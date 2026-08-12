import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL_ROLES_PATH = join(getAgentDir(), "model-roles.json");
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type ModelTargetSource = "role" | "direct" | "current";
export type ConfigIssueCode =
  | "invalid-json"
  | "invalid-root"
  | "invalid-roles"
  | "invalid-role"
  | "invalid-cycle-order";
export type ResolutionIssueCode =
  | "invalid-reference"
  | "invalid-thinking-level"
  | "unknown-role"
  | "role-cycle"
  | "model-not-found"
  | "authentication-failed"
  | "registry-error";

export interface ModelLike {
  provider: string;
  id: string;
}

export interface ModelAuth {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ModelRegistryLike<Model extends ModelLike> {
  find(provider: string, modelId: string): Model | undefined;
  getApiKeyAndHeaders(model: Model): Promise<ModelAuth>;
}

export interface ConfigIssue {
  code: ConfigIssueCode;
  message: string;
  role?: string;
  index?: number;
}

export interface ModelRolesConfig {
  roles: Readonly<Record<string, string>>;
  roleOrder: readonly string[];
  cycleOrder: readonly string[];
  issues: readonly ConfigIssue[];
}

export interface ResolutionIssue {
  code: ResolutionIssueCode;
  message: string;
  role?: string;
  chain?: readonly string[];
  model?: string;
}

export interface ResolvedModelTarget<Model extends ModelLike> {
  requested?: string;
  requestedSource: ModelTargetSource;
  source: ModelTargetSource;
  role?: string;
  roleChain: readonly string[];
  model: Model;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  auth: ModelAuth & { ok: true };
  fallback: boolean;
  issues: readonly ResolutionIssue[];
}

export interface UnresolvedModelTarget {
  requested?: string;
  requestedSource: ModelTargetSource;
  role?: string;
  roleChain: readonly string[];
  issues: readonly ResolutionIssue[];
}

export type ModelTargetResolution<Model extends ModelLike> =
  | ResolvedModelTarget<Model>
  | UnresolvedModelTarget;

export interface ResolveModelTargetOptions<Model extends ModelLike> {
  target?: string;
  currentModel?: Model;
  modelRegistry: ModelRegistryLike<Model>;
  config?: ModelRolesConfig;
  allowCurrentFallback?: boolean;
}

const ROLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function roleReferenceIssue(value: string): ResolutionIssueCode | undefined {
  const colon = value.lastIndexOf(":");
  const rolePart = colon < 0 ? value.slice(1) : value.slice(1, colon);
  if (!ROLE_NAME_PATTERN.test(rolePart)) return "invalid-reference";
  if (colon >= 0 && !THINKING_LEVEL_SET.has(value.slice(colon + 1))) return "invalid-thinking-level";
  return undefined;
}

function isValidRoleValue(value: string): boolean {
  if (value.startsWith("@")) return roleReferenceIssue(value) === undefined;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1 && value === value.trim();
}

export function normalizeModelRoles(value: unknown): ModelRolesConfig {
  const issues: ConfigIssue[] = [];
  if (!isObject(value)) {
    return {
      roles: {},
      roleOrder: [],
      cycleOrder: [],
      issues: [{ code: "invalid-root", message: "The model roles root must be an object." }],
    };
  }
  if (!isObject(value.roles)) {
    return {
      roles: {},
      roleOrder: [],
      cycleOrder: [],
      issues: [{ code: "invalid-roles", message: "The roles field must be an object." }],
    };
  }

  const roles: Record<string, string> = {};
  for (const [name, rawRole] of Object.entries(value.roles)) {
    if (!ROLE_NAME_PATTERN.test(name) || typeof rawRole !== "string" || !rawRole.trim() || !isValidRoleValue(rawRole)) {
      issues.push({ code: "invalid-role", role: name, message: `Role ${JSON.stringify(name)} is invalid.` });
      continue;
    }
    roles[name] = rawRole;
  }
  const roleOrder = Object.keys(roles);

  if (value.cycleOrder === undefined) return { roles, roleOrder, cycleOrder: roleOrder, issues };
  if (!Array.isArray(value.cycleOrder)) {
    issues.push({ code: "invalid-cycle-order", message: "cycleOrder must be an array of unique configured role names." });
    return { roles, roleOrder, cycleOrder: [], issues };
  }

  const seen = new Set<string>();
  const cycleOrder: string[] = [];
  value.cycleOrder.forEach((entry, index) => {
    if (typeof entry !== "string" || !ROLE_NAME_PATTERN.test(entry) || !(entry in roles) || seen.has(entry)) {
      issues.push({
        code: "invalid-cycle-order",
        index,
        message: `cycleOrder entry at index ${index} is not a unique configured role name.`,
      });
      return;
    }
    seen.add(entry);
    cycleOrder.push(entry);
  });
  return { roles, roleOrder, cycleOrder, issues };
}

export function loadModelRoles(path = MODEL_ROLES_PATH): ModelRolesConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { roles: {}, roleOrder: [], cycleOrder: [], issues: [] };
    }
    return {
      roles: {},
      roleOrder: [],
      cycleOrder: [],
      issues: [{ code: "invalid-json", message: `Unable to read model roles: ${String(error)}` }],
    };
  }
  try {
    return normalizeModelRoles(JSON.parse(text));
  } catch (error) {
    return {
      roles: {},
      roleOrder: [],
      cycleOrder: [],
      issues: [{ code: "invalid-json", message: `Invalid model-roles.json: ${String(error)}` }],
    };
  }
}

