/**
 * ServiceRunner — container lifecycle + Wyoming describe gate + health loop
 * + `wyoming-service` PropertyValues emission for signalk-whisper.
 *
 * The shape is shared across the signalk-piper / signalk-whisper /
 * signalk-openwakeword family (deliberately duplicated per repo):
 *
 *   start → ManagedContainer.start → resolve address → describe gate
 *         → ready (status + emission + notification clear) → health loop
 *   stop  → emit 'stopped' → container.stop() → 'Stopped'
 *
 * Wyoming is raw TCP, so the container-helper's HTTP `readiness` option is
 * deliberately omitted; readiness is our own describe loop (src/wyoming.ts).
 */

import {
  ManagedContainer,
  startSafely,
  errMsg,
  type ContainerState,
} from "signalk-container-helper";
import {
  buildContainerConfig,
  CONTAINER_NAME,
  defaultSettings,
  DOWNLOAD_HINT,
  IMAGE,
  NOTIFICATION_PATH,
  PLUGIN_ID,
  resolveTag,
  SERVICE_TYPE,
  WYOMING_PORT,
  type WhisperSettings,
} from "./config.js";
import { describeService, type DescribeResult } from "./wyoming.js";

/** Structural slice of the Signal K plugin `app` object the runner needs. */
export interface WhisperApp {
  debug(msg: string): void;
  error(msg: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  emitPropertyValue(name: string, value: any): void;
  handleMessage(id: string, delta: object): void;
}

export type ServiceStatus = "starting" | "ready" | "stopped" | "error";

/** The §3.1 `wyoming-service` announcement object, emitted verbatim. */
export interface WyomingServiceAnnouncement {
  plugin: string;
  type: string;
  uri: string | null;
  status: ServiceStatus;
}

export interface EmitterTiming {
  /** Minimum gap between emissions; flaps inside it collapse. Default 500. */
  minIntervalMs: number;
  /** Rolling window for flap detection. Default 60_000. */
  flapWindowMs: number;
  /** Emissions allowed per window before suppression. Default 10. */
  flapLimit: number;
}

/**
 * Emission discipline for the shared `wyoming-service` property (§3.1):
 * the server-wide PropertyValues cap is global and `emitPropertyValue`
 * THROWS once it is hit, so this emitter
 *
 * - never emits the same status twice in a row,
 * - enforces ≥ minIntervalMs between emissions (a flap that settles back to
 *   the last emitted status inside the window collapses to zero emissions),
 * - suppresses pathological churn (> flapLimit transitions per window) with
 *   a logged warning instead of emissions, remembering the newest suppressed
 *   status and replaying it once the window clears (so a service that
 *   settles while suppressed is not frozen at a stale status),
 * - omits emissions while the URI is unknown, EXCEPT 'stopped',
 * - wraps emitPropertyValue in try/catch and disables itself for the rest
 *   of the run if the server cap throws.
 */
export class StatusEmitter {
  uri: string | null = null;

  private readonly app: Pick<WhisperApp, "emitPropertyValue" | "error">;
  private readonly identity: { plugin: string; type: string };
  private readonly timing: EmitterTiming;
  private lastStatus: ServiceStatus | null = null;
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private pending: { status: ServiceStatus; timer: NodeJS.Timeout } | null =
    null;
  private flapReplay: { status: ServiceStatus; timer: NodeJS.Timeout } | null =
    null;
  private emitTimes: number[] = [];
  private disabled = false;
  private flapWarned = false;

  constructor(
    app: Pick<WhisperApp, "emitPropertyValue" | "error">,
    identity: { plugin: string; type: string },
    timing?: Partial<EmitterTiming>,
  ) {
    this.app = app;
    this.identity = identity;
    this.timing = {
      minIntervalMs: 500,
      flapWindowMs: 60_000,
      flapLimit: 10,
      ...timing,
    };
  }

