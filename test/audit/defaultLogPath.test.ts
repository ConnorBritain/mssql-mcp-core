import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AuditLogger } from "../../src/audit/AuditLogger.js";
import { FileSink } from "../../src/audit/sinks/FileSink.js";
import { getDefaultAuditLogPath } from "../../src/audit/defaultLogPath.js";

/** A path whose parent "directory" is actually a file, so mkdir always fails. */
function makeUncreatableLogPath(): { blocker: string; logPath: string } {
  const blocker = path.join(os.tmpdir(), `audit-blocker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(blocker, "");
  return { blocker, logPath: path.join(blocker, "logs", "audit.jsonl") };
}

describe("default audit log path", () => {
  const origLogPath = process.env.AUDIT_LOG_PATH;
  const origLogging = process.env.AUDIT_LOGGING;
  const cleanupPaths: string[] = [];

  afterEach(() => {
    if (origLogPath === undefined) delete process.env.AUDIT_LOG_PATH;
    else process.env.AUDIT_LOG_PATH = origLogPath;
    if (origLogging === undefined) delete process.env.AUDIT_LOGGING;
    else process.env.AUDIT_LOGGING = origLogging;
    for (const p of cleanupPaths) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
    cleanupPaths.length = 0;
    vi.restoreAllMocks();
  });

  it("is under the user's home directory, not process.cwd()", () => {
    expect(getDefaultAuditLogPath()).toBe(
      path.join(os.homedir(), ".mssql-mcp-server", "logs", "audit.jsonl")
    );
  });

  it("AuditLogger uses the home-based default when AUDIT_LOG_PATH is not set", () => {
    delete process.env.AUDIT_LOG_PATH;
    process.env.AUDIT_LOGGING = "true";

    const logger = new AuditLogger();

    expect((logger as any).logFilePath).toBe(getDefaultAuditLogPath());
  });

  it("AuditLogger does not throw when the log directory can't be created", () => {
    const { blocker, logPath } = makeUncreatableLogPath();
    cleanupPaths.push(blocker);
    process.env.AUDIT_LOG_PATH = logPath;
    process.env.AUDIT_LOGGING = "true";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => new AuditLogger()).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("FileSink does not throw when the log directory can't be created", () => {
    const { blocker, logPath } = makeUncreatableLogPath();
    cleanupPaths.push(blocker);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => new FileSink(logPath)).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
  });
});
