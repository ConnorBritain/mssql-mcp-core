import sql from "mssql";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { quoteName, quoteQualified, InvalidIdentifierError } from "../security/sqlIdentifier.js";
import { tableReference, validateColumnNames } from "../security/columnPolicy.js";
import {
  buildWhereClause,
  InvalidFilterError,
  SUPPORTED_OPERATORS,
  type FilterCondition,
  type MatchType,
} from "../security/whereFilter.js";

/** A Request-shaped sink that discards bindings — lets validation run filters before a transaction opens. */
const NOOP_BINDABLE = { input: (_name: string, _value: unknown) => undefined } as unknown as Parameters<
  typeof buildWhereClause
>[0];

interface TransactionOperation {
  type: "insert" | "update" | "delete";
  tableName: string;
  /** Required for insert */
  data?: Record<string, any> | Record<string, any>[];
  /** Required for update */
  updates?: Record<string, any>;
  /** Required for update and delete: structured, parameterized filters */
  filters?: FilterCondition[];
  /** Combine filters with AND ('all', default) or OR ('any') */
  matchType?: MatchType;
}

export class ExecuteTransactionTool implements Tool {
  [key: string]: any;
  name = "execute_transaction";
  description =
    "Executes multiple write operations (insert, update, delete) as a single atomic transaction. All operations succeed or all are rolled back.";
  inputSchema = {
    type: "object",
    properties: {
      environment: {
        type: "string",
        description: "Optional environment name to target.",
      },
      operations: {
        type: "array",
        description:
          "Array of operations to execute atomically. Each must have a 'type' (insert/update/delete), 'tableName', and type-specific fields.",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["insert", "update", "delete"],
              description: "The operation type.",
            },
            tableName: {
              type: "string",
              description: "Target table name.",
            },
            data: {
              oneOf: [{ type: "object" }, { type: "array", items: { type: "object" } }],
              description: "Data for insert operations.",
            },
            updates: {
              type: "object",
              description: "Key-value pairs for update operations.",
            },
            filters: {
              type: "array",
              description:
                "Structured WHERE conditions for update/delete (required, non-empty). Each: { column, operator, value }. Values are bound as parameters.",
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
              description: "Combine filters with AND ('all', default) or OR ('any').",
            },
          },
          required: ["type", "tableName"],
        },
      },
    },
    required: ["operations"],
  } as any;

  async run(params: any) {
    const { pool, operations, environment } = params;

    if (!operations || !Array.isArray(operations) || operations.length === 0) {
      return {
        success: false,
        message: "No operations provided.",
        error: "NO_OPERATIONS",
      };
    }

    // Validate all operations before starting transaction
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i] as TransactionOperation;
      const validation = this.validateOperation(op, i, params.environmentPolicy);
      if (validation) return validation;
    }

    const transaction = new sql.Transaction(pool);
    const results: any[] = [];

    try {
      await transaction.begin();

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i] as TransactionOperation;
        const result = await this.executeOperation(transaction, op, i);
        results.push(result);

        if (!result.success) {
          await transaction.rollback();
          return {
            success: false,
            message: `Operation ${i + 1} (${op.type} on ${op.tableName}) failed: ${result.message}. All operations rolled back.`,
            error: "OPERATION_FAILED",
            failedOperationIndex: i,
            results,
          };
        }
      }

      await transaction.commit();

      return {
        success: true,
        message: `All ${operations.length} operation(s) committed successfully.`,
        environment,
        operationCount: operations.length,
        results,
      };
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {
        // Transaction may already be aborted
      }
      return {
        success: false,
        message: `Transaction failed and was rolled back: ${error}`,
        error: "TRANSACTION_FAILED",
        results,
      };
    }
  }

  private validateOperation(
    op: TransactionOperation,
    index: number,
    environmentPolicy?: any,
  ): any | null {
    if (!op.type || !["insert", "update", "delete"].includes(op.type)) {
      return {
        success: false,
        message: `Operation ${index + 1}: invalid type '${op.type}'. Must be insert, update, or delete.`,
        error: "INVALID_OPERATION",
      };
    }
    if (!op.tableName) {
      return {
        success: false,
        message: `Operation ${index + 1}: tableName is required.`,
        error: "INVALID_OPERATION",
      };
    }
    // The free-form whereClause was removed (SQL-injection fix). Guide migration.
    if ((op as any).whereClause !== undefined) {
      return {
        success: false,
        message: `Operation ${index + 1}: 'whereClause' is no longer supported. Use structured 'filters' (e.g. [{ column, operator, value }]).`,
        error: "WHERECLAUSE_REMOVED",
      };
    }
    if (op.type === "insert" && !op.data) {
      return {
        success: false,
        message: `Operation ${index + 1}: 'data' is required for insert operations.`,
        error: "INVALID_OPERATION",
      };
    }
    const hasFilters = Array.isArray(op.filters) && op.filters.length > 0;
    if (op.type === "update" && (!op.updates || !hasFilters)) {
      return {
        success: false,
        message: `Operation ${index + 1}: 'updates' and a non-empty 'filters' array are required for update operations.`,
        error: "INVALID_OPERATION",
      };
    }
    if (op.type === "delete" && !hasFilters) {
      return {
        success: false,
        message: `Operation ${index + 1}: a non-empty 'filters' array is required for delete operations.`,
        error: "INVALID_OPERATION",
      };
    }

    const operationColumns = [
      ...(op.type === "insert" ? Object.keys((Array.isArray(op.data) ? op.data[0] : op.data) ?? {}) : []),
      ...(op.type === "update" ? Object.keys(op.updates ?? {}) : []),
      ...(op.filters ?? []).map((filter) => filter.column),
    ];
    const columnDecision = validateColumnNames(
      environmentPolicy,
      tableReference(op.tableName),
      operationColumns,
    );
    if (!columnDecision.allowed) {
      return { success: false, message: `Operation ${index + 1}: ${columnDecision.reason}`, error: "COLUMN_ACCESS_DENIED" };
    }

    // Validate identifiers and filters up front so a bad input fails cleanly (INVALID_REQUEST)
    // before the transaction opens, instead of throwing mid-transaction and surfacing as
    // TRANSACTION_FAILED after a wasted round-trip.
    try {
      quoteQualified(op.tableName);
      if (op.type === "insert") {
        const records = Array.isArray(op.data) ? op.data : [op.data];
        if (records[0]) Object.keys(records[0]).forEach((k) => quoteName(k));
      }
      if (op.type === "update") {
        Object.keys(op.updates!).forEach((k) => quoteName(k));
      }
      if (op.type === "update" || op.type === "delete") {
        buildWhereClause(NOOP_BINDABLE, op.filters, op.matchType ?? "all");
      }
    } catch (e) {
      if (e instanceof InvalidIdentifierError || e instanceof InvalidFilterError) {
        return { success: false, message: `Operation ${index + 1}: ${e.message}`, error: "INVALID_REQUEST" };
      }
      throw e;
    }

    return null;
  }

  private async executeOperation(
    transaction: sql.Transaction,
    op: TransactionOperation,
    index: number,
  ): Promise<any> {
    try {
      switch (op.type) {
        case "insert":
          return await this.executeInsert(transaction, op);
        case "update":
          return await this.executeUpdate(transaction, op);
        case "delete":
          return await this.executeDelete(transaction, op);
        default:
          return { success: false, message: `Unknown operation type: ${op.type}` };
      }
    } catch (error) {
      return {
        success: false,
        message: `${error}`,
        operationIndex: index,
      };
    }
  }

  private async executeInsert(
    transaction: sql.Transaction,
    op: TransactionOperation,
  ): Promise<any> {
    const records = Array.isArray(op.data) ? op.data : [op.data!];
    if (records.length === 0) {
      return { success: false, message: "No data provided for insertion." };
    }

    const columns = Object.keys(records[0]);
    const table = quoteQualified(op.tableName);
    const safeColumns = columns.map(quoteName).join(", ");
    const request = transaction.request();
    const valueClauses: string[] = [];

    records.forEach((record, recordIndex) => {
      const valueParams = columns
        .map((_, colIndex) => `@v${recordIndex}_${colIndex}`)
        .join(", ");
      valueClauses.push(`(${valueParams})`);
      columns.forEach((col, colIndex) => {
        request.input(`v${recordIndex}_${colIndex}`, record[col]);
      });
    });

    const query = `INSERT INTO ${table} (${safeColumns}) VALUES ${valueClauses.join(", ")}`;
    await request.query(query);

    return {
      success: true,
      message: `Inserted ${records.length} record(s) into ${op.tableName}.`,
      recordsInserted: records.length,
    };
  }

  private async executeUpdate(
    transaction: sql.Transaction,
    op: TransactionOperation,
  ): Promise<any> {
    const table = quoteQualified(op.tableName);
    const request = transaction.request();
    const setClause = Object.keys(op.updates!)
      .map((key, index) => {
        request.input(`upd_${index}`, op.updates![key]);
        return `${quoteName(key)} = @upd_${index}`;
      })
      .join(", ");

    const whereBody = buildWhereClause(request, op.filters, op.matchType ?? "all");
    const query = `UPDATE ${table} SET ${setClause} WHERE ${whereBody}`;
    const result = await request.query(query);

    return {
      success: true,
      message: `Updated ${result.rowsAffected[0]} row(s) in ${op.tableName}.`,
      rowsAffected: result.rowsAffected[0],
    };
  }

  private async executeDelete(
    transaction: sql.Transaction,
    op: TransactionOperation,
  ): Promise<any> {
    const table = quoteQualified(op.tableName);
    const request = transaction.request();
    const whereBody = buildWhereClause(request, op.filters, op.matchType ?? "all");
    const query = `DELETE FROM ${table} WHERE ${whereBody}`;
    const result = await request.query(query);

    return {
      success: true,
      message: `Deleted ${result.rowsAffected[0]} row(s) from ${op.tableName}.`,
      rowsDeleted: result.rowsAffected[0],
    };
  }
}
