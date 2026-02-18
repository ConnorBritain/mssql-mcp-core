import * as dgram from "dgram";
import * as net from "net";
import * as os from "os";
import type { AuditSink } from "./AuditSink.js";
import type { AuditLogEntry } from "../AuditLogger.js";

export interface SyslogSinkConfig {
  host: string;
  port?: number;
  protocol?: "udp" | "tcp";
  facility?: number;
  appName?: string;
}

export class SyslogSink implements AuditSink {
  readonly type = "syslog";

  private readonly host: string;
  private readonly port: number;
  private readonly protocol: "udp" | "tcp";
  private readonly facility: number;
  private readonly appName: string;
  private readonly hostname: string;

  private udpSocket: dgram.Socket | null = null;
  private tcpSocket: net.Socket | null = null;
  private tcpConnected = false;
  private tcpConnecting = false;
  private closed = false;

  constructor(config: SyslogSinkConfig) {
    this.host = config.host;
    this.port = config.port ?? 514;
    this.protocol = config.protocol ?? "udp";
    this.facility = config.facility ?? 16; // local0
    this.appName = config.appName ?? "mssql-mcp";
    this.hostname = os.hostname();

    if (this.protocol === "udp") {
      this.udpSocket = dgram.createSocket("udp4");
      this.udpSocket.unref();
    } else {
      this.connectTcp();
    }
  }

  send(entry: AuditLogEntry): void {
    if (this.closed) return;

    try {
      const severity = entry.result?.success === false ? 4 : 6; // warning : informational
      const pri = this.facility * 8 + severity;
      const timestamp = entry.timestamp || new Date().toISOString();
      const procId = process.pid.toString();
      const msgId = entry.toolName || "-";
      const msg = JSON.stringify(entry);

      const syslogMessage = `<${pri}>1 ${timestamp} ${this.hostname} ${this.appName} ${procId} ${msgId} - ${msg}`;

      if (this.protocol === "udp") {
        this.sendUdp(syslogMessage);
      } else {
        this.sendTcp(syslogMessage);
      }
    } catch (err) {
      process.stderr.write(`[SyslogSink] Error formatting message: ${err}\n`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;

    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch {
        // ignore
      }
      this.udpSocket = null;
    }

    if (this.tcpSocket) {
      try {
        this.tcpSocket.destroy();
      } catch {
        // ignore
      }
      this.tcpSocket = null;
      this.tcpConnected = false;
    }
  }

  private sendUdp(message: string): void {
    if (!this.udpSocket) return;
    const buf = Buffer.from(message, "utf-8");
    this.udpSocket.send(buf, 0, buf.length, this.port, this.host, (err) => {
      if (err) {
        process.stderr.write(`[SyslogSink] UDP send error: ${err.message}\n`);
      }
    });
  }

  private sendTcp(message: string): void {
    if (!this.tcpSocket || !this.tcpConnected) {
      if (!this.tcpConnecting) {
        this.connectTcp();
      }
      // Drop message if not connected — syslog is best-effort
      return;
    }

    try {
      // RFC 5425: octet-counting framing for TCP syslog
      const msgBuf = Buffer.from(message, "utf-8");
      this.tcpSocket.write(`${msgBuf.length} ${message}`, (err) => {
        if (err) {
          process.stderr.write(`[SyslogSink] TCP send error: ${err.message}\n`);
        }
      });
    } catch (err) {
      process.stderr.write(`[SyslogSink] TCP write error: ${err}\n`);
    }
  }

  private connectTcp(): void {
    if (this.closed || this.tcpConnecting) return;
    this.tcpConnecting = true;

    const socket = net.createConnection(this.port, this.host, () => {
      this.tcpConnected = true;
      this.tcpConnecting = false;
    });

    socket.unref();
    socket.setKeepAlive(true);

    socket.on("error", (err) => {
      process.stderr.write(`[SyslogSink] TCP connection error: ${err.message}\n`);
      this.tcpConnected = false;
      this.tcpConnecting = false;
    });

    socket.on("close", () => {
      this.tcpConnected = false;
      this.tcpConnecting = false;
      this.tcpSocket = null;

      // Auto-reconnect after delay
      if (!this.closed) {
        const timer = setTimeout(() => this.connectTcp(), 5000);
        timer.unref();
      }
    });

    this.tcpSocket = socket;
  }
}
