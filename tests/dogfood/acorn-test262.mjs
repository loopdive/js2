// Full Test262 differential parser gate for compiled Acorn (#1712).
//
// This extends the curated Acorn corpus to every Git-tracked Test262 JavaScript
// test. The pinned acorn@8.16.0 tarball is used on both sides:
//
//   node-acorn(source, options) === compiled-acorn(source, options)
//
// The comparison is exact, including `start`/`end` positions. Tests that Acorn
// does not support are still useful: both parsers must reject them. A compiled
// runtime trap never counts as a matching syntax rejection.
//
// By default, variants mirror Test262's execution policy:
//   - module: one module-goal parse
//   - onlyStrict: one script parse with a "use strict" directive
//   - noStrict/raw: one script parse without a directive
//   - otherwise: sloppy and strict script parses
//
// The runner enumerates files with `git ls-files`, not a recursive filesystem
// walk, so generated `.wasm` neighbours and local diagnostic probes cannot
// silently enter the measured corpus.
//
// Invoke:
//   pnpm run dogfood:acorn-test262
//   pnpm run dogfood:acorn-test262 -- --limit=100
//   pnpm run dogfood:acorn-test262 -- --path=language/expressions
//   pnpm run dogfood:acorn-test262 -- --shard=1/4
//   pnpm run dogfood:acorn-test262 -- --mismatch-report=/tmp/prior-report.json
//   pnpm run dogfood:acorn-test262 -- --json

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { diffAst } from "./ast-diff.mjs";
import { setupAcorn } from "./setup-acorn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DEFAULT_REPORT_PATH = join(HERE, "report", "acorn-test262.json");
const MAX_DIVERGENCES_PER_AST = 8;
const MAX_RECORDED_MISMATCHES = 500;
const STRICT_PREFIX = '"use strict";\n';
const ECMA_VERSION = 2025;

