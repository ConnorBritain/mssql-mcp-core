import * as fs from "fs";
import * as path from "path";
import type { AuditLogEntry } from "../AuditLogger.js";
import type { AuditSink } from "./AuditSink.js";

export class FileSink implements AuditSink {
  readonly type = "file";
  private readonly logFilePath: string;

  constructor(filePath?: string) {
    if (filePath) {
      this.logFilePath = path.resolve(filePath);
    } else {
      this.logFilePath = path.resolve(process.cwd(), "logs", "audit.jsonl");
    }
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  send(entry: AuditLogEntry): void {
    const logLine = JSON.stringify(entry) + "\n";
    fs.appendFileSync(this.logFilePath, logLine, { encoding: "utf-8" });
  }
}
