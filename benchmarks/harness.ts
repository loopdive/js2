/**
 * Benchmark harness for js2wasm.
 *
 * Compares four strategies:
 *   1. Pure JS          — run TypeScript source directly via eval
 *   2. Wasm host-call   — default mode (externref, host imports)
 *   3. Wasm GC-native   — fast mode (WasmGC structs/arrays, no host calls)
 *   4. Wasm linear      — fast + linear memory (future, skipped if unavailable)
 *
 * Usage:
 *   npx tsx benchmarks/run.ts [--suite strings|arrays|dom|mixed] [--filter name]
 */

import { compile, buildImports, instantiateWasm } from "../src/index.js";
import { calibrateBenchmarkBatchSize, timeBenchmarkBatch } from "./timing.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Strategy = "js" | "host-call" | "gc-native" | "linear-memory";

/**
 * Which stage of {@link runStrategy} a failure came from.
 *
 * `"cross-lane"` (#3898) is not an exception at all — the lane ran fine, it just
 * computed a different answer than the JS baseline. It is recorded through the
 * same failed-row channel (#3904) because the alternative, dropping the row, is
 * indistinguishable from "deliberately not applicable" in `latest.json`.
 */
export type FailurePhase = "setup" | "warmup" | "calibration" | "mid-loop" | "cross-lane";

export interface BenchmarkResult {
  name: string;
  strategy: Strategy;
  iterations: number;
  batchSize: number;
  totalMs: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  binarySize?: number;
  compileMs?: number;
  /** Primitive operations performed by one `run()` call, if the def declares it (#3898). */
  opsPerCall?: number;
  /** `medianMs` expressed per declared operation, in nanoseconds (#3898). */
  nsPerOp?: number;
  /** Floor `nsPerOp` was checked against (#3898). */
  minNsPerOp?: number;
  /**
   * Set by `report.ts` when `nsPerOp` is physically impossible — the lane is not
   * published as a valid comparison (#3898).
   */
  implausible?: boolean;
  /**
   * (#3904) Present and `"failed"` when the strategy errored instead of
   * producing timings. Timing fields are all `0` on such a row — every
   * consumer must skip them via {@link isMeasured}.
   *
   * A strategy listed in `BenchmarkDef.skip` is NOT recorded at all: an
   * absent row means "deliberately not applicable" and a `status: "failed"`
   * row means "this lane is broken". Before this existed, both looked
   * identical in `latest.json` (the row was simply missing), which is how the
   * four `dom/*` benchmarks shipped a JS-only chart for months.
   */
  status?: "failed";
  /** (#3904) First line of the error that made this strategy fail. */
  error?: string;
  /** (#3904) Stage the failure came from. */
  failedPhase?: FailurePhase;
}

/**
 * True when a row carries real timings. Failed rows are placeholders whose
 * numeric fields are all zero — never feed them to a median/ratio/winner
 * computation.
 *
 * This is also the exemption the #3898 plausibility guard needs: a failed row
 * has `medianMs === 0` and therefore an implied cost of 0 ns/op, which would
 * trip the floor on every failure and report a broken lane as a hoisted one.
 * "No measurement" and "an impossible measurement" are different diagnoses.
 */
export function isMeasured(r: BenchmarkResult): boolean {
  return r.status !== "failed";
}

