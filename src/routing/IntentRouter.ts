import { getEnvironmentManager } from "../config/EnvironmentManager.js";
import type {
  IntentCategory,
  IntentRouterOptions,
  ToolRoutingConfig,
  RoutingCandidate,
  RouteParams,
  RouteResult,
} from "../types.js";

export class IntentRouter {
  private readonly tools: ToolRoutingConfig[];
  private readonly allowMutations: boolean;
  private readonly requireConfirmationForMutations: boolean;

  constructor(options: IntentRouterOptions) {
    this.tools = options.tools;
    this.allowMutations = options.allowMutations;
    this.requireConfirmationForMutations = options.requireConfirmationForMutations;
  }

  async route(params: RouteParams): Promise<RouteResult> {
    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
    if (!prompt) {
      return {
        success: false,
        message: "Prompt is required to route intent.",
        error: "MISSING_PROMPT",
      };
    }

    const toolArguments = this.normalizeArguments(params.toolArguments ?? {});
    const confirmIntent = Boolean(params.confirmIntent);
    const preferredToolName = params.preferredToolName;
    const normalizedPrompt = prompt.toLowerCase();

    // Infer environment from prompt if not explicitly provided
    const environment = params.environment || await this.inferEnvironment(normalizedPrompt);
    if (environment) {
      toolArguments.environment = environment;
    }

    const inferredIntent = this.inferIntent(normalizedPrompt, toolArguments);
    const eligibleTools = this.tools.filter((tool) => this.isToolEligible(tool));

    const candidates = eligibleTools
      .map((tool) =>
        this.scoreTool(tool, normalizedPrompt, toolArguments, inferredIntent, preferredToolName)
      )
      .filter((candidate): candidate is RoutingCandidate => candidate.score > Number.NEGATIVE_INFINITY)
      .sort((a, b) => b.score - a.score);

    const bestCandidate = candidates[0];
    if (!bestCandidate || bestCandidate.score <= 0) {
      return {
        success: false,
        message:
          "Unable to determine an appropriate SQL tool for the provided prompt. Try specifying the desired action more concretely (e.g., 'list tables', 'describe table X', 'run SELECT ...').",
        error: "NO_TOOL_MATCH",
      };
    }

    const missingArgs = this.getMissingArguments(bestCandidate.config, toolArguments);
    if (missingArgs.length) {
      return {
        success: false,
        routedTool: bestCandidate.config.name,
        message: `Selected tool '${bestCandidate.config.name}' requires argument(s): ${missingArgs.join(", ")}. Provide them in the request arguments.`,
        error: "MISSING_ARGUMENTS",
      };
    }

    const requiresConfirmation =
      (bestCandidate.config.requiresConfirmation ||
        bestCandidate.config.mutatesData ||
        bestCandidate.config.schemaChange) &&
      this.requireConfirmationForMutations;

    if (requiresConfirmation && !confirmIntent) {
      return {
        success: false,
        routedTool: bestCandidate.config.name,
        message:
          "This operation modifies data or schema. Re-run with confirmIntent: true to proceed.",
        error: "CONFIRMATION_REQUIRED",
      };
    }

    try {
      const result = await bestCandidate.config.tool.run(toolArguments);
      return {
        success: true,
        routedTool: bestCandidate.config.name,
        intent: inferredIntent,
        reasoning: bestCandidate.reasons,
        toolResult: result,
        selectedEnvironment: environment,
      };
    } catch (error) {
      return {
        success: false,
        routedTool: bestCandidate.config.name,
        message: `Routed tool '${bestCandidate.config.name}' failed: ${error}`,
        error: "ROUTED_TOOL_FAILED",
        selectedEnvironment: environment,
      };
    }
  }

  private async inferEnvironment(prompt: string): Promise<string | undefined> {
    const envManager = await getEnvironmentManager();
    const environments = envManager.listEnvironments();

    for (const env of environments) {
      const patterns = [
        new RegExp(`\\b${env.name}\\b`, "i"),
        new RegExp(`\\b${env.name.replace(/-/g, "\\s")}\\b`, "i"),
      ];

      for (const pattern of patterns) {
        if (pattern.test(prompt)) {
          return env.name;
        }
      }
    }

    const envKeywords: Record<string, string[]> = {
      prod: ["production", "prod", "live"],
      staging: ["staging", "stage", "uat"],
      dev: ["development", "dev", "local"],
    };

    for (const [envSuffix, keywords] of Object.entries(envKeywords)) {
      for (const keyword of keywords) {
        if (prompt.includes(keyword)) {
          const matchingEnv = environments.find((e) =>
            e.name.toLowerCase().includes(envSuffix)
          );
          if (matchingEnv) {
            return matchingEnv.name;
          }
        }
      }
    }

    return undefined;
  }

