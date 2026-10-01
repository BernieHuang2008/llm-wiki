"use client";

import { Info } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A grey ⓘ that reveals its explanation only on hover (or keyboard focus).
 *
 * Settings rows are deliberately terse — the title and the control say
 * everything at a glance — so the "why" that used to sit under every heading
 * lives in here instead. Rendered inline (not portalled): the tooltip has room
 * on every tab and a fixed reference point keeps it from jumping around.
 */
export function InfoHint({ children }: { children: ReactNode }) {
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label="说明"
        className="inline-flex items-center rounded-full text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {/* pt-1.5 rather than mt-2: the padding is an invisible hover bridge, so
          the tooltip survives the cursor travelling down from the icon. */}
      <span className="pointer-events-none absolute left-0 top-full z-30 hidden w-80 max-w-[calc(100vw-2rem)] pt-1.5 group-hover:block group-focus-within:block">
        <span className="block max-h-80 overflow-y-auto rounded-md border border-border bg-card px-3 py-2 text-left text-xs font-normal leading-relaxed text-muted-foreground shadow-lg">
          {children}
        </span>
      </span>
    </span>
  );
}

/**
 * One table row of a settings pane: title (+ inline ⓘ) on the left, the
 * control that changes it on the right.
 */
export function SettingsRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-6">
      <div className="flex items-center gap-1.5 sm:w-44 sm:shrink-0">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {hint ? <InfoHint>{hint}</InfoHint> : null}
      </div>
      <div className="sm:min-w-0 sm:flex-1">{children}</div>
    </div>
  );
}
