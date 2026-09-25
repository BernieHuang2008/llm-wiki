// Server-only helpers that resolve the active wiki path and open the
// per-wiki resources (settings + SQLite). Used by API routes; not for
// client components.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { redirect } from "next/navigation";

import {
  backfillUsageCosts,
  DEFAULT_WIKI_SETTINGS,
  getApiKey,
  globalConfigPath,
  initWikiFolder,
  loadWikiSettings,
  missingKeyProvider,
  openDb,
  purgeOldTrash,
  syncWikiToDb,
  wikiSettingsPath,
  type Db,
  type KeyProvider,
  type WikiSettings,
} from "@llm-wiki/core";

// Throttle the trash purge so we don't crawl the trash dir on every API call.
// One purge per process per hour is plenty for V1.
let lastPurgeMs = 0;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

// Track which wikis we've already cost-backfilled this process lifetime.
// Backfill is for rows from the pre-fix era (where every insertUsage hard-
// coded cost_cents: null); once per wiki per process is enough. Switching
// wikis adds the new path to the set on first open.
const backfilledWikis = new Set<string>();

/**
 * Resolution order (docs/13-multi-wiki.md):
 * 1. `LLM_WIKI_PATH` env var — explicit override, wins. Useful for CI,
 *    scripting, and the CLI's `start <folder>` form.
 * 2. `activeWiki` in `~/.llm-wiki/config.json` — set by Settings → Wikis
 *    picker. The canonical user-facing mechanism for switching wikis
 *    without a server restart.
 * 3. `~/llm-wiki-default` — first-run fallback so the app boots usefully
 *    before the user has named a wiki.
 *
 * Sync read of the config file because this runs inside server-component
 * render paths and we don't want to make every page async on a tiny,
 * OS-cached JSON file. Failures fall through to the default silently.
 */
export function resolveWikiPath(): string {
  const fromEnv = process.env["LLM_WIKI_PATH"];
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(globalConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as { activeWiki?: unknown };
    if (typeof parsed.activeWiki === "string" && parsed.activeWiki.length > 0) {
      return parsed.activeWiki;
    }
  } catch {
    // ENOENT (no config yet) or malformed JSON — fall through to default.
  }
  return join(homedir(), "llm-wiki-default");
}

export type WikiContext = {
  wikiPath: string;
  db: Db;
  settings: WikiSettings;
};

/**
 * Hook the background task executor installs at module load. `openWikiContext`
 * calls it so the executor's worker lanes start on the first request that
 * touches a wiki, without importing the executor (which would be a cycle).
 */
let onWikiContextOpened: (() => void) | null = null;

export function registerWikiContextHook(hook: () => void): void {
  onWikiContextOpened = hook;
  // Start immediately as well: on the first request the hook is registered
  // during module evaluation, before `openWikiContext` reaches the call below.
  try {
    hook();
  } catch {
    // Starting the executor is best-effort; a request must never fail for it.
  }
}

/**
 * Cheap, synchronous context for the executor's polling loop: opens the DB and
 * reads settings from disk without the per-call disk→DB sync (which each
 * request already performs).
 */
export function openWikiContextSync(): WikiContext {
  const wikiPath = resolveWikiPath();
  const db = openDb(wikiPath);
  let settings: WikiSettings;
  try {
    settings = JSON.parse(
      readFileSync(wikiSettingsPath(wikiPath), "utf8"),
    ) as WikiSettings;
  } catch {
    settings = {
      ...DEFAULT_WIKI_SETTINGS,
      defaultModels: { ...DEFAULT_WIKI_SETTINGS.defaultModels },
    };
  }
  return { wikiPath, db, settings };
}

/**
 * Ensures the wiki folder is initialized, opens the DB, runs an idempotent
 * sync from disk, and returns the per-request context.
 *
 * The DB connection stays open for the lifetime of the request — callers
 * MUST close it when done (typical pattern: try/finally in the route).
 */
