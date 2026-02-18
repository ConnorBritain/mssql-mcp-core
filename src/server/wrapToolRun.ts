import { auditLogger } from "../audit/AuditLogger.js";
import type { WrapToolRunOptions } from "../types.js";

/**
 * Monkey-patches a tool's `run()` method to:
 *  1. Resolve the target environment and enforce policies
 *  2. Obtain a connection pool from EnvironmentManager
 *  3. Inject pool + environment info into the tool arguments
 *  4. Log invocations to the audit logger
 */
export function wrapToolRun(
  tool: { name: string; run: (...args: any[]) => Promise<any> },
  options: WrapToolRunOptions,
): void {
  const {
    environmentManager,
    sessionId,
    serverVersion,
    mutatingToolNames,
    approvalExemptTools,
    transactionManager,
  } = options;

  const originalRun = tool.run.bind(tool);

  tool.run = async function (...args: any[]) {
    const startTime = Date.now();
    const rawArgs = (args[0] ?? {}) as Record<string, any>;
    const requestedEnvironment =
      typeof rawArgs.environment === "string" ? rawArgs.environment : undefined;
    const envConfig = environmentManager.getEnvironment(requestedEnvironment);

    // Build policy object from environment config
    const policy = {
      name: envConfig.name,
      readonly: envConfig.readonly ?? false,
      allowedTools: envConfig.allowedTools,
      deniedTools: envConfig.deniedTools,
      maxRowsDefault: envConfig.maxRowsDefault,
      requireApproval: envConfig.requireApproval ?? false,
      auditLevel: envConfig.auditLevel ?? "basic",
    };

    // Check denied tools policy (takes precedence)
    if (
      policy.deniedTools &&
      policy.deniedTools.length > 0 &&
      policy.deniedTools.includes(tool.name)
    ) {
      return {
        success: false,
        message: `Tool '${tool.name}' is explicitly denied in environment '${policy.name}'.`,
        error: "TOOL_DENIED",
      };
    }

    // Check allowed tools policy
    if (
      policy.allowedTools &&
      policy.allowedTools.length > 0 &&
      !policy.allowedTools.includes(tool.name)
    ) {
      return {
        success: false,
        message: `Tool '${tool.name}' is not permitted in environment '${policy.name}'. Allowed tools: ${policy.allowedTools.join(", ")}.`,
        error: "TOOL_NOT_ALLOWED",
      };
    }

    // Check readonly policy for mutating tools
    if (policy.readonly && mutatingToolNames.has(tool.name)) {
      return {
        success: false,
        message: `Environment '${policy.name}' is read-only. Tool '${tool.name}' cannot be executed.`,
        error: "ENVIRONMENT_READONLY",
      };
    }

    // Check requireApproval policy (skip for approval-exempt tools)
    if (policy.requireApproval && !approvalExemptTools.has(tool.name)) {
      const hasConfirmation = rawArgs.confirm === true;
      if (!hasConfirmation) {
        return {
          success: false,
          requiresApproval: true,
          message: `Environment '${policy.name}' requires explicit approval for '${tool.name}'. Review the operation and re-run with confirm: true to proceed.`,
          error: "APPROVAL_REQUIRED",
          tool: tool.name,
          environment: policy.name,
          providedArguments: rawArgs,
          hint: "Add 'confirm: true' to your arguments after reviewing this operation.",
        };
      }
    }

    // Get connection for the specified or default environment
    const pool = await environmentManager.getConnection(policy.name);

    // Check for active transaction and inject it
    let transaction: import("mssql").Transaction | undefined;
    if (transactionManager?.hasActiveTransaction(policy.name)) {
      const activeTxn = transactionManager.getTransaction(policy.name)!;
      transaction = activeTxn.transaction;
    }

    // Enrich args with environment info, policy, and connection pool
    const toolArgs: Record<string, any> = {
      ...rawArgs,
      environment: policy.name,
      environmentPolicy: policy,
      pool,
      mcpServerVersion: serverVersion,
    };

    if (transaction) {
      toolArgs.transaction = transaction;
    }
    if (transactionManager) {
      toolArgs.transactionManager = transactionManager;
    }

    try {
      const result = await originalRun(toolArgs);
      const durationMs = Date.now() - startTime;

      auditLogger.logToolInvocation(tool.name, toolArgs, result, durationMs, {
        sessionId,
        environment: policy.name,
        auditLevel: policy.auditLevel as any,
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      auditLogger.logToolInvocation(
        tool.name,
        toolArgs,
        { success: false, error: String(error) },
        durationMs,
        {
          sessionId,
          environment: policy.name,
          auditLevel: policy.auditLevel as any,
        },
      );

      throw error;
    }
  };
}
