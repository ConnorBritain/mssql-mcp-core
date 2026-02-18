import type { AuditLogEntry } from "../AuditLogger.js";
import { FileSink } from "./FileSink.js";
import { SyslogSink } from "./SyslogSink.js";
import { HttpSink } from "./HttpSink.js";
import { AzureMonitorSink } from "./AzureMonitorSink.js";
import { CloudWatchSink } from "./CloudWatchSink.js";

export interface AuditSink {
  readonly type: string;
  send(entry: AuditLogEntry): void | Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export type AuditSinkConfig =
  | { type: "file"; path?: string }
  | { type: "syslog"; host: string; port?: number; protocol?: "udp" | "tcp"; facility?: number; appName?: string }
  | { type: "http"; url: string; headers?: Record<string, string>; method?: "POST" | "PUT"; batchSize?: number; flushIntervalMs?: number }
  | { type: "azure-monitor"; workspaceId: string; sharedKey: string; logType?: string; batchSize?: number; flushIntervalMs?: number }
  | { type: "cloudwatch"; logGroupName: string; logStreamName?: string; region?: string; batchSize?: number; flushIntervalMs?: number };

export function createAuditSink(config: AuditSinkConfig): AuditSink {
  switch (config.type) {
    case "file":
      return new FileSink(config.path);
    case "syslog":
      return new SyslogSink(config);
    case "http":
      return new HttpSink(config);
    case "azure-monitor":
      return new AzureMonitorSink(config);
    case "cloudwatch":
      return new CloudWatchSink(config);
    default:
      throw new Error(`Unknown audit sink type: ${(config as any).type}`);
  }
}
