"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { PreviewCard, type PagePreview, type PreviewAnchor } from "@/components/wiki/preview-card";

/**
 * How long the pointer must rest on a link before the card appears. Long enough
 * that sweeping across a sentence full of links does not fire a request per
 * word, short enough that a deliberate hover still feels like a hover.
 */
export const PREVIEW_OPEN_DELAY_MS = 800;

/**
 * Grace period after the pointer leaves the link. Together with the card's own
 * pointer handlers this is the "bridge": the pointer can travel from the link
 * to the card (to click "open page") without the card vanishing underneath it.
 */
const PREVIEW_CLOSE_GRACE_MS = 180;

/** Cap on the in-memory preview cache. Entries are tiny; this is a bound, not a budget. */
const CACHE_LIMIT = 200;

type PreviewTarget = { slug: string; anchor: PreviewAnchor };

type PreviewData = {
  status: "loading" | "ready" | "missing";
  preview: PagePreview | null;
};

type PendingState = PreviewTarget | null;

type LinkPreviewState = { active: boolean };

// Spreading these onto a link must be legal even when the hook stays inert, so
// every handler is optional; a provider always fills in the full set.
type LinkPreviewHandlers = {
  onPointerEnter?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave?: () => void;
  onFocus?: (event: React.FocusEvent<HTMLElement>) => void;
  onBlur?: () => void;
};

export type WikiLinkPreview = {
  /** True while this link owns the card (waiting for the delay, or showing it). */
  active: boolean;
  handlers: LinkPreviewHandlers;
};

const IDLE: LinkPreviewState = { active: false };
const ACTIVE: LinkPreviewState = { active: true };

/**
 * Which slug currently owns the card, published outside React.
 *
 * A link needs to re-render only when *its own* active flag flips, but a context
 * value cannot do that: a new context value re-renders every consumer, and a
 * link that returns a fresh object from a hook on every render is an infinite
 * loop under useSyncExternalStore. So the active slug lives in a tiny module
 * store with cached, referentially stable snapshots per slug, and each link
 * subscribes to just that.
 */
let activeSlug: string | null = null;
const listeners = new Set<() => void>();
const snapshots = new Map<string, LinkPreviewState>();

