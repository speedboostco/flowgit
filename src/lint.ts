import type { Json, StoredWorkflow } from "./types.js";

export type Severity = "error" | "warning";

export interface LintIssue {
  rule: string;
  severity: Severity;
  workflow: string;
  node?: string;
  message: string;
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ["OpenAI/Anthropic-style API key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["GitHub token", /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe secret key", /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Bearer token", /\bBearer\s+[A-Za-z0-9\-._~+/]{24,}={0,2}/],
  ["Private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

const TRIGGER_RE = /trigger$|\.webhook$|\.cron$|\.schedule|\.formTrigger$|\.manualTrigger$|\.start$/i;
const NOTE_TYPES = new Set(["n8n-nodes-base.stickyNote"]);

function* strings(value: Json | undefined): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value && typeof value === "object") for (const v of Object.values(value)) yield* strings(v);
}

export function lintWorkflow(wf: StoredWorkflow): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (rule: string, severity: Severity, message: string, node?: string) =>
    issues.push({ rule, severity, workflow: wf.name, node, message });

  const connected = new Set<string>();
  for (const [src, byType] of Object.entries(wf.connections ?? {})) {
    connected.add(src);
    for (const outputs of Object.values((byType ?? {}) as Record<string, Json>)) {
      if (!Array.isArray(outputs)) continue;
      for (const targets of outputs) {
        if (!Array.isArray(targets)) continue;
        for (const t of targets) {
          const n = (t as { node?: string })?.node;
          if (n) connected.add(n);
        }
      }
    }
  }

  let hasTrigger = false;
  for (const node of wf.nodes) {
    if (NOTE_TYPES.has(node.type)) continue;
    const isTrigger = TRIGGER_RE.test(node.type);
    if (isTrigger) hasTrigger = true;

    for (const s of strings(node.parameters as Json)) {
      const hit = SECRET_PATTERNS.find(([, re]) => re.test(s));
      if (hit) {
        add("no-hardcoded-secrets", "error", `looks like a hardcoded ${hit[0]}; move it into an n8n credential`, node.name);
        break;
      }
    }

    if (node.type === "n8n-nodes-base.webhook") {
      const auth = node.parameters?.authentication;
      if (!auth || auth === "none") {
        add("webhook-auth", "warning", "webhook accepts unauthenticated requests", node.name);
      }
    }

    if (node.disabled) add("no-disabled-nodes", "warning", "node is disabled", node.name);

    if (!isTrigger && wf.nodes.length > 1 && !connected.has(node.name)) {
      add("no-orphan-nodes", "warning", "node is not connected to anything", node.name);
    }

    if (node.type === "n8n-nodes-base.httpRequest") {
      const url = node.parameters?.url;
      if (typeof url === "string" && /^http:\/\/(?!localhost|127\.0\.0\.1)/i.test(url)) {
        add("http-insecure-url", "warning", `plain HTTP URL ${url}`, node.name);
      }
    }
  }

  const isErrorHandler = wf.nodes.some((n) => n.type === "n8n-nodes-base.errorTrigger");
  if (wf.active && hasTrigger && !isErrorHandler && !wf.settings?.errorWorkflow) {
    add("error-workflow", "warning", "active workflow has no error workflow; failures will go unnoticed");
  }
  return issues;
}

export function formatIssues(issues: LintIssue[], fileOf: (wf: string) => string, color = false): string {
  const c = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return issues
    .map((i) => {
      const sev = i.severity === "error" ? c(31, "error  ") : c(33, "warning");
      const where = i.node ? `${i.workflow} › ${i.node}` : i.workflow;
      return `${sev} ${fileOf(i.workflow)}  ${where}: ${i.message} ${c(2, `(${i.rule})`)}`;
    })
    .join("\n");
}
