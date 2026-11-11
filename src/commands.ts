import { ApiError, N8nClient } from "./client.js";
import { loadConfig, resolveEnv, UserError, type LoadedConfig } from "./config.js";
import { diffSets, formatDiff, hasChanges, type DiffResult } from "./diff.js";
import { formatIssues, lintWorkflow, type LintIssue } from "./lint.js";
import { credentialIndex, toApiBody, toStored, WF_REF, type ResolveIssue } from "./normalize.js";
import { readLocal, writeLocal } from "./store.js";
import type { RemoteWorkflow, StoredWorkflow } from "./types.js";

export interface Output {
  log(msg: string): void;
  color: boolean;
}

interface RemoteSnapshot {
  client: N8nClient;
  envName: string;
  remote: RemoteWorkflow[];
  stored: StoredWorkflow[];
}

function managed(loaded: LoadedConfig, wf: { tags?: { name: string }[] | string[]; isArchived?: unknown }): boolean {
  if (wf.isArchived === true) return false;
  const filter = loaded.config.tags;
  if (!filter?.length) return true;
  const names = (wf.tags ?? []).map((t) => (typeof t === "string" ? t : t.name));
  return names.some((n) => filter.includes(n));
}

async function snapshot(loaded: LoadedConfig, envName: string | undefined): Promise<RemoteSnapshot> {
  const { name, env, apiKey } = resolveEnv(loaded.config, envName);
  const client = new N8nClient(env.url, apiKey);
  const all = await client.listWorkflows();
  const idToName = new Map(all.map((w) => [w.id, w.name]));
  const remote = all.filter((w) => managed(loaded, w as RemoteWorkflow & { isArchived?: unknown }));
  const dupes = remote.map((w) => w.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dupes.length) {
    throw new UserError(`Environment "${name}" has several workflows named: ${[...new Set(dupes)].join(", ")}. Names must be unique.`);
  }
  return { client, envName: name, remote, stored: remote.map((w) => toStored(w, idToName)) };
}

export async function cmdPull(out: Output, opts: { env?: string }): Promise<number> {
  const loaded = await loadConfig();
  const snap = await snapshot(loaded, opts.env);
  const res = await writeLocal(loaded.workflowDir, snap.stored);
  out.log(
    `Pulled ${snap.stored.length} workflows from "${snap.envName}" into ${loaded.config.dir}/: ` +
      `${res.added.length} added, ${res.updated.length} updated, ${res.removed.length} removed, ${res.unchanged.length} unchanged.`,
  );
  for (const n of res.added) out.log(`  + ${n}`);
  for (const n of res.updated) out.log(`  ~ ${n}`);
  for (const n of res.removed) out.log(`  - ${n}`);
  return 0;
}

async function loadSide(loaded: LoadedConfig, side: string): Promise<{ label: string; workflows: StoredWorkflow[] }> {
  if (side === "git") {
    return { label: "git", workflows: (await readLocal(loaded.workflowDir)).map((l) => l.workflow) };
  }
  const snap = await snapshot(loaded, side);
  return { label: snap.envName, workflows: snap.stored };
}

export async function cmdDiff(
  out: Output,
  opts: { env?: string; from?: string; to?: string; exitCode?: boolean; json?: boolean },
): Promise<number> {
  const loaded = await loadConfig();
  const from = opts.from ?? "git";
  const to = opts.to ?? opts.env ?? Object.keys(loaded.config.environments)[0];
  if (!opts.to && !opts.env && Object.keys(loaded.config.environments).length > 1) {
    throw new UserError(`Pick a target with --env <name> (or --from/--to).`);
  }
  const [a, b] = await Promise.all([loadSide(loaded, from), loadSide(loaded, to)]);
  const d = diffSets(a.workflows, b.workflows);
  out.log(opts.json ? JSON.stringify(d, null, 2) : formatDiff(d, { source: a.label, target: b.label }, out.color));
  return opts.exitCode && hasChanges(d) ? 1 : 0;
}