function getSnapshot(slug: string): LinkPreviewState {
  const cached = snapshots.get(slug);
  if (cached !== undefined) return cached;
  const next = slug === activeSlug ? ACTIVE : IDLE;
  snapshots.set(slug, next);
  return next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(nextSlug: string | null): void {
  if (activeSlug === nextSlug) return;
  activeSlug = nextSlug;
  // Cheap invalidation: snapshots are rebuilt lazily from the new activeSlug, so
  // links that did not change state keep their previous object identity and
  // `useSyncExternalStore` skips re-rendering them.
  snapshots.clear();
  for (const listener of listeners) listener();
}

type PreviewContextValue = {
  /** Returns the stable handler slot for a link, creating it on first use. */
  register: (slug: string) => LinkPreviewHandlers;
};

/**
 * Fetched previews, alive for the lifetime of the browser session. Module scope
 * rather than provider state so navigating between pages keeps the warm cache —
 * the second hover on a page is then instant, with no request and no skeleton.
 * Bounded, in-memory, and thrown away on reload by design (the project forbids
 * localStorage/sessionStorage).
 */
const previewCache = new Map<string, PagePreview | null>();

const PreviewContext = createContext<PreviewContextValue | null>(null);

export type PagePreviewProviderProps = {
  children: ReactNode;
};

/**
 * Owns the single hover preview card for everything rendered inside it.
 *
 * One provider means one card and one set of timers no matter how many links a
 * page has: moving from link A to link B to link C shows at most one card, and
 * the open delay restarts per link instead of accumulating.
 */
export function PagePreviewProvider({ children }: PagePreviewProviderProps) {
  const [pending, setPending] = useState<PendingState>(null);
  const [data, setData] = useState<PreviewData | null>(null);

  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // Module memory only: the project forbids localStorage/sessionStorage, and a
  // preview is cheap to rebuild after a reload. `null` caches a 404 so a stale
  // link is not re-requested on every hover.
  const cacheRef = useRef<Map<string, PagePreview | null>>(previewCache);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimers();
    controllerRef.current?.abort();
    controllerRef.current = null;
    publish(null);
    setPending(null);
    setData(null);
  }, [clearTimers]);

  const cachePut = useCallback((slug: string, preview: PagePreview | null) => {
    const cache = cacheRef.current;
    // Delete-then-set so map order is recency order and the first key is the
    // oldest one to reap.
    cache.delete(slug);
    cache.set(slug, preview);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }, []);

  const load = useCallback(
    async (slug: string) => {
      const controller = new AbortController();
      controllerRef.current = controller;
      setData({ status: "loading", preview: null });

      try {
        const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/preview`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        if (res.status === 404) {
          cachePut(slug, null);
          setData({ status: "missing", preview: null });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const preview = (await res.json()) as PagePreview;
        if (controller.signal.aborted) return;
        cachePut(slug, preview);
        setData({ status: "ready", preview });
      } catch (err) {
        // An aborted request is a normal consequence of moving the pointer, not
        // a failure worth showing.
        if (controller.signal.aborted || (err as Error).name === "AbortError") return;
        // Surfaced in the card as "no preview"; the console line is what makes a
        // broken endpoint diagnosable instead of silently empty.
        console.warn(`[page-preview] 获取 ${slug} 的预览失败：${(err as Error).message}`);
        setData({ status: "missing", preview: null });
      }
    },
    [cachePut],
  );

  const show = useCallback(
    (slug: string, anchor: PreviewAnchor) => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      setPending({ slug, anchor });

      const cached = cacheRef.current.get(slug);
      if (cached === undefined) {
        void load(slug);
        return;
      }
      // A repeat hover must feel instant, so a cached value skips the fetch (and
      // its loading skeleton) entirely.
      setData(
        cached === null
          ? { status: "missing", preview: null }
          : { status: "ready", preview: cached },
      );
    },
    [load],
  );

  const scheduleOpen = useCallback(
    (slug: string, element: HTMLElement) => {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      if (openTimerRef.current !== null) clearTimeout(openTimerRef.current);

      publish(slug);
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null;
        const rect = element.getBoundingClientRect();
        show(slug, {
          rect: { top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width },
        });
      }, PREVIEW_OPEN_DELAY_MS);
    },
    [show],
  );

  const scheduleClose = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      dismiss();
    }, PREVIEW_CLOSE_GRACE_MS);
  }, [dismiss]);

  // An open card is positioned in viewport coordinates, so anything that moves
  // the link underneath it must close it rather than leave it floating over the
  // wrong text. Capture phase, because scrolls inside panes (the chat
  // transcript, a long page body) do not bubble to the window.
  useEffect(() => {
    if (pending === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [pending, dismiss]);

  useEffect(() => {
    return () => {
      clearTimers();
      controllerRef.current?.abort();
      // Reset the shared store so a remounted provider (route change, Fast
      // Refresh) never starts with a stale "this link is active" snapshot.
      publish(null);
    };
  }, [clearTimers]);

  // One handler slot per slug, kept stable across re-renders: React hands the
  // same `onPointerLeave` back to the same element, so a re-render in the middle
  // of a hover cannot drop the handler that would close the card.
  const slotsRef = useRef<Map<string, LinkPreviewHandlers>>(new Map());

  const register = useCallback(
    (slug: string): LinkPreviewHandlers => {
      const existing = slotsRef.current.get(slug);
      if (existing !== undefined) return existing;

      const handlers: LinkPreviewHandlers = {
        onPointerEnter: (event) => {
          // Touch and pen have no hover; firing a card there would compete with
          // the tap that navigates.
          if (event.pointerType !== "mouse") return;
          scheduleOpen(slug, event.currentTarget);
        },
        onPointerLeave: scheduleClose,
        onFocus: (event) => {
          // Keyboard users get the same affordance, with the same intent delay
          // so a tab pass through a long page does not flash cards.
          scheduleOpen(slug, event.currentTarget);
        },
        onBlur: dismiss,
      };
      slotsRef.current.set(slug, handlers);
      return handlers;
    },
    [scheduleOpen, scheduleClose, dismiss],
  );

  const contextValue = useMemo<PreviewContextValue>(() => ({ register }), [register]);

  const cardTitle = data?.preview ?? null;

  return (
    <PreviewContext.Provider value={contextValue}>
      {children}
      {pending !== null ? (
        <PreviewCard
          preview={cardTitle ?? placeholderPreview(pending.slug)}
          anchor={pending.anchor}
          loading={data === null || data.status === "loading"}
          missing={data?.status === "missing"}
          onPointerEnter={() => {
            // Re-entering the card cancels a pending close, so the bridge holds
            // while the pointer crosses the gap.
            if (closeTimerRef.current !== null) {
              clearTimeout(closeTimerRef.current);
              closeTimerRef.current = null;
            }
          }}
          onPointerLeave={scheduleClose}
        />
      ) : null}
    </PreviewContext.Provider>
  );
}

function placeholderPreview(slug: string): PagePreview {
  return {
    slug,
    title: slug,
    type: "concept",
    tags: [],
    updated: "",
    excerpt: "",
    truncated: false,
  };
}

/**
 * Attach to a link that points at a wiki page: returns the handlers to spread
 * onto the element and `active`, which is true while a card is on its way or
 * already showing.
 *
 * Pass `null` for links with nothing to preview (a strikethrough link to a page
 * that does not exist) — the hook then stays inert and requests nothing. Safe
 * with no provider above it either, which keeps MarkdownView renderable
 * standalone in previews and tests.
 */
export function useWikiLinkPreview(slug: string | null): WikiLinkPreview {
  const context = useContext(PreviewContext);
  const register = context?.register ?? null;

  // Server render and the hydration pass always report idle; the store is
  // client-only state and a card cannot be open before the first hover.
  const state = useSyncExternalStore(
    subscribe,
    () => (register === null || slug === null ? IDLE : getSnapshot(slug)),
    () => IDLE,
  );

  // Same lazy-slot idiom the provider uses: the slot object is created once per
  // slug and then reused, so the identity React sees never changes.
  const handlers = useMemo(
    () => (register === null || slug === null ? EMPTY_HANDLERS : register(slug)),
    [register, slug],
  );

  if (register === null || slug === null) return { active: false, handlers: EMPTY_HANDLERS };
  return { active: state.active, handlers };
}

const EMPTY_HANDLERS: LinkPreviewHandlers = {};
