/**
 * Minimal self-contained Wyoming `describe` client.
 *
 * The production plugin needs exactly one protocol interaction — send a
 * header-only `describe` event and read back one `info` event — so it embeds
 * this tiny client instead of depending on the signalk-wyoming orchestrator
 * package at runtime (which is a devDependency used only by the tests).
 *
 * Wire format (Wyoming 1.x):
 *
 *     <header JSON, one line, UTF-8>\n
 *     <data JSON, exactly data_length bytes>     (only when data_length > 0)
 *     <payload, exactly payload_length bytes>    (only when payload_length > 0)
 *
 * Malformed JSON is a protocol violation and is treated as a failed probe.
 * Non-`info` events before the `info` event are skipped. An inline header
 * `data` object is accepted and merged under the out-of-line data block.
 */

import net from "node:net";

export interface DescribeOptions {
  /** Overall budget for connect + describe + info. Default 5000 ms. */
  timeoutMs?: number;
}

export interface DescribeResult {
  /** Parsed `info` event data (asr/tts/wake program lists etc.). */
  info: Record<string, unknown>;
  /** Protocol version from the info event header, if present. */
  version: string | null;
  /** Round-trip time from connect to a fully-parsed info event. */
  latencyMs: number;
}

interface PendingHeader {
  type: string;
  version: string | null;
  dataLength: number;
  payloadLength: number;
  inlineData: Record<string, unknown> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 0;
}

/** Send `describe` to a Wyoming service and resolve with its `info` reply. */
export function describeService(
  host: string,
  port: number,
  options: DescribeOptions = {},
): Promise<DescribeResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise<DescribeResult>((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let buf = Buffer.alloc(0);
    let header: PendingHeader | null = null;

    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      fail(new Error(`describe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(): void {
      settled = true;
      clearTimeout(timer);
      socket.destroy();
    }

    function fail(err: unknown): void {
      if (settled) return;
      finish();
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    function succeed(info: Record<string, unknown>, version: string | null) {
      if (settled) return;
      finish();
      resolve({ info, version, latencyMs: Date.now() - startedAt });
    }

    // Consume as many complete events as the buffer holds; resolve on `info`.
    function drain(): void {
      for (;;) {
        if (header === null) {
          const nl = buf.indexOf(0x0a);
          if (nl === -1) return;
          const line = buf.subarray(0, nl).toString("utf8");
          buf = buf.subarray(nl + 1);
          const parsed: unknown = JSON.parse(line); // throws → fail via caller
          if (!isRecord(parsed) || typeof parsed.type !== "string") {
            throw new Error("malformed Wyoming header");
          }
          header = {
            type: parsed.type,
            version: typeof parsed.version === "string" ? parsed.version : null,
            dataLength: byteCount(parsed.data_length),
            payloadLength: byteCount(parsed.payload_length),
            inlineData: isRecord(parsed.data) ? parsed.data : undefined,
          };
        }
        // Big info events span many reads — wait for data + payload.
        if (buf.length < header.dataLength + header.payloadLength) return;
        const dataBytes = buf.subarray(0, header.dataLength);
        buf = buf.subarray(header.dataLength + header.payloadLength);
        let data: Record<string, unknown> = header.inlineData ?? {};
        if (header.dataLength > 0) {
          const block: unknown = JSON.parse(dataBytes.toString("utf8"));
          if (!isRecord(block)) throw new Error("malformed Wyoming data");
          data = { ...data, ...block }; // block keys win over inline data
        }
        const { type, version } = header;
        header = null;
        if (type === "info") {
          succeed(data, version);
          return;
        }
        // Ignore anything that is not the info event and keep scanning.
      }
    }

    socket.on("connect", () => {
      socket.write('{"type": "describe", "version": "1.0.0"}\n');
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        drain();
      } catch (err) {
        fail(err);
      }
    });
    socket.on("error", (err) => fail(err));
    socket.on("close", () =>
      fail(new Error("connection closed before an info event arrived")),
    );
  });
}
