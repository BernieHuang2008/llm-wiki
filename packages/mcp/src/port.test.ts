import { describe, expect, it } from "vitest";

import {
  DEFAULT_MCP_PORT,
  detectEndpointPath,
  detectWikiBasePath,
  normalizeMcpPath,
  resolveMcpPort,
  wikiBasePathFromMcpPath,
} from "./port";

describe("resolveMcpPort", () => {
  it("defaults to the hard-coded port", () => {
    expect(resolveMcpPort({})).toBe(DEFAULT_MCP_PORT);
  });

  it("honours the environment override", () => {
    expect(resolveMcpPort({ LLM_WIKI_MCP_PORT: "4001" })).toBe(4001);
  });

  it("ignores rubbish rather than binding a random port", () => {
    expect(resolveMcpPort({ LLM_WIKI_MCP_PORT: "abc" })).toBe(DEFAULT_MCP_PORT);
    expect(resolveMcpPort({ LLM_WIKI_MCP_PORT: "0" })).toBe(DEFAULT_MCP_PORT);
    expect(resolveMcpPort({ LLM_WIKI_MCP_PORT: "70000" })).toBe(DEFAULT_MCP_PORT);
    expect(resolveMcpPort({ LLM_WIKI_MCP_PORT: "  " })).toBe(DEFAULT_MCP_PORT);
  });
});

describe("normalizeMcpPath", () => {
  it.each([
    ["", "/mcp"],
    ["/", "/mcp"],
    ["mcp", "/mcp"],
    ["/mcp", "/mcp"],
    ["/mcp/", "/mcp"],
    ["/research/quantum/mcp", "/research/quantum/mcp"],
    ["//research//quantum//mcp//", "/research/quantum/mcp"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeMcpPath(input)).toBe(expected);
  });
});

describe("wikiBasePathFromMcpPath", () => {
  it.each([
    ["/mcp", ""],
    ["/quantum/mcp", "quantum"],
    ["/research/quantum/mcp", "research/quantum"],
  ])("%s → %s", (input, expected) => {
    expect(wikiBasePathFromMcpPath(input)).toBe(expected);
  });
});

describe("detectEndpointPath", () => {
  it("takes any /mcp suffix at face value", () => {
    expect(detectEndpointPath("/mcp")).toBe("/mcp");
    expect(detectEndpointPath("/research/quantum/mcp")).toBe("/research/quantum/mcp");
  });

  it("falls back to the default for anything else", () => {
    expect(detectEndpointPath("/")).toBe("/mcp");
    expect(detectEndpointPath("/health")).toBe("/mcp");
  });
});

describe("detectWikiBasePath", () => {
  it("is empty when the app did not say", () => {
    expect(detectWikiBasePath({})).toBe("");
  });

  it("reads the base path the app passes", () => {
    expect(detectWikiBasePath({ LLM_WIKI_MCP_BASE_PATH: "/quantum/" })).toBe("quantum");
    expect(detectWikiBasePath({ LLM_WIKI_MCP_BASE_PATH: "research/quantum" })).toBe(
      "research/quantum",
    );
  });
});
