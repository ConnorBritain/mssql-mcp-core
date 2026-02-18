import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { AzureMonitorSink } from "../../../src/audit/sinks/AzureMonitorSink.js";
import type { AuditLogEntry } from "../../../src/audit/AuditLogger.js";

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    timestamp: new Date().toISOString(),
    toolName: "test_tool",
    result: { success: true },
    durationMs: 42,
    ...overrides,
  };
}

describe("AzureMonitorSink", () => {
  let sink: AzureMonitorSink | null = null;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; init: RequestInit }[] = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      fetchCalls.push({ url: url.toString(), init });
      return new Response("", { status: 200 });
    }) as any;
  });

  afterEach(async () => {
    if (sink) {
      // Prevent flush during close from making extra calls
      globalThis.fetch = originalFetch;
      await sink.close();
      sink = null;
    } else {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends batched entries to correct Azure endpoint", async () => {
    sink = new AzureMonitorSink({
      workspaceId: "test-workspace-id",
      sharedKey: Buffer.from("test-key-123").toString("base64"),
      batchSize: 2,
      flushIntervalMs: 60000,
    });

    sink.send(makeEntry({ toolName: "a" }));
    sink.send(makeEntry({ toolName: "b" }));

    // Wait for async flush triggered by batchSize
    await new Promise((r) => setTimeout(r, 100));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(
      "https://test-workspace-id.ods.opinsights.azure.com/api/logs?api-version=2016-04-01"
    );
  });

  it("includes correct headers", async () => {
    sink = new AzureMonitorSink({
      workspaceId: "ws-id",
      sharedKey: Buffer.from("key").toString("base64"),
      logType: "CustomLogType",
      batchSize: 1,
      flushIntervalMs: 60000,
    });

    sink.send(makeEntry());
    await new Promise((r) => setTimeout(r, 100));

    expect(fetchCalls).toHaveLength(1);
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Log-Type"]).toBe("CustomLogType");
    expect(headers["x-ms-date"]).toBeDefined();
    expect(headers["Authorization"]).toMatch(/^SharedKey ws-id:/);
  });

  it("constructs HMAC-SHA256 signature", async () => {
    sink = new AzureMonitorSink({
      workspaceId: "ws-id",
      sharedKey: Buffer.from("secret-key").toString("base64"),
      batchSize: 1,
      flushIntervalMs: 60000,
    });

    sink.send(makeEntry());
    await new Promise((r) => setTimeout(r, 100));

    const headers = fetchCalls[0].init.headers as Record<string, string>;
    const auth = headers["Authorization"];

    // Should be: SharedKey ws-id:<base64-hmac>
    expect(auth).toMatch(/^SharedKey ws-id:[A-Za-z0-9+/]+=*$/);
  });

  it("has type 'azure-monitor'", () => {
    sink = new AzureMonitorSink({
      workspaceId: "ws",
      sharedKey: Buffer.from("k").toString("base64"),
      flushIntervalMs: 60000,
    });
    expect(sink.type).toBe("azure-monitor");
  });

  it("defaults logType to MSSQLMCPAudit", async () => {
    sink = new AzureMonitorSink({
      workspaceId: "ws",
      sharedKey: Buffer.from("k").toString("base64"),
      batchSize: 1,
      flushIntervalMs: 60000,
    });

    sink.send(makeEntry());
    await new Promise((r) => setTimeout(r, 100));

    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["Log-Type"]).toBe("MSSQLMCPAudit");
  });
});