  /** Last status actually emitted (null before the first emission). */
  get emittedStatus(): ServiceStatus | null {
    return this.lastStatus;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  /** Request an emission of `status`; the discipline above applies. */
  request(status: ServiceStatus): void {
    if (this.disabled) return;
    if (status === "stopped") {
      // Final word of a run: flush immediately (with the last known uri,
      // null included) instead of debouncing.
      this.cancelPending();
      this.emit(status);
      return;
    }
    if (this.uri === null) return; // nothing useful to announce yet
    if (this.pending !== null) {
      this.pending.status = status; // latest request wins
      return;
    }
    const now = Date.now();
    const wait = this.lastEmitAt + this.timing.minIntervalMs - now;
    if (wait > 0) {
      const timer = setTimeout(() => {
        const pendingStatus = this.pending?.status;
        this.pending = null;
        if (pendingStatus !== undefined) this.emit(pendingStatus);
      }, wait);
      timer.unref?.();
      this.pending = { status, timer };
      return;
    }
    this.emit(status);
  }

  /** Drop any scheduled emission (used on stop/reset). */
  cancelPending(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
  }

  /** Re-arm for a new plugin run (cap-disable is per-run per §3.1). */
  reset(): void {
    this.cancelPending();
    this.clearFlapReplay();
    this.disabled = false;
    this.flapWarned = false;
    this.emitTimes = [];
  }

  private clearFlapReplay(): void {
    if (this.flapReplay !== null) {
      clearTimeout(this.flapReplay.timer);
      this.flapReplay = null;
    }
  }

  private emit(status: ServiceStatus): void {
    if (this.disabled) return;
    if (status === this.lastStatus) return; // never repeat a status
    const now = Date.now();
    this.emitTimes = this.emitTimes.filter(
      (t) => now - t < this.timing.flapWindowMs,
    );
    if (this.emitTimes.length >= this.timing.flapLimit) {
      if (!this.flapWarned) {
        this.flapWarned = true;
        this.app.error(
          `wyoming-service status is flapping (> ${this.timing.flapLimit} ` +
            `transitions in ${this.timing.flapWindowMs / 1000}s) — ` +
            "suppressing emissions until it settles",
        );
      }
      // Remember the newest suppressed status and replay it once the
      // window has room again: if the service settles into a new state
      // during suppression, nothing else would ever re-request it and
      // consumers would see the stale pre-suppression status forever.
      this.clearFlapReplay();
      const retryInMs = this.emitTimes[0]! + this.timing.flapWindowMs - now + 1;
      const timer = setTimeout(() => {
        const replay = this.flapReplay;
        this.flapReplay = null;
        if (replay !== null) this.emit(replay.status);
      }, retryInMs);
      timer.unref?.();
      this.flapReplay = { status, timer };
      return;
    }
    this.flapWarned = false;
    const announcement: WyomingServiceAnnouncement = {
      plugin: this.identity.plugin,
      type: this.identity.type,
      uri: this.uri,
      status,
    };
    try {
      this.app.emitPropertyValue("wyoming-service", announcement);
      this.lastStatus = status;
      this.lastEmitAt = now;
      this.emitTimes.push(now);
      this.clearFlapReplay(); // a real emission supersedes any queued replay
    } catch (err) {
      // The server-wide PropertyValues cap throws for every emitter once
      // hit; log once and go quiet for the rest of this run.
      this.disabled = true;
      this.app.error(
        "emitPropertyValue failed (server PropertyValues cap reached?) — " +
          `disabling wyoming-service emissions for this run: ${errMsg(err)}`,
      );
    }
  }
}

export interface RunnerTiming {
  /** Budget for waiting on the signalk-container manager. */
  managerTimeoutMs: number;
  /** Describe-gate retry interval. */
  describeIntervalMs: number;
  /** Per-attempt describe timeout during the gate. */
  describeTimeoutMs: number;
  /** Describe-gate deadline (first-start model downloads are slow). */
  gateDeadlineMs: number;
  /** How often the gate refreshes the plugin status line. */
  gateReportEveryMs: number;
  /** Health-loop probe interval. */
  healthIntervalMs: number;
  /** Health-loop per-probe timeout. */
  healthTimeoutMs: number;
  /** Consecutive failures before the error transition. */
  healthFailThreshold: number;
  /** StatusEmitter minimum emission gap. */
  minEmitIntervalMs: number;
  /** StatusEmitter flap window. */
  flapWindowMs: number;
  /** StatusEmitter flap limit. */
  flapLimit: number;
}

export const DEFAULT_TIMING: RunnerTiming = {
  managerTimeoutMs: 120_000,
  describeIntervalMs: 2_000,
  describeTimeoutMs: 5_000,
  gateDeadlineMs: 600_000, // 10 min — first start downloads the model
  gateReportEveryMs: 15_000,
  healthIntervalMs: 30_000,
  healthTimeoutMs: 5_000,
  healthFailThreshold: 3,
  minEmitIntervalMs: 500,
  flapWindowMs: 60_000,
  flapLimit: 10,
};

export interface LastHealth {
  ok: boolean;
  /** Date.now() of the probe result. */
  at: number;
  latencyMs: number | null;
  error?: string;
}

export interface StatusReport {
  status: ServiceStatus;
  uri: string | null;
  tag: string;
  containerState: ContainerState;
  lastHealth: LastHealth | null;
  info: Record<string, unknown> | null;
}

function splitAddress(addr: string): { host: string; port: number } {
  const idx = addr.lastIndexOf(":");
  return { host: addr.slice(0, idx), port: Number(addr.slice(idx + 1)) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class ServiceRunner {
  readonly container: ManagedContainer;

  private readonly app: WhisperApp;
  private readonly timing: RunnerTiming;
  private readonly emitter: StatusEmitter;
  private settings: WhisperSettings = defaultSettings();
  private running = false;
  private runToken = 0;
  private status: ServiceStatus = "stopped";
  private uri: string | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private probeInFlight = false;
  private consecutiveFailures = 0;
  private lastHealth: LastHealth | null = null;
  private lastInfo: Record<string, unknown> | null = null;
  private notifiedState: "alarm" | "normal" | null = null;

  constructor(app: WhisperApp, timing: Partial<RunnerTiming> = {}) {
    this.app = app;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.emitter = new StatusEmitter(
      app,
      { plugin: PLUGIN_ID, type: SERVICE_TYPE },
      {
        minIntervalMs: this.timing.minEmitIntervalMs,
        flapWindowMs: this.timing.flapWindowMs,
        flapLimit: this.timing.flapLimit,
      },
    );
    this.container = new ManagedContainer({
      app,
      pluginId: PLUGIN_ID,
      name: CONTAINER_NAME, // runtime name: sk-whisper
      image: IMAGE,
      defaultTag: "auto",
      resolveTag,
      managerTimeoutMs: this.timing.managerTimeoutMs,
      buildConfig: (tag) => buildContainerConfig(this.settings, tag),
      updates: {
        versionSource: {
          dockerHubTags: IMAGE,
          // Numeric semver tags only (drop latest/branch tags).
          filter: (tag) => /^\d+\.\d+\.\d+$/.test(tag),
        },
      },
      ensureOptions: {
        // signalk-container's recurring (60 s) monitor hook — the one
        // manager-side health mechanism that works for raw TCP.
        healthCheck: () => this.tcpProbe(),
        onUnhealthy: (name, error) =>
          this.app.debug(`container ${name} reported unhealthy: ${error}`),
      },
      // NO `readiness` option: it is HTTP-only and a Wyoming TCP port can
      // never satisfy it. The describe gate below is our readiness.
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentSettings(): WhisperSettings {
    return this.settings;
  }

  /**
   * Synchronous entry point — Signal K's plugin.start() is synchronous, so
   * the async work runs under the helper's startSafely.
   */
  start(settings: WhisperSettings): void {
    this.settings = settings;
    this.running = true;
    this.consecutiveFailures = 0;
    this.lastHealth = null;
    this.emitter.reset();
    const token = ++this.runToken;
    startSafely(this.app, () => this.run(token));
  }

  /** Async — Signal K awaits plugin.stop(). Never throws. */
  async stop(): Promise<void> {
    this.running = false;
    this.runToken++; // invalidates any in-flight run/gate/health work
    this.stopHealthLoop();
    this.setStatus("stopped"); // emitted with the last known uri (or null)
    try {
      await this.container.stop();
    } catch (err) {
      this.app.debug(`container stop failed: ${errMsg(err)}`);
    }
    this.uri = null;
    this.emitter.uri = null;
    this.app.setPluginStatus("Stopped");
  }

  async statusReport(): Promise<StatusReport> {
    return {
      status: this.status,
      uri: this.uri,
      tag: this.container.lastStartedTag ?? this.settings.imageTag,
      containerState: await this.container.getState(),
      lastHealth: this.lastHealth,
      info: this.lastInfo,
    };
  }

  // ---------------------------------------------------------------------
  // Startup sequence
  // ---------------------------------------------------------------------

  private active(token: number): boolean {
    return this.running && token === this.runToken;
  }

  private async run(token: number): Promise<void> {
    const { tag } = await this.container.start(this.settings.imageTag);
    if (!this.active(token)) return;
    await this.acquireAndWatch(token, tag);
  }

  /**
   * Called after a successful container update (POST /api/update/apply).
   * `applyUpdate` recreates the container, and on bare metal the recreate
   * can move the published host port; with `readiness` omitted the helper
   * does NOT re-resolve the address for us (container-helper gotcha 3), so
   * re-resolve, re-run the describe gate against the new container, and
   * restart the health loop at the fresh address.
   */
  onUpdateApplied(tag: string): void {
    if (!this.running) return;
    const token = ++this.runToken; // supersede the old gate/health loop
    this.stopHealthLoop();
    this.consecutiveFailures = 0;
    startSafely(this.app, () => this.acquireAndWatch(token, tag));
  }

  /**
   * Post-start sequence shared by run() and onUpdateApplied(): resolve the
   * service address, gate on describe, then watch health.
   */
  private async acquireAndWatch(token: number, tag: string): Promise<void> {
    this.setStatus("starting"); // deferred until the uri is known (first run)
    this.app.setPluginStatus(
      `starting ${IMAGE}:${tag} — first start downloads the model ` +
        `(${DOWNLOAD_HINT})`,
    );

    // Resolve the service address. The helper returns bare host:port; the
    // tcp:// URI is ours to build. With bind 0.0.0.0 the port mapping is
    // explicit (not declared via signalkAccessiblePorts), so the local
    // address is known without asking the manager.
    let addr: string;
    if (this.settings.advanced.bind === "0.0.0.0") {
      addr = `127.0.0.1:${this.settings.port}`;
    } else {
      const resolved = await this.container.resolveAddress(WYOMING_PORT);
      if (!this.active(token)) return;
      if (resolved === null) {
        const msg =
          "could not resolve the whisper container address — is " +
          "signalk-container networking healthy?";
        this.app.setPluginError(msg);
        throw new Error(msg);
      }
      addr = resolved;
    }
    this.uri = `tcp://${addr}`;
    this.emitter.uri = this.uri;
    this.setStatus("starting"); // now emitted, uri known

    const info = await this.describeGate(token, addr, tag);
    if (info === null) {
      // Stopped/superseded → nothing to do. Gate deadline expired → the
      // error is already surfaced, but keep probing: the health loop's
      // success path flips 'error' back to 'ready' when the service
      // finally answers (§3.3 recovery) — e.g. a first-start model
      // download that outlasts the gate deadline.
      if (this.active(token)) this.startHealthLoop(token, addr, tag);
      return;
    }

    this.validateInfo(info);
    this.lastInfo = info.info;
    this.lastHealth = { ok: true, at: Date.now(), latencyMs: info.latencyMs };
    this.becomeReady(tag);
    this.startHealthLoop(token, addr, tag);
  }

  /**
   * Readiness gate: the plugin reports ready only once a Wyoming describe
   * returns a valid info event — which proves the model is downloaded AND
   * the service actually answers (§3.2).
   */
  private async describeGate(
    token: number,
    addr: string,
    tag: string,
  ): Promise<DescribeResult | null> {
    const { host, port } = splitAddress(addr);
    const startedAt = Date.now();
    const deadline = startedAt + this.timing.gateDeadlineMs;
    let lastReport = startedAt;
    let lastError: string | undefined;
    for (;;) {
      if (!this.active(token)) return null;
      try {
        return await describeService(host, port, {
          timeoutMs: this.timing.describeTimeoutMs,
        });
      } catch (err) {
        lastError = errMsg(err);
      }
      if (!this.active(token)) return null;
      const now = Date.now();
      if (now >= deadline) {
        const minutes = Math.round(this.timing.gateDeadlineMs / 60_000);
        const msg =
          `whisper did not answer a Wyoming describe within ${minutes} ` +
          `minute(s) (${this.uri}) — last error: ` +
          (lastError ?? "no describe attempt completed");
        this.app.setPluginError(msg);
        this.setStatus("error");
        this.raiseAlarm(msg);
        return null;
      }
      if (now - lastReport >= this.timing.gateReportEveryMs) {
        lastReport = now;
        const elapsed = Math.round((now - startedAt) / 1000);
        this.app.setPluginStatus(
          `starting ${IMAGE}:${tag} — waiting for the Wyoming service ` +
            `(${elapsed}s elapsed; first start downloads the model: ` +
            `${DOWNLOAD_HINT})`,
        );
      }
      await sleep(this.timing.describeIntervalMs);
    }
  }

  private validateInfo(result: DescribeResult): void {
    // An info event arriving at all satisfies the protocol check; a version
    // outside 1.x is loud but not fatal (images are pinned — drift should
    // be visible, not mysterious).
    if (result.version !== null && !result.version.startsWith("1.")) {
      this.app.error(
        `whisper answered with Wyoming protocol version ${result.version}; ` +
          "this plugin targets protocol 1.x — behavior may be unpredictable",
      );
    }
    const asr = result.info.asr;
    if (!Array.isArray(asr) || asr.length === 0) {
      this.app.error(
        "whisper's Wyoming info response advertises no ASR programs — " +
          "is the right image running?",
      );
    } else {
      this.app.debug(`whisper info: ${asr.length} ASR program(s) advertised`);
    }
  }

  private becomeReady(tag: string): void {
    this.consecutiveFailures = 0;
    this.app.setPluginStatus(`Running ${IMAGE}:${tag} at ${this.uri}`);
    this.setStatus("ready");
    this.clearAlarm();
  }

  // ---------------------------------------------------------------------
  // Health loop
  // ---------------------------------------------------------------------

  private startHealthLoop(token: number, addr: string, tag: string): void {
    this.stopHealthLoop();
    const { host, port } = splitAddress(addr);
    this.healthTimer = setInterval(() => {
      void this.healthTick(token, host, port, tag);
    }, this.timing.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  private stopHealthLoop(): void {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async healthTick(
    token: number,
    host: string,
    port: number,
    tag: string,
  ): Promise<void> {
    if (!this.active(token) || this.probeInFlight) return;
    this.probeInFlight = true;
    try {
      const result = await describeService(host, port, {
        timeoutMs: this.timing.healthTimeoutMs,
      });
      if (!this.active(token)) return;
      this.lastHealth = {
        ok: true,
        at: Date.now(),
        latencyMs: result.latencyMs,
      };
      this.lastInfo = result.info;
      this.consecutiveFailures = 0;
      if (this.status === "error") this.becomeReady(tag); // recovered
    } catch (err) {
      if (!this.active(token)) return;
      const reason = errMsg(err);
      this.lastHealth = {
        ok: false,
        at: Date.now(),
        latencyMs: null,
        error: reason,
      };
      this.consecutiveFailures++;
      this.app.debug(
        `whisper health probe failed (${this.consecutiveFailures} in a ` +
          `row): ${reason}`,
      );
      if (
        this.consecutiveFailures >= this.timing.healthFailThreshold &&
        this.status !== "error"
      ) {
        const msg =
          `whisper is not answering Wyoming describe requests at ` +
          `${this.uri} (${this.consecutiveFailures} consecutive ` +
          `failures): ${reason}`;
        this.app.setPluginError(msg);
        this.setStatus("error");
        this.raiseAlarm(msg);
      }
    } finally {
      this.probeInFlight = false;
    }
  }

  /** Boolean TCP probe for signalk-container's recurring healthCheck hook. */
  private async tcpProbe(): Promise<boolean> {
    if (this.uri === null) return true; // indeterminate — don't cry wolf
    const { host, port } = splitAddress(this.uri.replace("tcp://", ""));
    try {
      await describeService(host, port, {
        timeoutMs: this.timing.healthTimeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Emissions & notifications
  // ---------------------------------------------------------------------

  private setStatus(status: ServiceStatus): void {
    this.status = status;
    this.emitter.request(status);
  }

  private raiseAlarm(message: string): void {
    this.notify("alarm", message);
  }

  private clearAlarm(): void {
    this.notify("normal", "whisper is ready");
  }

  private notify(state: "alarm" | "normal", message: string): void {
    if (this.notifiedState === state) return;
    try {
      this.app.handleMessage(PLUGIN_ID, {
        updates: [
          {
            values: [
              {
                path: NOTIFICATION_PATH,
                // 'visual' only: generic notification-to-sound bridges must
                // not speak voice-service alarms out loud.
                value: { state, method: ["visual"], message },
              },
            ],
          },
        ],
      });
      this.notifiedState = state;
    } catch (err) {
      this.app.debug(`notification delta failed: ${errMsg(err)}`);
    }
  }
}
