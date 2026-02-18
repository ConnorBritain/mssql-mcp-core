import * as fs from "fs";
import * as path from "path";

export interface SecretProvider {
  type: string;
  resolve(name: string): string | undefined;
  initialize?(): Promise<void>;
}

export interface SecretProviderConfig {
  type: string;
  path?: string;
  directory?: string;
  // Azure Key Vault
  vaultUrl?: string;
  // AWS Secrets Manager
  region?: string;
  // HashiCorp Vault
  address?: string;
  token?: string;
  vaultPath?: string;
  // Common: explicit list of secrets to pre-fetch
  secrets?: string[];
  [key: string]: any;
}

export interface SecretsConfig {
  providers: SecretProviderConfig[];
}

/**
 * Resolves secrets from environment variables.
 */
class EnvProvider implements SecretProvider {
  type = "env";

  resolve(name: string): string | undefined {
    return process.env[name];
  }
}

/**
 * Resolves secrets from a .env file at an explicit absolute path.
 * Parses key=value lines, caches in memory.
 */
class DotenvProvider implements SecretProvider {
  type = "dotenv";
  private readonly cache: Map<string, string>;

  constructor(filePath: string) {
    this.cache = new Map();
    this.loadFile(filePath);
  }

  private loadFile(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;

        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();

        // Strip surrounding quotes (single or double)
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        if (key) {
          this.cache.set(key, value);
        }
      }
      console.error(`Loaded ${this.cache.size} secret(s) from dotenv file: ${filePath}`);
    } catch (error) {
      console.warn(`Failed to read dotenv file at ${filePath}: ${error}`);
    }
  }

  resolve(name: string): string | undefined {
    return this.cache.get(name);
  }
}

/**
 * Resolves secrets by reading individual files from a directory.
 * Looks for a file named `NAME` inside the configured directory.
 */
class FileProvider implements SecretProvider {
  type = "file";
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  resolve(name: string): string | undefined {
    // Prevent path traversal
    const safeName = path.basename(name);
    if (safeName !== name) {
      console.warn(`Secret name '${name}' contains path separators — rejected for safety`);
      return undefined;
    }

    const filePath = path.join(this.directory, safeName);
    try {
      return fs.readFileSync(filePath, "utf-8").trim();
    } catch {
      return undefined;
    }
  }
}

/**
 * Resolves secrets from Azure Key Vault.
 * Pre-fetches configured secrets during initialize() and serves them from an in-memory cache.
 * Uses DefaultAzureCredential from @azure/identity (already a project dependency).
 */
class AzureKeyVaultProvider implements SecretProvider {
  type = "azure-keyvault";
  private cache = new Map<string, string>();
  private readonly vaultUrl: string;
  private readonly secretNames?: string[];

  constructor(config: { vaultUrl: string; secrets?: string[] }) {
    this.vaultUrl = config.vaultUrl;
    this.secretNames = config.secrets;
  }

  async initialize(): Promise<void> {
    try {
      const { DefaultAzureCredential } = await import("@azure/identity");
      const { SecretClient } = await import("@azure/keyvault-secrets");

      const credential = new DefaultAzureCredential();
      const client = new SecretClient(this.vaultUrl, credential);

      if (this.secretNames && this.secretNames.length > 0) {
        // Fetch only the explicitly listed secrets
        const results = await Promise.allSettled(
          this.secretNames.map(async (name) => {
            const secret = await client.getSecret(name);
            if (secret.value !== undefined) {
              this.cache.set(name, secret.value);
            }
          })
        );

        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
          console.warn(
            `[azure-keyvault] Failed to fetch ${failures.length} secret(s): ` +
            failures.map((r) => (r as PromiseRejectedResult).reason?.message ?? "unknown").join(", ")
          );
        }
      } else {
        // List and fetch all secrets in the vault
        for await (const properties of client.listPropertiesOfSecrets()) {
          try {
            const secret = await client.getSecret(properties.name);
            if (secret.value !== undefined) {
              this.cache.set(properties.name, secret.value);
            }
          } catch (err: any) {
            console.warn(`[azure-keyvault] Failed to fetch secret '${properties.name}': ${err.message}`);
          }
        }
      }

      console.error(`[azure-keyvault] Loaded ${this.cache.size} secret(s) from ${this.vaultUrl}`);
    } catch (error: any) {
      console.error(`[azure-keyvault] Failed to initialize: ${error.message}`);
      throw error;
    }
  }

  resolve(name: string): string | undefined {
    return this.cache.get(name);
  }
}

/**
 * Resolves secrets from AWS Secrets Manager.
 * Pre-fetches configured secrets during initialize() and serves them from an in-memory cache.
 * Uses dynamic import of @aws-sdk/client-secrets-manager (optional dependency).
 */
class AwsSecretsManagerProvider implements SecretProvider {
  type = "aws-secrets-manager";
  private cache = new Map<string, string>();
  private readonly region: string;
  private readonly secretNames: string[];

  constructor(config: { region: string; secrets: string[] }) {
    this.region = config.region;
    this.secretNames = config.secrets;
  }

