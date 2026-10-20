import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WHY: `authMode: "aad"` used to hardcode InteractiveBrowserCredential, so every
// environment opened a browser popup. This guards the opt-in switch so a future
// refactor cannot silently drop the AAD_CREDENTIAL branch and regress headless use.
//
// `azcli` intentionally uses AzureCliCredential, not DefaultAzureCredential: on a
// host with service-principal env vars or managed identity configured, the default
// chain can acquire a token for a different principal than the user's `az login`.
const mocks = vi.hoisted(() => {
  const expiresOnTimestamp = Date.now() + 60 * 60 * 1000;
  const browserGetToken = vi.fn().mockResolvedValue({
    token: "browser-token",
    expiresOnTimestamp,
  });
  const defaultGetToken = vi.fn().mockResolvedValue({
    token: "default-token",
    expiresOnTimestamp,
  });
  const cliGetToken = vi.fn().mockResolvedValue({
    token: "cli-token",
    expiresOnTimestamp,
  });
  return {
    browserGetToken,
    defaultGetToken,
    cliGetToken,
    InteractiveBrowserCredential: vi.fn(() => ({ getToken: browserGetToken })),
    DefaultAzureCredential: vi.fn(() => ({ getToken: defaultGetToken })),
    AzureCliCredential: vi.fn(() => ({ getToken: cliGetToken })),
  };
});

vi.mock("@azure/identity", () => ({
  InteractiveBrowserCredential: mocks.InteractiveBrowserCredential,
  DefaultAzureCredential: mocks.DefaultAzureCredential,
  AzureCliCredential: mocks.AzureCliCredential,
}));

import { EnvironmentManager } from "../../src/config/EnvironmentManager.js";

const env = {
  name: "test",
  server: "example.database.windows.net",
  database: "example",
  authMode: "aad" as const,
};

async function resolveAadConfig() {
  const manager = await EnvironmentManager.create();
  return (manager as any).createSqlConfig(env);
}

describe("AAD credential selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SERVER_NAME = "example.database.windows.net";
    process.env.DATABASE_NAME = "example";
    delete process.env.AAD_CREDENTIAL;
    delete process.env.AZURE_TENANT_ID;
  });

  afterEach(() => {
    delete process.env.SERVER_NAME;
    delete process.env.DATABASE_NAME;
    delete process.env.AAD_CREDENTIAL;
    delete process.env.AZURE_TENANT_ID;
  });

  it("defaults to the interactive browser credential when AAD_CREDENTIAL is unset", async () => {
    const result = await resolveAadConfig();

    expect(mocks.InteractiveBrowserCredential).toHaveBeenCalledWith({
      redirectUri: "http://localhost",
    });
    expect(mocks.DefaultAzureCredential).not.toHaveBeenCalled();
    expect(mocks.AzureCliCredential).not.toHaveBeenCalled();
    expect(mocks.browserGetToken).toHaveBeenCalledWith("https://database.windows.net/.default");
    expect(result.config.authentication.options.token).toBe("browser-token");
  });

  it("keeps the browser credential for an explicit browser value", async () => {
    process.env.AAD_CREDENTIAL = "browser";

    await resolveAadConfig();

    expect(mocks.InteractiveBrowserCredential).toHaveBeenCalled();
    expect(mocks.DefaultAzureCredential).not.toHaveBeenCalled();
    expect(mocks.AzureCliCredential).not.toHaveBeenCalled();
  });

  it("uses AzureCliCredential for azcli", async () => {
    process.env.AAD_CREDENTIAL = "azcli";

    const result = await resolveAadConfig();

    expect(mocks.AzureCliCredential).toHaveBeenCalledWith({ tenantId: undefined });
    expect(mocks.DefaultAzureCredential).not.toHaveBeenCalled();
    expect(mocks.InteractiveBrowserCredential).not.toHaveBeenCalled();
    expect(mocks.cliGetToken).toHaveBeenCalledWith("https://database.windows.net/.default");
    expect(result.config.authentication.options.token).toBe("cli-token");
  });

  it("passes AZURE_TENANT_ID through to AzureCliCredential", async () => {
    process.env.AAD_CREDENTIAL = "azcli";
    process.env.AZURE_TENANT_ID = "tenant-123";

    await resolveAadConfig();

    expect(mocks.AzureCliCredential).toHaveBeenCalledWith({ tenantId: "tenant-123" });
  });

  it("uses DefaultAzureCredential for default and passes AZURE_TENANT_ID", async () => {
    process.env.AAD_CREDENTIAL = "default";
    process.env.AZURE_TENANT_ID = "tenant-123";

    const result = await resolveAadConfig();

    expect(mocks.DefaultAzureCredential).toHaveBeenCalledWith({ tenantId: "tenant-123" });
    expect(mocks.AzureCliCredential).not.toHaveBeenCalled();
    expect(mocks.InteractiveBrowserCredential).not.toHaveBeenCalled();
    expect(mocks.defaultGetToken).toHaveBeenCalledWith("https://database.windows.net/.default");
    expect(result.config.authentication.options.token).toBe("default-token");
  });
});
