/**
 * Smoke test for audit sinks.
 * Run with: npx tsx test/smoke-sinks.ts
 *
 * Validates core sink behavior without any external services or DB connection.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import * as dgram from "dgram";
import { AuditLogger } from "../src/audit/AuditLogger.js";
import type { AuditLogEntry } from "../src/audit/AuditLogger.js";
import { FileSink } from "../src/audit/sinks/FileSink.js";
import { HttpSink } from "../src/audit/sinks/HttpSink.js";
import { SyslogSink } from "../src/audit/sinks/SyslogSink.js";
import { createAuditSink } from "../src/audit/sinks/AuditSink.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    timestamp: new Date().toISOString(),
    toolName: "smoke_test",
    result: { success: true },
    durationMs: 10,
    ...overrides,
  };
}

// --- Test 1: FileSink ---
async function testFileSink() {
  console.log("\n1. FileSink");

  const filePath = path.join(os.tmpdir(), `smoke-filesink-${Date.now()}.jsonl`);

  try {
    const sink = new FileSink(filePath);
    sink.send(makeEntry({ toolName: "tool_1" }));
    sink.send(makeEntry({ toolName: "tool_2" }));

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");

    assert(lines.length === 2, "Wrote 2 JSON lines");
    assert(JSON.parse(lines[0]).toolName === "tool_1", "First entry correct");
    assert(JSON.parse(lines[1]).toolName === "tool_2", "Second entry correct");
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
}

// --- Test 2: HttpSink ---
async function testHttpSink() {
  console.log("\n2. HttpSink (local server)");

  const receivedBatches: any[][] = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      receivedBatches.push(JSON.parse(body));
      res.writeHead(200);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  try {
    const sink = new HttpSink({
      url: `http://127.0.0.1:${port}/audit`,
      batchSize: 2,
      flushIntervalMs: 60000,
    });

    sink.send(makeEntry({ toolName: "a" }));
    sink.send(makeEntry({ toolName: "b" }));

    // Wait for batch to send
    await new Promise((r) => setTimeout(r, 300));

    assert(receivedBatches.length === 1, "Received 1 batch");
    assert(receivedBatches[0].length === 2, "Batch contains 2 entries");
    assert(receivedBatches[0][0].toolName === "a", "First entry correct");

    // Test flush for remaining
    sink.send(makeEntry({ toolName: "c" }));
    await sink.flush();
    assert(receivedBatches.length === 2, "Flush sent remaining entries");

    await sink.close();
  } finally {
    server.close();
  }
}

// --- Test 3: SyslogSink ---
async function testSyslogSink() {
  console.log("\n3. SyslogSink (local UDP)");

  const received: string[] = [];

  const udpServer = dgram.createSocket("udp4");
  udpServer.on("message", (msg) => received.push(msg.toString("utf-8")));

  await new Promise<void>((resolve) => udpServer.bind(0, "127.0.0.1", () => resolve()));
  const port = (udpServer.address() as any).port;

  try {
    const sink = new SyslogSink({ host: "127.0.0.1", port, protocol: "udp" });

    sink.send(makeEntry({ toolName: "read_data", result: { success: true } }));

    await new Promise((r) => setTimeout(r, 200));

    assert(received.length === 1, "Received 1 syslog message");
    assert(received[0].startsWith("<"), "Starts with PRI field");
    assert(received[0].includes("mssql-mcp"), "Contains appName");
    assert(received[0].includes("read_data"), "Contains tool name");

    // Verify RFC 5424 format parts
    const match = received[0].match(/^<(\d+)>1 /);
    assert(match !== null, "Matches RFC 5424 header format");

    if (match) {
      const pri = parseInt(match[1]);
      const severity = pri % 8;
      assert(severity === 6, "Success uses severity 6 (informational)");
    }

    await sink.close();
  } finally {
    udpServer.close();
  }
}

// --- Test 4: AuditLogger routing ---
async function testAuditLoggerRouting() {
  console.log("\n4. AuditLogger routing (global + per-env)");

  const globalEntries: AuditLogEntry[] = [];
  const prodEntries: AuditLogEntry[] = [];

  const globalSink: any = {
    type: "mock-global",
    send(entry: AuditLogEntry) { globalEntries.push(entry); },
  };

  const prodSink: any = {
    type: "mock-prod",
    send(entry: AuditLogEntry) { prodEntries.push(entry); },
  };

  const logger = new AuditLogger();
  logger.configureSinks([globalSink], new Map([["production", [prodSink]]]));

  logger.log(makeEntry({ environment: "production", toolName: "prod_tool" }));
  logger.log(makeEntry({ environment: "staging", toolName: "stage_tool" }));
  logger.log(makeEntry({ toolName: "no_env" }));

  assert(prodEntries.length === 1, "Production entry routed to prod sink");
  assert(prodEntries[0].toolName === "prod_tool", "Correct entry in prod sink");
  assert(globalEntries.length === 2, "Other entries fall back to global");
  assert(globalEntries[0].toolName === "stage_tool", "Staging goes to global");
  assert(globalEntries[1].toolName === "no_env", "No-env goes to global");
}

// --- Test 5: createAuditSink factory ---
async function testFactory() {
  console.log("\n5. createAuditSink factory");

  const fileSink = createAuditSink({ type: "file" });
  assert(fileSink.type === "file", "Creates FileSink");

  const syslogSink = createAuditSink({ type: "syslog", host: "127.0.0.1" });
  assert(syslogSink.type === "syslog", "Creates SyslogSink");
  await syslogSink.close?.();

  const httpSink = createAuditSink({ type: "http", url: "http://localhost:9999", flushIntervalMs: 60000 });
  assert(httpSink.type === "http", "Creates HttpSink");
  await httpSink.close?.();

  const azureSink = createAuditSink({
    type: "azure-monitor",
    workspaceId: "ws",
    sharedKey: Buffer.from("key").toString("base64"),
    flushIntervalMs: 60000,
  });
  assert(azureSink.type === "azure-monitor", "Creates AzureMonitorSink");
  await azureSink.close?.();

  const cwSink = createAuditSink({ type: "cloudwatch", logGroupName: "/test", flushIntervalMs: 60000 });
  assert(cwSink.type === "cloudwatch", "Creates CloudWatchSink");
  await cwSink.close?.();

  let threw = false;
  try {
    createAuditSink({ type: "invalid" } as any);
  } catch {
    threw = true;
  }
  assert(threw, "Unknown type throws");
}

// --- Test 6: Backward compatibility ---
async function testBackwardCompat() {
  console.log("\n6. Backward compatibility (no configureSinks)");

  const logger = new AuditLogger();
  // Without configureSinks, should fall back to direct file write
  // Should not throw
  try {
    logger.log(makeEntry({ toolName: "legacy_tool" }));
    assert(true, "Legacy file write does not throw");
  } catch (e) {
    assert(false, `Legacy file write threw: ${e}`);
  }
}

// --- Main ---
async function main() {
  console.log("=== Audit Sinks Smoke Test ===");

  await testFileSink();
  await testHttpSink();
  await testSyslogSink();
  await testAuditLoggerRouting();
  await testFactory();
  await testBackwardCompat();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
