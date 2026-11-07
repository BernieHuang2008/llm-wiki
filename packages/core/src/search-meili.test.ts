import { afterEach, describe, expect, it, vi } from "vitest";

import { openInMemoryDb, type Db } from "./db";
import { upsertPage } from "./db-pages";
import {
  searchByMetadata,
  searchWikiInMeili,
  searchWikiPages,
  wikiIndexUid,
} from "./search-meili";

function seedPage(db: Db, slug: string, title: string, type: string, tags: string[]): void {
  upsertPage(db, {
    slug,
    title,
    type: type as "concept",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    word_count: 10,
    tags,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("wikiIndexUid", () => {
  it("is stable for the same path and safe for Meilisearch", () => {
    const a = wikiIndexUid("/data/wiki");
    const b = wikiIndexUid("/data/wiki/");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z0-9_]+$/);
  });

  it("differs for different wiki folders", () => {
    expect(wikiIndexUid("/data/physics")).not.toBe(wikiIndexUid("/data/ml"));
  });
});

describe("searchByMetadata", () => {
  it("matches titles and tags and honours filters", () => {
    const db = openInMemoryDb();
    try {
      seedPage(db, "shors-algorithm", "Shor's Algorithm", "concept", ["quantum", "factoring"]);
      seedPage(db, "grover", "Grover's Algorithm", "concept", ["quantum", "search"]);
      seedPage(db, "quantum-company", "Quantum Company", "entity", ["quantum"]);

      const hits = searchByMetadata(db, { query: "shor" });
      expect(hits.map((h) => h.slug)).toEqual(["shors-algorithm"]);

      const tagged = searchByMetadata(db, { query: "quantum", tags: ["factoring"] });
      expect(tagged.map((h) => h.slug)).toEqual(["shors-algorithm"]);

      const typed = searchByMetadata(db, { query: "quantum", type: "entity" });
      expect(typed.map((h) => h.slug)).toEqual(["quantum-company"]);
    } finally {
      db.close();
    }
  });
});

describe("searchWikiPages", () => {
  it("falls back to title/tag matching when Meilisearch is not configured", async () => {
    vi.stubEnv("MEILISEARCH_URL", "");
    const db = openInMemoryDb();
    try {
      seedPage(db, "shors-algorithm", "Shor's Algorithm", "concept", ["quantum"]);
      const result = await searchWikiPages("/data/wiki", db, { query: "shor" });
      expect(result.strategy).toBe("metadata");
      expect(result.hits.map((h) => h.slug)).toEqual(["shors-algorithm"]);
    } finally {
      db.close();
    }
  });
});

describe("searchWikiInMeili", () => {
  it("maps Meilisearch hits into the shared hit shape", async () => {
    vi.stubEnv("MEILISEARCH_URL", "http://meili.test");
    vi.stubEnv("MEILISEARCH_API_KEY", "secret");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          hits: [
            {
              slug: "shors-algorithm",
              title: "Shor's Algorithm",
              type: "concept",
              tags: ["quantum"],
              _formatted: {
                title: "\uE000Shor's\uE001 Algorithm",
                content: "\uE000Shor\uE001 factors integers…",
              },
              _rankingScore: 0.87,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const hits = await searchWikiInMeili("/data/wiki", { query: "shor", limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits?.[0]).toMatchObject({
      slug: "shors-algorithm",
      title: "\uE000Shor's\uE001 Algorithm",
      channel: "meili",
      type: "concept",
      score: 0.87,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toBeInstanceOf(Headers);
    expect(((init as RequestInit).headers as Headers).get("authorization")).toBe("Bearer secret");
  });

  it("returns null when the request fails so callers can fall back", async () => {
    vi.stubEnv("MEILISEARCH_URL", "http://meili.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    await expect(searchWikiInMeili("/data/wiki", { query: "shor" })).resolves.toBeNull();
  });
});
