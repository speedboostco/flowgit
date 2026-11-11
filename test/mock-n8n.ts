import http from "node:http";
import type { AddressInfo } from "node:net";

const ALLOWED_BODY = new Set(["name", "nodes", "connections", "settings", "staticData", "pinData", "description"]);

export interface MockOptions {
  apiKey: string;
  /** Settings keys this instance accepts; anything else → 400 like older n8n versions. */
  allowedSettings?: string[];
  credentials?: { id: string; name: string; type: string }[];
  workflows?: Record<string, unknown>[];
  pageSize?: number;
  /** Mimic n8n 2.x: settings.errorWorkflow must point to a published (active) workflow. */
  requirePublishedErrorWorkflow?: boolean;
}

export interface MockN8n {
  url: string;
  workflows: Map<string, Record<string, unknown>>;
  writes: string[];
  close(): Promise<void>;
}

export async function startMock(opts: MockOptions): Promise<MockN8n> {
  const workflows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const newId = () => `wf${String(++seq).padStart(4, "0")}${Math.random().toString(36).slice(2, 6)}`;
  for (const w of opts.workflows ?? []) workflows.set(String(w.id), { active: false, tags: [], ...w });
  const writes: string[] = [];
  const tags: { id: string; name: string }[] = [];
  const pageSize = opts.pageSize ?? 2;
  const allowedSettings = new Set(
    opts.allowedSettings ?? ["executionOrder", "errorWorkflow", "timezone", "saveManualExecutions", "callerPolicy", "availableInMCP"],
  );

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-n8n-api-key"] !== opts.apiKey) return send(401, { message: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const parts = url.pathname.replace(/^\/api\/v1\//, "").split("/");

    const validate = (b: Record<string, unknown>): string | null => {
      for (const k of Object.keys(b)) if (!ALLOWED_BODY.has(k)) return "request/body must NOT have additional properties";
      for (const k of ["name", "nodes", "connections", "settings"]) if (!(k in b)) return `request/body must have required property '${k}'`;
      for (const k of Object.keys((b.settings as object) ?? {})) {
        if (!allowedSettings.has(k)) return "request/body/settings must NOT have additional properties";
      }
      const ew = (b.settings as { errorWorkflow?: string } | undefined)?.errorWorkflow;
      if (opts.requirePublishedErrorWorkflow && ew && !workflows.get(ew)?.active) {
        return "The selected error workflow has no published version.";
      }
      return null;
    };

    if (parts[0] === "workflows" && parts.length === 1 && req.method === "GET") {
      const all = [...workflows.values()];
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : null;
      return send(200, { data: page, nextCursor: next });
    }
    if (parts[0] === "workflows" && parts.length === 1 && req.method === "POST") {
      const err = validate(body);
      if (err) return send(400, { message: err });
      const id = newId();
      const wf = { ...body, id, active: false, tags: [] };
      workflows.set(id, wf);
      writes.push(`create ${body.name}`);
      return send(200, wf);
    }
    if (parts[0] === "tags" && req.method === "GET") return send(200, { data: tags, nextCursor: null });
    if (parts[0] === "tags" && req.method === "POST") {
      const t = { id: `tag${tags.length + 1}`, name: body.name };
      tags.push(t);
      return send(201, t);
    }
    if (parts[0] === "workflows" && parts[2] === "tags" && req.method === "PUT") {
      const wf = workflows.get(parts[1]);
      if (!wf) return send(404, { message: "not found" });
      wf.tags = (body as { id: string }[]).map((x) => tags.find((t) => t.id === x.id)!);
      writes.push(`tags ${wf.name}`);
      return send(200, wf.tags);
    }
    if (parts[0] === "workflows" && parts.length >= 2) {
      const wf = workflows.get(parts[1]);
      if (!wf) return send(404, { message: "not found" });
      if (parts.length === 2 && req.method === "GET") return send(200, wf);
      if (parts.length === 2 && req.method === "PUT") {
        const err = validate(body);
        if (err) return send(400, { message: err });
        const updated = { ...wf, ...body, id: wf.id, active: wf.active, tags: wf.tags };
        workflows.set(parts[1], updated);
        writes.push(`update ${body.name}`);
        return send(200, updated);
      }
      if (parts[2] === "activate" || parts[2] === "deactivate") {
        wf.active = parts[2] === "activate";
        writes.push(`${parts[2]} ${wf.name}`);
        return send(200, wf);
      }
    }
    if (parts[0] === "credentials" && req.method === "GET") {
      if (!opts.credentials) return send(405, { message: "GET method not allowed" });
      return send(200, { data: opts.credentials, nextCursor: null });
    }
    send(404, { message: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    workflows,
    writes,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
