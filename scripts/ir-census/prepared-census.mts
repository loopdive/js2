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
import { fileURLToPath, pathToFileURL } from "node:url";

import { abortSiteOf, isWasmTrap, wasmErrorSite } from "../lib/wasm-exn-render.mjs";
import { childLoop, errorText, runPool } from "./pool.mts";
import { assembleStandIn } from "./stand-in-harness.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF), "../..");
const DETAIL_CAP = 600;
/** (#7486) The site-naming run-time abort's helper: the innermost frame of every trap at a site. */
const SITE_HELPER = "__js_value_unsupported_at";

type Entry = typeof import("../../src/test262/test262-prepared-entry.ts");
type Runtime = typeof import("../../src/test262/test262-prepared-runtime.ts");
type Runner = typeof import("../../tests/test262-runner.ts");
type Harness = typeof import("../../tests/test262-original-harness.ts");

interface Toolchain {
  readonly tree: string;
  readonly entry: Entry;
  readonly runtime: Runtime;
  readonly runner: Runner;
  readonly harness: Harness;
}

const REQUEST = { kind: "prepared-program-required", version: 1 } as const;
/** The options scripts/test262-worker.mjs passes for an original-harness row under `TEST262_COMPILER_PATH=ir`. */
const options = (scriptGoal: boolean) =>
  ({
    wholeProgram: REQUEST,
    allowJs: true,
    fileName: "test.js",
    sourceMap: false,
    emitWat: false,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
    scriptGoal,
    deferTopLevelInit: true,
    hostBridge: "always",
    trackIrOutcomes: true,
  }) as const;

async function loadToolchain(tree: string): Promise<Toolchain> {
  const load = (path: string) => import(pathToFileURL(join(tree, path)).href);
  const [entry, runtime, runner, harness] = await Promise.all([
    load("src/test262/test262-prepared-entry.ts"),
    load("src/test262/test262-prepared-runtime.ts"),
    load("tests/test262-runner.ts"),
    load("tests/test262-original-harness.ts"),
  ]);
  return { tree, entry, runtime, runner, harness };
}

interface Assembly {
  readonly source: string;
  readonly starts: readonly [number, string][];
  readonly bodyLine: number;
  readonly unmodelled?: boolean;
}

function realAssembly(tools: Toolchain, source: string, meta: ReturnType<Runner["parseMeta"]>): Assembly {
  const variant = tools.harness.assembleOriginalHarness(source, meta).primary;
  const starts: [number, string][] = [];
  let line = variant.strict ? 2 : 1;
  if (variant.bodyLineOffset > 0) {
    for (const part of tools.harness.harnessSourceParts(meta, meta.flags?.includes("async") === true)) {
      starts.push([line, part.name]);
      line += part.source.split("\n").length - 1;
    }
  }
  return { source: variant.source, starts, bodyLine: variant.bodyLineOffset + 1 };
}

function standInAssembly(tools: Toolchain, source: string, meta: ReturnType<Runner["parseMeta"]>): Assembly {
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
    result = await tools.entry.compile(
      assembly.source,
      options(!meta.flags?.includes("module") && !meta.flags?.includes("raw")),
    );
  } catch (error) {
    return { file, status: "crash", ...flags, detail: errorText(error) };
  }
  if (!tools.entry.requiredPreparedEmission(result) || !result.success) {
    return { file, status: "compile_error", ...flags, ...gapRow(tools, result, assembly) };
  }
  if (meta.flags?.includes("async")) return { file, status: "compiled", ...flags };
  let instance: WebAssembly.Instance | undefined;
  try {
    instance = tools.runtime.instantiatePreparedArtifact(result).instance;
    (instance.exports.__module_init as (() => void) | undefined)?.();
    return { file, status: "pass", ...flags };
  } catch (error) {
    return { file, status: "fail", ...flags, detail: errorText(error), ...trapOf(tools, result, instance, error) };
  }
}

/**
 * Where a run-time trap fired: the innermost Wasm frame's function name and the abort it was: (#7486) a run-time
 * abort site, with the function it was legalized in and the first frame past the abort's helper (`siteFrame`: that
 * function, or a copy the middle end made of it), or the abort body (#7354 U) of the innermost frame's function. Only
 * a Wasm trap counts; a host error (a stack-overflow `RangeError`) is not attributed to the frame it happened in.
 */
function trapOf(
  tools: Toolchain,
  result: Awaited<ReturnType<Entry["compile"]>>,
  instance: WebAssembly.Instance | undefined,
  error: unknown,
) {
  if (!isWasmTrap(error)) return {};
  const site = abortSiteOf(instance, tools.entry.requiredPreparedAbortSites?.(result));
  const { frames, aborted } = wasmErrorSite(error, tools.entry.requiredPreparedAbortBodies?.(result) ?? [], site);
  if (frames.length === 0) return {};
  return {
    trapFrame: frames[0],
    ...(site ? { siteFrame: frames.find((frame) => frame !== SITE_HELPER) } : {}),
    ...(aborted
      ? {
          abort: {
            code: aborted.code,
            site: aborted.site,
            name: aborted.name,
            detail: aborted.detail.slice(0, DETAIL_CAP),
          },
        }
      : {}),
  };
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