export async function openWikiContext(): Promise<WikiContext> {
  const wikiPath = resolveWikiPath();
  await initWikiFolder(wikiPath); // idempotent
  const db = openDb(wikiPath);
  try {
    await syncWikiToDb(wikiPath, db);
  } catch (err) {
    db.close();
    throw err;
  }
  const settings = await loadWikiSettings(wikiPath);

  // First request of the process starts the background task executor.
  onWikiContextOpened?.();

  // Best-effort 30-day trash cleanup. Throttled, errors ignored.
  if (Date.now() - lastPurgeMs > PURGE_INTERVAL_MS) {
    lastPurgeMs = Date.now();
    purgeOldTrash(wikiPath).catch(() => {});
  }

  // One-shot cost backfill per wiki per process. Picks up any usage rows
  // from before the cost_cents fix (2026-05-24) and fills them in from
  // the pricing table. NULL stays NULL for unknown models.
  if (!backfilledWikis.has(wikiPath)) {
    backfilledWikis.add(wikiPath);
    try {
      backfillUsageCosts(db);
    } catch {
      // Non-fatal — dashboard just shows a smaller cumulative.
    }
  }

  return { wikiPath, db, settings };
}

/**
 * Page-level redirect gate for protected routes — the equivalent of the
 * `next/navigation` middleware pattern, but since Next 14 middleware runs
 * on the Edge runtime (no `node:fs` access to `~/.llm-wiki/config.json`)
 * we do the check in each protected page's server component instead.
 *
 * Drops the user back at `/` if either:
 * - no OpenRouter API key is configured (any operation would fail loud)
 * - the active wiki has no topic set (the LLM has no scope to work in)
 *
 * `/` itself runs the onboarding wizard for these cases, so this is a
 * one-line redirect at the top of each protected page.
 *
 * Pages that opt in: `/wiki`, `/wiki/[slug]`, `/sources`, `/sources/[id]`,
 * `/query`, `/chats`, `/chats/[id]`, `/lint`, `/log`, `/graph`, `/schema`.
 * Pages that don't: `/`, `/about`, `/help`, `/developers`, `/settings`
 * (the user needs to be able to reach Settings to configure things).
 */
export type ModelSlotName = keyof WikiSettings["defaultModels"];

export type SetupStatus = {
  needsTopic: boolean;
  /** Provider whose key is missing for the gated slot, if any. */
  missingKeyProvider: KeyProvider | null;
};

/**
 * "Is this wiki ready to run the given operation?" — one implementation, used
 * by both the page gate and the onboarding wizard.
 *
 * A slot backed by Ollama never needs a key; a slot backed by OpenRouter needs
 * an OpenRouter key; a DeepSeek slot needs a DeepSeek key. Checking only
 * OpenRouter here was how a DeepSeek-only setup ended up bounced to a wizard
 * that could not accept the key it was asking for.
 */
export async function getSetupStatus(slot?: ModelSlotName): Promise<SetupStatus> {
  const settings = await loadWikiSettings(resolveWikiPath());
  let missing: KeyProvider | null = null;

  if (slot) {
    const provider = settings.defaultModels[slot].provider;
    const needed = missingKeyProvider(provider);
    if (needed) {
      const { key } = await getApiKey(needed);
      if (!key) missing = needed;
    }
  }

  return { needsTopic: settings.topic.trim().length === 0, missingKeyProvider: missing };
}

export async function requireSetup(slot?: ModelSlotName): Promise<void> {
  const status = await getSetupStatus(slot);
  if (status.needsTopic) {
    redirect("/");
  } else if (status.missingKeyProvider) {
    // Tell the wizard which key to ask for; without it the form would offer
    // the wrong provider's field and the user could never satisfy the gate.
    redirect(`/?needsKey=1&provider=${status.missingKeyProvider}&slot=${slot ?? ""}`);
  }
}
