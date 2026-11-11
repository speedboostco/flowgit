export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface N8nNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: number[];
  parameters?: JsonObject;
  credentials?: Record<string, { id?: string; name?: string }>;
  disabled?: boolean;
  [key: string]: unknown;
}

/** A workflow as returned by the n8n public API. */
export interface RemoteWorkflow {
  id: string;
  name: string;
  active?: boolean;
  nodes: N8nNode[];
  connections: JsonObject;
  settings?: JsonObject;
  tags?: { id?: string; name: string }[];
  [key: string]: unknown;
}

/** A workflow as stored in Git: environment-agnostic, no IDs that differ between instances. */
export interface StoredWorkflow {
  name: string;
  active: boolean;
  tags: string[];
  settings: JsonObject;
  nodes: N8nNode[];
  connections: JsonObject;
}

export interface RemoteCredential {
  id: string;
  name: string;
  type: string;
}
