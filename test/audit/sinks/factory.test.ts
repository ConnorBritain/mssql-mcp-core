import { describe, it, expect } from "vitest";
import { createAuditSink } from "../../../src/audit/sinks/AuditSink.js";
import { FileSink } from "../../../src/audit/sinks/FileSink.js";
import { SyslogSink } from "../../../src/audit/sinks/SyslogSink.js";
import { HttpSink } from "../../../src/audit/sinks/HttpSink.js";
import { AzureMonitorSink } from "../../../src/audit/sinks/AzureMonitorSink.js";
import { CloudWatchSink } from "../../../src/audit/sinks/CloudWatchSink.js";

describe("createAuditSink", () => {
  it("creates FileSink for type 'file'", () => {
    const sink = createAuditSink({ type: "file" });
    expect(sink).toBeInstanceOf(FileSink);
    expect(sink.type).toBe("file");
  });

  it("creates SyslogSink for type 'syslog'", async () => {
    const sink = createAuditSink({ type: "syslog", host: "127.0.0.1" });
    expect(sink).toBeInstanceOf(SyslogSink);
    expect(sink.type).toBe("syslog");
    await sink.close?.();
  });

  it("creates HttpSink for type 'http'", async () => {
    const sink = createAuditSink({ type: "http", url: "http://localhost:9999", flushIntervalMs: 60000 });
    expect(sink).toBeInstanceOf(HttpSink);
    expect(sink.type).toBe("http");
    await sink.close?.();
  });

  it("creates AzureMonitorSink for type 'azure-monitor'", async () => {
    const sink = createAuditSink({
      type: "azure-monitor",
      workspaceId: "ws",
      sharedKey: Buffer.from("key").toString("base64"),
      flushIntervalMs: 60000,
    });
    expect(sink).toBeInstanceOf(AzureMonitorSink);
    expect(sink.type).toBe("azure-monitor");
    await sink.close?.();
  });

  it("creates CloudWatchSink for type 'cloudwatch'", async () => {
    const sink = createAuditSink({
      type: "cloudwatch",
      logGroupName: "/test",
      flushIntervalMs: 60000,
    });
    expect(sink).toBeInstanceOf(CloudWatchSink);
    expect(sink.type).toBe("cloudwatch");
    await sink.close?.();
  });

  it("throws for unknown type", () => {
    expect(() => createAuditSink({ type: "unknown" } as any)).toThrow(
      "Unknown audit sink type: unknown"
    );
  });
});
