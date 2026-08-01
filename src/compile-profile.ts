// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Compile-phase profiler (#3672 "Required investigation" / #3946).
//
// The ESLint frontier compiles are large enough that "the compiler is slow"
// is not an actionable statement: the pipeline runs ~30 whole-graph passes and
// a `--cpu-prof` profile only ever lands after the process exits, which is no
// help when the run does not terminate. This module gives every phase a name,
// a wall time, and a heap-delta, and can stream them as they close so a
// still-running compile still tells you where it is.
//
// It is inert unless `JS2WASM_COMPILE_PROFILE` is set, and the disabled path is
// a single boolean test plus the callback invocation — no timers, no
// allocation, no `Map` writes. Compiles that don't opt in are unaffected.
//
//   JS2WASM_COMPILE_PROFILE=1        summary table on process exit
//   JS2WASM_COMPILE_PROFILE=stream   also print each phase as it closes
//
// Nested phases are tracked as a stack so `codegen > bodies > file:foo.js`
// reads as a tree. Self time is wall time minus the time attributed to direct
// children, which is what makes the table usable for attribution.

/** One completed (or still-open) phase measurement. */
export interface CompilePhaseRecord {
  /** Slash-joined path from the root phase, e.g. `codegen/bodies`. */
  readonly path: string;
  /** Number of times this phase path was entered. */
  calls: number;
  /** Total wall time across all entries, in milliseconds. */
  totalMs: number;
  /** Wall time not attributed to direct child phases, in milliseconds. */
  selfMs: number;
  /** Sum of `process.memoryUsage().heapUsed` deltas, in bytes. */
  heapDeltaBytes: number;
  /** Largest `heapUsed` observed while this phase was open, in bytes. */
  peakHeapBytes: number;
}

const ENV_VAR = "JS2WASM_COMPILE_PROFILE";

interface OpenPhase {
  readonly path: string;
  readonly startMs: number;
  readonly startHeap: number;
  childMs: number;
}

let enabled = false;
let streaming = false;
let installed = false;
const records = new Map<string, CompilePhaseRecord>();
const stack: OpenPhase[] = [];

function readEnv(): string | undefined {
  // `process` is absent in the browser playground bundle, which imports this
  // module transitively through the compiler core.
  return typeof process !== "undefined" ? process.env?.[ENV_VAR] : undefined;
}

function heapUsed(): number {
  return typeof process !== "undefined" && typeof process.memoryUsage === "function"
    ? process.memoryUsage().heapUsed
    : 0;
}

function configure(): void {
  const raw = readEnv();
  enabled = raw !== undefined && raw !== "" && raw !== "0" && raw !== "false";
  streaming = enabled && (raw === "stream" || raw === "2");
  if (enabled && !installed && typeof process !== "undefined" && typeof process.on === "function") {
    installed = true;
    process.on("exit", () => {
      if (records.size > 0) process.stderr.write(formatCompileProfile());
    });
  }
}

configure();

/** Re-read `JS2WASM_COMPILE_PROFILE`. Exposed so tests can toggle it in-process. */
export function refreshCompileProfileConfig(): void {
  configure();
}

/** True when phase instrumentation is active. */
export function isCompileProfileEnabled(): boolean {
  return enabled;
}

/** Drop all accumulated measurements (used by tests). */
export function resetCompileProfile(): void {
  records.clear();
  stack.length = 0;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function close(open: OpenPhase): void {
  const elapsed = performance.now() - open.startMs;
  const endHeap = heapUsed();
  let record = records.get(open.path);
  if (record === undefined) {
    record = {
      path: open.path,
      calls: 0,
      totalMs: 0,
      selfMs: 0,
      heapDeltaBytes: 0,
      peakHeapBytes: 0,
    };
    records.set(open.path, record);
  }
  record.calls += 1;
  record.totalMs += elapsed;
  record.selfMs += elapsed - open.childMs;
  record.heapDeltaBytes += endHeap - open.startHeap;
  if (endHeap > record.peakHeapBytes) record.peakHeapBytes = endHeap;

  const parent = stack[stack.length - 1];
  if (parent !== undefined) parent.childMs += elapsed;

  if (streaming) {
    const indent = "  ".repeat(stack.length);
    process.stderr.write(`[js2:profile] ${indent}${open.path} ${fmtMs(elapsed)} heap=${fmtMb(endHeap)}\n`);
  }
}

/**
 * Time `fn` as a named compile phase.
 *
 * Returns `fn()` unchanged, and rethrows unchanged — a phase that throws is
 * still recorded, because an aborting compile is exactly when the attribution
 * matters. Safe to nest.
 */
export function profilePhase<T>(name: string, fn: () => T): T {
  if (!enabled) return fn();
  const parent = stack[stack.length - 1];
  const open: OpenPhase = {
    path: parent === undefined ? name : `${parent.path}/${name}`,
    startMs: performance.now(),
    startHeap: heapUsed(),
    childMs: 0,
  };
  stack.push(open);
  try {
    return fn();
  } finally {
    stack.pop();
    close(open);
  }
}

/**
 * Record a scalar fact about the graph (source count, function count, …) so the
 * profile explains scale as well as time. No-op when profiling is off.
 */
export function profileCount(name: string, value: number): void {
  if (!enabled) return;
  process.stderr.write(`[js2:profile] count ${name}=${value}\n`);
}

/** Snapshot of everything measured so far, sorted by self time descending. */
export function getCompileProfile(): CompilePhaseRecord[] {
  return [...records.values()].sort((a, b) => b.selfMs - a.selfMs);
}

/** Render the measurements as a table, sorted by self time descending. */
export function formatCompileProfile(): string {
  const rows = getCompileProfile();
  if (rows.length === 0) return "";
  const totalSelf = rows.reduce((sum, r) => sum + r.selfMs, 0);
  const width = Math.max(5, ...rows.map((r) => r.path.length));
  const lines = [
    "",
    `[js2:profile] compile phases (total ${fmtMs(totalSelf)}, peak heap ${fmtMb(
      Math.max(0, ...rows.map((r) => r.peakHeapBytes)),
    )})`,
    `[js2:profile] ${"phase".padEnd(width)}  ${"self".padStart(9)}  ${"total".padStart(9)}  ${"calls".padStart(6)}  share`,
  ];
  for (const r of rows) {
    const share = totalSelf > 0 ? ((r.selfMs / totalSelf) * 100).toFixed(1) : "0.0";
    lines.push(
      `[js2:profile] ${r.path.padEnd(width)}  ${fmtMs(r.selfMs).padStart(9)}  ${fmtMs(r.totalMs).padStart(
        9,
      )}  ${String(r.calls).padStart(6)}  ${share.padStart(5)}%`,
    );
  }
  // Phases still open when the process died — the ones a hang is inside of.
  if (stack.length > 0) {
    lines.push(`[js2:profile] OPEN AT EXIT: ${stack.map((s) => s.path).join(" > ")}`);
  }
  lines.push("");
  return lines.join("\n");
}
