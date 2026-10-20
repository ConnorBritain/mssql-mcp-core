import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WHY: `authMode: "aad"` used to hardcode InteractiveBrowserCredential, so every
// environment opened a browser popup. This guards the opt-in switch so a future
// refactor cannot silently drop the AAD_CREDENTIAL branch and regress headless use.
const mocks = vi.hoisted(() => {
  const browserGetToken = vi.fn().mockResolvedValue({
    token: "browser-token",
    expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
  });
  const defaultGetToken = vi.fn().mockResolvedValue({
    token: "default-token",
    expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
  });
  return {
    browserGetToken,
    defaultGetToken,
    InteractiveBrowserCredential: vi.fn(() => ({ getToken: browserGetToken })),
    DefaultAzureCredential: vi.fn(() => ({ getToken: defaultGetToken })),
  };
});

vi.mock("@azure/identity", () => ({
  InteractiveBrowserCredential: mocks.InteractiveBrowserCredential,
  DefaultAzureCredential: mocks.DefaultAzureCredential,
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
    expect(mocks.browserGetToken).toHaveBeenCalledWith("https://database.windows.net/.default");
    expect(result.config.authentication.options.token).toBe("browser-token");
  });

  it("uses DefaultAzureCredential for azcli", async () => {
    process.env.AAD_CREDENTIAL = "azcli";

    const result = await resolveAadConfig();

    expect(mocks.DefaultAzureCredential).toHaveBeenCalledWith({ tenantId: undefined });
    expect(mocks.InteractiveBrowserCredential).not.toHaveBeenCalled();
    expect(mocks.defaultGetToken).toHaveBeenCalledWith("https://database.windows.net/.default");
    expect(result.config.authentication.options.token).toBe("default-token");
  });

  it("passes AZURE_TENANT_ID through to DefaultAzureCredential", async () => {
    process.env.AAD_CREDENTIAL = "default";
    process.env.AZURE_TENANT_ID = "tenant-123";

    await resolveAadConfig();

    expect(mocks.DefaultAzureCredential).toHaveBeenCalledWith({ tenantId: "tenant-123" });
    expect(mocks.InteractiveBrowserCredential).not.toHaveBeenCalled();
  });

  it("keeps the browser credential for an explicit browser value", async () => {
    process.env.AAD_CREDENTIAL = "browser";

    await resolveAadConfig();

    expect(mocks.InteractiveBrowserCredential).toHaveBeenCalled();
    expect(mocks.DefaultAzureCredential).not.toHaveBeenCalled();
  });
});
