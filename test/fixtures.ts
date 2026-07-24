/**
 * Shared test fixtures: a mock Signal K app, a fake signalk-container
 * manager (installed on globalThis like the real plugin does), fast runner
 * timings, and small async helpers.
 */

import { vi } from "vitest";
import type { ContainerManagerApi } from "signalk-container-helper";
import type {
  RunnerTiming,
  WyomingServiceAnnouncement,
} from "../src/service.js";

export function makeApp() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn(),
    emitPropertyValue: vi.fn(),
    handleMessage: vi.fn(),
    savePluginOptions: vi.fn((_config: object, cb: (err: unknown) => void) =>
      cb(null),
    ),
  };
}

export type TestApp = ReturnType<typeof makeApp>;

export interface FakeManagerSetup {
  /** What resolveContainerAddress returns. */
  resolveAddress?: string | null;
}

/** Fake ContainerManagerApi recording calls (only the members we exercise). */
export function makeManager(setup: FakeManagerSetup = {}) {
  const { resolveAddress = "127.0.0.1:10300" } = setup;
  const manager = {
    getRuntime: vi.fn(() => ({
      runtime: "podman" as const,
      version: "5.4.2",
      isRootless: true,
    })),
    whenReady: vi.fn(async () => {}),
    pullImage: vi.fn(async () => {}),
    imageExists: vi.fn(async () => true),
    ensureRunning: vi.fn<
      (
        name: string,
        config: Record<string, unknown>,
        options?: unknown,
      ) => Promise<void>
    >(async () => {}),
    recreate: vi.fn<
      (
        name: string,
        config: Record<string, unknown>,
        options?: unknown,
      ) => Promise<void>
    >(async () => {}),
    start: vi.fn<(name: string) => Promise<void>>(async () => {}),
    stop: vi.fn<(name: string) => Promise<void>>(async () => {}),
    remove: vi.fn<(name: string) => Promise<void>>(async () => {}),
    getState: vi.fn(async () => "running" as const),
    listContainers: vi.fn(async () => []),
    resolveContainerAddress: vi.fn<
      (name: string, port: number) => Promise<string | null>
    >(async () => resolveAddress),
    updates: {
      register: vi.fn<(registration: unknown) => void>(() => {}),
      unregister: vi.fn<(pluginId: string) => void>(() => {}),
      checkOne: vi.fn(async () => ({})),
      checkAll: vi.fn(async () => []),
      getLastResult: vi.fn(() => null),
      sources: {
        githubReleases: vi.fn(() => ({
          fetch: async () => ({ kind: "version" as const, latest: "3.5.0" }),
        })),
        dockerHubTags: vi.fn(() => ({
          fetch: async () => ({ kind: "version" as const, latest: "3.5.0" }),
        })),
      },
    },
  };
  return manager;
}

export type FakeManager = ReturnType<typeof makeManager>;

export function installManager(manager: FakeManager | undefined): void {
  (
    globalThis as { __signalk_containerManager?: ContainerManagerApi }
  ).__signalk_containerManager = manager as unknown as ContainerManagerApi;
}

export function clearManager(): void {
  delete (globalThis as { __signalk_containerManager?: ContainerManagerApi })
    .__signalk_containerManager;
}

/** Fast real-timer timings for socket-driven lifecycle tests. */
export const FAST_TIMING: Partial<RunnerTiming> = {
  managerTimeoutMs: 2_000,
  describeIntervalMs: 25,
  describeTimeoutMs: 250,
  gateDeadlineMs: 3_000,
  gateReportEveryMs: 10_000,
  healthIntervalMs: 40,
  healthTimeoutMs: 150,
  healthFailThreshold: 3,
  minEmitIntervalMs: 0,
  flapWindowMs: 60_000,
  flapLimit: 1_000,
};

/** All `wyoming-service` PropertyValues emissions captured so far. */
export function emissions(app: TestApp): WyomingServiceAnnouncement[] {
  return app.emitPropertyValue.mock.calls
    .filter(([name]) => name === "wyoming-service")
    .map(([, value]) => value as WyomingServiceAnnouncement);
}

/** All notification path/value pairs sent via handleMessage. */
export function notifications(
  app: TestApp,
): { path: string; value: Record<string, unknown> }[] {
  return app.handleMessage.mock.calls.map(([, delta]) => {
    const d = delta as {
      updates: { values: { path: string; value: Record<string, unknown> }[] }[];
    };
    return d.updates[0]!.values[0]!;
  });
}

export async function waitFor(
  condition: () => boolean,
  what = "condition",
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
