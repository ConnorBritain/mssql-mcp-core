import { Tool } from "@modelcontextprotocol/sdk/types.js";

export class CommitTransactionTool implements Tool {
  [key: string]: any;
  name = "commit_transaction";
  description =
    "Commits the active transaction for the target environment, making all operations within it permanent.";
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
      const { environment, transactionManager } = params;

      if (!transactionManager) {
        return {
          success: false,
          message: "Transaction support is not enabled on this server.",
          error: "TRANSACTIONS_DISABLED",
        };
      }

      const { operationCount } = await transactionManager.commit(environment);

      return {
        success: true,
        message: `Transaction committed for environment '${environment}'. ${operationCount} operation(s) applied.`,
        environment,
        operationCount,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to commit transaction: ${error}`,
        error: "COMMIT_FAILED",
      };
    }
  }
}
