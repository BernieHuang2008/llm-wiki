import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  base64UrlEncode,
  randomApprovalCode,
  randomToken,
  safeEqual,
  sha256,
  verifyPkce,
} from "./crypto";
import { MCP_TOOL_IDS, SCOPE_ALL, toolScope, toolsForScopes } from "../tools/registry";

/** The challenge a conforming client would send for a given verifier. */
function challengeFor(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

describe("verifyPkce", () => {
  const verifier = "a".repeat(48);

  it("accepts a matching S256 pair", () => {
    expect(verifyPkce(challengeFor(verifier), "S256", verifier)).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    expect(verifyPkce(challengeFor(verifier), "S256", "b".repeat(48))).toBe(false);
  });

  it("treats a missing method as S256", () => {
    expect(verifyPkce(challengeFor(verifier), undefined, verifier)).toBe(true);
  });

  it("supports plain only when it was requested", () => {
    expect(verifyPkce(verifier, "plain", verifier)).toBe(true);
    // A client that sent the verifier as its own challenge must not be accepted
    // down the S256 path.
    expect(verifyPkce(verifier, "S256", verifier)).toBe(false);
  });

  it("refuses out-of-range or illegal verifiers", () => {
    expect(verifyPkce(challengeFor(verifier), "S256", "short")).toBe(false);
    expect(verifyPkce(challengeFor(verifier), "S256", "a".repeat(129))).toBe(false);
    expect(verifyPkce(challengeFor(verifier), "S256", `${"a".repeat(40)}!!`)).toBe(false);
  });
});

describe("token generation", () => {
  it("produces distinct, URL-safe secrets", () => {
    const a = randomToken(24);
    const b = randomToken(24);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes deterministically", () => {
    expect(sha256("x")).toBe(sha256("x"));
    expect(sha256("x")).not.toBe(sha256("y"));
  });

  it("makes a typable approval code", () => {
    expect(randomApprovalCode()).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
  });

  it("compares safely", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("scopes", () => {
  it("derives one scope per tool", () => {
    expect(toolScope("wiki_search")).toBe("wiki:search");
    expect(toolScope("wiki_read_page")).toBe("wiki:read-page");
    expect(toolScope("wiki_get_toc")).toBe("wiki:get-toc");
  });

  it("expands wiki:read to every tool", () => {
    expect(toolsForScopes([SCOPE_ALL])).toEqual([...MCP_TOOL_IDS]);
  });

  it("grants only the tools named by specific scopes", () => {
    expect(toolsForScopes(["wiki:search", "wiki:backlinks"])).toEqual([
      "wiki_search",
      "wiki_backlinks",
    ]);
  });

  it("grants nothing for an unknown scope", () => {
    expect(toolsForScopes(["wiki:nonsense"])).toEqual([]);
  });
});
