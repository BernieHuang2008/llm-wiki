#!/usr/bin/env node
// Bundles the MCP server into `dist/`.
//
// Why a bundle instead of a tsc build: the workspace packages (`@llm-wiki/core`
// and friends) ship TypeScript *source* with no `dist/` — the app transpiles
// them through Next. A plain `node` process cannot import that, so the MCP
// server compiles the core in as part of its own bundle. Only the packages that
// must stay real files on disk (native addons, and chokidar which pulls them in
// optionally) are left external.
//
// The `createRequire` banner exists because `gray-matter` and `chokidar` are
// CommonJS and call `require()` at runtime; in an ESM bundle that global does
// not exist.

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * Resolved through Node rather than `node_modules/.bin`, because pnpm's shim
 * directory is not guaranteed to exist after a filtered install.
 */
const ESBUILD = resolve(PACKAGE_DIR, "node_modules", "esbuild", "bin", "esbuild");

const EXTERNAL = [
  // Native addons and the packages that conditionally require them.
  "better-sqlite3",
  "keytar",
  "chokidar",
  // The MCP SDK is resolved as a normal dependency at runtime. Bundling it
  // would duplicate zod and produce a second copy of the protocol layer, which
  // makes stack traces point at generated code.
  "@modelcontextprotocol/*",
];

const BANNER = [
  "import { createRequire as __llmWikiCreateRequire } from 'node:module';",
  "const require = __llmWikiCreateRequire(import.meta.url);",
].join("\n");

const TARGETS = [
  // The library face: what the launcher's inspection subcommands import, and
  // the only build output that is safe to `import()` without side effects.
  { entry: "src/index.ts", out: "dist/index.js" },
  // Executables. Importing either one starts a server, so nothing may import
  // them.
  { entry: "src/bin/http.ts", out: "dist/server.js" },
  { entry: "src/bin/stdio.ts", out: "dist/stdio.js" },
];

const watch = process.argv.includes("--watch");

for (const target of TARGETS) {
  const args = [
    join(PACKAGE_DIR, target.entry),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--sourcemap",
    `--outfile=${join(PACKAGE_DIR, target.out)}`,
    `--banner:js=${BANNER}`,
    ...EXTERNAL.map((name) => `--external:${name}`),
    "--log-level=warning",
  ];
  if (watch) args.push("--watch");

  execFileSync(process.execPath, [ESBUILD, ...args], {
    // inherit, not pipe: the esbuild CLI is a child process and its progress
    // output belongs on this terminal anyway.
    stdio: ["ignore", "inherit", "inherit"],
  });
}

if (!watch) {
  console.log(`已构建 ${TARGETS.map((t) => t.out).join(", ")}`);
}
