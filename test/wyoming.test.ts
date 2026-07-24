import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MockWyomingServer } from "signalk-wyoming/mock";
import { describeService } from "../src/wyoming.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function startMock(
  options: ConstructorParameters<typeof MockWyomingServer>[0] = {},
): Promise<{ server: MockWyomingServer; port: number }> {
  const server = new MockWyomingServer(options);
  const port = await server.listen();
  cleanups.push(() => server.close());
  return { server, port };
}

/** Raw TCP server for wire-level fault injection; cleans up its sockets. */
async function startRawServer(
  onConnection: (socket: net.Socket) => void,
): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.resume(); // consume client bytes so FIN gets processed
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return (server.address() as net.AddressInfo).port;
}

describe("describeService", () => {
  it("returns parsed info (asr programs) and the protocol version", async () => {
    const { port } = await startMock({ role: "asr" });
    const result = await describeService("127.0.0.1", port);
    expect(Array.isArray(result.info.asr)).toBe(true);
    expect((result.info.asr as unknown[]).length).toBeGreaterThan(0);
    expect(result.version).toMatch(/^1\./);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("skips non-info events and survives byte-by-byte delivery", async () => {
    // Raw TCP server: replies to anything with a pong event followed by an
    // info event, dribbled out in 3-byte slices across many writes.
    const infoData = JSON.stringify({ asr: [{ name: "w" }], tts: [] });
    const reply = Buffer.concat([
      Buffer.from('{"type": "pong"}\n', "utf8"),
      Buffer.from(
        JSON.stringify({
          type: "info",
          version: "1.5.4",
          data_length: Buffer.byteLength(infoData),
        }) + "\n",
        "utf8",
      ),
      Buffer.from(infoData, "utf8"),
    ]);
    const port = await startRawServer((socket) => {
      let offset = 0;
      const timer = setInterval(() => {
        if (offset >= reply.length) {
          clearInterval(timer);
          return;
        }
        socket.write(reply.subarray(offset, offset + 3));
        offset += 3;
      }, 1);
      socket.on("close", () => clearInterval(timer));
    });

    const result = await describeService("127.0.0.1", port, {
      timeoutMs: 3000,
    });
    expect(result.info).toEqual({ asr: [{ name: "w" }], tts: [] });
    expect(result.version).toBe("1.5.4");
  });

  it("times out against a hung service", async () => {
    const { port } = await startMock({ role: "asr", hang: true });
    await expect(
      describeService("127.0.0.1", port, { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out after 100ms/);
  });

  it("rejects when the connection closes before an info event", async () => {
    const { port } = await startMock({ role: "asr", refuseConnections: true });
    await expect(describeService("127.0.0.1", port)).rejects.toThrow();
  });

  it("rejects when nothing listens on the port", async () => {
    // Grab an ephemeral port, then close it so nothing is listening.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    await expect(
      describeService("127.0.0.1", port, { timeoutMs: 500 }),
    ).rejects.toThrow();
  });

  it("treats a malformed header as a failed probe", async () => {
    const port = await startRawServer((socket) => {
      socket.write("this is not json\n");
    });
    await expect(
      describeService("127.0.0.1", port, { timeoutMs: 500 }),
    ).rejects.toThrow();
  });
});
