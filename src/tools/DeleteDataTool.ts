import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createRequest } from "../transactions/TransactionManager.js";
import { quoteQualified, InvalidIdentifierError } from "../security/sqlIdentifier.js";
import { buildWhereClause, InvalidFilterError, SUPPORTED_OPERATORS } from "../security/whereFilter.js";
import { filterRecordColumns, tableReference, validateColumnNames } from "../security/columnPolicy.js";

export class DeleteDataTool implements Tool {
  [key: string]: any;
  name = "delete_data";
  description =
    "Deletes rows from an MSSQL table with preview and confirmation. Targets rows via structured, parameterized filters (no raw SQL).";

  inputSchema = {
    type: "object",
    properties: {
      tableName: {
        type: "string",
        description: "Name of the table to delete from (optionally schema-qualified, e.g. 'dbo.Orders').",
      },
      filters: {
        type: "array",
        description:
          "Structured WHERE conditions (required, non-empty). Each: { column, operator, value }. Values are bound as parameters. Combined with AND unless matchType is 'any'.",
        items: {
          type: "object",
          properties: {
            column: { type: "string", description: "Column name (validated identifier)." },
            operator: { type: "string", enum: SUPPORTED_OPERATORS, description: "Comparison operator." },
            value: { description: "Value to compare (bound as a parameter). Array for IN; omit for IS NULL / IS NOT NULL." },
          },
          required: ["column", "operator"],
        },
      },
      matchType: {
        type: "string",
        enum: ["all", "any"],
        description: "Combine conditions with AND ('all', default) or OR ('any').",
      },
      confirmDelete: {
        type: "boolean",
        description: "Set to true to confirm and execute the delete after preview. First call without this to see preview.",
      },
      maxRows: {
        type: "number",
        description: "Maximum number of rows allowed to delete. Defaults to 1000 for safety.",
      },
      environment: {
        type: "string",
        description: "Optional environment name to target",
      },
    },
    required: ["tableName", "filters"],
  } as any;

  private static readonly MAX_ROWS_DEFAULT = 1000;

  async run(params: any) {
    let query: string | undefined;
    try {
      const { tableName, filters, matchType, confirmDelete, maxRows } = params;

      // The free-form whereClause was removed (SQL-injection fix). Guide migration.
      if (params.whereClause !== undefined) {
        return {
          success: false,
          message:
            "'whereClause' is no longer supported. Use structured 'filters', e.g. filters: [{ column: 'status', operator: '=', value: 'archived' }].",
          error: "WHERECLAUSE_REMOVED",
        };
      }

      const columnDecision = validateColumnNames(
        params.environmentPolicy,
        tableReference(tableName),
        Array.isArray(filters) ? filters.map((filter: any) => filter.column) : [],
      );
      if (!columnDecision.allowed) {
        return { success: false, message: columnDecision.reason, error: "COLUMN_ACCESS_DENIED" };
      }

      // Validate identifiers and filters up front, before any query executes.
      let table: string;
      const countRequest = createRequest(params);
      let whereBody: string;
      try {
        table = quoteQualified(tableName);
        whereBody = buildWhereClause(countRequest, filters, matchType ?? "all");
      } catch (e) {
        if (e instanceof InvalidIdentifierError || e instanceof InvalidFilterError) {
          return { success: false, message: e.message, error: "INVALID_REQUEST" };
        }
        throw e;
      }

      const maxAllowed = maxRows || DeleteDataTool.MAX_ROWS_DEFAULT;

      // Step 1: Get count of affected rows
      const countQuery = `SELECT COUNT(*) as affectedRows FROM ${table} WHERE ${whereBody}`;
      const countResult = await countRequest.query(countQuery);
      const affectedRows = countResult.recordset[0].affectedRows;

      if (affectedRows === 0) {
        return {
          success: false,
          message: "No rows match the filters. No deletion will be performed.",
          error: "NO_ROWS_MATCHED",
          affectedRows: 0,
        };
      }

      if (affectedRows > maxAllowed) {
        return {
          success: false,
          message: `Delete would affect ${affectedRows} rows, which exceeds the maximum of ${maxAllowed}. Refine your filters or increase maxRows parameter.`,
          error: "TOO_MANY_ROWS",
          affectedRows,
          maxAllowed,
        };
      }

      // Step 2: Show preview if not confirmed
      if (!confirmDelete) {
        const previewRequest = createRequest(params);
        const previewWhere = buildWhereClause(previewRequest, filters, matchType ?? "all");
        const previewQuery = `SELECT TOP 10 * FROM ${table} WHERE ${previewWhere}`;
        const previewResult = await previewRequest.query(previewQuery);

        return {
          success: false,
          needsConfirmation: true,
          message: `⚠️ WARNING: ${affectedRows} row(s) will be permanently deleted. Review the preview below and re-run with confirmDelete: true to proceed.`,
          affectedRows,
          preview: filterRecordColumns(
            params.environmentPolicy,
            tableReference(tableName),
            previewResult.recordset,
          ),
          error: "CONFIRMATION_REQUIRED",
        };
      }

      // Step 3: Execute the delete
      const request = createRequest(params);
      const finalWhere = buildWhereClause(request, filters, matchType ?? "all");
      query = `DELETE FROM ${table} WHERE ${finalWhere}`;
      const result = await request.query(query);

      return {
        success: true,
        message: `Successfully deleted ${result.rowsAffected[0]} row(s) from table '${tableName}'`,
        rowsDeleted: result.rowsAffected[0],
      };
    } catch (error) {
      console.error("Error deleting data:", error);
      return {
        success: false,
        message: `Failed to delete data${query ? ` with '${query}'` : ""}: ${error}`,
        error: "DELETE_FAILED",
      };
    }
  }
}
