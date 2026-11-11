import { UserError } from "./config.js";
import type { JsonObject, RemoteCredential, RemoteWorkflow } from "./types.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    message: string,
  ) {
    super(message);
  }
}

/** Minimal client for the n8n public API (v1). */
export class N8nClient {
  private base: string;

  constructor(
    url: string,
    private apiKey: string,
  ) {
    this.base = url.replace(/\/+$/, "") + "/api/v1";
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: {
          "X-N8N-API-KEY": this.apiKey,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new UserError(`Cannot reach ${this.base}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) throw new UserError(`n8n rejected the API key (401) at ${this.base}.`);
      let msg = text;
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        /* keep raw text */
      }
      throw new ApiError(res.status, text, `${method} ${path} failed (${res.status}): ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const page = await this.request<{ data: T[]; nextCursor?: string | null }>(
        "GET",
        `${path}${sep}limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      out.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return out;
  }

  listWorkflows(): Promise<RemoteWorkflow[]> {
    return this.paginate<RemoteWorkflow>("/workflows?excludePinnedData=true");
  }

  getWorkflow(id: string): Promise<RemoteWorkflow> {
    return this.request("GET", `/workflows/${encodeURIComponent(id)}`);
  }

  createWorkflow(body: JsonObject): Promise<RemoteWorkflow> {
    return this.request("POST", "/workflows", body);
  }

  updateWorkflow(id: string, body: JsonObject): Promise<RemoteWorkflow> {
    return this.request("PUT", `/workflows/${encodeURIComponent(id)}`, body);
  }

  activate(id: string): Promise<unknown> {
    return this.request("POST", `/workflows/${encodeURIComponent(id)}/activate`);
  }

  deactivate(id: string): Promise<unknown> {
    return this.request("POST", `/workflows/${encodeURIComponent(id)}/deactivate`);
  }

  listTags(): Promise<{ id: string; name: string }[]> {
    return this.paginate<{ id: string; name: string }>("/tags");
  }

  createTag(name: string): Promise<{ id: string; name: string }> {
    return this.request("POST", "/tags", { name });
  }

  setWorkflowTags(id: string, tagIds: string[]): Promise<unknown> {
    return this.request("PUT", `/workflows/${encodeURIComponent(id)}/tags`, tagIds.map((t) => ({ id: t })));
  }

  /** Returns null when the instance's API version cannot list credentials. */
  async listCredentials(): Promise<RemoteCredential[] | null> {
    try {
      return await this.paginate<RemoteCredential>("/credentials");
    } catch (e) {
      if (e instanceof ApiError && [404, 405].includes(e.status)) return null;
      throw e;
    }
  }
}
