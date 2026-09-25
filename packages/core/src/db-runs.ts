// Durable history of query and lint runs.
//
// Why this exists: the wiki layer is deliberately plain markdown, and log.md
// only keeps a one-line summary per run. That is not enough to reopen a past
// query (nothing was ever stored) or to act on a past lint run (only the issue
// count survived). `run_history` keeps the full validated response so the UI
// can list recent work and open any entry again.

import { randomUUID } from "node:crypto";

import type { Db } from "./db";

export type RunKind = "query" | "lint";

export const RUN_KINDS: readonly RunKind[] = ["query", "lint"] as const;

export type RunRow = {
  id: string;
  kind: RunKind;
  /** Query text, or a short health summary for lint. Drives the list rows. */
  label: string;
  model: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  created_at: string;
};

type RunRowDb = {
  id: string;
  kind: string;
  label: string;
  model: string | null;
  input: string | null;
  output: string | null;
  error: string | null;
  created_at: string;
};

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A truncated write must not break the whole list.
    return null;
  }
}

function rowFromDb(r: RunRowDb): RunRow {
  if (!RUN_KINDS.includes(r.kind as RunKind)) {
    throw new Error(`run_history.${r.id}: unknown kind in DB: ${r.kind}`);
  }
  return {
    id: r.id,
    kind: r.kind as RunKind,
    label: r.label,
    model: r.model,
    input: parseJson(r.input),
    output: parseJson(r.output),
    error: r.error,
    created_at: r.created_at,
  };
}

export type RecordRunOptions = {
  kind: RunKind;
  label: string;
  model?: string | null;
  input?: unknown;
  output?: unknown;
  error?: string | null;
};

/** Appends one run. Returns the new row's id. */
export function recordRun(db: Db, opts: RecordRunOptions): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO run_history (id, kind, label, model, input, output, error, created_at)
     VALUES (@id, @kind, @label, @model, @input, @output, @error, @created_at)`,
  ).run({
    id,
    kind: opts.kind,
    label: opts.label,
    model: opts.model ?? null,
    input: opts.input === undefined ? null : JSON.stringify(opts.input),
    output: opts.output === undefined ? null : JSON.stringify(opts.output),
    error: opts.error ?? null,
    created_at: new Date().toISOString(),
  });
  return id;
}

export function getRun(db: Db, id: string): RunRow | null {
  const row = db.prepare(`SELECT * FROM run_history WHERE id = ?`).get(id) as
    | RunRowDb
    | undefined;
  return row ? rowFromDb(row) : null;
}

export type ListRunsOptions = {
  kind?: RunKind;
  limit?: number;
  /** Only runs created at or after this ISO timestamp. */
  since?: string;
};

/** Recent runs of one kind, newest first. */
export function listRuns(db: Db, opts: ListRunsOptions = {}): RunRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.kind) {
    clauses.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.since) {
    clauses.push("created_at >= ?");
    params.push(opts.since);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  // Cap defensively: the caller may ask for more than we ever want to render.
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
  // `rowid` breaks ties: two runs can land in the same millisecond, and
  // without it their relative order is undefined.
  const rows = db
    .prepare(
      `SELECT * FROM run_history ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params, limit) as RunRowDb[];
  return rows.map(rowFromDb);
}

export function countRuns(db: Db, kind: RunKind, since?: string): number {
  if (since) {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM run_history WHERE kind = ? AND created_at >= ?`)
      .get(kind, since) as { n: number };
    return row.n;
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM run_history WHERE kind = ?`)
    .get(kind) as { n: number };
  return row.n;
}

export function deleteRun(db: Db, id: string): void {
  db.prepare(`DELETE FROM run_history WHERE id = ?`).run(id);
}
