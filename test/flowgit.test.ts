import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli.js";
import { startMock, type MockN8n } from "./mock-n8n.js";

const DEV_KEY = "dev-key";
const PROD_KEY = "prod-key";

function devWorkflows() {
  return [
    {
      id: "devErr",
      name: "Error handler",
      active: true,
      tags: [{ id: "t1", name: "ops" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      versionId: "v-1",
      settings: { executionOrder: "v1" },
      nodes: [
        { id: "n1", name: "Error Trigger", type: "n8n-nodes-base.errorTrigger", typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: "n2",
          name: "Notify Slack",
          type: "n8n-nodes-base.slack",
          typeVersion: 2,
          position: [200, 0],
          parameters: { text: "={{ $json.execution.error.message }}" },
          credentials: { slackApi: { id: "devCredSlack", name: "Slack bot" } },
        },
      ],
      connections: { "Error Trigger": { main: [[{ node: "Notify Slack", type: "main", index: 0 }]] } },
    },
    {
      id: "devSub",
      name: "Enrich lead",
      active: false,
      settings: { executionOrder: "v1", callerPolicy: "any" },
      nodes: [
        { id: "s1", name: "When called", type: "n8n-nodes-base.executeWorkflowTrigger", typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: "s2",
          name: "Lookup",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4,
          position: [200, 0],
          parameters: { url: "https://api.example.com/lead", method: "GET" },
          credentials: { httpHeaderAuth: { id: "devCredHttp", name: "Lead API" } },
        },
      ],
      connections: { "When called": { main: [[{ node: "Lookup", type: "main", index: 0 }]] } },
    },
    {
      id: "devMain",
      name: "Inbound leads",
      active: true,
      settings: { executionOrder: "v1", errorWorkflow: "devErr", availableInMCP: false },
      nodes: [
        {
          id: "m1",
          name: "Webhook",
          type: "n8n-nodes-base.webhook",
          typeVersion: 2,
          position: [0, 0],
          webhookId: "hook-1",
          parameters: { path: "leads", httpMethod: "POST", authentication: "headerAuth" },
          credentials: { httpHeaderAuth: { id: "devCredHttp", name: "Lead API" } },
        },
        {
          id: "m2",
          name: "Enrich",
          type: "n8n-nodes-base.executeWorkflow",
          typeVersion: 1.2,
          position: [200, 0],
          parameters: {
            workflowId: { __rl: true, value: "devSub", mode: "list", cachedResultName: "Enrich lead", cachedResultUrl: "/workflow/devSub" },
          },
        },
      ],
      connections: { Webhook: { main: [[{ node: "Enrich", type: "main", index: 0 }]] } },
    },
  ];
}

const prodCreds = [
  { id: "prodCredSlack", name: "Slack bot", type: "slackApi" },
  { id: "prodCredHttp", name: "Lead API", type: "httpHeaderAuth" },
];

describe("flowgit", () => {
  let dev: MockN8n;
  let prod: MockN8n;
  let dir: string;
  let logs: string[];
  const origCwd = process.cwd();

  const run = async (...args: string[]) => {
    logs = [];
    return main(args, { log: (m) => logs.push(m), color: false });
  };
  const output = () => logs.join("\n");
  const readWf = async (file: string) => JSON.parse(await readFile(path.join(dir, "workflows", file), "utf8"));

  before(async () => {
    process.env.N8N_DEV_API_KEY = DEV_KEY;
    process.env.N8N_PROD_API_KEY = PROD_KEY;
  });

  beforeEach(async () => {
    await dev?.close();
    await prod?.close();
    dev = await startMock({ apiKey: DEV_KEY, workflows: devWorkflows(), credentials: [] });
    prod = await startMock({ apiKey: PROD_KEY, credentials: prodCreds });
    process.chdir(origCwd);
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(tmpdir(), "flowgit-"));
    process.chdir(dir);
    await writeFile(
      "flowgit.json",
      JSON.stringify({
        dir: "workflows",
        environments: {
          dev: { url: dev.url, apiKeyEnv: "N8N_DEV_API_KEY" },
          prod: { url: prod.url, apiKeyEnv: "N8N_PROD_API_KEY" },
        },
      }),
    );
  });

  after(async () => {
    process.chdir(origCwd);
    await dev?.close();
    await prod?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("pull writes env-agnostic files across paginated results", async () => {
    assert.equal(await run("pull", "--env", "dev"), 0);
    const files = (await readdir(path.join(dir, "workflows"))).sort();
    assert.deepEqual(files, ["enrich-lead.json", "error-handler.json", "inbound-leads.json"]);

    const main = await readWf("inbound-leads.json");
    assert.equal(main.settings.errorWorkflow, "@workflow:Error handler");
    const enrich = main.nodes.find((n: { name: string }) => n.name === "Enrich");
    assert.equal(enrich.parameters.workflowId.value, "@workflow:Enrich lead");
    assert.equal(enrich.parameters.workflowId.cachedResultUrl, undefined);
    const hook = main.nodes.find((n: { name: string }) => n.name === "Webhook");
    assert.deepEqual(hook.credentials, { httpHeaderAuth: { name: "Lead API" } });

    const err = await readWf("error-handler.json");
    assert.equal(err.id, undefined);
    assert.equal(err.versionId, undefined);
    assert.equal(err.updatedAt, undefined);
    assert.deepEqual(err.tags, ["ops"]);
    assert.equal(err.active, true);
  });

  it("pull is idempotent", async () => {
    await run("pull", "--env", "dev");
    await run("pull", "--env", "dev");
    assert.match(output(), /0 added, 0 updated, 0 removed, 3 unchanged/);
  });

  it("push creates workflows on an empty target and remaps IDs", async () => {
    await run("pull", "--env", "dev");
    assert.equal(await run("push", "--env", "prod"), 0, output());
    assert.equal(prod.workflows.size, 3);
    const byName = new Map([...prod.workflows.values()].map((w) => [w.name as string, w]));
    const errId = byName.get("Error handler")!.id;
    const subId = byName.get("Enrich lead")!.id;
    const mainWf = byName.get("Inbound leads")! as any;
    assert.equal(mainWf.settings.errorWorkflow, errId);
    const enrich = mainWf.nodes.find((n: any) => n.name === "Enrich");
    assert.equal(enrich.parameters.workflowId.value, subId);
    const hook = mainWf.nodes.find((n: any) => n.name === "Webhook");
    assert.equal(hook.credentials.httpHeaderAuth.id, "prodCredHttp");
    // Without --activate nothing gets switched on.
    assert.equal(mainWf.active, false);
    assert.match(output(), /Re-run with --activate/);
  });

  it("second push is a no-op and diff is clean", async () => {
    await run("pull", "--env", "dev");
    await run("push", "--env", "prod", "--activate");
    prod.writes.length = 0;
    assert.equal(await run("push", "--env", "prod"), 0);
    assert.deepEqual(prod.writes, []);
    assert.equal(await run("diff", "--env", "prod", "--exit-code"), 0);
    assert.match(output(), /No differences/);
  });

  it("--activate syncs active state", async () => {
    await run("pull", "--env", "dev");
    await run("push", "--env", "prod", "--activate");
    const active = [...prod.workflows.values()].filter((w) => w.active).map((w) => w.name).sort();
    assert.deepEqual(active, ["Error handler", "Inbound leads"]);
  });

  it("diff reports node-level changes and --exit-code fails", async () => {
    await run("pull", "--env", "dev");
    await run("push", "--env", "prod", "--activate");
    const file = path.join(dir, "workflows", "enrich-lead.json");
    const wf = JSON.parse(await readFile(file, "utf8"));
    wf.nodes.find((n: any) => n.name === "Lookup").parameters.url = "https://api.example.com/v2/lead";
    wf.nodes.push({ name: "Log", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [400, 0], parameters: {} });
    wf.connections.Lookup = { main: [[{ node: "Log", type: "main", index: 0 }]] };
    await writeFile(file, JSON.stringify(wf));
    assert.equal(await run("diff", "--env", "prod", "--exit-code"), 1);
    const text = output();
    assert.match(text, /~ Enrich lead/);
    assert.match(text, /\+ node Log/);
    assert.match(text, /~ node Lookup {2}parameters\.url/);
    assert.match(text, /\+ Lookup → Log/);
  });

  it("diff can compare two instances", async () => {
    await run("pull", "--env", "dev");
    assert.equal(await run("diff", "--from", "dev", "--to", "prod"), 0);
    assert.match(output(), /\+ Inbound leads {2}\(only in dev\)/);
  });

  it("dry run writes nothing", async () => {
    await run("pull", "--env", "dev");
    assert.equal(await run("push", "--env", "prod", "--dry-run"), 0);
    assert.equal(prod.workflows.size, 0);
    assert.match(output(), /Dry run: 3 workflow\(s\) would be written/);
  });

  it("aborts before writing when a credential is missing on target", async () => {
    await prod.close();
    prod = await startMock({ apiKey: PROD_KEY, credentials: [prodCreds[1]] });
    const cfg = JSON.parse(await readFile("flowgit.json", "utf8"));
    cfg.environments.prod.url = prod.url;
    await writeFile("flowgit.json", JSON.stringify(cfg));
    await run("pull", "--env", "dev");
    assert.equal(await run("push", "--env", "prod"), 1);
    assert.equal(prod.workflows.size, 0);
    assert.match(output(), /credential "Slack bot" \(slackApi\) not found/);
  });

  it("credential overrides in flowgit.json are honoured", async () => {
    await prod.close();
    prod = await startMock({ apiKey: PROD_KEY, credentials: [prodCreds[1]] });
    const cfg = JSON.parse(await readFile("flowgit.json", "utf8"));
    cfg.environments.prod.url = prod.url;
    cfg.environments.prod.credentials = { "slackApi:Slack bot": "manualSlackId" };
    await writeFile("flowgit.json", JSON.stringify(cfg));
    await run("pull", "--env", "dev");
    assert.equal(await run("push", "--env", "prod"), 0, output());
    const err = [...prod.workflows.values()].find((w) => w.name === "Error handler") as any;
    assert.equal(err.nodes.find((n: any) => n.name === "Notify Slack").credentials.slackApi.id, "manualSlackId");
  });

  it("links error workflows after publishing them (n8n 2.x)", async () => {
    await prod.close();
    prod = await startMock({ apiKey: PROD_KEY, credentials: prodCreds, requirePublishedErrorWorkflow: true });
    const cfg = JSON.parse(await readFile("flowgit.json", "utf8"));
    cfg.environments.prod.url = prod.url;
    await writeFile("flowgit.json", JSON.stringify(cfg));
    await run("pull", "--env", "dev");
    assert.equal(await run("push", "--env", "prod", "--activate"), 0, output());
    const byName = new Map([...prod.workflows.values()].map((w) => [w.name as string, w as any]));
    assert.equal(byName.get("Inbound leads").settings.errorWorkflow, byName.get("Error handler").id);
    assert.equal(await run("diff", "--env", "prod", "--exit-code"), 0, output());
  });

  it("falls back to minimal settings on older n8n versions", async () => {
    await prod.close();
    prod = await startMock({ apiKey: PROD_KEY, credentials: prodCreds, allowedSettings: ["executionOrder"] });
    const cfg = JSON.parse(await readFile("flowgit.json", "utf8"));
    cfg.environments.prod.url = prod.url;
    await writeFile("flowgit.json", JSON.stringify(cfg));
    await run("pull", "--env", "dev");
    assert.equal(await run("push", "--env", "prod"), 0, output());
    assert.equal(prod.workflows.size, 3);
    assert.match(output(), /pushed with minimal settings/);
  });

  it("lint flags secrets and open webhooks", async () => {
    await run("pull", "--env", "dev");
    const file = path.join(dir, "workflows", "inbound-leads.json");
    const wf = JSON.parse(await readFile(file, "utf8"));
    const hook = wf.nodes.find((n: any) => n.name === "Webhook");
    hook.parameters.authentication = "none";
    wf.nodes.push({
      name: "Call OpenAI",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4,
      position: [400, 0],
      parameters: { url: "https://api.openai.com/v1/chat", headerParameters: { parameters: [{ name: "Authorization", value: "Bearer sk-proj-abcdefghijklmnopqrstuvwxyz123456" }] } },
    });
    wf.connections.Enrich = { main: [[{ node: "Call OpenAI", type: "main", index: 0 }]] };
    await writeFile(file, JSON.stringify(wf));
    assert.equal(await run("lint"), 1);
    const text = output();
    assert.match(text, /error .*Call OpenAI: looks like a hardcoded/);
    assert.match(text, /warning .*Webhook: webhook accepts unauthenticated requests/);
  });

  it("lint does not ask an error handler for its own error workflow", async () => {
    await run("pull", "--env", "dev");
    await run("lint");
    assert.doesNotMatch(output(), /Error handler: active workflow has no error workflow/);
  });

  it("lint passes on clean workflows", async () => {
    await run("pull", "--env", "dev");
    assert.equal(await run("lint"), 0, output());
  });

  it("reports a missing API key clearly", async () => {
    delete process.env.N8N_PROD_API_KEY;
    try {
      await assert.rejects(run("diff", "--env", "prod"), /N8N_PROD_API_KEY/);
    } finally {
      process.env.N8N_PROD_API_KEY = PROD_KEY;
    }
  });
});
