import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusEmitter } from "../src/service.js";
import { emissions, makeApp, type TestApp } from "./fixtures.js";

const IDENTITY = { plugin: "signalk-whisper", type: "asr" };

describe("StatusEmitter", () => {
  let app: TestApp;

  beforeEach(() => {
    vi.useFakeTimers();
    app = makeApp();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("omits emissions while the uri is unknown, except 'stopped'", () => {
    const emitter = new StatusEmitter(app, IDENTITY);
    emitter.request("starting");
    emitter.request("ready");
    expect(emissions(app)).toEqual([]);
    emitter.request("stopped");
    expect(emissions(app)).toEqual([
      { plugin: "signalk-whisper", type: "asr", uri: null, status: "stopped" },
    ]);
  });

  it("emits the full announcement object on every transition", () => {
    const emitter = new StatusEmitter(app, IDENTITY, { minIntervalMs: 0 });
    emitter.uri = "tcp://127.0.0.1:10300";
    emitter.request("starting");
    emitter.request("ready");
    expect(emissions(app)).toEqual([
      {
        plugin: "signalk-whisper",
        type: "asr",
        uri: "tcp://127.0.0.1:10300",
        status: "starting",
      },
      {
        plugin: "signalk-whisper",
        type: "asr",
        uri: "tcp://127.0.0.1:10300",
        status: "ready",
      },
    ]);
  });

  it("never emits the same status twice in a row", () => {
    const emitter = new StatusEmitter(app, IDENTITY, { minIntervalMs: 0 });
    emitter.uri = "tcp://x";
    emitter.request("ready");
    emitter.request("ready");
    emitter.request("ready");
    expect(emissions(app)).toHaveLength(1);
  });

  it("collapses an error → ready → error flap inside the debounce window", () => {
    const emitter = new StatusEmitter(app, IDENTITY, { minIntervalMs: 500 });
    emitter.uri = "tcp://x";
    emitter.request("error"); // emitted immediately
    expect(emissions(app)).toHaveLength(1);

    vi.advanceTimersByTime(100);
    emitter.request("ready"); // scheduled for t=500
    vi.advanceTimersByTime(100);
    emitter.request("error"); // replaces the pending 'ready'
    vi.advanceTimersByTime(1_000);

    // settled back on the already-emitted status → nothing new went out
    expect(emissions(app)).toHaveLength(1);
    expect(emissions(app)[0]!.status).toBe("error");
  });

  it("delays a rapid follow-up transition to the debounce boundary", () => {
    const emitter = new StatusEmitter(app, IDENTITY, { minIntervalMs: 500 });
    emitter.uri = "tcp://x";
    emitter.request("starting");
    vi.advanceTimersByTime(100);
    emitter.request("ready");
    expect(emissions(app)).toHaveLength(1); // still debounced

    vi.advanceTimersByTime(400);
    expect(emissions(app)).toHaveLength(2);
    expect(emissions(app)[1]!.status).toBe("ready");
  });

  it("suppresses pathological flapping with a warning, then recovers", () => {
    const emitter = new StatusEmitter(app, IDENTITY, {
      minIntervalMs: 0,
      flapWindowMs: 1_000,
      flapLimit: 3,
    });
    emitter.uri = "tcp://x";
    emitter.request("starting");
    emitter.request("ready");
    emitter.request("error"); // 3 emissions — window full
    emitter.request("ready"); // suppressed
    emitter.request("error"); // suppressed
    expect(emissions(app)).toHaveLength(3);
    expect(app.error).toHaveBeenCalledTimes(1);
    expect(String(app.error.mock.calls[0]![0])).toMatch(/flapping/);

    vi.advanceTimersByTime(1_100); // window clears
    emitter.request("ready");
    expect(emissions(app)).toHaveLength(4);
    expect(emissions(app)[3]!.status).toBe("ready");
  });

  it("replays the last suppressed status once the flap window clears", () => {
    const emitter = new StatusEmitter(app, IDENTITY, {
      minIntervalMs: 0,
      flapWindowMs: 1_000,
      flapLimit: 3,
    });
    emitter.uri = "tcp://x";
    emitter.request("starting");
    emitter.request("ready");
    emitter.request("error"); // 3 emissions — window full
    emitter.request("ready"); // suppressed — the service settled on 'ready'
    expect(emissions(app)).toHaveLength(3);

    // no further request arrives; the suppressed status must still surface
    vi.advanceTimersByTime(1_100);
    expect(emissions(app)).toHaveLength(4);
    expect(emissions(app)[3]!.status).toBe("ready");
  });

  it("drops a queued flap replay when a real emission supersedes it", () => {
    const emitter = new StatusEmitter(app, IDENTITY, {
      minIntervalMs: 0,
      flapWindowMs: 1_000,
      flapLimit: 3,
    });
    emitter.uri = "tcp://x";
    emitter.request("starting"); // t=0
    vi.advanceTimersByTime(200);
    emitter.request("ready"); // t=200
    vi.advanceTimersByTime(200);
    emitter.request("error"); // t=400 — window full
    vi.advanceTimersByTime(100);
    emitter.request("ready"); // t=500 — suppressed, queued for replay
    vi.advanceTimersByTime(500); // t=1000 — the t=0 emission left the window
    emitter.request("starting"); // emits, superseding the queued 'ready'
    expect(emissions(app)).toHaveLength(4);
    expect(emissions(app)[3]!.status).toBe("starting");

    vi.advanceTimersByTime(2_000); // the stale replay must NOT fire
    expect(emissions(app)).toHaveLength(4);
  });

  it("disables itself for the run when emitPropertyValue throws (cap)", () => {
    app.emitPropertyValue.mockImplementation(() => {
      throw new Error("Max PropertyValues count 1000 exceeded");
    });
    const emitter = new StatusEmitter(app, IDENTITY, { minIntervalMs: 0 });
    emitter.uri = "tcp://x";
    emitter.request("ready");
    emitter.request("error");
    emitter.request("stopped");
    expect(app.emitPropertyValue).toHaveBeenCalledTimes(1);
    expect(app.error).toHaveBeenCalledTimes(1);
    expect(String(app.error.mock.calls[0]![0])).toMatch(/disabling/);

    // reset() re-arms for the next plugin run
    app.emitPropertyValue.mockReset();
    emitter.reset();
    emitter.request("ready");
    expect(emissions(app)).toHaveLength(1);
    expect(emissions(app)[0]!.status).toBe("ready");
  });

  it("flushes 'stopped' immediately with the last known uri", () => {
    const emitter = new StatusEmitter(app, IDENTITY, { minIntervalMs: 500 });
    emitter.uri = "tcp://127.0.0.1:10300";
    emitter.request("ready");
    emitter.request("stopped"); // inside the debounce window — still instant
    const all = emissions(app);
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual({
      plugin: "signalk-whisper",
      type: "asr",
      uri: "tcp://127.0.0.1:10300",
      status: "stopped",
    });
  });
});
