// "Recent runs" window rules, shared by the list and detail routes and the UI
// copy so they can never disagree about what "recent" means.

import type { RunKind } from "@llm-wiki/core";

/** At most this many runs are listed. */
export const RUN_LIST_LIMIT = 50;
/** …and never older than this, whichever bound bites first. */
export const RUN_WINDOW_DAYS = 14;

/** Recent-lint panel shows this many runs (per the product spec). */
export const LINT_LIST_LIMIT = 5;

export const RUN_KIND_LABEL: Record<RunKind, string> = {
  query: "查询",
  lint: "体检",
};

/** ISO timestamp for the start of the recent-runs window. */
export function recentWindowStart(now: Date = new Date()): string {
  return new Date(now.getTime() - RUN_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
