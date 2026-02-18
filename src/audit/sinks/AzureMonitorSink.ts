import { createHmac } from "node:crypto";
import type { AuditSink } from "./AuditSink.js";
import type { AuditLogEntry } from "../AuditLogger.js";

export interface AzureMonitorSinkConfig {
  workspaceId: string;
  sharedKey: string;
  logType?: string;
  batchSize?: number;
  flushIntervalMs?: number;
}

export class AzureMonitorSink implements AuditSink {
  readonly type = "azure-monitor";

  private readonly workspaceId: string;
  private readonly sharedKey: string;
  private readonly logType: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private buffer: AuditLogEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AzureMonitorSinkConfig) {
    this.workspaceId = config.workspaceId;
    this.sharedKey = config.sharedKey;
    this.logType = config.logType ?? "MSSQLMCPAudit";
    this.batchSize = config.batchSize ?? 10;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;

    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  send(entry: AuditLogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= this.batchSize) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    try {
      const body = JSON.stringify(batch);
      const contentLength = Buffer.byteLength(body, "utf-8");
      const rfc1123Date = new Date().toUTCString();

      const signature = this.buildSignature(contentLength, rfc1123Date);
      const url = `https://${this.workspaceId}.ods.opinsights.azure.com/api/logs?api-version=2016-04-01`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Log-Type": this.logType,
          "x-ms-date": rfc1123Date,
          "Authorization": `SharedKey ${this.workspaceId}:${signature}`,
        },
        body,
      });

      if (!response.ok) {
        process.stderr.write(
          `AzureMonitorSink: HTTP ${response.status} — ${await response.text()}\n`
        );
      }
    } catch (err) {
      process.stderr.write(
        `AzureMonitorSink: send failed — ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private buildSignature(contentLength: number, date: string): string {
    const stringToSign = [
      "POST",
      String(contentLength),
      "application/json",
      `x-ms-date:${date}`,
      "/api/logs",
    ].join("\n");

    const decodedKey = Buffer.from(this.sharedKey, "base64");
    const hmac = createHmac("sha256", decodedKey)
      .update(stringToSign, "utf-8")
      .digest("base64");
    return hmac;
  }
}