export interface BenchmarkDef {
  name: string;
  /** TypeScript source exporting a `run` function (no args, returns void | number). */
  source: string;
  /** Number of timed iterations (default 100). */
  iterations?: number;
  /** Warmup iterations (default 5). */
  warmup?: number;
  /**
   * Host dependencies for buildImports (e.g. DOM stubs).
   *
   * This is the ONLY host-injection channel — every `env.*` import the module
   * declares is resolved from here. A `declared_global` import (`document`,
   * `window`, ...) is keyed by the *global's own name*, not by its class, so a
   * benchmark using `declare const document: Document` needs a `document`
   * entry, not just a `Document` one (#3904). A previous `extraEnv` field
   * claimed to inject extra env imports but was never read by the harness; it
   * was removed rather than left as a trap.
   */
  deps?: Record<string, unknown>;
  /**
   * JS-equivalent function to benchmark as baseline.
   *
   * It SHOULD return an accumulator folding in every iteration (#3898): the
   * harness cross-checks that value against the Wasm `run()` return value, and
   * `report.ts` uses it to prove both lanes did the same work.
   */
  js: () => number | void;
  /**
   * Number of primitive operations one `run()` call performs (e.g. 1000
   * `indexOf` calls). Feeds the plausibility guard in `report.ts` (#3898):
   * a lane reporting under ~1 ns per operation is not measuring the work it
   * claims to measure and must not be published as a valid comparison.
   */
  opsPerCall?: number;
  /**
   * Benchmark-specific lower bound on the cost of one operation, in
   * nanoseconds, when more is known than the universal ~1 ns physical floor
   * (#3898).
   *
   * The universal floor alone would not have caught this bug: the hoisted
   * `string/indexOf` baseline reported 1.56 ns/op, which clears 1 ns. But an
   * `indexOf` that scans several characters and allocates nothing still cannot
   * retire in 1.56 ns, and the honest measurement is ~33 ns. Set this to a
   * value comfortably below the honest cost (roughly a quarter of it) so a
   * faster machine cannot trip it, while a collapsed loop — which is 20x+
   * faster, not 4x — always does.
   */
  minNsPerOp?: number;
  /**
   * Strategies that are deliberately not applicable to this benchmark.
   * Skipped strategies produce no row at all; a strategy that *fails* produces
   * a `status: "failed"` row instead (#3904).
   */
  skip?: Strategy[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

/**
 * (#3904) Record a strategy failure as a first-class result row instead of
 * dropping it. The stderr line is kept for the interactive run; the returned
 * row is what makes the failure survive into `latest.json` so the published
 * page — and the next person reading it — can tell a broken lane from an
 * inapplicable one without re-running the suite by hand.
 */
function failedRow(name: string, strategy: Strategy, phase: FailurePhase, message: string): BenchmarkResult {
  return {
    name,
    strategy,
    iterations: 0,
    batchSize: 0,
    totalMs: 0,
    avgMs: 0,
    medianMs: 0,
    p95Ms: 0,
    status: "failed",
    error: message,
    failedPhase: phase,
  };
}

function failedResult(name: string, strategy: Strategy, phase: FailurePhase, err: unknown): BenchmarkResult {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.split("\n")[0] ?? raw;
  // Preserve the historical stderr wording so existing greps keep matching.
  const phaseNote = phase === "setup" ? "" : phase === "warmup" ? " (runtime)" : ` (runtime, ${phase})`;
  process.stderr.write(`\n    [${strategy} skipped${phaseNote}: ${message}]\n`);
  return failedRow(name, strategy, phase, message);
}

// ---------------------------------------------------------------------------
// Compilation cache
// ---------------------------------------------------------------------------

interface CompiledModule {
  binary: Uint8Array;
  imports: any;
  stringPool: string[];
  compileMs: number;
}

const compileCache = new Map<string, CompiledModule>();

async function compileSource(source: string, fast: boolean, target?: "gc" | "linear"): Promise<CompiledModule> {
  const optimize = 4;
  const key = `${fast}:${target ?? "gc"}:O${optimize}:${source}`;
  const cached = compileCache.get(key);
  if (cached) return cached;

  const t0 = performance.now();
  const result = await compile(source, { fast, target, emitWat: false, optimize });
  const compileMs = performance.now() - t0;

  if (!result.success) {
    throw new Error(
      `Compilation failed (fast=${fast}, target=${target}):\n` + result.errors.map((e) => `  ${e.message}`).join("\n"),
    );
  }

  const mod: CompiledModule = {
    binary: result.binary,
    imports: result.imports,
    stringPool: result.stringPool,
    compileMs,
  };
  compileCache.set(key, mod);
  return mod;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Cross-lane result assertion (#3898).
 *
 * The JS baseline and the Wasm `source` are supposed to be two implementations
 * of the *same* computation. If they disagree, whatever the page publishes as
 * "JS vs Wasm" is comparing two different workloads — which is exactly how the
 * hoisted string baselines went unnoticed for so long. Report it loudly and
 * refuse to publish the lane rather than publishing a meaningless ratio.
 *
 * Returns the mismatch message, or `null` when the two lanes agree (or when
 * either side declines to return a number, which is the pre-#3898 shape).
 */
function checkSameResult(name: string, strategy: Strategy, jsResult: unknown, wasmResult: unknown): string | null {
  if (typeof jsResult !== "number" || typeof wasmResult !== "number") return null;
  if (Object.is(jsResult, wasmResult)) return null;

  process.stderr.write(
    `\n` +
      `  !! CROSS-LANE MISMATCH in "${name}" [${strategy}]\n` +
      `     js baseline returned ${jsResult}, wasm run() returned ${wasmResult}.\n` +
      `     The two lanes are not computing the same thing; refusing to publish\n` +
      `     this comparison (#3898).\n`,
  );
  process.exitCode = 1;
  return `cross-lane mismatch: js baseline returned ${jsResult}, wasm run() returned ${wasmResult}`;
}

async function runStrategy(
  def: BenchmarkDef,
  strategy: Strategy,
  jsReference: unknown,
): Promise<BenchmarkResult | null> {
  if (def.skip?.includes(strategy)) return null;

  const iterations = def.iterations ?? 100;
  const warmup = def.warmup ?? 5;
  const timings: number[] = [];

  let fn: () => unknown;
  let binarySize: number | undefined;
  let compileMs: number | undefined;

  try {
    switch (strategy) {
      case "js": {
        fn = def.js;
        break;
      }

      case "host-call": {
        const mod = await compileSource(def.source, false);
        binarySize = mod.binary.byteLength;
        compileMs = mod.compileMs;
        const imports = buildImports(mod.imports, def.deps ?? {}, mod.stringPool);
        const { instance } = await instantiateWasm(mod.binary, imports.env, imports.string_constants);
        imports.setInstance?.(instance);
        const run = (instance.exports as Record<string, Function>).run;
        if (!run) throw new Error(`No "run" export in host-call module for "${def.name}"`);
        fn = run as () => unknown;
        break;
      }

      case "gc-native": {
        const mod = await compileSource(def.source, true);
        binarySize = mod.binary.byteLength;
        compileMs = mod.compileMs;
        const imports = buildImports(mod.imports, def.deps ?? {}, mod.stringPool);
        const { instance } = await instantiateWasm(mod.binary, imports.env, imports.string_constants);
        imports.setInstance?.(instance);
        const run = (instance.exports as Record<string, Function>).run;
        if (!run) throw new Error(`No "run" export in gc-native module for "${def.name}"`);
        fn = run as () => unknown;
        break;
      }

      case "linear-memory": {
        const mod = await compileSource(def.source, true, "linear");
        binarySize = mod.binary.byteLength;
        compileMs = mod.compileMs;
        const imports = buildImports(mod.imports, def.deps ?? {}, mod.stringPool);
        const { instance } = await instantiateWasm(mod.binary, imports.env, imports.string_constants);
        imports.setInstance?.(instance);
        const run = (instance.exports as Record<string, Function>).run;
        if (!run) throw new Error(`No "run" export in linear-memory module for "${def.name}"`);
        fn = run as () => unknown;
        break;
      }
    }
  } catch (err) {
    // Strategy failed to compile / instantiate for this benchmark.
    // Some optimizer failures (notably Binaryen's Emscripten wrapper) set a
    // process exit code before throwing. Since this path downgrades the
    // failure to a recorded-but-unmeasured row, clear that sticky state here.
    process.exitCode = undefined;
    return failedResult(def.name, strategy, "setup", err);
  }

  // Warmup
  let lastResult: unknown;
  try {
    for (let i = 0; i < warmup; i++) lastResult = fn();
  } catch (err) {
    return failedResult(def.name, strategy, "warmup", err);
  }

  // Cross-lane result assertion (#3898) — after warmup, before timing.
  // Recorded as a failed row, not dropped: under #3904 an absent row means
  // "deliberately not applicable", which is the opposite of what a mismatch is.
  if (strategy !== "js") {
    const mismatch = checkSameResult(def.name, strategy, jsReference, lastResult);
    if (mismatch) return failedRow(def.name, strategy, "cross-lane", mismatch);
  }

  // Linear-memory benchmarks may use a bump allocator whose state persists
  // between calls, so retain their historical single-call samples. Other
  // strategies are safe to batch: the harness already invokes each function
  // repeatedly and observes timing rather than individual return values.
  let batchSize = 1;
  try {
    if (strategy !== "linear-memory") {
      batchSize = calibrateBenchmarkBatchSize(fn);
      timeBenchmarkBatch(fn, batchSize); // warm the calibrated loop before retaining samples
    }
  } catch (err) {
    return failedResult(def.name, strategy, "calibration", err);
  }

  // Timed runs. Each entry is normalized to one benchmark call, preserving the
  // existing result units while avoiding sub-millisecond timer quantization.
  //
  // Guard the same way as warmup (#1868): a strategy can pass warmup yet trap
  // mid-loop — e.g. the linear-memory backend's bump allocator exhausts memory
  // after many `split`/concat iterations, surfacing as a `memory access out of
  // bounds` RuntimeError. Whether that trap lands in warmup (caught) or in a
  // later timed iteration is non-deterministic across V8 versions, so an
  // unguarded timed loop made the whole benchmark suite abort fatally on CI
  // (Node 26) while passing locally (Node 25). Catching it here downgrades a
  // mid-run trap to a skipped strategy, matching warmup's behaviour.
  try {
    for (let i = 0; i < iterations; i++) {
      timings.push(timeBenchmarkBatch(fn, batchSize) / batchSize);
    }
  } catch (err) {
    return failedResult(def.name, strategy, "mid-loop", err);
  }

  timings.sort((a, b) => a - b);
  const totalMs = timings.reduce((s, t) => s + t, 0);
  const medianMs = median(timings);

  return {
    name: def.name,
    strategy,
    iterations,
    batchSize,
    totalMs,
    avgMs: totalMs / iterations,
    medianMs,
    p95Ms: percentile(timings, 95),
    binarySize,
    compileMs,
    opsPerCall: def.opsPerCall,
    nsPerOp: def.opsPerCall ? (medianMs * 1e6) / def.opsPerCall : undefined,
    minNsPerOp: def.minNsPerOp,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const ALL_STRATEGIES: Strategy[] = ["js", "host-call", "gc-native", "linear-memory"];

export async function runBenchmark(
  def: BenchmarkDef,
  strategies: Strategy[] = ALL_STRATEGIES,
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  // Reference value for the cross-lane assertion (#3898). Computed once, outside
  // the timed region, so a throwing baseline cannot abort the whole suite.
  let jsReference: unknown;
  try {
    jsReference = def.js();
  } catch {
    jsReference = undefined;
  }

  for (const s of strategies) {
    const r = await runStrategy(def, s, jsReference);
    if (r) results.push(r);
  }
  return results;
}

export async function runSuite(
  name: string,
  defs: BenchmarkDef[],
  strategies: Strategy[] = ALL_STRATEGIES,
): Promise<BenchmarkResult[]> {
  console.log(`\n=== Suite: ${name} ===\n`);
  const all: BenchmarkResult[] = [];

  for (const def of defs) {
    process.stdout.write(`  ${def.name} ...`);
    const results = await runBenchmark(def, strategies);
    all.push(...results);

    // Inline summary
    const cols = results.map((r) =>
      isMeasured(r) ? `${r.strategy}: ${r.medianMs.toFixed(3)}ms` : `${r.strategy}: FAILED`,
    );
    console.log(` ${cols.join("  |  ")}`);
  }

  return all;
}
