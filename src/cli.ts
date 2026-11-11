#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appendFile, readFile } from "node:fs/promises";
import { cmdDiff, cmdLint, cmdPull, cmdPush, type Output } from "./commands.js";
import { UserError, writeInitialConfig } from "./config.js";

const HELP = `flowgit — Git version control and dev→prod environments for self-hosted n8n

Usage:
  flowgit init                       Create flowgit.json in the current directory
  flowgit pull   [--env dev]         Export workflows from n8n into ./workflows (env-agnostic JSON)
  flowgit diff   [--env prod]        Show what differs between Git and an n8n instance
  flowgit diff   --from dev --to prod   Compare two instances (use "git" as a side, too)
  flowgit push   --env prod          Apply Git to an n8n instance (creates/updates, never deletes)
  flowgit lint                       Check workflows for hardcoded secrets, open webhooks, etc.

Options:
  --env <name>        Environment from flowgit.json
  --dry-run           push: show the plan, change nothing
  --activate          push: also sync active/inactive state
  --force             push: write even if some credentials/workflow references are unresolved
  --exit-code         diff: exit 1 when there are differences (for CI)
  --strict            lint: exit 1 on warnings too
  --json              diff/lint: machine-readable output
  --no-color          Disable colors
  -v, --version       Print version
  -h, --help          Show this help

API keys are read from the environment variables named in flowgit.json (apiKeyEnv).
A .env file in the current directory is loaded automatically.
Docs: https://github.com/speedboostco/flowgit`;

type Flags = Record<string, string | boolean>;

function parse(argv: string[]): { cmd?: string; flags: Flags } {
  const flags: Flags = {};
  let cmd: string | undefined;
  const valued = new Set(["env", "from", "to"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      if (valued.has(k)) {
        const v = inline ?? argv[++i];
        if (!v || v.startsWith("--")) throw new UserError(`--${k} needs a value`);
        flags[k] = v;
      } else flags[k] = true;
    } else if (!cmd) cmd = a;
    else throw new UserError(`Unexpected argument "${a}"`);
  }
  return { cmd, flags };
}

async function loadDotEnv(): Promise<void> {
  let text: string;
  try {
    text = await readFile(".env", "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

export async function main(argv: string[], out: Output): Promise<number> {
  const { cmd, flags } = parse(argv);
  if (flags.version) {
    out.log(version());
    return 0;
  }
  if (flags.help || !cmd) {
    out.log(HELP);
    return cmd || flags.help ? 0 : 1;
  }
  if (flags["no-color"]) out.color = false;
  await loadDotEnv();
  const env = flags.env as string | undefined;
  switch (cmd) {
    case "init": {
      const file = await writeInitialConfig();
      await appendFile(".gitignore", "\n.env\n").catch(() => undefined);
      out.log(`Created ${file}.\nNext: set N8N_DEV_API_KEY (n8n → Settings → n8n API) in .env, edit the URLs, then run "flowgit pull --env dev".`);
      return 0;
    }
    case "pull":
      return cmdPull(out, { env });
    case "diff":
      return cmdDiff(out, {
        env,
        from: flags.from as string | undefined,
        to: flags.to as string | undefined,
        exitCode: Boolean(flags["exit-code"]),
        json: Boolean(flags.json),
      });
    case "push":
      return cmdPush(out, {
        env,
        dryRun: Boolean(flags["dry-run"]),
        activate: Boolean(flags.activate),
        force: Boolean(flags.force),
      });
    case "lint":
      return cmdLint(out, { strict: Boolean(flags.strict), json: Boolean(flags.json) });
    default:
      throw new UserError(`Unknown command "${cmd}". Run "flowgit --help".`);
  }
}

function isEntry(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntry()) {
  const out: Output = { log: (m) => console.log(m), color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR };
  main(process.argv.slice(2), out).then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof UserError) console.error(`flowgit: ${e.message}`);
      else console.error(e);
      process.exit(2);
    },
  );
}
