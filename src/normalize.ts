import type { Json, JsonObject, N8nNode, RemoteCredential, RemoteWorkflow, StoredWorkflow } from "./types.js";

/** Marker used in Git for a reference to another workflow, resolved per environment by name. */
export const WF_REF = "@workflow:";

const NODE_KEYS = new Set([
  "id",
  "name",
  "webhookId",
  "disabled",
  "notesInFlow",
  "notes",
  "type",
  "typeVersion",
  "executeOnce",
  "alwaysOutputData",
  "retryOnFail",
  "maxTries",
  "waitBetweenTries",
  "continueOnFail",
  "onError",
  "position",
  "parameters",
  "credentials",
]);

/**
 * Settings accepted by the public API across n8n 1.x/2.x. Newer keys are sent only if present in Git;
 * push retries with a minimal set if an older instance rejects them.
 */
export const SAFE_SETTINGS = new Set([
  "saveExecutionProgress",
  "saveManualExecutions",
  "saveDataErrorExecution",
  "saveDataSuccessExecution",
  "executionTimeout",
  "errorWorkflow",
  "timezone",
  "executionOrder",
  "callerPolicy",
  "callerIds",
  "timeSavedPerExecution",
  "availableInMCP",
]);

const EXECUTE_WORKFLOW_TYPES = new Set([
  "n8n-nodes-base.executeWorkflow",
  "@n8n/n8n-nodes-langchain.toolWorkflow",
]);

export function sortKeys<T extends Json>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sortKeys(v)) as T;
  if (value && typeof value === "object") {
    const out: JsonObject = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as JsonObject)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out as T;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value as Json), null, 2) + "\n";
}

type Mapper = (value: string) => string;

/** Rewrites workflow references inside a node (sub-workflow calls). */
function mapNodeWorkflowRefs(node: N8nNode, map: Mapper): N8nNode {
  if (!EXECUTE_WORKFLOW_TYPES.has(node.type) || !node.parameters) return node;
  const params = { ...node.parameters };
  const ref = params.workflowId;
  if (typeof ref === "string" && ref && !ref.startsWith("=")) {
    params.workflowId = map(ref);
  } else if (ref && typeof ref === "object" && !Array.isArray(ref)) {
    const rl = { ...(ref as JsonObject) };
    if (typeof rl.value === "string" && rl.value && !rl.value.startsWith("=")) {
      rl.value = map(rl.value);
      delete rl.cachedResultUrl;
      if (rl.value.startsWith(WF_REF)) rl.cachedResultName = rl.value.slice(WF_REF.length);
    }
    params.workflowId = rl;
  }
  return { ...node, parameters: params };
}

function mapSettingsRefs(settings: JsonObject, map: Mapper): JsonObject {
  const out = { ...settings };
  if (typeof out.errorWorkflow === "string" && out.errorWorkflow) out.errorWorkflow = map(out.errorWorkflow);
  if (typeof out.callerIds === "string" && out.callerIds) {
    out.callerIds = out.callerIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(map)
      .join(",");
  }
  return out;
}

/** Converts an API workflow into its environment-agnostic Git form. */
export function toStored(wf: RemoteWorkflow, idToName: Map<string, string>): StoredWorkflow {
  const toRef: Mapper = (id) => (idToName.has(id) ? WF_REF + idToName.get(id) : id);
  const nodes = (wf.nodes ?? [])
    .map((n) => {
      const clean: N8nNode = { name: n.name, type: n.type };
      for (const [k, v] of Object.entries(n)) if (NODE_KEYS.has(k) && v !== undefined) clean[k] = v;
      if (n.credentials) {
        const creds: Record<string, { name?: string }> = {};
        for (const [type, c] of Object.entries(n.credentials)) creds[type] = { name: c?.name };
        clean.credentials = creds;
      }
      return mapNodeWorkflowRefs(clean, toRef);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return sortKeys({
    name: wf.name,
    active: Boolean(wf.active),
    tags: (wf.tags ?? []).map((t) => t.name).sort(),
    settings: mapSettingsRefs((wf.settings ?? {}) as JsonObject, toRef),
    nodes: nodes as unknown as Json,
    connections: (wf.connections ?? {}) as Json,
  } as unknown as Json) as unknown as StoredWorkflow;
}

export interface ResolveContext {
  /** Workflow name -> ID on the target instance. */
  workflowIds: Map<string, string>;
  /** "<type>:<name>" -> ID on the target instance. */
  credentialIds: Map<string, string>;
  /** Credential names known to exist on the target (used when IDs cannot be listed). */
  credentialsListable: boolean;
}

export interface ResolveIssue {
  workflow: string;
  node?: string;
  message: string;
}

/** Converts a Git workflow into an API request body for a specific instance. */
export function toApiBody(
  wf: StoredWorkflow,
  ctx: ResolveContext,
  opts: { minimalSettings?: boolean } = {},
): { body: JsonObject; issues: ResolveIssue[] } {
  const issues: ResolveIssue[] = [];
  const fromRef = (node?: string): Mapper => (value) => {
    if (!value.startsWith(WF_REF)) return value;
    const name = value.slice(WF_REF.length);
    const id = ctx.workflowIds.get(name);
    if (!id) {
      issues.push({ workflow: wf.name, node, message: `references workflow "${name}" which does not exist on target` });
      return value;
    }
    return id;
  };

  const nodes = wf.nodes.map((n) => {
    let node: N8nNode = { ...n };
    if (n.credentials) {
      const creds: Record<string, { id?: string; name?: string }> = {};
      for (const [type, c] of Object.entries(n.credentials)) {
        const name = c?.name ?? "";
        const id = ctx.credentialIds.get(`${type}:${name}`);
        if (id) creds[type] = { id, name };
        else {
          if (ctx.credentialsListable) {
            issues.push({ workflow: wf.name, node: n.name, message: `credential "${name}" (${type}) not found on target` });
          }
          creds[type] = { name };
        }
      }
      node.credentials = creds;
    }
    node = mapNodeWorkflowRefs(node, fromRef(n.name));
    return node;
  });

  let settings: JsonObject = {};
  for (const [k, v] of Object.entries(wf.settings ?? {})) if (SAFE_SETTINGS.has(k)) settings[k] = v;
  settings = mapSettingsRefs(settings, fromRef());
  if (opts.minimalSettings) {
    settings = { executionOrder: (wf.settings?.executionOrder as string) ?? "v1" };
  }
  if (Object.keys(settings).length === 0) settings = { executionOrder: "v1" };

  return {
    body: {
      name: wf.name,
      nodes: nodes as unknown as Json,
      connections: wf.connections,
      settings,
    },
    issues,
  };
}

export function credentialIndex(creds: RemoteCredential[], overrides: Record<string, string> = {}): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of creds) m.set(`${c.type}:${c.name}`, c.id);
  for (const [k, v] of Object.entries(overrides)) m.set(k, v);
  return m;
}
