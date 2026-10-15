import * as os from "os";
import * as path from "path";

/**
 * Default audit log location when AUDIT_LOG_PATH is not set.
 * Uses the user's home directory rather than process.cwd(), because MCP clients
 * may launch the server from a directory the user can't write to
 * (e.g. C:\Windows\System32 on Windows).
 */
export function getDefaultAuditLogPath(): string {
  return path.join(os.homedir(), ".mssql-mcp-server", "logs", "audit.jsonl");
}
