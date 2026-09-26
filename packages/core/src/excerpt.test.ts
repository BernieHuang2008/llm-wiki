import { describe, expect, it } from "vitest";

import { buildExcerpt, DEFAULT_EXCERPT_LIMIT } from "./excerpt";

describe("buildExcerpt", () => {
  it("returns the opening paragraph with markdown stripped", () => {
    const { text, truncated } = buildExcerpt(
      "# 摘要\n\n**Shor 算法**是一个量子算法，用于在多项式时间内完成整数分解。\n\n## 细节\n\n更多内容。\n",
    );
    expect(text).toBe("Shor 算法是一个量子算法，用于在多项式时间内完成整数分解。");
    // The excerpt text itself is complete; later sections existing is not
    // truncation — the card is a preview, not the page.
    expect(truncated).toBe(false);
  });

  it("skips link-only opening sections and picks the first real prose", () => {
    const { text } = buildExcerpt(
      [
        "## 相关链接",
        "",
        "[[qc]] [[shor|Shor]]",
        "",
        "## 概述",
        "",
        "Shor 算法由 Peter Shor 于 1994 年提出，是量子计算最具影响力的结果之一。",
        "",
        "## 参考",
        "",
        "- [[bell-labs]]",
      ].join("\n"),
    );
    expect(text).toContain("Shor 算法由 Peter Shor 于 1994 年提出");
    expect(text).not.toContain("qc");
  });

  it("never leaks fenced code or table content", () => {
    const { text } = buildExcerpt(
      [
        "## 用法",
        "",
        "```ts",
        "const secret = 'do-not-preview-me';",
        "```",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "调用 `run()` 即可启动一次完整的模拟流程。",
      ].join("\n"),
    );
    expect(text).toBe("调用 run() 即可启动一次完整的模拟流程。");
    expect(text).not.toContain("do-not-preview-me");
  });

  it("reduces inline links, image alt text and autolinks to plain text", () => {
    const { text } = buildExcerpt(
      "参考 [官方文档](https://example.com/x) 与 ![量子电路图](img.png)，也可访问 <https://example.org/y> 查看。",
    );
    expect(text).toBe("参考 官方文档 与 量子电路图，也可访问 https://example.org/y 查看。");
  });

  it("falls back to the section headings when a page has no prose", () => {
    const { text, truncated } = buildExcerpt(
      "## 定义\n\n[[qubit]]\n\n## 性质\n\n[[entanglement]]\n",
    );
    expect(text).toBe("定义 · 性质");
    expect(truncated).toBe(false);
  });

  it("returns an empty excerpt for an empty body", () => {
    expect(buildExcerpt("")).toEqual({ text: "", truncated: false });
    expect(buildExcerpt("\n\n   \n")).toEqual({ text: "", truncated: false });
  });

  it("cuts on a sentence boundary inside the budget", () => {
    const sentence = "这是一个足够长的句子，用来填满预览卡片的字符预算。";
    const { text, truncated } = buildExcerpt(sentence.repeat(4), { limit: 60 });
    expect(text.length).toBeLessThanOrEqual(60);
    expect(text.endsWith("。")).toBe(true);
    expect(truncated).toBe(true);
  });

  it("does not rewind to a tiny opening sentence", () => {
    const { text } = buildExcerpt(`短句。${"后续内容".repeat(40)}`, { limit: 100 });
    expect(text.length).toBeGreaterThan(60);
  });

  it("recognises english sentence endings", () => {
    const { text } = buildExcerpt(
      "Shor's algorithm factors integers. It runs in polynomial time. More detail follows here that overflows the budget.",
      { limit: 80 },
    );
    expect(text).toBe("Shor's algorithm factors integers. It runs in polynomial time.");
  });

  it("always respects the character budget, even with no sentence boundary", () => {
    const { text } = buildExcerpt("quantum".repeat(200), { limit: 40 });
    expect(text.length).toBeLessThanOrEqual(40);
  });

  it("marks a single short page as not truncated", () => {
    const { text, truncated } = buildExcerpt("这是一个简短但完整的词条说明。");
    expect(text).toBe("这是一个简短但完整的词条说明。");
    expect(truncated).toBe(false);
  });

  it("keeps a short complete sentence instead of treating it as a shell", () => {
    const { text } = buildExcerpt("调用 run() 即可启动一次完整的模拟流程。");
    expect(text).toBe("调用 run() 即可启动一次完整的模拟流程。");
  });

  it("uses the documented default budget", () => {
    expect(DEFAULT_EXCERPT_LIMIT).toBe(450);
    const { text } = buildExcerpt("词条内容。".repeat(500));
    expect(text.length).toBeLessThanOrEqual(DEFAULT_EXCERPT_LIMIT);
  });
});
