// ─── Main entry point ───────────────────────────────────────────────────────
export { startMcpServer } from "./server/createMcpServer.js";

// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  TierLevel,
  McpServerConfig,
  IntentCategory,
  RunnableTool,
  ToolRoutingConfig,
  IntentRouterOptions,
  RoutingCandidate,
  RouteParams,
  RouteResult,
  WrapToolRunOptions,
} from "./types.js";

// ─── Config ─────────────────────────────────────────────────────────────────
export {
  EnvironmentManager,
  getEnvironmentManager,
} from "./config/EnvironmentManager.js";
export type {
  EnvironmentConfig,
  EnvironmentsConfig,
  AccessLevel,
  AuditLevel as ConfigAuditLevel,
  TierLevel as ConfigTierLevel,
} from "./config/EnvironmentManager.js";
export {
  SecretResolver,
  createSecretResolver,
  validateDotenvPath,
  validateFileDirectory,
} from "./config/SecretResolver.js";
export type { SecretProvider, SecretsConfig, SecretProviderConfig } from "./config/SecretResolver.js";

// ─── Audit ──────────────────────────────────────────────────────────────────
export { AuditLogger, auditLogger } from "./audit/AuditLogger.js";
export type { AuditLogEntry, AuditLevel } from "./audit/AuditLogger.js";

// ─── Routing ────────────────────────────────────────────────────────────────
export { IntentRouter } from "./routing/IntentRouter.js";

// ─── Server harness ─────────────────────────────────────────────────────────
export { wrapToolRun } from "./server/wrapToolRun.js";
export {
  createAllToolInstances,
  getReaderTools,
  getWriterTools,
  getAdminTools,
  buildToolRegistry,
  READER_MUTATING_TOOLS,
  WRITER_MUTATING_TOOLS,
  ADMIN_MUTATING_TOOLS,
  READER_APPROVAL_EXEMPT,
  WRITER_APPROVAL_EXEMPT,
  ADMIN_APPROVAL_EXEMPT,
} from "./server/toolsets.js";

// ─── Shims ──────────────────────────────────────────────────────────────────
export { initShims } from "./shims.js";

// ─── Tools ──────────────────────────────────────────────────────────────────
export {
  CreateIndexTool,
  CreateTableTool,
  DeleteDataTool,
  DescribeTableTool,
  DropTableTool,
  ExplainQueryTool,
  InsertDataTool,
  InspectDependenciesTool,
  ListDatabasesTool,
  ListEnvironmentsTool,
  ListScriptsTool,
  ListTableTool,
  ProfileTableTool,
  ReadDataTool,
  RelationshipInspectorTool,
  RunScriptTool,
  SearchSchemaTool,
  TestConnectionTool,
  UpdateDataTool,
  ValidateEnvironmentConfigTool,
} from "./tools/index.js";
