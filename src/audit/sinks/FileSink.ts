import * as fs from "fs";
import * as path from "path";
import type { AuditLogEntry } from "../AuditLogger.js";
import type { AuditSink } from "./AuditSink.js";
import { getDefaultAuditLogPath } from "../defaultLogPath.js";

export class FileSink implements AuditSink {
  readonly type = "file";
  private readonly logFilePath: string;

  constructor(filePath?: string) {
    if (filePath) {
      this.logFilePath = path.resolve(filePath);
    } else {
      this.logFilePath = getDefaultAuditLogPath();
    }
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    const dir = path.dirname(this.logFilePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (error) {
      // Don't crash the server if the log directory can't be created
      console.error(`Warning: could not create audit log directory '${dir}':`, error);
    }
  }

  send(entry: AuditLogEntry): void {
    const logLine = JSON.stringify(entry) + "\n";
    fs.appendFileSync(this.logFilePath, logLine, { encoding: "utf-8" });
  }
}