  async initialize(): Promise<void> {
    let sdk: any;
    try {
      sdk = await import("@aws-sdk/client-secrets-manager");
    } catch {
      throw new Error(
        "[aws-secrets-manager] @aws-sdk/client-secrets-manager is not installed. " +
        "Install it with: npm install @aws-sdk/client-secrets-manager"
      );
    }

    try {
      const client = new sdk.SecretsManagerClient({ region: this.region });

      // Use BatchGetSecretValue if available and multiple secrets requested
      if (this.secretNames.length > 1 && sdk.BatchGetSecretValueCommand) {
        try {
          const response = await client.send(
            new sdk.BatchGetSecretValueCommand({
              SecretIdList: this.secretNames,
            })
          );

          for (const secret of response.SecretValues ?? []) {
            if (secret.Name && secret.SecretString) {
              this.cache.set(secret.Name, secret.SecretString);
            }
          }

          // Report any errors
          for (const err of response.Errors ?? []) {
            console.warn(`[aws-secrets-manager] Failed to fetch '${err.SecretId}': ${err.Message}`);
          }
        } catch {
          // Fall back to individual GetSecretValue calls
          await this.fetchIndividually(client, sdk);
        }
      } else {
        await this.fetchIndividually(client, sdk);
      }

      console.error(`[aws-secrets-manager] Loaded ${this.cache.size} secret(s) from region ${this.region}`);
    } catch (error: any) {
      if (error.message?.includes("not installed")) throw error;
      console.error(`[aws-secrets-manager] Failed to initialize: ${error.message}`);
      throw error;
    }
  }

  private async fetchIndividually(client: any, sdk: any): Promise<void> {
    const results = await Promise.allSettled(
      this.secretNames.map(async (name) => {
        const response = await client.send(
          new sdk.GetSecretValueCommand({ SecretId: name })
        );
        if (response.SecretString) {
          this.cache.set(name, response.SecretString);
        }
      })
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      console.warn(
        `[aws-secrets-manager] Failed to fetch ${failures.length} secret(s): ` +
        failures.map((r) => (r as PromiseRejectedResult).reason?.message ?? "unknown").join(", ")
      );
    }
  }

  resolve(name: string): string | undefined {
    return this.cache.get(name);
  }
}

/**
 * Resolves secrets from HashiCorp Vault (KV v2 engine).
 * Pre-fetches configured secrets during initialize() via the Vault HTTP API.
 * No external dependencies — uses Node's built-in fetch (Node 18+).
 */
class HashiCorpVaultProvider implements SecretProvider {
  type = "hashicorp-vault";
  private cache = new Map<string, string>();
  private readonly address: string;
  private readonly vaultPath: string;
  private readonly token: string;
  private readonly secretNames?: string[];

  constructor(config: { address: string; token?: string; path: string; secrets?: string[] }) {
    this.address = config.address.replace(/\/+$/, ""); // strip trailing slash
    this.vaultPath = config.path;
    this.secretNames = config.secrets;

    // Resolve token: config > VAULT_TOKEN env > ~/.vault-token file
    this.token = config.token || process.env.VAULT_TOKEN || "";
    if (!this.token) {
      try {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "";
        const tokenPath = path.join(homeDir, ".vault-token");
        this.token = fs.readFileSync(tokenPath, "utf-8").trim();
      } catch {
        // Token will be empty — initialize() will fail with a clear error
      }
    }
  }

