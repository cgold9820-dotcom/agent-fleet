import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "../tasks.js";

/** What Orca knows about a workspace, keyed by normalized worktree path. */
export interface OrcaWorkspace {
  name: string;
  comment?: string;
  agent?: string;
}

/** Default location of Orca's profile database on each platform. */
export function orcaProfileDb(): string {
  if (process.env.ORCA_PROFILE_DB) return process.env.ORCA_PROFILE_DB;
  const base =
    process.platform === "win32"
      ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "orca", "profiles", "local-default", "profile-state.db");
}

/**
 * Parse Orca's `worktreeMeta` document: a record keyed `<repoId>::<path>`
 * whose values carry the workspace's display name, comment and the agent it
 * was created with.
 */
export function parseWorktreeMeta(payload: string): Map<string, OrcaWorkspace> {
  const out = new Map<string, OrcaWorkspace>();
  const meta = JSON.parse(payload) as Record<string, { displayName?: string; comment?: string; createdWithAgent?: string; isArchived?: boolean }>;
  for (const [key, m] of Object.entries(meta ?? {})) {
    const sep = key.indexOf("::");
    const path = sep >= 0 ? key.slice(sep + 2) : key;
    if (!path || !m?.displayName) continue;
    out.set(normalizePath(path), { name: m.displayName, comment: m.comment || undefined, agent: m.createdWithAgent || undefined });
  }
  return out;
}

/** Load node:sqlite without its one-time "experimental feature" warning. */
function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (!String(warning).includes("SQLite")) (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * Read workspace names from Orca's profile database (read-only). Returns an
 * empty map when Orca is not installed, the database layout is unknown, or
 * this Node has no built-in SQLite (added in Node 22.5).
 */
export function readOrcaWorkspaces(dbPath = orcaProfileDb()): Map<string, OrcaWorkspace> {
  if (!existsSync(dbPath)) return new Map();
  let db: { prepare(sql: string): { get(...args: unknown[]): unknown }; close(): void } | undefined;
  try {
    const { DatabaseSync } = loadSqlite();
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db!.prepare("SELECT payload FROM profile_state_documents WHERE domain = ?").get("worktreeMeta") as { payload?: string } | undefined;
    return row?.payload ? parseWorktreeMeta(row.payload) : new Map();
  } catch {
    return new Map();
  } finally {
    db?.close();
  }
}
