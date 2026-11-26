// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Prepared-path census: where each positive ES5 file stops on the Prepared
 * whole-program path (`TEST262_COMPILER_PATH=ir`, front door
 * `wholeProgram: { kind: "prepared-program-required", version: 1 }`).
 *
 *   npx tsx scripts/ir-census/prepared-census.mts --files .tmp/ir-census/es5-files.txt \
 *     --out .tmp/ir-census/prepared-real.jsonl --harness real|stand-in [--jobs N] [--tree <dir>]
 *
 * - `--harness real`: the literal runner assembly
 *   (`assembleOriginalHarness(...).primary`), the program CI measures.
 * - `--harness stand-in`: the same body behind stand-in-harness.mjs, to
 *   measure what stands behind the prelude.
 * - Compile through `src/test262/test262-prepared-entry.ts` with the options
 *   the CI worker passes (standalone). A refusal is the path's first
 *   gap: its code, stage, detail and line, and the part of the program the line
 *   falls in (`harness:<file>`, `stand-in`, `test`). A thrown compile is
 *   `crash`.
 * - A compiled file is run: instantiate, then `__module_init`. Returning is
 *   `pass`, throwing `fail`. Async tests are compiled but not run (`compiled`).
 * - Negative tests are skipped: a compile failure is their expected outcome,
 *   so they say nothing about the path.
 * - `--tree <dir>` measures another checkout, as in census.mts.
 */
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { childLoop, errorText, runPool } from "./pool.mts";
import {
  type Assembly,
  type Entry,
  loadToolchain,
  type Meta,
  options,
  realAssembly,
  type Toolchain,
} from "./prepared-toolchain.mts";
import { assembleStandIn } from "./stand-in-harness.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF), "../..");
const DETAIL_CAP = 600;

function standInAssembly(tools: Toolchain, source: string, meta: Meta): Assembly {
  const strict = meta.flags?.includes("onlyStrict") === true;
  if (meta.flags?.includes("raw")) return { source, starts: [], bodyLine: 1 };
  const parts = tools.harness.harnessSourceParts(meta, meta.flags?.includes("async") === true);
  return assembleStandIn(source, parts, strict);
}

function origin(line: number | undefined, assembly: Assembly): string {
  if (line === undefined) return "unlocated";
  if (line >= assembly.bodyLine) return "test";
  let name = "prefix";
  for (const [first, part] of assembly.starts) if (line >= first) name = part;
  if (name === "stand-in") return "stand-in";
  // A gap located on the directive line is a module-init gap reported at the unit's start: the body's.
  return name === "directive" ? "test" : `harness:${name}`;
}

interface Gap {
  readonly code?: string;
  readonly stage?: string;
  readonly detail?: string;
  readonly location?: { readonly line?: number };
}

function gapRow(tools: Toolchain, result: Awaited<ReturnType<Entry["compile"]>>, assembly: Assembly) {
  const failure = tools.entry.requiredPreparedFailure(result);
  if (failure?.kind === "unsupported") {
    const gap = failure.failure as Gap;
    return {
      phase: failure.phase,
      code: gap.code,
      stage: gap.stage,
      detail: gap.detail?.slice(0, DETAIL_CAP),
      line: gap.location?.line,
      origin: origin(gap.location?.line, assembly),
    };
  }
  // Otherwise the first error-severity diagnostic is the gap; the failure kind says which layer refused.
  const first = result.errors.find((error) => error.severity === "error");
  return {
    phase: failure?.kind ?? (tools.entry.requiredPreparedFrontendFailure(result) ? "frontend" : "errors"),
    detail: (first?.message ?? JSON.stringify(failure) ?? "compile failed").slice(0, DETAIL_CAP),
    line: first?.line,
    origin: origin(first?.line, assembly),
  };
}

async function measureFile(tools: Toolchain, file: string, standIn: boolean): Promise<object> {
  const abs = join(tools.tree, "test262/test", file);
  const source = readFileSync(abs, "utf8");
  const meta = tools.runner.parseMeta(source);
  if (meta.negative) return { file, status: "skip", skipReason: "negative" };
  const assembly = standIn ? standInAssembly(tools, source, meta) : realAssembly(tools, source, meta);
  const flags = { ...(assembly.unmodelled ? { unmodelled: true } : {}) };
  let result: Awaited<ReturnType<Entry["compile"]>>;
  try {
    result = await tools.entry.compile(assembly.source, options(meta));
  } catch (error) {
    return { file, status: "crash", ...flags, detail: errorText(error) };
  }
  if (!tools.entry.requiredPreparedEmission(result) || !result.success) {
    return { file, status: "compile_error", ...flags, ...gapRow(tools, result, assembly) };
  }
  if (meta.flags?.includes("async")) return { file, status: "compiled", ...flags };
  try {
    const { instance } = tools.runtime.instantiatePreparedArtifact(result);
    (instance.exports.__module_init as (() => void) | undefined)?.();
    return { file, status: "pass", ...flags };
  } catch (error) {
    return { file, status: "fail", ...flags, detail: errorText(error) };
  }
}

const argv = process.argv.slice(2);
if (argv[0] === "--child") {
  const tools = await loadToolchain(argv[1]!);
  await childLoop((file) => measureFile(tools, file, argv[2] === "stand-in"));
} else {
  const value = (flag: string, fallback?: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const harness = value("--harness", "real")!;
  if (harness !== "real" && harness !== "stand-in")
    throw new Error(`--harness must be real or stand-in, got ${harness}`);
  const tree = resolve(value("--tree", REPO_ROOT)!);
  await runPool({
    files: resolve(value("--files")!),
    out: resolve(value("--out")!),
    jobs: Number(value("--jobs", String(availableParallelism()))),
    timeoutMs: Number(value("--timeout-s", "60")) * 1000,
    child: [SELF, "--child", tree, harness],
    cwd: REPO_ROOT,
  });
}
