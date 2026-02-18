import type { AuditSink } from "./AuditSink.js";
import type { AuditLogEntry } from "../AuditLogger.js";

export interface HttpSinkConfig {
  url: string;
  headers?: Record<string, string>;
  method?: string;
  batchSize?: number;
  flushIntervalMs?: number;
}

export class HttpSink implements AuditSink {
  readonly type = "http";

  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly method: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  private buffer: AuditLogEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(config: HttpSinkConfig) {
    this.url = config.url;
    this.headers = config.headers ?? {};
    this.method = config.method ?? "POST";
    this.batchSize = config.batchSize ?? 10;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;

    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  send(entry: AuditLogEntry): void {
    if (this.closed) return;

    this.buffer.push(entry);

    if (this.buffer.length >= this.batchSize) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const entries = this.buffer.splice(0);

    try {
      await this.post(entries);
    } catch {
      // Single retry
      try {
        await this.post(entries);
      } catch (retryErr) {
        process.stderr.write(
          `[HttpSink] Failed to send ${entries.length} audit entries after retry: ${retryErr}\n`
        );
        // Drop entries
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.flush();
  }

  private async post(entries: AuditLogEntry[]): Promise<void> {
    const response = await fetch(this.url, {
      method: this.method,
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(entries),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }
}