  private normalizeArguments(args: any) {
    if (!args || typeof args !== "object") {
      return {};
    }
    const cloned: Record<string, any> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) {
        cloned[key] = value;
      }
    }
    return cloned;
  }

  private isToolEligible(tool: ToolRoutingConfig) {
    if (this.allowMutations) {
      return true;
    }
    return !tool.mutatesData && !tool.schemaChange;
  }

  private inferIntent(prompt: string, toolArguments: Record<string, any>): IntentCategory {
    const detectors: Array<{ intent: IntentCategory; keywords: string[] }> = [
      {
        intent: "schema_change",
        keywords: ["create table", "drop table", "create index", "drop index", "alter", "ddl"],
      },
      {
        intent: "data_write",
        keywords: ["update", "insert", "delete", "fix", "modify", "change", "correct"],
      },
      {
        intent: "metadata",
        keywords: ["profile", "sample", "statistics", "distribution", "quality"],
      },
      {
        intent: "schema_discovery",
        keywords: ["describe", "columns", "list tables", "show tables", "schema", "search"],
      },
      {
        intent: "data_read",
        keywords: ["select", "query", "fetch", "count", "report", "view"],
      },
    ];

    for (const detector of detectors) {
      if (detector.keywords.some((keyword) => prompt.includes(keyword))) {
        return detector.intent;
      }
    }

    const sqlSnippet = this.extractSqlSnippet(toolArguments);
    if (sqlSnippet) {
      if (sqlSnippet.startsWith("select")) {
        return "data_read";
      }
      if (sqlSnippet.startsWith("update") || sqlSnippet.startsWith("delete")) {
        return "data_write";
      }
      if (sqlSnippet.startsWith("insert")) {
        return "data_write";
      }
      if (sqlSnippet.startsWith("create") || sqlSnippet.startsWith("drop")) {
        return "schema_change";
      }
    }

    if (toolArguments?.tablePattern || toolArguments?.columnPattern) {
      return "schema_discovery";
    }

    return "data_read";
  }

  private extractSqlSnippet(args: Record<string, any>) {
    const sqlCandidate =
      typeof args?.query === "string" ? args.query : typeof args?.sql === "string" ? args.sql : null;
    return sqlCandidate?.trim().toLowerCase() ?? null;
  }

  private scoreTool(
    config: ToolRoutingConfig,
    prompt: string,
    toolArguments: Record<string, any>,
    inferredIntent: IntentCategory,
    preferredToolName?: string
  ): RoutingCandidate {
    let score = config.baseScore ?? 0.5;
    const reasons: string[] = [];

    if (config.intents.includes(inferredIntent)) {
      score += 5;
      reasons.push(`intent match (${inferredIntent})`);
    }

    if (preferredToolName && config.name === preferredToolName) {
      score += 3;
      reasons.push("preferred tool match");
    }

    if (config.keywords?.length) {
      for (const keyword of config.keywords) {
        if (prompt.includes(keyword)) {
          score += 2;
          reasons.push(`keyword '${keyword}'`);
        }
      }
    }

    if (config.requiredArgs?.length) {
      for (const arg of config.requiredArgs) {
        if (this.hasArgument(toolArguments, arg)) {
          score += 1;
        } else {
          score -= 1;
        }
      }
    }

    if ((config.mutatesData || config.schemaChange) && !this.allowMutations) {
      score = Number.NEGATIVE_INFINITY;
    }

    return { config, score, reasons };
  }

  private hasArgument(args: Record<string, any>, key: string) {
    if (!args) {
      return false;
    }
    const value = args[key];
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === "object") {
      return Object.keys(value).length > 0;
    }
    return true;
  }

  private getMissingArguments(config: ToolRoutingConfig, args: Record<string, any>) {
    if (!config.requiredArgs || config.requiredArgs.length === 0) {
      return [];
    }
    return config.requiredArgs.filter((arg) => !this.hasArgument(args, arg));
  }
}
