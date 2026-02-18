import { Tool } from "@modelcontextprotocol/sdk/types.js";

export class BeginTransactionTool implements Tool {
  [key: string]: any;
  name = "begin_transaction";
  description =
    "Begins a database transaction for the target environment. All subsequent write operations (insert, update, delete) will execute within this transaction until committed or rolled back. Only one transaction per environment at a time.";
  inputSchema = {
    type: "object",
    properties: {
      environment: {
        type: "string",
        description: "Optional environment name to target.",
      },
    },
    required: [],
  } as any;

  async run(params: any) {
    try {
      const { pool, environment, transactionManager } = params;

      if (!transactionManager) {
        return {
          success: false,
          message: "Transaction support is not enabled on this server.",
          error: "TRANSACTIONS_DISABLED",
        };
      }

      await transactionManager.begin(environment, pool);

      return {
        success: true,
        message: `Transaction started for environment '${environment}'.`,
        environment,
        hint: "Use commit_transaction or rollback_transaction when done.",
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to begin transaction: ${error}`,
        error: "BEGIN_FAILED",
      };
    }
  }
}
