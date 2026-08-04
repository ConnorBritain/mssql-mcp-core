import sql from "mssql";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getEnvironmentManager } from "../config/EnvironmentManager.js";
import { enforceQueryColumnPolicy } from "../security/queryColumnPolicy.js";

export class ExplainQueryTool implements Tool {
  [key: string]: any;
  name = "explain_query";
  description = "Generates an estimated execution plan (SHOWPLAN_XML) for a SQL query without executing it.";

  inputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "SQL statement to analyze (typically SELECT/UPDATE/INSERT/DELETE).",
      },
      environment: {
        type: "string",
        description: "Optional environment name to target (prod, staging, etc).",
      },
      includePlanXml: {
        type: "boolean",
        description: "If true (default), returns the raw SHOWPLAN XML. Set false for summary only.",
      },
    },
    required: ["query"],
  } as any;

  async run(params: any) {
    const { query, includePlanXml = true, environment } = params ?? {};

    if (typeof query !== "string" || !query.trim()) {
      return {
        success: false,
        message: "explain_query requires a non-empty SQL string.",
        error: "INVALID_QUERY",
      };
    }

    const sanitizedQuery = query.trim();
    const policyResult = enforceQueryColumnPolicy(sanitizedQuery, params?.environmentPolicy);
    if (!policyResult.allowed) {
      return { success: false, message: `Column policy validation failed: ${policyResult.reason}`, error: "COLUMN_ACCESS_DENIED" };
    }
    const envManager = await getEnvironmentManager();
    const pool = await envManager.getConnection(environment);

    // SHOWPLAN_XML is connection-scoped, so "SET SHOWPLAN_XML ON", the query, and the reset MUST
    // run on the same connection. The previous code used three separate pooled requests, so the
    // pool could send the query to a different connection where SHOWPLAN was off and EXECUTE the
    // caller's SQL for real (a reader-tier arbitrary-execution hole). A transaction pins one
    // connection for all three statements; we also roll it back as defense in depth, so even if a
    // statement did execute, its data changes are undone (SQL Server DDL/DML is transactional).
    const transaction = new sql.Transaction(pool);
    let began = false;
    try {
      await transaction.begin();
      began = true;

      await transaction.request().batch("SET SHOWPLAN_XML ON;");
      const result = await transaction.request().query(sanitizedQuery);
      await transaction.request().batch("SET SHOWPLAN_XML OFF;");

      await transaction.rollback();
      began = false;

      const planXml = this.extractPlanXml(result.recordset?.[0]);
      const summary = {
        success: true,
        message: "Generated estimated execution plan.",
        hasPlanXml: Boolean(planXml),
      };

      return includePlanXml && planXml ? { ...summary, planXml } : summary;
    } catch (error) {
      if (began) {
        try {
          await transaction.rollback();
        } catch {
          // transaction may already be aborted
        }
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Failed to generate plan: ${errorMessage}`,
        error: "SHOWPLAN_FAILED",
      };
    }
  }

  private extractPlanXml(row: any): string | null {
    if (!row) {
      return null;
    }

    const knownColumns = [
      "ShowPlanXML",
      "Microsoft SQL Server 2005 XML Showplan",
      "Plan",
    ];

    for (const column of knownColumns) {
      if (row[column]) {
        return row[column];
      }
    }

    const firstXml = Object.values(row).find((value) =>
      typeof value === "string" && value.trim().startsWith("<?xml")
    );

    return (firstXml as string | undefined) ?? null;
  }
}