interface ParsedTarget {
  direct?: string;
  role?: string;
  roleChain: string[];
  thinkingLevel?: ThinkingLevel;
  issue?: ResolutionIssue;
}

function parseRoleReference(value: string): { role: string; thinkingLevel?: ThinkingLevel } | ResolutionIssue {
  const issueCode = roleReferenceIssue(value);
  if (issueCode) {
    return {
      code: issueCode,
      message: issueCode === "invalid-thinking-level"
        ? `Role reference ${JSON.stringify(value)} has an unsupported thinking level.`
        : `Role reference ${JSON.stringify(value)} is invalid.`,
    };
  }
  const colon = value.lastIndexOf(":");
  return {
    role: colon < 0 ? value.slice(1) : value.slice(1, colon),
    ...(colon < 0 ? {} : { thinkingLevel: value.slice(colon + 1) as ThinkingLevel }),
  };
}

function parseTarget(target: string, config: ModelRolesConfig): ParsedTarget {
  if (!target.startsWith("@")) {
    const slash = target.indexOf("/");
    return slash > 0 && slash < target.length - 1
      ? { direct: target, roleChain: [] }
      : {
          roleChain: [],
          issue: { code: "invalid-reference", message: `Model reference ${JSON.stringify(target)} is invalid.` },
        };
  }

  let current = target;
  let thinkingLevel: ThinkingLevel | undefined;
  const roleChain: string[] = [];
  const visited = new Set<string>();
  let requestedRole: string | undefined;
  while (current.startsWith("@")) {
    const parsed = parseRoleReference(current);
    if ("code" in parsed) return { role: requestedRole, roleChain, thinkingLevel, issue: { ...parsed, chain: roleChain } };
    requestedRole ??= parsed.role;
    thinkingLevel ??= parsed.thinkingLevel;
    if (visited.has(parsed.role)) {
      return {
        role: requestedRole,
        roleChain,
        thinkingLevel,
        issue: {
          code: "role-cycle",
          role: parsed.role,
          chain: [...roleChain, parsed.role],
          message: `Role cycle detected: ${[...roleChain, parsed.role].join(" -> ")}.`,
        },
      };
    }
    visited.add(parsed.role);
    roleChain.push(parsed.role);
    const value = config.roles[parsed.role];
    if (value === undefined) {
      return {
        role: requestedRole,
        roleChain,
        thinkingLevel,
        issue: {
          code: "unknown-role",
          role: parsed.role,
          chain: roleChain,
          message: `Role ${JSON.stringify(parsed.role)} is not configured.`,
        },
      };
    }
    current = value;
  }
  return { direct: current, role: requestedRole, roleChain, thinkingLevel };
}

function splitDirectReference(value: string): { provider: string; modelId: string; thinkingLevel?: ThinkingLevel } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  const provider = value.slice(0, slash);
  let modelId = value.slice(slash + 1);
  const colon = modelId.lastIndexOf(":");
  let thinkingLevel: ThinkingLevel | undefined;
  if (colon > 0 && THINKING_LEVEL_SET.has(modelId.slice(colon + 1))) {
    thinkingLevel = modelId.slice(colon + 1) as ThinkingLevel;
    modelId = modelId.slice(0, colon);
  }
  return provider && modelId ? { provider, modelId, thinkingLevel } : undefined;
}

