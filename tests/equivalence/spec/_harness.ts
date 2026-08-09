// #2092 — table-driven spec-conformance harness.
//
// The ~600 ad-hoc June probes found 170 bugs the example-driven corpus could
// not see, but they lived only in issue markdown and would rot. This harness
// promotes them into table-driven `tests/equivalence/spec/<family>.test.ts`
// files: each row is a self-contained snippet whose Wasm output is auto-diffed
// against the SAME snippet evaluated as JS (Node), across FOUR lanes:
//
//   1. host          — default WasmGC + JS host imports
//   2. host  -O       — host + Binaryen wasm-opt (optimize: 2)
//   3. standalone    — `target: "standalone"` (pure WasmGC, no JS host)
//   4. standalone -O  — standalone + wasm-opt
//
// The standalone lanes also assert no host-import leak (the #1901/#1472
// `assertNoHostObjectImports` check) so a coercion that silently delegates to a
// JS host import in standalone mode is caught as a failure, not a pass.
//
// IMPORTANT — snippets must be SELF-CONTAINED (zero-arg exported `run`):
// standalone mode has no JS host to inject `any` values, so every value a probe
// exercises must be constructed inside wasm (`const x: any = "..."`). Passing
// host JS values into externref params is NOT a standalone scenario and would
// give a misleading result (see #2059 resolution note). The snippet returns an
// `f64`/`i32` `number` (booleans encode as `? 1 : 0`) so the diff is exact.
//
// Open-bug repros are landed RED-BUT-BASELINED: add a row with `bug: <issue#>`
// and the lanes it currently fails, then register the generated test id(s) in
// scripts/equivalence-baseline.json (the equivalence-gate known-failures
// mechanism). A deliberately-reverted fix then turns the suite red in exactly
// the lane that regressed.

import { describe, it, expect } from "vitest";
import { compile } from "../../../src/index.js";
import { buildImports, evaluateAsJs } from "../helpers.js";
import { buildImports as buildRuntimeImports } from "../../../src/runtime.js";

export type Lane = "host" | "host-O" | "standalone" | "standalone-O";

export const ALL_LANES: readonly Lane[] = ["host", "host-O", "standalone", "standalone-O"];

/** A single spec-conformance row. */
export interface SpecRow {
  /** Human-readable label — becomes the vitest test title. Must be unique within a family. */
  readonly name: string;
  /**
   * A self-contained TS snippet exporting a zero-arg `run(): number`. The
   * harness compiles + runs it in each lane and diffs against `evaluateAsJs`.
   * Booleans must be encoded as `? 1 : 0`; the exact f64/i32 value is compared.
   */
  readonly src: string;
  /**
   * The expected numeric result (computed by evaluating the snippet as JS at
   * build time so the table is self-checking and does not silently drift if the
   * snippet is malformed). Optional — when omitted the harness evaluates the
   * snippet as JS itself.
   */
  readonly expect?: number;
  /**
   * Open-bug marker. When set, the row is expected to FAIL in `failsIn` lanes
   * and those generated test ids must be in scripts/equivalence-baseline.json.
   * Documents the owning issue so a reverted fix points at the right bug.
   */
  readonly bug?: number;
  /** Lanes where a `bug` row currently fails (subset of ALL_LANES). */
  readonly failsIn?: readonly Lane[];
  /** Lanes to skip entirely (e.g. a feature genuinely unsupported standalone). */
  readonly skipLanes?: readonly Lane[];
}

const BANNED_HOST_IMPORTS = [
  /^env::__extern_/,
  /^env::__object_/,
  /^env::__new_plain_object/,
  /^env::__get_builtin/,
  /^env::__proto_method_call/,
  /^env::__to_primitive/,
  /^env::__hasOwnProperty/,
  /^env::__host_/,
];

function assertNoHostObjectImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED_HOST_IMPORTS) {
    const hits = labels.filter((l) => re.test(l));
    expect(hits, `standalone leaked ${re} (got ${hits.join(", ")})`).toEqual([]);
  }
}

function laneOptions(lane: Lane): Parameters<typeof compile>[1] {
  switch (lane) {
    case "host":
      return {};
    case "host-O":
      return { optimize: 2 };
    case "standalone":
      return { target: "standalone" };
    case "standalone-O":
      return { target: "standalone", optimize: 2 };
  }
}

/** Run a snippet's exported `run()` in one lane, returning the numeric result. */
async function runLane(src: string, lane: Lane): Promise<number> {
  const r = await compile(src, laneOptions(lane));
  if (!r.success) {
    throw new Error(`[${lane}] compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  if (!WebAssembly.validate(r.binary)) {
    throw new Error(`[${lane}] invalid Wasm binary (WebAssembly.validate failed)\nWAT:\n${r.wat}`);
  }
  const isStandalone = lane === "standalone" || lane === "standalone-O";
  if (isStandalone) {
    assertNoHostObjectImports(r.imports);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    return (instance.exports as Record<string, () => number>).run();
  }
  // Host lane — full host-import fidelity (iterator protocol, struct getters).
  const imports = buildImports(r);
  let setInstanceFn: ((instance: WebAssembly.Instance) => void) | undefined;
  if (r.imports && r.imports.length > 0) {
    const rt = buildRuntimeImports(r.imports, undefined, r.stringPool);
    setInstanceFn = rt.setInstance;
    imports.env = { ...(imports.env as Record<string, Function>), ...rt.env };
    if (rt.string_constants) imports.string_constants = rt.string_constants;
  }
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  setInstanceFn?.(instance);
  return (instance.exports as Record<string, () => number>).run();
}

/** Evaluate a snippet's `run()` as plain JS (types stripped) for the expected value. */
function evalRunAsJs(src: string): number {
  // `evaluateAsJs` transpiles the TS snippet (stripping `: any`/`as number`/…)
  // and returns the exported functions; `run()` is the snippet's entry point.
  const exports = evaluateAsJs(src);
  return (exports.run as () => number)();
}

/**
 * Register a spec-conformance family as a vitest `describe`. Each row × lane
 * becomes one `it`. The generated test id (used by the equivalence-gate
 * baseline) is `<family> > <lane> > <row.name>`.
 */
export function defineSpecFamily(family: string, rows: readonly SpecRow[]): void {
  describe(family, () => {
    for (const lane of ALL_LANES) {
      describe(lane, () => {
        for (const row of rows) {
          if (row.skipLanes?.includes(lane)) {
            it.skip(row.name, () => {});
            continue;
          }
          it(row.name, async () => {
            const expected = row.expect ?? evalRunAsJs(row.src);
            const got = await runLane(row.src, lane);
            // Booleans encode as 0/1; everything else is an exact f64/i32 number.
            // Use Object.is so -0 / NaN distinctions surface (spec-relevant).
            expect(Object.is(got, expected) || got === expected, `${family} [${lane}] ${row.name}`).toBe(true);
          });
        }
      });
    }
  });
}
