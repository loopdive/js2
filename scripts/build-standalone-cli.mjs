#!/usr/bin/env node
// Build a relocatable single-file CLI bundle for Bun/Deno/native executable flows.
// The normal library build keeps TypeScript external for npm usage.
// This build intentionally bundles TypeScript and injects TypeScript lib
// declarations so the resulting file can be moved away from node_modules.
// Binaryen remains optional because it is only used for wasm-opt post-processing.

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTFILE = "dist/js2wasm-standalone.mjs";

export function discoverTypeScriptLibNames(libDir = resolveTypeScriptLibDir()) {
  return readdirSync(libDir)
    .filter((name) => /^lib\..*\.d\.ts$/.test(name))
    .sort();
}

export function resolveTypeScriptLibDir(root = ROOT) {
  const require = createRequire(pathToFileURL(resolve(root, "package.json")));
  return dirname(require.resolve("typescript/lib/lib.d.ts"));
}

export function readTypeScriptLibFiles({
  libDir = resolveTypeScriptLibDir(),
  names = discoverTypeScriptLibNames(libDir),
} = {}) {
  const files = {};
  for (const name of names) {
    const path = resolve(libDir, name);
    if (!existsSync(path)) {
      throw new Error(`TypeScript lib file not found: ${path}`);
    }
    files[name] = readFileSync(path, "utf8");
  }
  return files;
}

export function createTsLibGlobalPrelude(options = {}) {
  const files = readTypeScriptLibFiles(options);
  return [
    'import { createRequire as __js2wasmCreateRequire } from "node:module";',
    'import { dirname as __js2wasmDirname } from "node:path";',
    'import { fileURLToPath as __js2wasmFileURLToPath } from "node:url";',
    "const require = __js2wasmCreateRequire(import.meta.url);",
    "const __filename = __js2wasmFileURLToPath(import.meta.url);",
    "const __dirname = __js2wasmDirname(__filename);",
    "globalThis.__js2wasmTsLibFiles = {",
    "  ...(globalThis.__js2wasmTsLibFiles ?? globalThis.__ts2wasmTsLibFiles ?? {}),",
    `  ...${JSON.stringify(files)},`,
    "};",
    "",
  ].join("\n");
}

function readPackageJson(root = ROOT) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
}

export async function buildStandaloneCli({
  root = ROOT,
  outfile = DEFAULT_OUTFILE,
  minify = false,
  sourcemap = false,
} = {}) {
  const esbuild = await import("esbuild");
  const packageJson = readPackageJson(root);
  const outPath = resolve(root, outfile);
  mkdirSync(dirname(outPath), { recursive: true });

  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["src/cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: outPath,
    minify,
    sourcemap,
    legalComments: "none",
    mainFields: ["module", "main"],
    banner: {
      js: createTsLibGlobalPrelude({ libDir: resolveTypeScriptLibDir(root) }),
    },
    define: {
      __JS2WASM_CLI_VERSION__: JSON.stringify(packageJson.version),
    },
    external: ["binaryen", "typescript7", "typescript7/*"],
    logLevel: "info",
  });

  console.log(`Standalone CLI bundle written to ${relative(root, outPath)}`);
}

function parseArgs(argv) {
  const options = {
    outfile: DEFAULT_OUTFILE,
    minify: false,
    sourcemap: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--outfile" || arg === "-o") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a path`);
      options.outfile = value;
    } else if (arg.startsWith("--outfile=")) {
      options.outfile = arg.slice("--outfile=".length);
    } else if (arg === "--minify") {
      options.minify = true;
    } else if (arg === "--sourcemap") {
      options.sourcemap = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: pnpm run build:standalone-cli -- [options]

Build a relocatable js2wasm CLI bundle at ${DEFAULT_OUTFILE}.

Options:
  -o, --outfile <path>  Output bundle path (default: ${DEFAULT_OUTFILE})
  --minify             Minify the generated JavaScript
  --sourcemap          Emit a source map
  -h, --help           Show this help`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      await buildStandaloneCli(options);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
