import { describe, it, expect, afterEach } from "vitest";
import * as dgram from "dgram";
import { SyslogSink } from "../../../src/audit/sinks/SyslogSink.js";
import type { AuditLogEntry } from "../../../src/audit/AuditLogger.js";

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    timestamp: "2026-01-15T12:00:00.000Z",
    toolName: "test_tool",
    result: { success: true },
    durationMs: 42,
    ...overrides,
  };
}

describe("SyslogSink", () => {
  let server: dgram.Socket | null = null;
  let sink: SyslogSink | null = null;

  afterEach(async () => {
    if (sink) {
      await sink.close();
      sink = null;
    }
    if (server) {
      server.close();
      server = null;
    }
  });

  it("sends RFC 5424 messages via UDP", async () => {
    const received: string[] = [];

    await new Promise<void>((resolve) => {
      server = dgram.createSocket("udp4");
      server.on("message", (msg) => {
        received.push(msg.toString("utf-8"));
      });
      server.bind(0, "127.0.0.1", () => resolve());
    });

    const port = (server!.address() as any).port;
    sink = new SyslogSink({ host: "127.0.0.1", port, protocol: "udp" });

    const entry = makeEntry({ toolName: "read_data" });
    sink.send(entry);

    // Give UDP time to deliver
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toHaveLength(1);
    const msg = received[0];

    // RFC 5424: <PRI>1 TIMESTAMP HOSTNAME APP PID MSGID - MSG
    expect(msg).toMatch(/^<\d+>1 /);
    expect(msg).toContain("mssql-mcp");
    expect(msg).toContain("read_data");

    // Should contain the JSON entry
    const jsonPart = msg.substring(msg.indexOf(" - ") + 3);
    const parsed = JSON.parse(jsonPart);
    expect(parsed.toolName).toBe("read_data");
  });

  it("uses severity 6 (informational) for success", async () => {
    const received: string[] = [];

    await new Promise<void>((resolve) => {
      server = dgram.createSocket("udp4");
      server.on("message", (msg) => received.push(msg.toString("utf-8")));
      server.bind(0, "127.0.0.1", () => resolve());
    });

    const port = (server!.address() as any).port;
    sink = new SyslogSink({ host: "127.0.0.1", port, facility: 16 });

    sink.send(makeEntry({ result: { success: true } }));
    await new Promise((r) => setTimeout(r, 200));

    // PRI = facility * 8 + severity = 16 * 8 + 6 = 134
    expect(received[0]).toMatch(/^<134>/);
  });

  it("uses severity 4 (warning) for failure", async () => {
    const received: string[] = [];

    await new Promise<void>((resolve) => {
      server = dgram.createSocket("udp4");
      server.on("message", (msg) => received.push(msg.toString("utf-8")));
      server.bind(0, "127.0.0.1", () => resolve());
    });

    const port = (server!.address() as any).port;
    sink = new SyslogSink({ host: "127.0.0.1", port, facility: 16 });

    sink.send(makeEntry({ result: { success: false, error: "timeout" } }));
    await new Promise((r) => setTimeout(r, 200));

    // PRI = 16 * 8 + 4 = 132
    expect(received[0]).toMatch(/^<132>/);
  });

  it("has type 'syslog'", () => {
    sink = new SyslogSink({ host: "127.0.0.1" });
    expect(sink.type).toBe("syslog");
  });

  it("cleans up socket on close", async () => {
    sink = new SyslogSink({ host: "127.0.0.1", protocol: "udp" });
    await sink.close();

    // Sending after close should not throw
    sink.send(makeEntry());
    sink = null; // prevent double-close in afterEach
  });
});
