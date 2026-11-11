import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

export interface EnvConfig {
  /** Base URL of the n8n instance, e.g. https://n8n.example.com */
  url: string;
  /** Name of the environment variable that holds the API key. */
  apiKeyEnv: string;
  /**
   * Optional credential overrides for this environment.
   * Key: "<credentialType>:<credential name in Git>", value: credential ID on this instance.
   */
  credentials?: Record<string, string>;
}

export interface Config {
  /** Directory (relative to the config file) where workflow JSON files are stored. */
  dir: string;
  environments: Record<string, EnvConfig>;
  /** Only manage workflows that carry at least one of these tags (optional). */
  tags?: string[];
}

export const CONFIG_FILE = "flowgit.json";

export interface LoadedConfig {
  config: Config;
  root: string;
  workflowDir: string;
}

export async function loadConfig(cwd = process.cwd()): Promise<LoadedConfig> {
  const file = path.join(cwd, CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new UserError(`No ${CONFIG_FILE} found in ${cwd}. Run "flowgit init" first.`);
  }
  let config: Config;
  try {
    config = JSON.parse(raw) as Config;
  } catch (e) {
    throw new UserError(`${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  if (!config.environments || Object.keys(config.environments).length === 0) {
    throw new UserError(`${CONFIG_FILE} must define at least one environment.`);
  }
  config.dir ||= "workflows";
  return { config, root: cwd, workflowDir: path.join(cwd, config.dir) };
}

export function resolveEnv(config: Config, name: string | undefined): { name: string; env: EnvConfig; apiKey: string } {
  const names = Object.keys(config.environments);
  const envName = name ?? (names.length === 1 ? names[0] : undefined);
  if (!envName) {
    throw new UserError(`Several environments are configured (${names.join(", ")}). Pick one with --env <name>.`);
  }
  const env = config.environments[envName];
  if (!env) throw new UserError(`Unknown environment "${envName}". Configured: ${names.join(", ")}.`);
  const url = process.env[`FLOWGIT_${envName.toUpperCase()}_URL`] || env.url;
  if (!url) throw new UserError(`Environment "${envName}" has no url.`);
  const apiKey = process.env[env.apiKeyEnv];
  if (!apiKey) {
    throw new UserError(`Environment variable ${env.apiKeyEnv} (API key for "${envName}") is not set.`);
  }
  return { name: envName, env: { ...env, url }, apiKey };
}

export async function writeInitialConfig(cwd = process.cwd()): Promise<string> {
  const file = path.join(cwd, CONFIG_FILE);
  try {
    await access(file);
    throw new UserError(`${CONFIG_FILE} already exists.`);
  } catch (e) {
    if (e instanceof UserError) throw e;
  }
  const config: Config = {
    dir: "workflows",
    environments: {
      dev: { url: "http://localhost:5678", apiKeyEnv: "N8N_DEV_API_KEY" },
      prod: { url: "https://n8n.example.com", apiKeyEnv: "N8N_PROD_API_KEY" },
    },
  };
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
  return file;
}

/** An error caused by user input or environment; printed without a stack trace. */
export class UserError extends Error {}
