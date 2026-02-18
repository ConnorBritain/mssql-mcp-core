import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FileSink } from "../../../src/audit/sinks/FileSink.js";
import type { AuditLogEntry } from "../../../src/audit/AuditLogger.js";

function makeTempPath(): string {
  return path.join(os.tmpdir(), `filesink-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    timestamp: new Date().toISOString(),
    toolName: "test_tool",
    result: { success: true },
    durationMs: 42,
    ...overrides,
  };
}

describe("FileSink", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(p)); } catch { /* ignore */ }
    }
    cleanupPaths.length = 0;
  });

  it("writes entries as JSON lines", () => {
    const filePath = makeTempPath();
    cleanupPaths.push(filePath);

    const sink = new FileSink(filePath);
    const entry1 = makeEntry({ toolName: "tool_a" });
    const entry2 = makeEntry({ toolName: "tool_b" });

    sink.send(entry1);
    sink.send(entry2);

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).toolName).toBe("tool_a");
    expect(JSON.parse(lines[1]).toolName).toBe("tool_b");
  });

  it("auto-creates directory if missing", () => {
    const dir = path.join(os.tmpdir(), `filesink-nested-${Date.now()}`);
    const filePath = path.join(dir, "sub", "audit.jsonl");
    cleanupPaths.push(filePath);

    const sink = new FileSink(filePath);
    sink.send(makeEntry());

    expect(fs.existsSync(filePath)).toBe(true);

    // Cleanup nested dirs
    try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
  });

  it("has type 'file'", () => {
    const filePath = makeTempPath();
    cleanupPaths.push(filePath);
    const sink = new FileSink(filePath);
    expect(sink.type).toBe("file");
  });

  it("uses default path when no path provided", () => {
    // Just verify construction doesn't throw
    const sink = new FileSink();
    expect(sink.type).toBe("file");
  });
});