export async function cmdLint(out: Output, opts: { strict?: boolean; json?: boolean }): Promise<number> {
  const loaded = await loadConfig();
  const local = await readLocal(loaded.workflowDir);
  if (!local.length) {
    out.log(`No workflows in ${loaded.config.dir}/. Run "flowgit pull" first.`);
    return 0;
  }
  const fileOf = new Map(local.map((l) => [l.workflow.name, l.file.slice(loaded.root.length + 1)]));
  const issues: LintIssue[] = local.flatMap((l) => lintWorkflow(l.workflow));
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  if (opts.json) out.log(JSON.stringify(issues, null, 2));
  else {
    if (issues.length) out.log(formatIssues(issues, (w) => fileOf.get(w) ?? w, out.color) + "\n");
    out.log(`${local.length} workflows checked: ${errors} errors, ${warnings} warnings.`);
  }
  return errors > 0 || (opts.strict && warnings > 0) ? 1 : 0;
}

export interface PushOptions {
  env?: string;
  dryRun?: boolean;
  activate?: boolean;
  force?: boolean;
}

export async function cmdPush(out: Output, opts: PushOptions): Promise<number> {
  const loaded = await loadConfig();
  const local = (await readLocal(loaded.workflowDir)).map((l) => l.workflow);
  if (!local.length) throw new UserError(`No workflows in ${loaded.config.dir}/ to push.`);
  const snap = await snapshot(loaded, opts.env);
  const { env } = resolveEnv(loaded.config, snap.envName);
  const d: DiffResult = diffSets(local, snap.stored);

  out.log(formatDiff(d, { source: "git", target: snap.envName }, out.color));
  if (d.removed.length) {
    out.log(`\nNote: ${d.removed.length} workflow(s) exist only on "${snap.envName}" and are left untouched.`);
  }
  const toWrite = [...d.added, ...d.changed.map((c) => c.name)];
  if (!toWrite.length) return 0;

  // Resolve IDs on the target and check every reference before writing anything.
  const creds = await snap.client.listCredentials();
  const credentialIds = credentialIndex(creds ?? [], env.credentials);
  const workflowIds = new Map(snap.remote.map((w) => [w.name, w.id]));
  const planned = new Map(workflowIds);
  for (const name of d.added) planned.set(name, "<new>");
  const localByName = new Map(local.map((w) => [w.name, w]));
  const issues: ResolveIssue[] = [];
  for (const name of toWrite) {
    issues.push(...toApiBody(localByName.get(name)!, { workflowIds: planned, credentialIds, credentialsListable: creds !== null }).issues);
  }
  if (creds === null) {
    out.log(`\nWarning: "${snap.envName}" cannot list credentials via the API; credentials are matched by name only.`);
  }
  if (issues.length) {
    out.log(`\n${issues.length} unresolved reference(s) on "${snap.envName}":`);
    for (const i of issues) out.log(`  ${i.workflow}${i.node ? ` › ${i.node}` : ""}: ${i.message}`);
    if (!opts.force) {
      out.log(`\nCreate the missing credentials/workflows on "${snap.envName}", map them in flowgit.json, or re-run with --force.`);
      return 1;
    }
  }
  if (opts.dryRun) {
    out.log(`\nDry run: ${toWrite.length} workflow(s) would be written to "${snap.envName}".`);
    return 0;
  }

  // Pass 1: create missing workflows so cross-references can be resolved to real IDs.
  for (const name of d.added) {
    const created = await snap.client.createWorkflow({
      name,
      nodes: [],
      connections: {},
      settings: { executionOrder: "v1" },
    });
    workflowIds.set(name, created.id);
  }

  // Pass 2: write full definitions.
  const ctx = { workflowIds, credentialIds, credentialsListable: creds !== null };
  let written = 0;
  /** Workflows whose error workflow must be published first (n8n 2.x); re-written after activation. */
  const deferredErrorWf: string[] = [];
  const write = async (name: string, opts: { minimalSettings?: boolean; withoutErrorWorkflow?: boolean } = {}) => {
    const wf = localByName.get(name)!;
    const body = toApiBody(wf, ctx, opts).body;
    if (opts.withoutErrorWorkflow) delete (body.settings as Record<string, unknown>).errorWorkflow;
    await snap.client.updateWorkflow(workflowIds.get(name)!, body);
  };
  const isSettingsRejection = (e: unknown) =>
    e instanceof ApiError && e.status === 400 && /settings/.test(e.body) && /additional propert/i.test(e.body);
  const isUnpublishedErrorWf = (e: unknown) =>
    e instanceof ApiError && e.status === 400 && /error workflow/i.test(e.body) && /publish|active/i.test(e.body);

  for (const name of toWrite) {
    let minimal = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await write(name, { minimalSettings: minimal, withoutErrorWorkflow: deferredErrorWf.includes(name) });
        break;
      } catch (e) {
        if (isSettingsRejection(e) && !minimal) {
          out.log(`  ! ${name}: target n8n rejected some settings; pushed with minimal settings.`);
          minimal = true;
        } else if (isUnpublishedErrorWf(e) && !deferredErrorWf.includes(name)) {
          deferredErrorWf.push(name);
        } else {
          throw new UserError(`Failed to write "${name}" to "${snap.envName}": ${(e as Error).message}`);
        }
      }
    }
    written++;
    out.log(`  ✓ ${name}${deferredErrorWf.includes(name) ? " (error workflow linked after activation)" : ""}`);
  }

  // Tags: create missing ones on the target, then assign.
  const remoteTags = new Map(snap.remote.map((w) => [w.name, (w.tags ?? []).map((t) => t.name).sort().join("\u0000")]));
  const needTags = toWrite.filter((n) => (localByName.get(n)!.tags ?? []).slice().sort().join("\u0000") !== (remoteTags.get(n) ?? ""));
  if (needTags.length) {
    try {
      const tagIds = new Map((await snap.client.listTags()).map((t) => [t.name, t.id]));
      for (const name of needTags) {
        const ids: string[] = [];
        for (const tag of localByName.get(name)!.tags ?? []) {
          if (!tagIds.has(tag)) tagIds.set(tag, (await snap.client.createTag(tag)).id);
          ids.push(tagIds.get(tag)!);
        }
        await snap.client.setWorkflowTags(workflowIds.get(name)!, ids);
      }
    } catch (e) {
      out.log(`  ! could not sync tags: ${(e as Error).message}`);
    }
  }

  // Activation state.
  const remoteActive = new Map(snap.remote.map((w) => [w.name, Boolean(w.active)]));
  const inactiveNew: string[] = [];
  for (const name of toWrite) {
    const want = Boolean(localByName.get(name)!.active);
    const has = remoteActive.get(name) ?? false;
    if (want === has) continue;
    if (!opts.activate) {
      if (want) inactiveNew.push(name);
      continue;
    }
    const id = workflowIds.get(name)!;
    try {
      await (want ? snap.client.activate(id) : snap.client.deactivate(id));
      out.log(`  ${want ? "▶ activated" : "⏸ deactivated"} ${name}`);
    } catch (e) {
      out.log(`  ! could not ${want ? "activate" : "deactivate"} ${name}: ${(e as Error).message}`);
    }
  }
  // Link error workflows that needed to be published first.
  for (const name of deferredErrorWf) {
    try {
      // n8n publishes asynchronously; give it a moment before linking.
      for (let i = 0; ; i++) {
        try {
          await write(name);
          break;
        } catch (e) {
          if (!isUnpublishedErrorWf(e) || i >= 4) throw e;
          await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        }
      }
      out.log(`  ✓ ${name}: error workflow linked`);
    } catch (e) {
      out.log(
        `  ! ${name}: error workflow not linked — it must be active on "${snap.envName}" first` +
          `${opts.activate ? "" : " (re-run with --activate)"}. ${(e as Error).message}`,
      );
    }
  }
  out.log(`\nPushed ${written} workflow(s) to "${snap.envName}".`);
  if (inactiveNew.length) {
    out.log(`${inactiveNew.length} workflow(s) are active in Git but inactive on "${snap.envName}". Re-run with --activate to switch them on.`);
  }
  return 0;
}

export { WF_REF };