function modelKey(model: ModelLike): string {
  return `${model.provider}/${model.id}`;
}

export async function resolveModelTarget<Model extends ModelLike>(
  options: ResolveModelTargetOptions<Model>,
): Promise<ModelTargetResolution<Model>> {
  const config = options.config ?? loadModelRoles();
  const requested = options.target?.trim() || undefined;
  const requestedSource: ModelTargetSource = requested?.startsWith("@")
    ? "role"
    : requested
      ? "direct"
      : "current";
  const parsed = requested ? parseTarget(requested, config) : { roleChain: [] };
  const issues: ResolutionIssue[] = parsed.issue ? [parsed.issue] : [];
  const candidates: Array<{
    model?: Model;
    source: ModelTargetSource;
    identity?: string;
    thinkingLevel?: ThinkingLevel;
    fallback: boolean;
  }> = [];

  if (parsed.direct && !parsed.issue) {
    const direct = splitDirectReference(parsed.direct);
    if (!direct) {
      issues.push({ code: "invalid-reference", message: `Model reference ${JSON.stringify(parsed.direct)} is invalid.` });
    } else {
      try {
        const fullModelId = parsed.direct.slice(parsed.direct.indexOf("/") + 1);
        const exactModel = options.modelRegistry.find(direct.provider, fullModelId);
        if (exactModel) {
          candidates.push({
            model: exactModel,
            source: requestedSource,
            identity: modelKey(exactModel),
            thinkingLevel: parsed.thinkingLevel,
            fallback: false,
          });
        } else {
          const suffixedModel = options.modelRegistry.find(direct.provider, direct.modelId);
          candidates.push({
            model: suffixedModel,
            source: requestedSource,
            identity: `${direct.provider}/${direct.modelId}`,
            thinkingLevel: parsed.thinkingLevel ?? direct.thinkingLevel,
            fallback: false,
          });
        }
      } catch (error) {
        issues.push({ code: "registry-error", model: parsed.direct, message: `Model registry lookup failed: ${String(error)}` });
      }
    }
  }

  if (!requested && options.currentModel) {
    candidates.push({ model: options.currentModel, source: "current", identity: modelKey(options.currentModel), fallback: false });
  } else if (options.allowCurrentFallback !== false && options.currentModel) {
    const currentIdentity = modelKey(options.currentModel);
    const duplicate = candidates.find((candidate) => candidate.identity === currentIdentity);
    if (duplicate && duplicate.model === undefined) {
      duplicate.model = options.currentModel;
    } else if (!duplicate) {
      candidates.push({ model: options.currentModel, source: "current", identity: currentIdentity, fallback: true });
    }
  }

  for (const candidate of candidates) {
    if (!candidate.model) {
      issues.push({
        code: "model-not-found",
        model: candidate.identity,
        message: `Model ${JSON.stringify(candidate.identity)} was not found.`,
      });
      continue;
    }
    try {
      const auth = await options.modelRegistry.getApiKeyAndHeaders(candidate.model);
      if (!auth.ok) {
        issues.push({
          code: "authentication-failed",
          model: candidate.identity,
          message: `Authentication failed for ${JSON.stringify(candidate.identity)}.`,
        });
        continue;
      }
      return {
        requested,
        requestedSource,
        source: candidate.source,
        ...(parsed.role ? { role: parsed.role } : {}),
        roleChain: parsed.roleChain,
        model: candidate.model,
        modelId: modelKey(candidate.model),
        ...(candidate.thinkingLevel ? { thinkingLevel: candidate.thinkingLevel } : {}),
        auth: auth as ModelAuth & { ok: true },
        fallback: candidate.fallback,
        issues,
      };
    } catch (error) {
      issues.push({
        code: "registry-error",
        model: candidate.identity,
        message: `Authentication lookup failed for ${JSON.stringify(candidate.identity)}: ${String(error)}`,
      });
    }
  }

  return {
    requested,
    requestedSource,
    ...(parsed.role ? { role: parsed.role } : {}),
    roleChain: parsed.roleChain,
    issues,
  };
}

export function selectThinkingLevel(
  explicit: ThinkingLevel | undefined,
  role: ThinkingLevel | undefined,
  fallback: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  return explicit ?? role ?? fallback;
}

export function isResolvedModelTarget<Model extends ModelLike>(
  resolution: ModelTargetResolution<Model>,
): resolution is ResolvedModelTarget<Model> {
  return "model" in resolution;
}
