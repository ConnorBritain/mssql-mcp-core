# @connorbritain/mssql-mcp-core

Shared core library for the MSSQL MCP tiered package family. This package provides every tool class, the MCP server harness, environment management, audit logging, secret resolution, intent routing, and policy enforcement middleware. Consumer packages (reader, writer, server) depend on this library and call `startMcpServer()` with a tier to get a fully configured MCP server.

## Architecture

```
@connorbritain/mssql-mcp-core
        |
        |-- @connorbritain/mssql-mcp-reader  (14 read-only tools)
        |-- @connorbritain/mssql-mcp-writer  (17 tools: reader + INSERT/UPDATE/DELETE)
        |-- @connorbritain/mssql-mcp-server  (20 tools: writer + CREATE TABLE/INDEX, DROP TABLE)
```

Each consumer package is a thin wrapper that passes its tier to `startMcpServer()`. All business logic, tool implementations, and governance infrastructure live here.

## How Consumer Packages Use This Library

```ts
import { startMcpServer } from "@connorbritain/mssql-mcp-core";

startMcpServer({ tier: "reader" });
```

The `tier` parameter controls which tools are registered with the MCP server:

| Tier | Tools | What it adds |
|------|-------|-------------|
| `reader` | 14 | All read-only and schema discovery tools |
| `writer` | 17 | Reader tools + `insert_data`, `update_data`, `delete_data` |
| `admin` | 20 | Writer tools + `create_table`, `create_index`, `drop_table` |

**[Config Builder](https://connorbritain.github.io/mssql-mcp-config-builder/)** — Visual wizard to generate configuration files for consumer packages.

## Exports

### Server Entry Point

```ts
import { startMcpServer } from "@connorbritain/mssql-mcp-core";
```

- **`startMcpServer(config: McpServerConfig)`** — Initializes the MCP server over stdio for the given tier. Registers tools, applies `wrapToolRun` policy middleware to each, and starts listening.

### Tool Classes

All 20 tool classes are exported individually:

```ts
import {
  // Read-only (Reader tier)
  ReadDataTool,
  ListTableTool,
  ListDatabasesTool,
  ListEnvironmentsTool,
  ValidateEnvironmentConfigTool,
  ListScriptsTool,
  RunScriptTool,
  DescribeTableTool,
  SearchSchemaTool,
  ProfileTableTool,
  RelationshipInspectorTool,
  InspectDependenciesTool,
  TestConnectionTool,
  ExplainQueryTool,

  // Write (Writer tier adds these)
  InsertDataTool,
  DeleteDataTool,
  UpdateDataTool,

  // Admin/DDL (Server tier adds these)
  CreateTableTool,
  CreateIndexTool,
  DropTableTool,
} from "@connorbritain/mssql-mcp-core";
```

Each tool class implements the `RunnableTool` interface with `name`, `description`, `inputSchema`, and `run(params)`.

### Environment Management

```ts
import { EnvironmentManager, getEnvironmentManager } from "@connorbritain/mssql-mcp-core";
```

- **`EnvironmentManager`** — Manages multi-environment configurations, connection pools, per-environment policies (readonly, allowedTools, deniedTools, maxRowsDefault, requireApproval, auditLevel, allowedSchemas, deniedSchemas), and secret resolution.
- **`getEnvironmentManager()`** — Returns the singleton instance.

### Audit Logging

```ts
import { AuditLogger, auditLogger } from "@connorbritain/mssql-mcp-core";
```

- **`AuditLogger`** — Writes JSON Lines audit log entries with timestamps, tool names, arguments (sensitive fields auto-redacted), results, session ID, and environment name.
- **`auditLogger`** — Singleton instance. Configured via `AUDIT_LOG_PATH` and `AUDIT_LOGGING` environment variables.

### Secret Resolution

```ts
import {
  SecretResolver,
  createSecretResolver,
  validateDotenvPath,
  validateFileDirectory,
} from "@connorbritain/mssql-mcp-core";
```

- **`SecretResolver`** — Resolves `${secret:NAME}` placeholders in environment config values from environment variables, `.env` files, or external secret providers.
- **`createSecretResolver(config)`** — Factory for `SecretResolver` instances.

### Intent Routing

```ts
import { IntentRouter } from "@connorbritain/mssql-mcp-core";
```

- **`IntentRouter`** — Routes natural language intents to the appropriate MCP tool using keyword matching and scoring. Used internally by `startMcpServer`.

### Policy Middleware

```ts
import { wrapToolRun } from "@connorbritain/mssql-mcp-core";
```

- **`wrapToolRun(tool, options)`** — Monkey-patches a tool's `run()` method to enforce per-environment policies (readonly, allowedTools, deniedTools, requireApproval), obtain a connection pool, inject environment context into tool arguments, and log all invocations to the audit logger.

### Toolset Helpers

```ts
import {
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
} from "@connorbritain/mssql-mcp-core";
```

- **`createAllToolInstances()`** — Instantiates all 20 tool classes and returns them as a named object.
- **`getReaderTools(t)`** — Returns the 14-tool array for the reader tier.
- **`getWriterTools(t)`** — Returns the 17-tool array for the writer tier.
- **`getAdminTools(t)`** — Returns the 20-tool array for the admin/server tier.
- **`buildToolRegistry(t)`** — Returns the full routing config array used by `IntentRouter`.
- **`READER_MUTATING_TOOLS`** — Empty `Set<string>` (reader has no mutating tools).
- **`WRITER_MUTATING_TOOLS`** — `Set` of `insert_data`, `delete_data`, `update_data`.
- **`ADMIN_MUTATING_TOOLS`** — `Set` of all write + DDL tool names.
- **`READER_APPROVAL_EXEMPT`** — `Set` of tools that bypass `requireApproval` in the reader tier.
- **`WRITER_APPROVAL_EXEMPT`** — `Set` of tools that bypass `requireApproval` in the writer tier.
- **`ADMIN_APPROVAL_EXEMPT`** — `Set` of tools that bypass `requireApproval` in the admin tier.

### Types

```ts
import type {
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
  EnvironmentConfig,
  EnvironmentsConfig,
  AccessLevel,
  AuditLogEntry,
  AuditLevel,
  SecretsConfig,
  SecretProviderConfig,
} from "@connorbritain/mssql-mcp-core";
```

## Build

```bash
npm install
npm run build   # Compiles TypeScript to dist/
npm run watch   # Watch mode for development
```

## Related Packages

| Package | npm | Tier |
|---------|-----|------|
| Reader | `@connorbritain/mssql-mcp-reader` | Read-only |
| Writer | `@connorbritain/mssql-mcp-writer` | Read + write |
| Server | `@connorbritain/mssql-mcp-server` | Full admin |

## License

MIT
