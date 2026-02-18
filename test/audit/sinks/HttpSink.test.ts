import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "http";
import { HttpSink } from "../../../src/audit/sinks/HttpSink.js";
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

function createTestServer(): Promise<{ server: http.Server; port: number; requests: { method: string; body: any }[] }> {
  return new Promise((resolve) => {
    const requests: { method: string; body: any }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        requests.push({ method: req.method!, body: JSON.parse(body) });
        res.writeHead(200);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, port, requests });
    });
  });
}

describe("HttpSink", () => {
  let testServer: { server: http.Server; port: number; requests: any[] } | null = null;
  let sink: HttpSink | null = null;

  afterEach(async () => {
    if (sink) {
      await sink.close();
      sink = null;
    }
    if (testServer) {
      testServer.server.close();
      testServer = null;
    }
  });

  it("batches entries and sends when batchSize reached", async () => {
    testServer = await createTestServer();

    sink = new HttpSink({
      url: `http://127.0.0.1:${testServer.port}/audit`,
      batchSize: 3,
      flushIntervalMs: 60000, // high interval so only batch triggers
    });

    // Send 3 entries to trigger batch
    sink.send(makeEntry({ toolName: "a" }));
    sink.send(makeEntry({ toolName: "b" }));
    sink.send(makeEntry({ toolName: "c" }));

    // Wait for async flush
    await new Promise((r) => setTimeout(r, 300));

    expect(testServer.requests).toHaveLength(1);
    expect(testServer.requests[0].body).toHaveLength(3);
    expect(testServer.requests[0].body[0].toolName).toBe("a");
  });

  it("flush() sends remaining buffered entries", async () => {
    testServer = await createTestServer();

    sink = new HttpSink({
      url: `http://127.0.0.1:${testServer.port}/audit`,
      batchSize: 100,
      flushIntervalMs: 60000,
    });

    sink.send(makeEntry({ toolName: "x" }));
    sink.send(makeEntry({ toolName: "y" }));

    await sink.flush();

    expect(testServer.requests).toHaveLength(1);
    expect(testServer.requests[0].body).toHaveLength(2);
  });

  it("retries once on failure then drops", async () => {
    let callCount = 0;
    const server = http.createServer((_req, res) => {
      let body = "";
      _req.on("data", (c) => { body += c; });
      _req.on("end", () => {
        callCount++;
        res.writeHead(500);
        res.end("error");
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as any).port;

    sink = new HttpSink({
      url: `http://127.0.0.1:${port}/audit`,
      batchSize: 100,
      flushIntervalMs: 60000,
    });

    sink.send(makeEntry());

    // Suppress stderr during retry
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as any;
    await sink.flush();
    process.stderr.write = origWrite;

    // First attempt + 1 retry = 2 calls
    expect(callCount).toBe(2);

    server.close();
  });

  it("close() flushes remaining entries and clears timer", async () => {
    testServer = await createTestServer();

    sink = new HttpSink({
      url: `http://127.0.0.1:${testServer.port}/audit`,
      batchSize: 100,
      flushIntervalMs: 60000,
    });

    sink.send(makeEntry({ toolName: "final" }));
    await sink.close();
    sink = null; // prevent double close

    expect(testServer.requests).toHaveLength(1);
    expect(testServer.requests[0].body[0].toolName).toBe("final");
  });

  it("has type 'http'", async () => {
    testServer = await createTestServer();
    sink = new HttpSink({
      url: `http://127.0.0.1:${testServer.port}/audit`,
      flushIntervalMs: 60000,
    });
    expect(sink.type).toBe("http");
  });
});
