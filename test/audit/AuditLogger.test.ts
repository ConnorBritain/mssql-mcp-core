import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { AuditLogger } from "../../src/audit/AuditLogger.js";
import type { AuditLogEntry } from "../../src/audit/AuditLogger.js";
import type { AuditSink } from "../../src/audit/sinks/AuditSink.js";

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    timestamp: new Date().toISOString(),
    toolName: "test_tool",
    result: { success: true },
    durationMs: 42,
    ...overrides,
  };
}

function createMockSink(name = "mock"): AuditSink & { entries: AuditLogEntry[]; flushed: boolean; closed: boolean } {
  const entries: AuditLogEntry[] = [];
  return {
    type: name,
    entries,
    flushed: false,
    closed: false,
    send(entry: AuditLogEntry) { entries.push(entry); },
    async flush() { (this as any).flushed = true; },
    async close() { (this as any).closed = true; },
  };
}

describe("AuditLogger", () => {
  let logger: AuditLogger;

  beforeEach(() => {
    // Create fresh logger with audit enabled
    const origEnv = process.env.AUDIT_LOGGING;
    process.env.AUDIT_LOGGING = "true";
    logger = new AuditLogger();
    if (origEnv === undefined) {
      delete process.env.AUDIT_LOGGING;
    } else {
      process.env.AUDIT_LOGGING = origEnv;
    }
  });

  describe("configureSinks", () => {
    it("routes entries to global sinks", () => {
      const globalSink = createMockSink("global");
      logger.configureSinks([globalSink], new Map());

      logger.log(makeEntry({ toolName: "read_data" }));

      expect(globalSink.entries).toHaveLength(1);
      expect(globalSink.entries[0].toolName).toBe("read_data");
    });

    it("routes entries to environment-specific sinks", () => {
      const globalSink = createMockSink("global");
      const prodSink = createMockSink("prod");
      const perEnv = new Map([["production", [prodSink]]]);

      logger.configureSinks([globalSink], perEnv);

      logger.log(makeEntry({ environment: "production" }));
      logger.log(makeEntry({ environment: "staging" }));

      // production entry goes to prod sink only
      expect(prodSink.entries).toHaveLength(1);
      expect(prodSink.entries[0].environment).toBe("production");

      // staging falls back to global
      expect(globalSink.entries).toHaveLength(1);
      expect(globalSink.entries[0].environment).toBe("staging");
    });

    it("entries without environment go to global sinks", () => {
      const globalSink = createMockSink();
      logger.configureSinks([globalSink], new Map());

      logger.log(makeEntry());

      expect(globalSink.entries).toHaveLength(1);
    });
  });

  describe("logToolInvocation", () => {
    it("skips logging at 'none' level", () => {
      const sink = createMockSink();
      logger.configureSinks([sink], new Map());

      logger.logToolInvocation("tool", {}, { success: true }, 100, {
        auditLevel: "none",
      });

      expect(sink.entries).toHaveLength(0);
    });

    it("logs minimal info at 'basic' level", () => {
      const sink = createMockSink();
      logger.configureSinks([sink], new Map());

      logger.logToolInvocation("read_data", { query: "SELECT 1" }, { success: true, recordCount: 5 }, 150, {
        auditLevel: "basic",
        sessionId: "sess-1",
        environment: "dev",
      });

      expect(sink.entries).toHaveLength(1);
      const entry = sink.entries[0];
      expect(entry.toolName).toBe("read_data");
      expect(entry.arguments).toBeUndefined(); // basic: no arguments
      expect(entry.result?.success).toBe(true);
      expect(entry.result?.recordCount).toBe(5);
      expect(entry.durationMs).toBe(150);
      expect(entry.sessionId).toBe("sess-1");
    });

    it("logs full details at 'verbose' level", () => {
      const sink = createMockSink();
      logger.configureSinks([sink], new Map());

      logger.logToolInvocation(
        "read_data",
        { query: "SELECT * FROM users" },
        { success: true, data: [{ id: 1 }] },
        200,
        { auditLevel: "verbose" },
      );

      expect(sink.entries).toHaveLength(1);
      const entry = sink.entries[0];
      expect(entry.arguments).toBeDefined();
      expect(entry.result?.data).toBeDefined();
    });
  });

  describe("redaction", () => {
    it("redacts sensitive argument keys", () => {
      const sink = createMockSink();
      logger.configureSinks([sink], new Map());

      logger.logToolInvocation(
        "test",
        { query: "SELECT 1", password: "secret123", apiKey: "abc" },
        { success: true },
        100,
        { auditLevel: "verbose" },
      );

      const args = sink.entries[0].arguments!;
      expect(args.query).toBe("SELECT 1");
      expect(args.password).toBe("[REDACTED]");
      expect(args.apiKey).toBe("[REDACTED]");
    });

    it("strips pool and environmentPolicy from arguments", () => {
      const sink = createMockSink();
      logger.configureSinks([sink], new Map());

      logger.logToolInvocation(
        "test",
        { query: "SELECT 1", pool: { connected: true }, environmentPolicy: { name: "dev" } },
        { success: true },
        50,
        { auditLevel: "verbose" },
      );

      const args = sink.entries[0].arguments!;
      expect(args.pool).toBeUndefined();
      expect(args.environmentPolicy).toBeUndefined();
      expect(args.query).toBe("SELECT 1");
    });
  });

  describe("flush and close", () => {
    it("flush delegates to all configured sinks", async () => {
      const sink1 = createMockSink("s1");
      const sink2 = createMockSink("s2");
      logger.configureSinks([sink1, sink2], new Map());

      await logger.flush();

      expect(sink1.flushed).toBe(true);
      expect(sink2.flushed).toBe(true);
    });

    it("close delegates to all configured sinks", async () => {
      const sink1 = createMockSink("s1");
      const sink2 = createMockSink("s2");
      logger.configureSinks([sink1, sink2], new Map());

      await logger.close();

      expect(sink1.closed).toBe(true);
      expect(sink2.closed).toBe(true);
    });

    it("deduplicates sinks across global and env configs", async () => {
      const sharedSink = createMockSink();
      let flushCount = 0;
      sharedSink.flush = async () => { flushCount++; };

      const perEnv = new Map([["prod", [sharedSink]]]);
      logger.configureSinks([sharedSink], perEnv);

      await logger.flush();

      // Should only flush once despite appearing in both global and env
      expect(flushCount).toBe(1);
    });
  });

  describe("backward compatibility", () => {
    it("works without configureSinks (legacy file write)", () => {
      // Logger without configureSinks should not throw when logging
      const freshLogger = new AuditLogger();
      // This should not throw
      freshLogger.log(makeEntry());
    });
  });
});
