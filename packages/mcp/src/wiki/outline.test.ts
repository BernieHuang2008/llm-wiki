import { describe, expect, it } from "vitest";

import { childHeadings, extractHeadings, findHeading, slugify } from "./outline";

const PAGE = `---
title: Example
---

# Example

Intro paragraph.

## Alpha

Alpha body.

### Alpha Child

Child body.

## Beta

Beta body.

\`\`\`bash
# not a heading
echo hi
\`\`\`

## Gamma
`;

describe("extractHeadings", () => {
  it("lists headings with line ranges and paths", () => {
    const headings = extractHeadings(PAGE);
    expect(headings.map((h) => h.title)).toEqual([
      "Example",
      "Alpha",
      "Alpha Child",
      "Beta",
      "Gamma",
    ]);
    expect(headings.map((h) => h.path)).toEqual([
      "Example",
      "Example > Alpha",
      "Example > Alpha > Alpha Child",
      "Example > Beta",
      "Example > Gamma",
    ]);
  });

  it("gives a parent the full range and a child its own range", () => {
    const headings = extractHeadings(PAGE);
    const alpha = headings.find((h) => h.title === "Alpha");
    const child = headings.find((h) => h.title === "Alpha Child");
    expect(alpha).toBeDefined();
    expect(child).toBeDefined();
    // Alpha ends where Beta begins; its own content stops before the child.
    expect(alpha?.ownEndLine).toBeLessThan(child?.startLine ?? 0);
    expect(alpha?.endLine).toBeGreaterThan(alpha?.ownEndLine ?? 0);
  });

  it("ignores a # line inside a fenced code block", () => {
    const headings = extractHeadings(PAGE);
    expect(headings.some((h) => h.title.includes("not a heading"))).toBe(false);
  });

  it("can drop the leading H1", () => {
    const headings = extractHeadings(PAGE, { includeTitleHeading: false });
    expect(headings[0]?.title).toBe("Alpha");
  });

  it("numbers duplicate anchors apart", () => {
    const headings = extractHeadings("# A\n\n## Same\n\ntext\n\n## Same\n\nmore\n");
    const ids = headings.filter((h) => h.title === "Same").map((h) => h.id);
    expect(ids).toEqual(["same", "same-1"]);
  });

  it("returns nothing for a page without headings", () => {
    expect(extractHeadings("just prose, no structure")).toEqual([]);
  });
});

describe("findHeading", () => {
  const headings = extractHeadings(PAGE);

  it("matches the full title path", () => {
    expect(findHeading(headings, "Example > Alpha > Alpha Child")?.title).toBe("Alpha Child");
  });

  it("matches a bare title and an anchor id", () => {
    expect(findHeading(headings, "Beta")?.title).toBe("Beta");
    expect(findHeading(headings, "alpha-child")?.title).toBe("Alpha Child");
  });

  it("is case-insensitive", () => {
    expect(findHeading(headings, "gAmMa")?.title).toBe("Gamma");
  });

  it("falls back to a substring match", () => {
    expect(findHeading(headings, "child")?.title).toBe("Alpha Child");
  });

  it("returns null when nothing matches", () => {
    expect(findHeading(headings, "nope")).toBeNull();
  });
});

describe("childHeadings", () => {
  it("returns only the direct children", () => {
    const headings = extractHeadings(PAGE);
    const alpha = headings.find((h) => h.title === "Alpha");
    expect(alpha).toBeDefined();
    expect(childHeadings(headings, alpha!)?.map((h) => h.title)).toEqual(["Alpha Child"]);
  });
});

describe("slugify", () => {
  it("lowercases, strips punctuation and hyphenates", () => {
    expect(slugify("Shor's Algorithm!")).toBe("shors-algorithm");
  });

  it("keeps CJK characters", () => {
    expect(slugify("显著性")).toBe("显著性");
  });
});
