import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { CloudWatchSink } from "../../../src/audit/sinks/CloudWatchSink.js";
import type { AuditLogEntry } from "../../../src/audit/AuditLogger.js";

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    timestamp: new Date().toISOString(),
    toolName: "test_tool",
    result: { success: true },
    durationMs: 42,
    ...overrides,
  };
}

// Build mock SDK that tracks calls
function createMockSdk() {
  const commands: { name: string; input: any }[] = [];

  const mockClient = {
    send: vi.fn(async (command: any) => {
      const cmdName = command.constructor?.name || command._name || "Unknown";
      commands.push({ name: cmdName, input: command.input });

      if (cmdName === "DescribeLogStreamsCommand") {
        return {
          logStreams: [{
            logStreamName: command.input.logStreamNamePrefix,
            uploadSequenceToken: "token-1",
          }],
        };
      }
      if (cmdName === "PutLogEventsCommand") {
        return { nextSequenceToken: "token-2" };
      }
      return {};
    }),
    destroy: vi.fn(),
  };

  // Create command constructors
  function makeCommand(name: string) {
    return class {
      static _name = name;
      _name = name;
      input: any;
      constructor(input: any) { this.input = input; }
      get [Symbol.toStringTag]() { return name; }
    };
  }

  // Override the constructor name
  const CloudWatchLogsClient = vi.fn(() => mockClient);
  const CreateLogGroupCommand = makeCommand("CreateLogGroupCommand");
  const CreateLogStreamCommand = makeCommand("CreateLogStreamCommand");
  const DescribeLogStreamsCommand = makeCommand("DescribeLogStreamsCommand");
  const PutLogEventsCommand = makeCommand("PutLogEventsCommand");

  return {
    mockClient,
    commands,
    sdk: {
      CloudWatchLogsClient,
      CreateLogGroupCommand,
      CreateLogStreamCommand,
      DescribeLogStreamsCommand,
      PutLogEventsCommand,
    },
  };
}

describe("CloudWatchSink", () => {
  let sink: CloudWatchSink | null = null;

  afterEach(async () => {
    if (sink) {
      await sink.close();
      sink = null;
    }
    vi.restoreAllMocks();
  });

  it("has type 'cloudwatch'", () => {
    // Mock the import so constructor doesn't fail
    vi.doMock("@aws-sdk/client-cloudwatch-logs", () => createMockSdk().sdk);

    sink = new CloudWatchSink({
      logGroupName: "/test/group",
      flushIntervalMs: 60000,
    });
    expect(sink.type).toBe("cloudwatch");
  });

  it("creates log group and stream on first flush", async () => {
    const { sdk, commands, mockClient } = createMockSdk();
    vi.doMock("@aws-sdk/client-cloudwatch-logs", () => sdk);

    // Reimport to pick up mock
    const { CloudWatchSink: MockedSink } = await import("../../../src/audit/sinks/CloudWatchSink.js");

    sink = new MockedSink({
      logGroupName: "/test/audit",
      logStreamName: "test-stream",
      batchSize: 100,
      flushIntervalMs: 60000,
    }) as any;

    // Wait for initClient
    await new Promise((r) => setTimeout(r, 100));

    sink!.send(makeEntry());
    await sink!.flush();

    const cmdNames = commands.map((c) => c.name);
    expect(cmdNames).toContain("CreateLogGroupCommand");
    expect(cmdNames).toContain("CreateLogStreamCommand");
    expect(cmdNames).toContain("PutLogEventsCommand");

    const createGroup = commands.find((c) => c.name === "CreateLogGroupCommand");
    expect(createGroup!.input.logGroupName).toBe("/test/audit");

    const createStream = commands.find((c) => c.name === "CreateLogStreamCommand");
    expect(createStream!.input.logStreamName).toBe("test-stream");
  });

  it("sends log events with correct format", async () => {
    const { sdk, commands } = createMockSdk();
    vi.doMock("@aws-sdk/client-cloudwatch-logs", () => sdk);

    const { CloudWatchSink: MockedSink } = await import("../../../src/audit/sinks/CloudWatchSink.js");

    sink = new MockedSink({
      logGroupName: "/test/group",
      logStreamName: "stream",
      batchSize: 100,
      flushIntervalMs: 60000,
    }) as any;

    await new Promise((r) => setTimeout(r, 100));

    sink!.send(makeEntry({ toolName: "read_data" }));
    sink!.send(makeEntry({ toolName: "list_tables" }));
    await sink!.flush();

    const putCmd = commands.find((c) => c.name === "PutLogEventsCommand");
    expect(putCmd).toBeDefined();
    expect(putCmd!.input.logGroupName).toBe("/test/group");
    expect(putCmd!.input.logStreamName).toBe("stream");
    expect(putCmd!.input.logEvents).toHaveLength(2);
    expect(putCmd!.input.logEvents[0].message).toContain("read_data");
  });

  it("disables gracefully when SDK not available", async () => {
    vi.doMock("@aws-sdk/client-cloudwatch-logs", () => {
      throw new Error("Cannot find module");
    });

    const { CloudWatchSink: MockedSink } = await import("../../../src/audit/sinks/CloudWatchSink.js");

    // Suppress stderr
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as any;

    sink = new MockedSink({
      logGroupName: "/test/group",
      flushIntervalMs: 60000,
    }) as any;

    await new Promise((r) => setTimeout(r, 200));
    process.stderr.write = origWrite;

    // Should silently accept entries without throwing
    sink!.send(makeEntry());
    await sink!.flush();
  });
});