function parseList(yaml, name) {
  const inline = yaml.match(new RegExp(`^${name}:\\s*\\[([^\\]]*)\\]`, "m"));
  if (inline) {
    return inline[1]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  const block = yaml.match(new RegExp(`^${name}:\\s*\\n((?:[ \\t]+-\\s*.*(?:\\n|$))+)`, "m"));
  if (!block) return [];
  return block[1]
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

export function parseTest262Flags(source) {
  const match = source.match(/\/\*---\s*([\s\S]*?)\s*---\*\//);
  return match ? parseList(match[1], "flags") : [];
}

export function buildTestVariants(source, flags, { strictReruns = true } = {}) {
  const flagSet = new Set(flags);
  if (flagSet.has("module")) {
    return [{ mode: "module", source, options: { ecmaVersion: ECMA_VERSION, sourceType: "module" } }];
  }
  if (flagSet.has("onlyStrict")) {
    return [
      {
        mode: "strict",
        source: STRICT_PREFIX + source,
        options: { ecmaVersion: ECMA_VERSION, sourceType: "script" },
      },
    ];
  }

  const sloppy = {
    mode: flagSet.has("raw") ? "raw" : "sloppy",
    source,
    options: { ecmaVersion: ECMA_VERSION, sourceType: "script" },
  };
  if (!strictReruns || flagSet.has("raw") || flagSet.has("noStrict")) return [sloppy];
  return [
    sloppy,
    {
      mode: "strict",
      source: STRICT_PREFIX + source,
      options: { ecmaVersion: ECMA_VERSION, sourceType: "script" },
    },
  ];
}

function parseArgs(argv) {
  const options = {
    json: false,
    limit: null,
    mismatchReports: [],
    pathFilters: [],
    reportPath: DEFAULT_REPORT_PATH,
    shardIndex: 0,
    shardCount: 1,
    strictReruns: true,
  };

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--json") options.json = true;
    else if (arg === "--single-variant") options.strictReruns = false;
    else if (arg.startsWith("--limit=")) options.limit = Number.parseInt(arg.slice("--limit=".length), 10);
    else if (arg.startsWith("--mismatch-report="))
      options.mismatchReports.push(resolve(arg.slice("--mismatch-report=".length)));
    else if (arg.startsWith("--path=")) options.pathFilters.push(arg.slice("--path=".length));
    else if (arg.startsWith("--report=")) options.reportPath = resolve(arg.slice("--report=".length));
    else if (arg.startsWith("--shard=")) {
      const match = arg.slice("--shard=".length).match(/^(\d+)\/(\d+)$/);
      if (!match) throw new Error(`invalid shard ${arg}; expected --shard=N/M`);
      const oneBased = Number.parseInt(match[1], 10);
      options.shardCount = Number.parseInt(match[2], 10);
      options.shardIndex = oneBased - 1;
      if (oneBased < 1 || oneBased > options.shardCount) {
        throw new Error(`invalid shard ${arg}; N must be between 1 and M`);
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.limit !== null && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  return options;
}

function resolveTest262() {
  const configured = process.env.ACORN_TEST262_ROOT;
  if (configured) {
    const test262Root = realpathSync(resolve(configured));
    return { test262Root, testDir: join(test262Root, "test") };
  }

  // Provisioned worktrees link test262/test to the canonical submodule. Resolve
  // that link so `git ls-files` can see the submodule's own .git metadata.
  const testDir = realpathSync(join(ROOT, "test262", "test"));
  return { test262Root: dirname(testDir), testDir };
}

function trackedTestFiles(test262Root, testDir) {
  const output = execFileSync("git", ["-C", test262Root, "ls-files", "-z", "--", "test/*.js"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split("\0")
    .filter(Boolean)
    .map((path) => ({
      path: path.slice("test/".length),
      absolutePath: join(testDir, path.slice("test/".length)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function selectFiles(files, options) {
  let selected = files;
  if (options.mismatchReports.length > 0) {
    const mismatchFiles = new Set();
    for (const reportPath of options.mismatchReports) {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      for (const mismatch of report.recordedMismatches ?? []) {
        if (typeof mismatch?.file === "string") mismatchFiles.add(mismatch.file);
      }
    }
    selected = selected.filter((file) => mismatchFiles.has(file.path));
  }
  if (options.pathFilters.length > 0) {
    selected = selected.filter((file) => options.pathFilters.some((filter) => file.path.includes(filter)));
  }
  if (options.shardCount > 1) {
    selected = selected.filter((_, index) => index % options.shardCount === options.shardIndex);
  }
  if (options.limit !== null) selected = selected.slice(0, options.limit);
  return selected;
}

function describeThrow(error) {
  if (error == null) return { kind: "unknown", message: String(error) };
  const stack = typeof error.stack === "string" ? error.stack.split("\n").slice(0, 8).join("\n") : undefined;
  if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) {
    return { kind: "runtime-trap", message: error.message || String(error), stack };
  }
  if (typeof WebAssembly !== "undefined" && WebAssembly.Exception && error instanceof WebAssembly.Exception) {
    return { kind: "wasm-exception", message: error.message || "WebAssembly.Exception", stack };
  }
  const name = typeof error.name === "string" && error.name ? error.name : "Error";
  return {
    kind: name === "SyntaxError" ? "syntax-error" : "host-error",
    message: typeof error.message === "string" && error.message ? error.message : String(error),
    stack,
  };
}

function parseCapture(parse, source, options) {
  try {
    return { ast: parse(source, options), error: null };
  } catch (error) {
    return { ast: null, error: describeThrow(error) };
  }
}

function rejectionMatches(oracleError, compiledError) {
  return oracleError?.kind === "syntax-error" && compiledError?.kind === "wasm-exception";
}

function jsonSafe(value) {
  if (typeof value === "bigint") return `${value}n`;
  return value;
}

function mismatchSignature(mismatch) {
  if (mismatch.status !== "ast-mismatch") return mismatch.status;
  const first = mismatch.divergences[0];
  if (!first) return "ast-mismatch";
  return `ast-mismatch:${first.reason}@${first.path.replace(/\[\d+\]/g, "[*]")}`;
}

function recordMismatch(state, mismatch) {
  state.mismatchedVariants++;
  state.mismatchedFiles.add(mismatch.file);
  const signature = mismatchSignature(mismatch);
  const group = state.groups.get(signature) ?? { signature, count: 0, files: new Set(), example: null };
  group.count++;
  group.files.add(mismatch.file);
  if (group.example === null) group.example = mismatch;
  state.groups.set(signature, group);
  if (state.mismatches.length < MAX_RECORDED_MISMATCHES) state.mismatches.push(mismatch);
}

async function compileAcorn(log) {
  const { entryModulePath, version, pin } = setupAcorn();
  const source = readFileSync(entryModulePath, "utf8");
  log(`[acorn-test262] compiling pinned acorn@${version} once...`);
  const started = performance.now();
  const result = await compile(source, {
    fileName: "acorn.mjs",
    skipSemanticDiagnostics: true,
  });
  const compileMs = Math.round(performance.now() - started);
  if (!result.binary?.length) {
    throw new Error(
      `compiled Acorn emitted no binary: ${(result.errors ?? []).map((error) => error?.messageText ?? error).join("; ")}`,
    );
  }

  const module = await WebAssembly.compile(result.binary);
  const io = result.importObject ?? {};
  const instance = await WebAssembly.instantiate(module, io);
  io.__setInstance?.(instance);
  const exports = wrapExports(instance, { signatures: result.exportSignatures });
  if (typeof exports.parse !== "function") throw new Error("compiled Acorn has no callable parse export");

  const oracle = await import(pathToFileURL(entryModulePath).href);
  return {
    version,
    pin,
    compileMs,
    binaryBytes: result.binary.length,
    compiledParse: (sourceText, options) => exports.parse(sourceText, options),
    oracleParse: (sourceText, options) => oracle.parse(sourceText, options),
  };
}

export async function runTest262Differential(rawOptions = {}) {
  const options = {
    json: false,
    limit: null,
    mismatchReports: [],
    pathFilters: [],
    reportPath: DEFAULT_REPORT_PATH,
    shardIndex: 0,
    shardCount: 1,
    strictReruns: true,
    ...rawOptions,
  };
  const log = options.json ? () => {} : (...args) => console.error(...args);
  const { test262Root, testDir } = resolveTest262();
  const allFiles = trackedTestFiles(test262Root, testDir);
  const selectedFiles = selectFiles(allFiles, options);
  const test262Revision = execFileSync("git", ["-C", test262Root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const compilerRevision = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const compilerDirty =
    execFileSync("git", ["-C", ROOT, "status", "--porcelain=v1", "--untracked-files=normal"], {
      encoding: "utf8",
    }).trim().length > 0;
  const corpusDigest = createHash("sha256")
    .update(selectedFiles.map((file) => file.path).join("\n"))
    .digest("hex");

  log(
    `[acorn-test262] tracked files=${allFiles.length}, selected=${selectedFiles.length}, ` +
      `revision=${test262Revision.slice(0, 12)}`,
  );

  const compiled = await compileAcorn(log);
  log(
    `[acorn-test262] compile=${compiled.compileMs}ms, binary=${compiled.binaryBytes} bytes; ` +
      "running exact differential...",
  );

  const state = {
    variants: 0,
    bothParsedEqual: 0,
    bothRejected: 0,
    mismatchedVariants: 0,
    mismatchedFiles: new Set(),
    mismatches: [],
    groups: new Map(),
  };
  const runStarted = performance.now();

  for (let fileIndex = 0; fileIndex < selectedFiles.length; fileIndex++) {
    const file = selectedFiles[fileIndex];
    const source = readFileSync(file.absolutePath, "utf8");
    const flags = parseTest262Flags(source);
    const variants = buildTestVariants(source, flags, { strictReruns: options.strictReruns });

    for (const variant of variants) {
      state.variants++;
      const oracle = parseCapture(compiled.oracleParse, variant.source, variant.options);
      const actual = parseCapture(compiled.compiledParse, variant.source, variant.options);

      if (oracle.error || actual.error) {
        if (oracle.error && actual.error && rejectionMatches(oracle.error, actual.error)) {
          state.bothRejected++;
          continue;
        }
        const status = oracle.error
          ? actual.error
            ? "rejection-kind-mismatch"
            : "compiled-accepted-oracle-rejected"
          : "compiled-rejected-oracle-accepted";
        recordMismatch(state, {
          file: file.path,
          mode: variant.mode,
          status,
          oracleError: oracle.error,
          compiledError: actual.error,
        });
        continue;
      }

      let differential;
      try {
        differential = diffAst(oracle.ast, actual.ast, {
          ignorePositions: false,
          maxDivergences: MAX_DIVERGENCES_PER_AST,
        });
      } catch (error) {
        recordMismatch(state, {
          file: file.path,
          mode: variant.mode,
          status: "comparison-error",
          comparisonError: describeThrow(error),
        });
        continue;
      }

      if (differential.equal) {
        state.bothParsedEqual++;
        continue;
      }
      recordMismatch(state, {
        file: file.path,
        mode: variant.mode,
        status: "ast-mismatch",
        divergences: differential.divergences.map((divergence) => ({
          ...divergence,
          expected: jsonSafe(divergence.expected),
          actual: jsonSafe(divergence.actual),
        })),
      });
    }

    const completed = fileIndex + 1;
    if (completed % 500 === 0 || completed === selectedFiles.length) {
      const elapsedSeconds = (performance.now() - runStarted) / 1000;
      const rate = completed / Math.max(elapsedSeconds, 0.001);
      const rssMiB = process.memoryUsage().rss / 1024 / 1024;
      log(
        `[acorn-test262] ${completed}/${selectedFiles.length} files; ${state.variants} variants; ` +
          `${state.mismatchedVariants} mismatches; ${rate.toFixed(1)} files/s; rss=${rssMiB.toFixed(0)} MiB`,
      );
    }
  }

  const runMs = Math.round(performance.now() - runStarted);
  const groups = [...state.groups.values()]
    .map((group) => ({
      signature: group.signature,
      count: group.count,
      files: group.files.size,
      example: group.example,
    }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
  const summary = {
    trackedFiles: allFiles.length,
    selectedFiles: selectedFiles.length,
    exactFiles: selectedFiles.length - state.mismatchedFiles.size,
    mismatchedFiles: state.mismatchedFiles.size,
    variants: state.variants,
    bothParsedExact: state.bothParsedEqual,
    bothRejected: state.bothRejected,
    mismatchedVariants: state.mismatchedVariants,
  };
  const report = {
    umbrella: 1712,
    generatedAt: new Date().toISOString(),
    acornVersion: compiled.version,
    acornTarballShasum: compiled.pin.shasum,
    compilerRevision,
    compilerDirty,
    test262Revision,
    corpusDigest,
    options: {
      ecmaVersion: ECMA_VERSION,
      exactPositions: true,
      strictReruns: options.strictReruns,
      mismatchReports: options.mismatchReports,
      pathFilters: options.pathFilters,
      limit: options.limit,
      shard: `${options.shardIndex + 1}/${options.shardCount}`,
    },
    compileMs: compiled.compileMs,
    binaryBytes: compiled.binaryBytes,
    runMs,
    summary,
    mismatchGroups: groups,
    recordedMismatches: state.mismatches,
    omittedMismatches: Math.max(0, state.mismatchedVariants - state.mismatches.length),
  };

  mkdirSync(dirname(options.reportPath), { recursive: true });
  writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.json) {
    log("");
    log("=== compiled Acorn × Test262 exact AST differential ===");
    log(
      `files ${summary.exactFiles}/${summary.selectedFiles} exact; variants ${summary.bothParsedExact} parsed-exact, ` +
        `${summary.bothRejected} matching syntax rejections, ${summary.mismatchedVariants} mismatches`,
    );
    log(`run ${(runMs / 1000).toFixed(1)}s; report ${relative(ROOT, options.reportPath)}`);
    for (const group of groups.slice(0, 20)) {
      log(`  ×${group.count} ${group.signature} (${group.files} files; e.g. ${group.example.file})`);
    }
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseArgs(process.argv.slice(2));
  runTest262Differential(options)
    .then((report) => {
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.summary.mismatchedVariants === 0 ? 0 : 1;
    })
    .catch((error) => {
      console.error("[acorn-test262] harness crashed:", error?.stack ?? error);
      process.exitCode = 2;
    });
}
