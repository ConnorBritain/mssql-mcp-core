import { describe, it, expect, beforeEach, vi } from "vitest";

// Fake mssql Transaction that records the exact sequence of statements and transaction control,
// so we can assert explain_query pins one connection and rolls it back.
const h = vi.hoisted(() => {
  const state = {
    calls: [] as string[],
    throwOnQuery: false,
    recordset: [{ ShowPlanXML: "<?xml version='1.0'?><ShowPlanXML/>" }] as any[],
  };
  class FakeRequest {
    async batch(sqlText: string) {
      state.calls.push("batch:" + sqlText.trim());
      return {};
    }
    async query(sqlText: string) {
      state.calls.push("query:" + sqlText.trim());
      if (state.throwOnQuery) throw new Error("boom");
      return { recordset: state.recordset };
    }
  }
  class FakeTransaction {
    constructor(_pool: unknown) {}
    async begin() {
      state.calls.push("begin");
    }
    async commit() {
      state.calls.push("commit");
    }
    async rollback() {
      state.calls.push("rollback");
    }
    request() {
      return new FakeRequest();
    }
  }
  return { state, FakeTransaction };
});

vi.mock("mssql", () => ({ default: { Transaction: h.FakeTransaction } }));
vi.mock("../../src/config/EnvironmentManager.js", () => ({
  getEnvironmentManager: async () => ({ getConnection: async () => ({}) }),
}));

import { ExplainQueryTool } from "../../src/tools/ExplainQueryTool.js";

beforeEach(() => {
  h.state.calls.length = 0;
  h.state.throwOnQuery = false;
});

// WHY: the pre-fix explain_query ran "SET SHOWPLAN_XML ON", the caller's query, and the reset on
// three SEPARATE pooled requests. SHOWPLAN_XML is connection-scoped, so the query could land on a
// different connection with SHOWPLAN off and EXECUTE for real - a reader-tier arbitrary-execution
// hole. This locks that all three run inside ONE transaction (one connection) and that the
// transaction is rolled back, so a caller's write query cannot execute-and-persist via explain_query.
describe("explain_query - SHOWPLAN runs on one pinned, rolled-back connection", () => {
  it("issues SET ON, the query, SET OFF, then rollback, all in a single transaction", async () => {
    const res = await new ExplainQueryTool().run({ query: "UPDATE Orders SET x = 1" });
    expect(res.success).toBe(true);
    expect(h.state.calls).toEqual([
      "begin",
      "batch:SET SHOWPLAN_XML ON;",
      "query:UPDATE Orders SET x = 1",
      "batch:SET SHOWPLAN_XML OFF;",
      "rollback",
    ]);
  });

  it("rolls back (never commits) even when the query throws", async () => {
    h.state.throwOnQuery = true;
    const res = await new ExplainQueryTool().run({ query: "SELECT 1" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("SHOWPLAN_FAILED");
    expect(h.state.calls).toContain("rollback");
    expect(h.state.calls).not.toContain("commit");
  });

  it("rejects an empty query before opening any transaction", async () => {
    const res = await new ExplainQueryTool().run({ query: "   " });
    expect(res.success).toBe(false);
    expect(res.error).toBe("INVALID_QUERY");
    expect(h.state.calls).toEqual([]);
  });
});
