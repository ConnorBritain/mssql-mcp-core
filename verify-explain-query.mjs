// Live verification for the explain_query SHOWPLAN fix (0.6.1).
//
// Confirms the ONE thing a mock cannot: that `SET SHOWPLAN_XML ON` inside the pinned transaction
// actually SUPPRESSES execution on a real SQL Server (and leaves no SHOWPLAN leak on the pool).
//
// PREREQUISITES:
//   1. Build the fix first:  npm run build   (dist/ must contain the patched ExplainQueryTool)
//   2. Point it at a TEST database where the login may CREATE and DROP a table.
//
// RUN (from the mssql-mcp-core directory):
//   Single-env via env vars (same ones the reader uses):
//     SERVER_NAME=... DATABASE_NAME=... SQL_AUTH_MODE=sql SQL_USERNAME=... SQL_PASSWORD=... \
//       node verify-explain-query.mjs
//   Or a multi-env config:
//     ENVIRONMENTS_CONFIG_PATH=./environments.json VERIFY_ENVIRONMENT=test \
//       node verify-explain-query.mjs
//
// Exit code 0 = all checks passed (safe to publish 0.6.1). Non-zero = do NOT publish.

import sql from "mssql";
import { ExplainQueryTool, getEnvironmentManager } from "./dist/index.js";

const env = process.env.VERIFY_ENVIRONMENT || undefined;
const PROBE = `ExplainProbe_${process.pid}`;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const mgr = await getEnvironmentManager();
  const pool = await mgr.getConnection(env);
  const exec = (q) => new sql.Request(pool).batch(q);
  const count = async () => (await new sql.Request(pool).query(`SELECT COUNT(*) AS n FROM ${PROBE}`)).recordset[0].n;

  const tool = new ExplainQueryTool();

  try {
    await exec(`IF OBJECT_ID('${PROBE}', 'U') IS NOT NULL DROP TABLE ${PROBE};`);
    await exec(`CREATE TABLE ${PROBE} (id INT);`);
    console.log(`\nProbe table ${PROBE} created. Running checks:\n`);

    // 1. Explain an INSERT. It must return a plan AND must not actually insert the row.
    const insertRes = await tool.run({ query: `INSERT INTO ${PROBE} (id) VALUES (1)`, environment: env });
    check("explain(INSERT) succeeds", insertRes.success === true, insertRes.error ?? insertRes.message ?? "");
    check("explain(INSERT) returns a plan", insertRes.hasPlanXml === true);
    check("INSERT did NOT execute (row count is 0)", (await count()) === 0, `count=${await count()}`);

    // 2. Explain a SELECT. It must return a plan.
    const selRes = await tool.run({ query: `SELECT * FROM ${PROBE}`, environment: env });
    check("explain(SELECT) returns a plan", selRes.success === true && selRes.hasPlanXml === true);

    // 3. No SHOWPLAN leak: a normal write after the explains must actually execute.
    await exec(`INSERT INTO ${PROBE} (id) VALUES (42);`);
    check("normal write after explain executes for real (no SHOWPLAN leak)", (await count()) === 1, `count=${await count()}`);

    console.log(
      failures === 0
        ? "\nALL CHECKS PASSED. SHOWPLAN suppresses execution and the connection is clean. Safe to ship 0.6.1.\n"
        : `\n${failures} CHECK(S) FAILED. Do NOT publish 0.6.1. SHOWPLAN-in-transaction needs rework (fall back to a dedicated connection).\n`,
    );
  } finally {
    try { await exec(`IF OBJECT_ID('${PROBE}', 'U') IS NOT NULL DROP TABLE ${PROBE};`); } catch { /* best effort */ }
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nVERIFY ERROR:", e?.message ?? e);
  process.exit(2);
});