  async initialize(): Promise<void> {
    if (!this.token) {
      throw new Error(
        "[hashicorp-vault] No Vault token found. Provide 'token' in config, " +
        "set VAULT_TOKEN env var, or create ~/.vault-token"
      );
    }

    try {
      // Read from KV v2 path: GET /v1/{path}
      // The path should be in KV v2 format, e.g., "secret/data/mssql"
      const url = `${this.address}/v1/${this.vaultPath}`;
      const response = await fetch(url, {
        headers: {
          "X-Vault-Token": this.token,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body}`);
      }

      const json = await response.json() as any;

      // KV v2 returns data nested under data.data
      const secretData: Record<string, any> = json.data?.data ?? json.data ?? {};

      if (this.secretNames && this.secretNames.length > 0) {
        // Only cache the requested secrets
        for (const name of this.secretNames) {
          const value = secretData[name];
          if (value !== undefined) {
            this.cache.set(name, String(value));
          } else {
            console.warn(`[hashicorp-vault] Secret '${name}' not found at path '${this.vaultPath}'`);
          }
        }
      } else {
        // Cache all secrets from the path
        for (const [key, value] of Object.entries(secretData)) {
          this.cache.set(key, String(value));
        }
      }

      console.error(`[hashicorp-vault] Loaded ${this.cache.size} secret(s) from ${this.address}`);
    } catch (error: any) {
      console.error(`[hashicorp-vault] Failed to initialize: ${error.message}`);
      throw error;
    }
  }

  resolve(name: string): string | undefined {
    return this.cache.get(name);
  }
}

/**
 * Resolves ${secret:NAME} placeholders by querying an ordered list of providers.
 * First provider to return a value wins.
 */
export class SecretResolver {
  private readonly providers: SecretProvider[];

  constructor(providers: SecretProvider[]) {
    this.providers = providers;
  }

  /**
   * Resolve a single secret by name, trying each provider in order.
   */
  resolve(name: string): string | undefined {
    for (const provider of this.providers) {
      const value = provider.resolve(name);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /**
   * Replace all ${secret:NAME} placeholders in a string.
   */
  resolveString(value: string | undefined): string | undefined {
    if (!value) return value;

    const secretPattern = /\$\{secret:([^}]+)\}/g;
    return value.replace(secretPattern, (match, secretName) => {
      const resolved = this.resolve(secretName);
      if (resolved === undefined) {
        console.warn(`Secret '${secretName}' not found in any configured provider`);
        return match;
      }
      return resolved;
    });
  }

  /**
   * Recursively resolve secret placeholders in all string values of an object.
   */
  resolveObject<T extends Record<string, any>>(config: T): T {
    const resolved = { ...config };
    for (const [key, value] of Object.entries(resolved)) {
      if (typeof value === "string") {
        (resolved as any)[key] = this.resolveString(value);
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        (resolved as any)[key] = this.resolveObject(value);
      }
    }
    return resolved;
  }

  /**
   * Extract all ${secret:NAME} references from a string.
   */
  static extractSecretNames(value: string): string[] {
    const names: string[] = [];
    const pattern = /\$\{secret:([^}]+)\}/g;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      names.push(match[1]);
    }
    return names;
  }

  /**
   * Check which secret names are resolvable and which are not.
   */
  checkResolvability(names: string[]): { resolved: string[]; unresolved: string[] } {
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const name of names) {
      if (this.resolve(name) !== undefined) {
        resolved.push(name);
      } else {
        unresolved.push(name);
      }
    }
    return { resolved, unresolved };
  }

  get providerCount(): number {
    return this.providers.length;
  }

  get providerTypes(): string[] {
    return this.providers.map((p) => p.type);
  }
}

/**
 * Create a SecretResolver from configuration.
 * Defaults to [{ type: "env" }] if no config provided.
 * Now async to support vault providers that need initialization.
 */
export async function createSecretResolver(config?: SecretsConfig): Promise<SecretResolver> {
  const providerConfigs = config?.providers ?? [{ type: "env" }];
  const providers: SecretProvider[] = [];

  for (const pc of providerConfigs) {
    switch (pc.type) {
      case "env":
        providers.push(new EnvProvider());
        break;

      case "dotenv":
        if (!pc.path) {
          console.warn("Dotenv provider requires a 'path' — skipping");
          break;
        }
        providers.push(new DotenvProvider(pc.path));
        break;

      case "file":
        if (!pc.directory) {
          console.warn("File provider requires a 'directory' — skipping");
          break;
        }
        providers.push(new FileProvider(pc.directory));
        break;

      case "azure-keyvault": {
        if (!pc.vaultUrl) {
          console.warn("Azure Key Vault provider requires 'vaultUrl' — skipping");
          break;
        }
        providers.push(new AzureKeyVaultProvider({
          vaultUrl: pc.vaultUrl,
          secrets: pc.secrets,
        }));
        break;
      }

      case "aws-secrets-manager": {
        if (!pc.region) {
          console.warn("AWS Secrets Manager provider requires 'region' — skipping");
          break;
        }
        if (!pc.secrets || pc.secrets.length === 0) {
          console.warn("AWS Secrets Manager provider requires 'secrets' list — skipping");
          break;
        }
        providers.push(new AwsSecretsManagerProvider({
          region: pc.region,
          secrets: pc.secrets,
        }));
        break;
      }

      case "hashicorp-vault": {
        if (!pc.address) {
          console.warn("HashiCorp Vault provider requires 'address' — skipping");
          break;
        }
        if (!pc.vaultPath) {
          console.warn("HashiCorp Vault provider requires 'vaultPath' — skipping");
          break;
        }
        providers.push(new HashiCorpVaultProvider({
          address: pc.address,
          token: pc.token,
          path: pc.vaultPath,
          secrets: pc.secrets,
        }));
        break;
      }

      default:
        console.warn(`Unknown secret provider type '${pc.type}' — skipping`);
    }
  }

  // If no providers were successfully created, fall back to env
  if (providers.length === 0) {
    providers.push(new EnvProvider());
  }

  // Initialize any providers that need async setup (vault providers)
  for (const provider of providers) {
    if (provider.initialize) {
      await provider.initialize();
    }
  }

  return new SecretResolver(providers);
}

/**
 * Check if a dotenv provider config points to a readable file.
 */
export function validateDotenvPath(filePath: string): { valid: boolean; error?: string } {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return { valid: true };
  } catch {
    return { valid: false, error: `Dotenv file not readable: ${filePath}` };
  }
}

/**
 * Check if a file provider config points to a readable directory.
 */
export function validateFileDirectory(directory: string): { valid: boolean; error?: string } {
  try {
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) {
      return { valid: false, error: `Not a directory: ${directory}` };
    }
    fs.accessSync(directory, fs.constants.R_OK);
    return { valid: true };
  } catch {
    return { valid: false, error: `Directory not accessible: ${directory}` };
  }
}
