import { stableStringify } from "./normalize.js";
import type { Json, JsonObject, N8nNode, StoredWorkflow } from "./types.js";

export interface NodeChange {
  node: string;
  fields: string[];
  layoutOnly: boolean;
}

export interface WorkflowChange {
  name: string;
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesChanged: NodeChange[];
  edgesAdded: string[];
  edgesRemoved: string[];
  settingsChanged: string[];
  activeChanged?: { from: boolean; to: boolean };
  tagsChanged?: { from: string[]; to: string[] };
}

export interface DiffResult {
  /** Present in source (e.g. Git), missing in target. */
  added: string[];
  /** Present in target, missing in source. */
  removed: string[];
  changed: WorkflowChange[];
  unchanged: string[];
}

const eq = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);

function paramPaths(a: Json | undefined, b: Json | undefined, prefix: string, depth: number, out: string[]): void {
  if (eq(a, b)) return;
  const isObj = (v: unknown): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);
  if (depth > 0 && isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      paramPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, depth - 1, out);
    }
    return;
  }
  out.push(prefix || "(root)");
}

function nodeChange(from: N8nNode, to: N8nNode): NodeChange | null {
  const fields: string[] = [];
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  keys.delete("id");
  let layout = false;
  for (const k of [...keys].sort()) {
    if (eq(from[k], to[k])) continue;
    if (k === "position") layout = true;
    else if (k === "parameters") paramPaths(from.parameters, to.parameters, "parameters", 3, fields);
    else fields.push(k);
  }
  if (!layout && fields.length === 0) return null;
  return { node: to.name, fields, layoutOnly: fields.length === 0 };
}

function edges(connections: JsonObject): Set<string> {
  const out = new Set<string>();
  for (const [src, byType] of Object.entries(connections ?? {})) {
    if (!byType || typeof byType !== "object" || Array.isArray(byType)) continue;
    for (const [type, outputs] of Object.entries(byType)) {
      if (!Array.isArray(outputs)) continue;
      outputs.forEach((targets, outIdx) => {
        if (!Array.isArray(targets)) return;
        for (const t of targets) {
          const tt = t as JsonObject;
          const suffix = type === "main" ? (outIdx > 0 ? ` [out ${outIdx}]` : "") : ` [${type}]`;
          out.add(`${src} → ${String(tt.node)}${suffix}`);
        }
      });
    }
  }
  return out;
}

export function diffWorkflow(from: StoredWorkflow, to: StoredWorkflow): WorkflowChange | null {
  const fromNodes = new Map(from.nodes.map((n) => [n.name, n]));
  const toNodes = new Map(to.nodes.map((n) => [n.name, n]));
  const change: WorkflowChange = {
    name: to.name,
    nodesAdded: [...toNodes.keys()].filter((n) => !fromNodes.has(n)).sort(),
    nodesRemoved: [...fromNodes.keys()].filter((n) => !toNodes.has(n)).sort(),
    nodesChanged: [],
    edgesAdded: [],
    edgesRemoved: [],
    settingsChanged: [],
  };
  for (const [name, n] of toNodes) {
    const prev = fromNodes.get(name);
    if (!prev) continue;
    const c = nodeChange(prev, n);
    if (c) change.nodesChanged.push(c);
  }
  const ea = edges(from.connections);
  const eb = edges(to.connections);
  change.edgesAdded = [...eb].filter((e) => !ea.has(e)).sort();
  change.edgesRemoved = [...ea].filter((e) => !eb.has(e)).sort();
  for (const k of new Set([...Object.keys(from.settings ?? {}), ...Object.keys(to.settings ?? {})])) {
    if (!eq(from.settings?.[k], to.settings?.[k])) change.settingsChanged.push(k);
  }
  change.settingsChanged.sort();
  if (Boolean(from.active) !== Boolean(to.active)) change.activeChanged = { from: Boolean(from.active), to: Boolean(to.active) };
  if (!eq(from.tags ?? [], to.tags ?? [])) change.tagsChanged = { from: from.tags ?? [], to: to.tags ?? [] };

  const empty =
    !change.nodesAdded.length &&
    !change.nodesRemoved.length &&
    !change.nodesChanged.length &&
    !change.edgesAdded.length &&
    !change.edgesRemoved.length &&
    !change.settingsChanged.length &&
    !change.activeChanged &&
    !change.tagsChanged;
  return empty ? null : change;
}

/** Diff of `target` → `source`: what applying `source` onto `target` would change. */
export function diffSets(source: StoredWorkflow[], target: StoredWorkflow[]): DiffResult {
  const src = new Map(source.map((w) => [w.name, w]));
  const tgt = new Map(target.map((w) => [w.name, w]));
  const res: DiffResult = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [name, wf] of src) {
    const t = tgt.get(name);
    if (!t) {
      res.added.push(name);
      continue;
    }
    const c = diffWorkflow(t, wf);
    if (c) res.changed.push(c);
    else res.unchanged.push(name);
  }
  for (const name of tgt.keys()) if (!src.has(name)) res.removed.push(name);
  res.added.sort();
  res.removed.sort();
  res.unchanged.sort();
  res.changed.sort((a, b) => a.name.localeCompare(b.name));
  return res;
}

export function hasChanges(d: DiffResult): boolean {
  return d.added.length + d.removed.length + d.changed.length > 0;
}

export function formatDiff(d: DiffResult, labels: { source: string; target: string }, color = false): string {
  const c = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const green = (s: string) => c(32, s);
  const red = (s: string) => c(31, s);
  const yellow = (s: string) => c(33, s);
  const dim = (s: string) => c(2, s);
  const lines: string[] = [];
  for (const n of d.added) lines.push(green(`+ ${n}`) + dim(`  (only in ${labels.source})`));
  for (const n of d.removed) lines.push(red(`- ${n}`) + dim(`  (only in ${labels.target})`));
  for (const w of d.changed) {
    lines.push(yellow(`~ ${w.name}`));
    for (const n of w.nodesAdded) lines.push(green(`    + node ${n}`));
    for (const n of w.nodesRemoved) lines.push(red(`    - node ${n}`));
    for (const n of w.nodesChanged) {
      lines.push(yellow(`    ~ node ${n.node}`) + dim(n.layoutOnly ? "  (moved only)" : `  ${n.fields.join(", ")}`));
    }
    for (const e of w.edgesAdded) lines.push(green(`    + ${e}`));
    for (const e of w.edgesRemoved) lines.push(red(`    - ${e}`));
    if (w.settingsChanged.length) lines.push(yellow(`    ~ settings: ${w.settingsChanged.join(", ")}`));
    if (w.activeChanged) lines.push(yellow(`    ~ active: ${w.activeChanged.from} → ${w.activeChanged.to}`));
    if (w.tagsChanged) lines.push(yellow(`    ~ tags: [${w.tagsChanged.from.join(", ")}] → [${w.tagsChanged.to.join(", ")}]`));
  }
  const summary = `${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed, ${d.unchanged.length} unchanged`;
  if (!lines.length) return `No differences between ${labels.source} and ${labels.target}. ${dim(`(${summary})`)}`;
  return [...lines, "", dim(summary)].join("\n");
}
