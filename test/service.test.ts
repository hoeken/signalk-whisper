import { afterEach, describe, expect, it } from "vitest";
import { MockWyomingServer } from "signalk-wyoming/mock";
import { NAUTICAL_PROMPT, applyDefaults } from "../src/config.js";
import { ServiceRunner } from "../src/service.js";
import {
  FAST_TIMING,
  clearManager,
  emissions,
  installManager,
  makeApp,
  makeManager,
  notifications,
  waitFor,
} from "./fixtures.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  clearManager();
});

async function setup(options: {
  mock?: ConstructorParameters<typeof MockWyomingServer>[0];
  config?: Record<string, unknown>;
  timing?: Record<string, number>;
}) {
  const server = new MockWyomingServer({ role: "asr", ...options.mock });
  const port = await server.listen();
  cleanups.push(() => server.close());
  const manager = makeManager({ resolveAddress: `127.0.0.1:${port}` });
  installManager(manager);
  const app = makeApp();
  const runner = new ServiceRunner(app, { ...FAST_TIMING, ...options.timing });
  cleanups.push(() => runner.stop());
  runner.start(applyDefaults(options.config ?? {}));
  return { server, port, manager, app, runner };
}

describe("ServiceRunner lifecycle", () => {
  it("starts the container, gates on describe, and emits ready", async () => {
    const { port, manager, app } = await setup({});
    await waitFor(
      () => emissions(app).some((e) => e.status === "ready"),
      "ready emission",
    );

    // §3.1 announcement shape, exactly
    expect(emissions(app)).toEqual([
      {
        plugin: "signalk-whisper",
        type: "asr",
        uri: `tcp://127.0.0.1:${port}`,
        status: "starting",
      },
      {
        plugin: "signalk-whisper",
        type: "asr",
        uri: `tcp://127.0.0.1:${port}`,
        status: "ready",
      },
    ]);

    // container wiring: pinned tag, stable command, loopback networking
    expect(manager.ensureRunning).toHaveBeenCalledTimes(1);
    const [name, config] = manager.ensureRunning.mock.calls[0]!;
    expect(name).toBe("whisper");
    expect(config.image).toBe("rhasspy/wyoming-whisper");
    expect(config.tag).toBe("3.5.0");
    expect(config.command).toEqual([
      "--model",
      "tiny-int8",
      "--language",
      "en",
      "--initial-prompt",
      NAUTICAL_PROMPT,
    ]);
    expect(config.signalkAccessiblePorts).toEqual([10300]);
    expect(config.signalkDataMount).toBe("/data");
    expect(config.readiness).toBeUndefined(); // HTTP readiness must be off
    expect(manager.updates.register).toHaveBeenCalledTimes(1);

    expect(app.setPluginStatus).toHaveBeenCalledWith(
      `Running rhasspy/wyoming-whisper:3.5.0 at tcp://127.0.0.1:${port}`,
    );
    // ready clears the health notification
    const notes = notifications(app);
    expect(notes[notes.length - 1]).toEqual({
      path: "notifications.voice.whisper",
      value: {
        state: "normal",
        method: ["visual"],
        message: "whisper is ready",
      },
    });
  });

  it("mentions the model download in the starting status", async () => {
    const { app } = await setup({});
    await waitFor(
      () => emissions(app).some((e) => e.status === "ready"),
      "ready emission",
    );
    const statuses = app.setPluginStatus.mock.calls.map((c) => String(c[0]));
    expect(
      statuses.some((s) => s.includes("first start downloads the model")),
    ).toBe(true);
    expect(statuses.some((s) => s.includes("43 MB"))).toBe(true);
  });

  it("keeps retrying the describe gate until the service answers", async () => {
    const { server, app } = await setup({ mock: { refuseConnections: true } });
    // let a few refused attempts happen, then open up
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(emissions(app).some((e) => e.status === "ready")).toBe(false);
    server.refuseConnections = false;
    await waitFor(
      () => emissions(app).some((e) => e.status === "ready"),
      "ready after recovery",
    );
  });

  it("fails loudly when the describe gate deadline passes", async () => {
    const { app } = await setup({
      mock: { hang: true },
      timing: { gateDeadlineMs: 300, describeTimeoutMs: 80 },
    });
    await waitFor(
      () => emissions(app).some((e) => e.status === "error"),
      "error emission",
    );
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining("did not answer a Wyoming describe"),
    );
    const alarms = notifications(app).filter((n) => n.value.state === "alarm");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.path).toBe("notifications.voice.whisper");
  });

  it("keeps probing after the gate deadline so a late service recovers", async () => {
    const { server, app } = await setup({
      mock: { hang: true },
      timing: { gateDeadlineMs: 300, describeTimeoutMs: 80 },
    });
    await waitFor(
      () => emissions(app).some((e) => e.status === "error"),
      "error emission",
    );

    // e.g. a slow first-start model download finally finishes
    server.hang = false;
    await waitFor(() => {
      const all = emissions(app);
      return all[all.length - 1]?.status === "ready";
    }, "recovery emission");
    const notes = notifications(app);
    expect(notes[notes.length - 1]!.value.state).toBe("normal");
  });

  it("re-resolves the address and re-gates after an applied update", async () => {
    const { manager, app, runner } = await setup({});
    await waitFor(
      () => emissions(app).some((e) => e.status === "ready"),
      "ready emission",
    );

    // The update recreates the container and the published host port moves.
    const server2 = new MockWyomingServer({ role: "asr" });
    const port2 = await server2.listen();
    cleanups.push(() => server2.close());
    manager.resolveContainerAddress.mockResolvedValue(`127.0.0.1:${port2}`);

    runner.onUpdateApplied("3.6.0");
    await waitFor(() => {
      const all = emissions(app);
      const last = all[all.length - 1];
      return (
        last?.status === "ready" && last.uri === `tcp://127.0.0.1:${port2}`
      );
    }, "ready at the new address");
    expect(app.setPluginStatus).toHaveBeenCalledWith(
      `Running rhasspy/wyoming-whisper:3.6.0 at tcp://127.0.0.1:${port2}`,
    );
    const report = await runner.statusReport();
    expect(report.uri).toBe(`tcp://127.0.0.1:${port2}`);
    expect(report.status).toBe("ready");
  });

  it("raises an alarm after 3 failed health probes and recovers", async () => {
    const { server, app } = await setup({});
    await waitFor(
      () => emissions(app).some((e) => e.status === "ready"),
      "ready emission",
    );

    server.hang = true; // service stops answering
    await waitFor(
      () => emissions(app).some((e) => e.status === "error"),
      "error emission",
    );
    expect(app.setPluginError).toHaveBeenCalledWith(
      expect.stringContaining("consecutive"),
    );
    const alarm = notifications(app).find((n) => n.value.state === "alarm")!;
    expect(alarm.path).toBe("notifications.voice.whisper");
    expect(alarm.value.method).toEqual(["visual"]);

    server.hang = false; // service comes back
    await waitFor(() => {
      const all = emissions(app);
      return all[all.length - 1]?.status === "ready";
    }, "recovery emission");
    const notes = notifications(app);
    expect(notes[notes.length - 1]!.value.state).toBe("normal");
  });

  it("emits stopped and stops the container on stop()", async () => {
    const { port, manager, app, runner } = await setup({});
    await waitFor(
      () => emissions(app).some((e) => e.status === "ready"),
      "ready emission",
    );
    await runner.stop();

    const all = emissions(app);
    expect(all[all.length - 1]).toEqual({
      plugin: "signalk-whisper",
      type: "asr",
      uri: `tcp://127.0.0.1:${port}`, // last known uri
      status: "stopped",
    });
    expect(manager.stop).toHaveBeenCalledWith("whisper");
    expect(manager.updates.unregister).toHaveBeenCalledWith("signalk-whisper");
    expect(app.setPluginStatus).toHaveBeenCalledWith("Stopped");
    expect(runner.isRunning).toBe(false);
  });

  it("skips the manager address lookup with bind 0.0.0.0", async () => {
    const server = new MockWyomingServer({ role: "asr" });
    const port = await server.listen();
    cleanups.push(() => server.close());
    const manager = makeManager({ resolveAddress: null });
    installManager(manager);
    const app = makeApp();
    const runner = new ServiceRunner(app, FAST_TIMING);
    cleanups.push(() => runner.stop());
    runner.start(applyDefaults({ port, advanced: { bind: "0.0.0.0" } }));
    await waitFor(
      () => emissions(app).some((e) => e.status === "ready"),
      "ready emission",
    );

    expect(emissions(app)[0]!.uri).toBe(`tcp://127.0.0.1:${port}`);
    expect(manager.resolveContainerAddress).not.toHaveBeenCalled();
    const config = manager.ensureRunning.mock.calls.at(-1)![1];
    expect(config.ports).toEqual({ "10300": `0.0.0.0:${port}` });
    expect(config.signalkAccessiblePorts).toBeUndefined();
  });

  it("surfaces an unresolvable container address as a plugin error", async () => {
    const server = new MockWyomingServer({ role: "asr" });
    await server.listen();
    cleanups.push(() => server.close());
    const manager = makeManager({ resolveAddress: null });
    installManager(manager);
    const app = makeApp();
    const runner = new ServiceRunner(app, FAST_TIMING);
    cleanups.push(() => runner.stop());
    runner.start(applyDefaults({}));

    await waitFor(
      () =>
        app.setPluginError.mock.calls.some((c) =>
          String(c[0]).includes("could not resolve"),
        ),
      "address error",
    );
    expect(emissions(app).some((e) => e.status === "ready")).toBe(false);
  });

  it("reports a plugin error when signalk-container never appears", async () => {
    clearManager();
    const app = makeApp();
    const runner = new ServiceRunner(app, {
      ...FAST_TIMING,
      managerTimeoutMs: 100,
    });
    cleanups.push(() => runner.stop());
    runner.start(applyDefaults({}));
    await waitFor(
      () => app.setPluginError.mock.calls.length > 0,
      "manager-unavailable error",
    );
    expect(emissions(app)).toEqual([]);
  });
});
