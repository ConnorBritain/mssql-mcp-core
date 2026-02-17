import { Tool } from "@modelcontextprotocol/sdk/types.js";

// ─── Tier ────────────────────────────────────────────────────────────────────

export type TierLevel = "reader" | "writer" | "admin";

// ─── Server startup config ──────────────────────────────────────────────────

export interface McpServerConfig {
  /** Display name shown to MCP clients, e.g. "mssql-mcp-reader" */
  name: string;
  /** SemVer string, e.g. "0.2.0" */
  version: string;
  /** Which tool-set tier to expose */
  tier: TierLevel;
}

// ─── Intent routing ─────────────────────────────────────────────────────────

export type IntentCategory =
  | "data_read"
  | "data_write"
  | "schema_discovery"
  | "schema_change"
  | "metadata";

export interface RunnableTool extends Tool {
  run: (args: any) => Promise<any>;
}

export interface ToolRoutingConfig {
  tool: RunnableTool;
  name: string;
  intents: IntentCategory[];
  keywords?: string[];
  requiredArgs?: string[];
  mutatesData?: boolean;
  schemaChange?: boolean;
  baseScore?: number;
  requiresConfirmation?: boolean;
}

export interface IntentRouterOptions {
  tools: ToolRoutingConfig[];
  allowMutations: boolean;
  requireConfirmationForMutations: boolean;
}

export interface RoutingCandidate {
  config: ToolRoutingConfig;
  score: number;
  reasons: string[];
}

export interface RouteParams {
  prompt: string;
  toolArguments?: Record<string, any>;
  confirmIntent?: boolean;
  preferredToolName?: string;
  environment?: string;
}

export interface RouteResult {
  success: boolean;
  routedTool?: string;
  intent?: IntentCategory;
  reasoning?: string[];
  toolResult?: any;
  message?: string;
  error?: string;
  selectedEnvironment?: string;
}

// ─── WrapToolRun options ────────────────────────────────────────────────────

export interface WrapToolRunOptions {
  environmentManager: import("./config/EnvironmentManager.js").EnvironmentManager;
  sessionId: string;
  serverVersion: string;
  mutatingToolNames: Set<string>;
  approvalExemptTools: Set<string>;
}
