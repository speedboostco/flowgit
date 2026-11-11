import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "./normalize.js";
import type { StoredWorkflow } from "./types.js";

export interface LocalWorkflow {
  file: string;
  workflow: StoredWorkflow;
}

export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s || "workflow";
}

export async function readLocal(dir: string): Promise<LocalWorkflow[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: LocalWorkflow[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    const file = path.join(dir, f);
    let wf: StoredWorkflow;
    try {
      wf = JSON.parse(await readFile(file, "utf8")) as StoredWorkflow;
    } catch (e) {
      throw new Error(`${file}: invalid JSON (${(e as Error).message})`);
    }
    if (!wf || typeof wf.name !== "string" || !Array.isArray(wf.nodes)) continue;
    if (seen.has(wf.name)) throw new Error(`Duplicate workflow name "${wf.name}" in ${seen.get(wf.name)} and ${file}`);
    seen.set(wf.name, file);
    wf.connections ??= {};
    wf.settings ??= {};
    wf.tags ??= [];
    out.push({ file, workflow: wf });
  }
  return out;
}

export interface WriteResult {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
}

/** Makes the directory mirror exactly the given workflows. Existing files keep their names. */
export async function writeLocal(dir: string, workflows: StoredWorkflow[]): Promise<WriteResult> {
  await mkdir(dir, { recursive: true });
  const existing = await readLocal(dir);
  const fileByName = new Map(existing.map((e) => [e.workflow.name, e.file]));
  const contentByFile = new Map(existing.map((e) => [e.file, stableStringify(e.workflow)]));
  const used = new Set<string>();
  const res: WriteResult = { added: [], updated: [], removed: [], unchanged: [] };

  for (const wf of workflows) {
    let file = fileByName.get(wf.name);
    if (!file) {
      const base = slugify(wf.name);
      let candidate = path.join(dir, `${base}.json`);
      // A path is free only if no other workflow (kept or about to be removed) already owns it.
      for (let i = 2; used.has(candidate) || contentByFile.has(candidate); i++) {
        candidate = path.join(dir, `${base}-${i}.json`);
      }
      file = candidate;
    }
    used.add(file);
    const content = stableStringify(wf);
    if (!contentByFile.has(file)) res.added.push(wf.name);
    else if (contentByFile.get(file) !== content) res.updated.push(wf.name);
    else {
      res.unchanged.push(wf.name);
      continue;
    }
    await writeFile(file, content, "utf8");
  }
  const keep = new Set(workflows.map((w) => w.name));
  for (const e of existing) {
    if (!keep.has(e.workflow.name) && !used.has(e.file)) {
      await rm(e.file);
      res.removed.push(e.workflow.name);
    }
  }
  return res;
}
