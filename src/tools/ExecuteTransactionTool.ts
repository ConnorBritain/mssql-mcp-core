import sql from "mssql";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

interface TransactionOperation {
  type: "insert" | "update" | "delete";
  tableName: string;
  /** Required for insert */
  data?: Record<string, any> | Record<string, any>[];
  /** Required for update */
  updates?: Record<string, any>;
  /** Required for update and delete */
  whereClause?: string;
  /** Confirms update (bypasses preview in batch mode) */
  confirmUpdate?: boolean;
  /** Confirms delete (bypasses preview in batch mode) */
  confirmDelete?: boolean;
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
            whereClause: {
              type: "string",
              description: "WHERE clause for update/delete operations.",
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
      const validation = this.validateOperation(op, i);
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
    if (op.type === "insert" && !op.data) {
      return {
        success: false,
        message: `Operation ${index + 1}: 'data' is required for insert operations.`,
        error: "INVALID_OPERATION",
      };
    }
    if (op.type === "update" && (!op.updates || !op.whereClause)) {
      return {
        success: false,
        message: `Operation ${index + 1}: 'updates' and 'whereClause' are required for update operations.`,
        error: "INVALID_OPERATION",
      };
    }
    if (op.type === "delete" && !op.whereClause) {
      return {
        success: false,
        message: `Operation ${index + 1}: 'whereClause' is required for delete operations.`,
        error: "INVALID_OPERATION",
      };
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

    const query = `INSERT INTO ${op.tableName} (${columns.join(", ")}) VALUES ${valueClauses.join(", ")}`;
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
    const request = transaction.request();
    const setClause = Object.keys(op.updates!)
      .map((key, index) => {
        request.input(`upd_${index}`, op.updates![key]);
        return `[${key}] = @upd_${index}`;
      })
      .join(", ");

    const query = `UPDATE ${op.tableName} SET ${setClause} WHERE ${op.whereClause}`;
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
    const request = transaction.request();
    const query = `DELETE FROM ${op.tableName} WHERE ${op.whereClause}`;
    const result = await request.query(query);

    return {
      success: true,
      message: `Deleted ${result.rowsAffected[0]} row(s) from ${op.tableName}.`,
      rowsDeleted: result.rowsAffected[0],
    };
  }
}
