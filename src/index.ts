/**
 * signalk-whisper — Whisper speech-to-text (Wyoming protocol) for Signal K.
 *
 * Runs rhasspy/wyoming-whisper in a container managed via signalk-container
 * (through signalk-container-helper), gates readiness on a Wyoming
 * `describe` handshake, health-checks it, and advertises the service on the
 * shared `wyoming-service` PropertyValues channel for the signalk-wyoming
 * orchestrator (or any other consumer) to discover.
 */

import type { Plugin, ServerAPI } from "@signalk/server-api";
import {
  errMsg,
  fetchWithTimeout,
  type RouterLike,
} from "signalk-container-helper";
import {
  applyDefaults,
  CONFIG_SCHEMA,
  IMAGE,
  isSemverTag,
  PLUGIN_ID,
  UI_SCHEMA,
} from "./config.js";
import { ServiceRunner, type RunnerTiming } from "./service.js";

export type { RunnerTiming };
export { ServiceRunner };

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}

type Handler = (req: unknown, res: ResponseLike) => unknown;

interface PluginRouter {
  get(path: string, handler: Handler): unknown;
  post(path: string, handler: Handler): unknown;
  /** Permission registrar (Signal K ≥ 2.x); feature-detect. */
  access?(level: "readonly" | "readwrite"): PluginRouter;
}

const TAGS_URL = `https://hub.docker.com/v2/repositories/${IMAGE}/tags/?page_size=25`;

/** Numeric-descending compare for the plain x.y.z tags isSemverTag admits. */
function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export default function createPlugin(app: ServerAPI): Plugin {
  let runner: ServiceRunner | undefined;
  let lastConfig: Record<string, unknown> = {};

  // Constructed lazily and kept for the process lifetime: registerWithRouter
  // is called even when the plugin is disabled, and Express routes cannot be
  // deregistered — the single runner instance is what the persistent routes
  // delegate to. Construction is side-effect free.
  const getRunner = (): ServiceRunner => {
    runner ??= new ServiceRunner(app);
    return runner;
  };

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: "Whisper STT (Wyoming)",
    description:
      "Whisper speech-to-text service (rhasspy/wyoming-whisper) in a " +
      "managed container, discoverable by the signalk-wyoming voice stack.",

    schema: () => CONFIG_SCHEMA as unknown as object,
    uiSchema: () => UI_SCHEMA as unknown as object,

    start(config: object) {
      lastConfig = (config ?? {}) as Record<string, unknown>;
      getRunner().start(applyDefaults(lastConfig));
    },

    // Async and awaited by the server: the next start() (e.g. on config
    // change) does not run until the container has actually stopped.
    async stop() {
      await runner?.stop();
    },

    registerWithRouter(router: unknown) {
      const r = getRunner();
      const pluginRouter = router as PluginRouter;

      // registerWithRouter outlives stop(): every handler is guarded by the
      // running flag so routes answer 503 instead of acting on a stopped
      // (or never-started) plugin.
      const guard =
        (handler: Handler): Handler =>
        (req, res) => {
          if (!r.isRunning) {
            res.status(503).json({ error: "signalk-whisper is not running" });
            return;
          }
          return handler(req, res);
        };

      // Container update routes (admin-only by default — correct):
      // GET /plugins/signalk-whisper/api/update/check
      // POST /plugins/signalk-whisper/api/update/apply
      const guardedRouter: RouterLike = {
        get: (path, handler) => pluginRouter.get(path, guard(handler)),
        post: (path, handler) => pluginRouter.post(path, guard(handler)),
      };
      r.container.registerUpdateRoutes(guardedRouter, {
        onApplied: (requestedTag, resolvedTag) => {
          // Persist the REQUESTED tag (e.g. "auto") so auto-tracking
          // survives restarts.
          lastConfig = { ...lastConfig, imageTag: requestedTag };
          app.savePluginOptions(lastConfig, (err) => {
            if (err) {
              app.error(`failed to persist updated image tag: ${errMsg(err)}`);
            }
          });
          // The recreate may have moved the published host port: re-resolve
          // the address, re-run the describe gate, restart the health loop.
          r.onUpdateApplied(resolvedTag);
        },
      });

      // Readonly routes — any authenticated user when the server supports
      // route permissions, admin-only otherwise.
      const readonlyRouter =
        typeof pluginRouter.access === "function"
          ? pluginRouter.access("readonly")
          : pluginRouter;

      // GET /plugins/signalk-whisper/api/status
      readonlyRouter.get(
        "/api/status",
        guard(async (_req, res) => {
          try {
            res.json(await r.statusReport());
          } catch (err) {
            res.status(500).json({ error: errMsg(err) });
          }
        }),
      );

      // GET /plugins/signalk-whisper/api/versions — the config panel's
      // version-dropdown feed. Deliberately NOT guarded by the running
      // flag: the operator picks a tag while the plugin is still disabled,
      // and the route only reaches out to Docker Hub on demand.
      readonlyRouter.get("/api/versions", (_req, res) => {
        void (async () => {
          try {
            const response = await fetchWithTimeout(TAGS_URL, {
              timeoutMs: 10_000,
            });
            if (!response.ok) {
              res
                .status(502)
                .json({ error: `Docker Hub answered HTTP ${response.status}` });
              return;
            }
            const body = (await response.json()) as {
              results?: { name?: unknown }[];
            };
            const versions = (Array.isArray(body.results) ? body.results : [])
              .map((entry) =>
                typeof entry?.name === "string" ? entry.name : "",
              )
              .filter(isSemverTag)
              .sort(compareSemverDesc)
              .map((tag) => ({ tag }));
            res.json({ versions });
          } catch (err) {
            res.status(502).json({ error: errMsg(err) });
          }
        })();
      });
    },
  };

  return plugin;
}
