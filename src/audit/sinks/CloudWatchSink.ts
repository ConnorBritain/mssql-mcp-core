import type { AuditSink } from "./AuditSink.js";
import type { AuditLogEntry } from "../AuditLogger.js";

export interface CloudWatchSinkConfig {
  logGroupName: string;
  logStreamName?: string;
  region?: string;
  batchSize?: number;
  flushIntervalMs?: number;
}

export class CloudWatchSink implements AuditSink {
  readonly type = "cloudwatch";

  private readonly logGroupName: string;
  private readonly logStreamName: string;
  private readonly region?: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private buffer: AuditLogEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private client: any = null;
  private sequenceToken: string | undefined;
  private initialized = false;
  private disabled = false;

  constructor(config: CloudWatchSinkConfig) {
    this.logGroupName = config.logGroupName;
    this.logStreamName = config.logStreamName ?? `mssql-mcp-${Date.now()}`;
    this.region = config.region;
    this.batchSize = config.batchSize ?? 10;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;

    this.initClient().catch(() => {});

    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  send(entry: AuditLogEntry): void {
    if (this.disabled) return;
    this.buffer.push(entry);
    if (this.buffer.length >= this.batchSize) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.disabled || this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    try {
      if (!this.client) await this.initClient();
      if (this.disabled) return;
      if (!this.initialized) await this.ensureLogGroupAndStream();

      await this.putLogEvents(batch);
    } catch (err) {
      process.stderr.write(
        `CloudWatchSink: send failed — ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    if (this.client) {
      this.client.destroy?.();
      this.client = null;
    }
  }

  private async initClient(): Promise<void> {
    try {
      const sdk: any = await import("@aws-sdk/client-cloudwatch-logs");
      this.client = new sdk.CloudWatchLogsClient(
        this.region ? { region: this.region } : {}
      );
    } catch {
      process.stderr.write(
        "CloudWatchSink: @aws-sdk/client-cloudwatch-logs is not installed. Sink disabled.\n"
      );
      this.disabled = true;
    }
  }

  private async ensureLogGroupAndStream(): Promise<void> {
    const sdk = await import("@aws-sdk/client-cloudwatch-logs");

    try {
      await this.client.send(
        new sdk.CreateLogGroupCommand({ logGroupName: this.logGroupName })
      );
    } catch (err: any) {
      if (err.name !== "ResourceAlreadyExistsException") {
        process.stderr.write(
          `CloudWatchSink: CreateLogGroup failed — ${err.message}\n`
        );
      }
    }

    try {
      await this.client.send(
        new sdk.CreateLogStreamCommand({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName,
        })
      );
    } catch (err: any) {
      if (err.name !== "ResourceAlreadyExistsException") {
        process.stderr.write(
          `CloudWatchSink: CreateLogStream failed — ${err.message}\n`
        );
      }
    }

    await this.refreshSequenceToken(sdk);
    this.initialized = true;
  }

  private async refreshSequenceToken(sdk: any): Promise<void> {
    try {
      const result = await this.client.send(
        new sdk.DescribeLogStreamsCommand({
          logGroupName: this.logGroupName,
          logStreamNamePrefix: this.logStreamName,
        })
      );
      const stream = result.logStreams?.find(
        (s: any) => s.logStreamName === this.logStreamName
      );
      this.sequenceToken = stream?.uploadSequenceToken;
    } catch (err: any) {
      process.stderr.write(
        `CloudWatchSink: DescribeLogStreams failed — ${err.message}\n`
      );
    }
  }

  private async putLogEvents(batch: AuditLogEntry[]): Promise<void> {
    const sdk = await import("@aws-sdk/client-cloudwatch-logs");

    const logEvents = batch.map((entry) => ({
      timestamp: new Date(entry.timestamp).getTime(),
      message: JSON.stringify(entry),
    }));

    try {
      const result = await this.client.send(
        new sdk.PutLogEventsCommand({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName,
          sequenceToken: this.sequenceToken,
          logEvents,
        })
      );
      this.sequenceToken = result.nextSequenceToken;
    } catch (err: any) {
      if (
        err.name === "InvalidSequenceTokenException" ||
        err.name === "DataAlreadyAcceptedException"
      ) {
        this.sequenceToken = err.expectedSequenceToken;
        try {
          const result = await this.client.send(
            new sdk.PutLogEventsCommand({
              logGroupName: this.logGroupName,
              logStreamName: this.logStreamName,
              sequenceToken: this.sequenceToken,
              logEvents,
            })
          );
          this.sequenceToken = result.nextSequenceToken;
        } catch (retryErr: any) {
          process.stderr.write(
            `CloudWatchSink: PutLogEvents retry failed — ${retryErr.message}\n`
          );
        }
      } else {
        throw err;
      }
    }
  }
}
