import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createRequest } from "../transactions/TransactionManager.js";
import { quoteName, quoteQualified, InvalidIdentifierError } from "../security/sqlIdentifier.js";
import { buildWhereClause, InvalidFilterError, SUPPORTED_OPERATORS } from "../security/whereFilter.js";
import { filterRecordColumns, tableReference, validateColumnNames } from "../security/columnPolicy.js";

export class UpdateDataTool implements Tool {
  [key: string]: any;
  name = "update_data";
  description =
    "Updates rows in an MSSQL table with preview and confirmation. Targets rows via structured, parameterized filters (no raw SQL).";
  inputSchema = {
    type: "object",
    properties: {
      tableName: {
        type: "string",
        description: "Name of the table to update (optionally schema-qualified, e.g. 'dbo.Orders').",
      },
      updates: {
        type: "object",
        description: "Key-value pairs of columns to update. Example: { 'status': 'active', 'last_updated': '2025-01-01' }",
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
      confirmUpdate: {
        type: "boolean",
        description: "Set to true to confirm and execute the update after preview. First call without this to see preview.",
      },
      maxRows: {
        type: "number",
        description: "Maximum number of rows allowed to update. Defaults to 1000 for safety.",
      },
      environment: {
        type: "string",
        description: "Optional environment name to target",
      },
    },
    required: ["tableName", "updates", "filters"],
  } as any;

  private static readonly MAX_ROWS_DEFAULT = 1000;

  async run(params: any) {
    let query: string | undefined;
    try {
      const { tableName, updates, filters, matchType, confirmUpdate, maxRows } = params;

      // The free-form whereClause was removed (SQL-injection fix). Guide migration.
      if (params.whereClause !== undefined) {
        return {
          success: false,
          message:
            "'whereClause' is no longer supported. Use structured 'filters', e.g. filters: [{ column: 'status', operator: '=', value: 'archived' }].",
          error: "WHERECLAUSE_REMOVED",
        };
      }

      if (!updates || typeof updates !== "object" || Array.isArray(updates) || Object.keys(updates).length === 0) {
        return {
          success: false,
          message: "'updates' must be a non-empty object of column/value pairs.",
          error: "MISSING_UPDATES",
        };
      }

      const policyColumns = [
        ...Object.keys(updates),
        ...(Array.isArray(filters) ? filters.map((filter: any) => filter.column) : []),
      ];
      const columnDecision = validateColumnNames(
        params.environmentPolicy,
        tableReference(tableName),
        policyColumns,
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
        Object.keys(updates).forEach((key) => quoteName(key)); // reject malicious column names
        whereBody = buildWhereClause(countRequest, filters, matchType ?? "all");
      } catch (e) {
        if (e instanceof InvalidIdentifierError || e instanceof InvalidFilterError) {
          return { success: false, message: e.message, error: "INVALID_REQUEST" };
        }
        throw e;
      }

      const maxAllowed = maxRows || UpdateDataTool.MAX_ROWS_DEFAULT;

      // Step 1: Get count of affected rows
      const countQuery = `SELECT COUNT(*) as affectedRows FROM ${table} WHERE ${whereBody}`;
      const countResult = await countRequest.query(countQuery);
      const affectedRows = countResult.recordset[0].affectedRows;

      if (affectedRows === 0) {
        return {
          success: false,
          message: "No rows match the filters. No update will be performed.",
          error: "NO_ROWS_MATCHED",
          affectedRows: 0,
        };
      }

      if (affectedRows > maxAllowed) {
        return {
          success: false,
          message: `Update would affect ${affectedRows} rows, which exceeds the maximum of ${maxAllowed}. Refine your filters or increase maxRows parameter.`,
          error: "TOO_MANY_ROWS",
          affectedRows,
          maxAllowed,
        };
      }

      // Step 2: Show preview if not confirmed
      if (!confirmUpdate) {
        const previewRequest = createRequest(params);
        const previewWhere = buildWhereClause(previewRequest, filters, matchType ?? "all");
        const previewQuery = `SELECT TOP 10 * FROM ${table} WHERE ${previewWhere}`;
        const previewResult = await previewRequest.query(previewQuery);

        return {
          success: false,
          needsConfirmation: true,
          message: `Preview: ${affectedRows} row(s) will be updated. Review the preview below and re-run with confirmUpdate: true to proceed.`,
          affectedRows,
          preview: filterRecordColumns(
            params.environmentPolicy,
            tableReference(tableName),
            previewResult.recordset,
          ),
          updates,
          error: "CONFIRMATION_REQUIRED",
        };
      }

      // Step 3: Execute the update
      const request = createRequest(params);

      // Build SET clause: values are bound parameters, column names are quoted identifiers.
      const setClause = Object.keys(updates)
        .map((key, index) => {
          const paramName = `update_${index}`;
          request.input(paramName, updates[key]);
          return `${quoteName(key)} = @${paramName}`;
        })
        .join(", ");

      const finalWhere = buildWhereClause(request, filters, matchType ?? "all");
      query = `UPDATE ${table} SET ${setClause} WHERE ${finalWhere}`;
      const result = await request.query(query);

      return {
        success: true,
        message: `Successfully updated ${result.rowsAffected[0]} row(s) in table '${tableName}'`,
        rowsAffected: result.rowsAffected[0],
        updates,
      };
    } catch (error) {
      console.error("Error updating data:", error);
      return {
        success: false,
        message: `Failed to update data${query ? ` with '${query}'` : ""}: ${error}`,
        error: "UPDATE_FAILED",
      };
    }
  }
}
