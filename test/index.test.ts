import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerAPI } from "@signalk/server-api";
import { MockWyomingServer } from "signalk-wyoming/mock";
import createPlugin from "../src/index.js";
import {
  clearManager,
  emissions,
  installManager,
  makeApp,
  makeManager,
  waitFor,
  type TestApp,
} from "./fixtures.js";

type Handler = (req: unknown, res: unknown) => unknown;

interface Route {
  handler: Handler;
  access: string | null;
}

function makeRouter() {
  const routes = new Map<string, Route>();
  const add =
    (method: string, access: string | null) =>
    (path: string, handler: Handler) => {
      routes.set(`${method} ${path}`, { handler, access });
    };
  return {
    routes,
    get: add("GET", null),
    post: add("POST", null),
    access: (level: string) => ({
      get: add("GET", level),
      post: add("POST", level),
    }),
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  clearManager();
});

function asServerApi(app: TestApp): ServerAPI {
  return app as unknown as ServerAPI;
}

describe("plugin factory", () => {
  it("exposes the Signal K plugin surface", () => {
    const plugin = createPlugin(asServerApi(makeApp()));
    expect(plugin.id).toBe("signalk-whisper");
    expect(plugin.name).toBe("Whisper STT (Wyoming)");
    const schema = (plugin.schema as () => any)();
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["model", "language", "initialPrompt"]),
    );
    const uiSchema = (plugin.uiSchema as () => any)();
    expect(uiSchema.initialPrompt["ui:widget"]).toBe("textarea");
    expect(typeof plugin.start).toBe("function");
    expect(typeof plugin.stop).toBe("function");
    expect(typeof plugin.registerWithRouter).toBe("function");
  });

  it("construction and registerWithRouter are safe without start()", () => {
    const plugin = createPlugin(asServerApi(makeApp()));
    const router = makeRouter();
    plugin.registerWithRouter!(router as any);

    expect([...router.routes.keys()]).toEqual(
      expect.arrayContaining([
        "GET /api/update/check",
        "POST /api/update/apply",
        "GET /api/status",
      ]),
    );
    expect(router.routes.get("GET /api/status")!.access).toBe("readonly");
    // update routes stay admin-only (no access registrar call)
    expect(router.routes.get("GET /api/update/check")!.access).toBeNull();
  });

  it("guards routes with the running flag (503 when stopped)", async () => {
    const plugin = createPlugin(asServerApi(makeApp()));
    const router = makeRouter();
    plugin.registerWithRouter!(router as any);
    for (const key of [
      "GET /api/status",
      "GET /api/update/check",
      "POST /api/update/apply",
    ]) {
      const res = makeRes();
      await router.routes.get(key)!.handler({}, res);
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: "signalk-whisper is not running" });
    }
  });

  it("runs the full start → status route → update apply → stop cycle", async () => {
    const server = new MockWyomingServer({ role: "asr" });
    const port = await server.listen();
    cleanups.push(() => server.close());
    const manager = makeManager({ resolveAddress: `127.0.0.1:${port}` });
    installManager(manager);

    const app = makeApp();
    const plugin = createPlugin(asServerApi(app));
    const router = makeRouter();
    plugin.registerWithRouter!(router as any);

    plugin.start({}, vi.fn());
    cleanups.push(() => plugin.stop() as Promise<void>);
    await waitFor(
      () =>
        app.setPluginStatus.mock.calls.some((c) =>
          String(c[0]).startsWith("Running rhasspy/wyoming-whisper:3.5.0"),
        ),
      "running status",
    );

    // readonly status route
    const statusRes = makeRes();
    await router.routes.get("GET /api/status")!.handler({}, statusRes);
    expect(statusRes.statusCode).toBe(200);
    const report = statusRes.body as Record<string, unknown>;
    expect(report.status).toBe("ready");
    expect(report.uri).toBe(`tcp://127.0.0.1:${port}`);
    expect(report.tag).toBe("3.5.0");
    expect(report.containerState).toBe("running");
    expect((report.lastHealth as Record<string, unknown>).ok).toBe(true);
    expect(report.info).toHaveProperty("asr");

    // update apply persists the REQUESTED tag via savePluginOptions;
    // the recreate moves the published host port — the runner must
    // re-resolve the address and re-gate against the new container
    const server2 = new MockWyomingServer({ role: "asr" });
    const port2 = await server2.listen();
    cleanups.push(() => server2.close());
    manager.resolveContainerAddress.mockResolvedValue(`127.0.0.1:${port2}`);

    const applyRes = makeRes();
    await router.routes
      .get("POST /api/update/apply")!
      .handler({ body: { tag: "3.6.0" } }, applyRes);
    expect(applyRes.body).toEqual({ success: true, tag: "3.6.0" });
    expect(manager.recreate).toHaveBeenCalled();
    expect(app.savePluginOptions).toHaveBeenCalledWith(
      expect.objectContaining({ imageTag: "3.6.0" }),
      expect.any(Function),
    );

    await waitFor(
      () =>
        app.setPluginStatus.mock.calls.some(
          (c) =>
            String(c[0]) ===
            `Running rhasspy/wyoming-whisper:3.6.0 at tcp://127.0.0.1:${port2}`,
        ),
      "running at the new address after the update",
    );
    const afterUpdate = makeRes();
    await router.routes.get("GET /api/status")!.handler({}, afterUpdate);
    const updated = afterUpdate.body as Record<string, unknown>;
    expect(updated.status).toBe("ready");
    expect(updated.uri).toBe(`tcp://127.0.0.1:${port2}`);
    expect(updated.tag).toBe("3.6.0");

    // stop: awaited, emits stopped, stops the container
    await plugin.stop();
    expect(manager.stop).toHaveBeenCalledWith("whisper");
    const all = emissions(app);
    expect(all[all.length - 1]!.status).toBe("stopped");

    const after = makeRes();
    await router.routes.get("GET /api/status")!.handler({}, after);
    expect(after.statusCode).toBe(503);
  });
});
