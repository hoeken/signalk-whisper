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
import { errMsg, type RouterLike } from "signalk-container-helper";
import {
  applyDefaults,
  CONFIG_SCHEMA,
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

      // GET /plugins/signalk-whisper/api/status — any authenticated user
      // when the server supports route permissions, admin-only otherwise.
      const statusHandler: Handler = guard(async (_req, res) => {
        try {
          res.json(await r.statusReport());
        } catch (err) {
          res.status(500).json({ error: errMsg(err) });
        }
      });
      if (typeof pluginRouter.access === "function") {
        pluginRouter.access("readonly").get("/api/status", statusHandler);
      } else {
        pluginRouter.get("/api/status", statusHandler);
      }
    },
  };

  return plugin;
}
