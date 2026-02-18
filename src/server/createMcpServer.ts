import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as crypto from "crypto";

import { initShims } from "../shims.js";
import { getEnvironmentManager } from "../config/EnvironmentManager.js";
import { TransactionManager } from "../transactions/TransactionManager.js";
import type { McpServerConfig, RunnableTool } from "../types.js";
import { IntentRouter } from "../routing/IntentRouter.js";
import { wrapToolRun } from "./wrapToolRun.js";
import { auditLogger } from "../audit/AuditLogger.js";
import { createAuditSink, type AuditSink, type AuditSinkConfig } from "../audit/sinks/AuditSink.js";
import {
  createAllToolInstances,
  getReaderTools,
  getWriterTools,
  getAdminTools,
  getExplicitTransactionTools,
  getBatchTransactionTools,
  buildToolRegistry,
  READER_MUTATING_TOOLS,
  WRITER_MUTATING_TOOLS,
  ADMIN_MUTATING_TOOLS,
  READER_APPROVAL_EXEMPT,
  WRITER_APPROVAL_EXEMPT,
  ADMIN_APPROVAL_EXEMPT,
} from "./toolsets.js";

/**
 * Start an MCP server with the given tier configuration.
 * This is the single entry point that reader/writer/server all call.
 */
export async function startMcpServer(config: McpServerConfig): Promise<void> {
  // 1. Runtime shims (SlowBuffer, dotenv)
  initShims();

  // 2. Session ID for audit correlation
  const sessionId = crypto.randomUUID();

  // 3. Environment manager (reads ENVIRONMENTS_CONFIG_PATH, etc.)
  const environmentManager = await getEnvironmentManager();

  // 3b. Configure audit sinks from environment config
  const rawConfig = environmentManager.getRawConfig();
  if (rawConfig) {
    const secretResolver = environmentManager.getSecretResolver();

    // Resolve secrets and create global sinks
    const globalSinkConfigs = rawConfig.auditSinks ?? [];
    const globalSinks: AuditSink[] = [];
    for (const sinkConfig of globalSinkConfigs) {
      try {
        const resolved = secretResolver.resolveObject(sinkConfig) as AuditSinkConfig;
        globalSinks.push(createAuditSink(resolved));
      } catch (err) {
        console.error(`Failed to create global audit sink '${sinkConfig.type}':`, err);
      }
    }

    // If no global sinks configured, default to file sink (preserves backward compat)
    if (globalSinks.length === 0) {
      const logPath = process.env.AUDIT_LOG_PATH;
      globalSinks.push(createAuditSink({ type: "file", path: logPath }));
    }

    // Resolve secrets and create per-environment sinks
    const perEnvSinks = new Map<string, AuditSink[]>();
    for (const envConfig of rawConfig.environments) {
      if (envConfig.auditSinks && envConfig.auditSinks.length > 0) {
        const envSinks: AuditSink[] = [];
        for (const sinkConfig of envConfig.auditSinks) {
          try {
            const resolved = secretResolver.resolveObject(sinkConfig) as AuditSinkConfig;
            envSinks.push(createAuditSink(resolved));
          } catch (err) {
            console.error(`Failed to create audit sink '${sinkConfig.type}' for env '${envConfig.name}':`, err);
          }
        }
        if (envSinks.length > 0) {
          perEnvSinks.set(envConfig.name, envSinks);
        }
      }
    }

    auditLogger.configureSinks(globalSinks, perEnvSinks);
    console.error(`Configured audit sinks: ${globalSinks.length} global, ${perEnvSinks.size} environment-specific`);
  }

  // 4. Create all tool instances
  const tools = createAllToolInstances();

  // 5. Select tools and policies based on tier
  let exposedTools: RunnableTool[];
  let mutatingToolNames: Set<string>;
  let approvalExemptTools: Set<string>;

  switch (config.tier) {
    case "reader":
      exposedTools = getReaderTools(tools);
      mutatingToolNames = READER_MUTATING_TOOLS;
      approvalExemptTools = READER_APPROVAL_EXEMPT;
      break;
    case "writer":
      exposedTools = getWriterTools(tools);
      mutatingToolNames = WRITER_MUTATING_TOOLS;
      approvalExemptTools = WRITER_APPROVAL_EXEMPT;
      break;
    case "admin":
      exposedTools = getAdminTools(tools);
      mutatingToolNames = ADMIN_MUTATING_TOOLS;
      approvalExemptTools = ADMIN_APPROVAL_EXEMPT;
      break;
  }

  // 6. Determine transaction mode and append transaction tools
  const envTransactionMode = process.env.TRANSACTION_MODE as
    | "explicit"
    | "batch"
    | "none"
    | undefined;
  const effectiveTransactionMode =
    config.tier === "reader"
      ? "none"
      : envTransactionMode ?? config.transactionMode ?? "explicit";

  let transactionManager: TransactionManager | undefined;

  if (effectiveTransactionMode !== "none") {
    transactionManager = new TransactionManager();

    if (effectiveTransactionMode === "explicit") {
      exposedTools.push(...getExplicitTransactionTools(tools));
    } else if (effectiveTransactionMode === "batch") {
      exposedTools.push(...getBatchTransactionTools(tools));
    }
  }

  // 7. Wrap all exposed tools with policy enforcement + pool injection
  for (const tool of exposedTools) {
    wrapToolRun(tool, {
      environmentManager,
      sessionId,
      serverVersion: config.version,
      mutatingToolNames,
      approvalExemptTools,
      transactionManager,
    });
  }

  // 8. Build intent router (optional, used internally — not exposed as a tool)
  const isReadOnly = config.tier === "reader" || process.env.READONLY === "true";
  const requireMutationConfirmation = process.env.REQUIRE_MUTATION_CONFIRMATION !== "false";
  const toolRegistry = buildToolRegistry(tools);

  const _intentRouter = new IntentRouter({
    tools: toolRegistry,
    allowMutations: !isReadOnly,
    requireConfirmationForMutations: requireMutationConfirmation,
  });

  // 9. Build a Map for fast tool dispatch
  const toolMap = new Map<string, RunnableTool>();
  for (const tool of exposedTools) {
    toolMap.set(tool.name, tool);
  }

  // 10. Create MCP server
  const server = new Server(
    { name: config.name, version: config.version },
    { capabilities: { tools: {} } },
  );

  // 11. Register request handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const tool = toolMap.get(name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      const result = await tool.run(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error occurred: ${error}` }],
        isError: true,
      };
    }
  });

  // 12. Connect transport and start
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
