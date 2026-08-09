// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3907 — every compilation lane must return the SAME number.
 *
 * ## Why this test exists
 *
 * `mixed/fibonacci` shipped on the published performance page reporting
 * `gc-native` as 1.59x faster than JS. It was returning **-269,534,592** where
 * JS returns **8,320,400,000** — it had never been compared. `fast` mode
 * (= the `gc-native` lane) lowered EVERY TypeScript `number` to a Wasm `i32`
 * (`mapTsTypeToWasm`, plus two unconditional `ctx.fast ⇒ i32` numeric hints in
 * `binary-ops.ts`), so the lane was benchmarking wrapping 32-bit integer
 * arithmetic against JS's IEEE-754 doubles. That is not the same computation,
 * so the speedup never meant what the page claimed.
 *
 * The guard that catches this class of bug is **result equality across lanes**,
 * not "the module instantiates and does not trap". A benchmark that traps is
 * loud; a benchmark that silently computes a different function is not, and
 * that is exactly how a wrong answer sat on a public page.
 *
 * ## What is asserted
 *
 * For each source: the value returned by `run()` compiled as
 *   - `host-call`  (`fast: false`)
 *   - `gc-native`  (`fast: true`)  ← the lane that was wrong
 *   - `linear-memory` (`fast: true, target: "linear"`)
 * must equal the value produced by running the SAME source as JavaScript
 * (transpiled with `ts.transpileModule`, so the reference is derived from the
 * source rather than hand-copied and cannot drift from it).
 *
 * `mixed/fibonacci` is imported from `benchmarks/suites/mixed.ts` itself, so
 * the published benchmark and this guard can never diverge.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { mixedBenchmarks } from "../benchmarks/suites/mixed.js";
import { arrayBenchmarks } from "../benchmarks/suites/arrays.js";

type Lane = "host-call" | "gc-native" | "linear-memory";

const WASM_LANES: readonly Lane[] = ["host-call", "gc-native", "linear-memory"];

async function runLane(source: string, lane: Lane): Promise<number> {
  const options =
    lane === "host-call"
      ? ({ fast: false } as const)
      : lane === "gc-native"
        ? ({ fast: true } as const)
        : ({ fast: true, target: "linear" } as const);
  const result = await compile(source, options);
  if (!result.success) {
    throw new Error(`${lane}: compile failed — ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  const run = (instance.exports as Record<string, unknown>).run;
  if (typeof run !== "function") throw new Error(`${lane}: no "run" export`);
  return (run as () => number)();
}

/** Run the benchmark source as plain JS — the spec-correct reference value. */
function runAsJs(source: string): unknown {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  // `export function run` → a plain declaration we can call from the wrapper.
  // ESNext (not `None`/CommonJS) so the emit carries no `exports` shim.
  const body = js.replace(/\bexport\s+function\b/g, "function");
  return new Function(`${body}\nreturn run();`)() as unknown;
}

function benchmarkSource(name: string): string {
  const def = [...mixedBenchmarks, ...arrayBenchmarks].find((b) => b.name === name);
  if (!def) throw new Error(`benchmark "${name}" not found in the mixed/array suites`);
  return def.source;
}

/**
 * Each case is a `number`-returning `run()`. Values are chosen to leave the
 * int32 range or carry a fraction — i.e. to be observably different if any
 * lane narrows a `number` to i32.
 */
const CASES: ReadonlyArray<{ name: string; source: string; expected: number; lanes?: readonly Lane[] }> = [
  // The published benchmark, verbatim from the suite. It alternates fib(29)
  // and fib(30), keeping the work induction-dependent while still taking an
  // unbounded sum past 2^31.
  {
    name: "mixed/fibonacci (published benchmark source)",
    source: benchmarkSource("mixed/fibonacci"),
    // #3898 keeps the accumulator inside the exact i32 range with `% FIB_MOD`.
    // Keep this pinned to the published source's modulo result so source and
    // cross-lane semantics cannot drift independently again.
    expected: 731_344_958,
  },
  // The SECOND wrong published benchmark, found while re-measuring: `gc-native`
  // returned 704,982,704 where JS returns 4,999,950,000 — the same 2^31 wrap,
  // also never compared, also published (as "2.68x faster than JS").
  {
    name: "array/reduce (published benchmark source)",
    source: benchmarkSource("array/reduce"),
    expected: 4_999_950_000,
    // `linear-memory` is excluded because `codegen-linear` rejects `.reduce()`
    // outright ("Unsupported Array method", src/codegen-linear/index.ts) — a
    // pre-existing capability gap in that backend, not a numeric disagreement.
    // The two lanes that CAN compile it must still agree, which is the point.
    lanes: ["host-call", "gc-native"],
  },
  {
    name: "accumulator past 2^31 via +",
    source: `export function run(): number {
  let sum = 0;
  for (let i = 0; i < 10000; i = i + 1) { sum = sum + 832040; }
  return sum;
}`,
    expected: 8_320_400_000,
  },
  {
    name: "accumulator past 2^31 via +=",
    source: `export function run(): number {
  let sum = 0;
  for (let i = 0; i < 10000; i = i + 1) { sum += 832040; }
  return sum;
}`,
    expected: 8_320_400_000,
  },
  {
    name: "product past 2^31",
    source: `export function run(): number { let a = 100000; let b = 100000; return a * b; }`,
    expected: 10_000_000_000,
  },
  {
    name: "literal past 2^31 survives the round trip",
    source: `export function run(): number { let n = 3000000000; return n; }`,
    expected: 3_000_000_000,
  },
  {
    name: "fractional local",
    source: `export function run(): number { let n = 3.5; return n; }`,
    expected: 3.5,
  },
  {
    name: "division producing a fraction",
    source: `export function run(): number { let a = 7; let b = 2; return a / b; }`,
    expected: 3.5,
  },
  {
    name: "irrational result keeps full precision",
    source: `export function run(): number { return Math.sqrt(2); }`,
    expected: Math.SQRT2,
  },
  {
    name: "fractional array elements",
    source: `export function run(): number { const a: number[] = [1.5, 2.5]; return a[0]! + a[1]!; }`,
    expected: 4,
  },
  {
    name: "fraction through a call boundary",
    source: `function id(x: number): number { return x; }
export function run(): number { let n = 0.25; return id(n) + id(n); }`,
    expected: 0.5,
  },
  // (#3907) The counter-step spellings must agree with each other AND stay
  // correct. `i = i + 1` is the desugared `i += 1`; both are proven bounded by
  // the loop condition and both stay i32, but a mistake in that proof would
  // show up here as a wrong sum rather than as a slowdown.
  {
    name: "counter spelled `i = i + 1` accumulating past 2^31",
    source: `export function run(): number {
  let sum = 0;
  for (let i = 0; i < 20000; i = i + 1) { sum = sum + 500000; }
  return sum;
}`,
    expected: 10_000_000_000,
  },
  {
    name: "counter spelled `i++` accumulating past 2^31",
    source: `export function run(): number {
  let sum = 0;
  for (let i = 0; i < 20000; i++) { sum = sum + 500000; }
  return sum;
}`,
    expected: 10_000_000_000,
  },
  {
    name: "counter spelled `i = i + 2` visits the same elements",
    source: `export function run(): number {
  let sum = 0;
  for (let i = 0; i < 10; i = i + 2) { sum = sum + i; }
  return sum;
}`,
    expected: 20,
  },
  {
    name: "array element written from a proven counter, read as a fraction",
    source: `export function run(): number {
  const a: number[] = [];
  for (let i = 0; i < 10; i = i + 1) { a.push(i); }
  return a[7]! / 2;
}`,
    expected: 3.5,
  },
];

describe("#3907 cross-lane numeric result equality", () => {
  for (const testCase of CASES) {
    it(`${testCase.name} — every lane agrees`, async () => {
      // The JS reference is derived from the same source, so a source edit can
      // never silently invalidate the expectation.
      expect(runAsJs(testCase.source)).toBe(testCase.expected);

      const lanes = testCase.lanes ?? WASM_LANES;
      const byLane = new Map<Lane, number>();
      for (const lane of lanes) {
        byLane.set(lane, await runLane(testCase.source, lane));
      }
      expect(Object.fromEntries(byLane)).toEqual(Object.fromEntries(lanes.map((l) => [l, testCase.expected])));
    });
  }
});

/**
 * (#3907) The formatter cases, which are what #3917 filed independently before
 * the shared root cause was found. `String(n)` returned `"3"` for `n = 3.5`
 * because the value had never been *stored* as 3.5 — nothing was wrong in
 * `number_toString`, which is why the search inside the formatter came up
 * empty.
 *
 * ## Why these run with `nativeStrings: false`
 *
 * `fast: true` auto-enables `nativeStrings`, and a `NativeString` (a WasmGC
 * i16 array) is not a JS string across the export boundary — it reads back as
 * `null`, and calling `.length` on the formatter's result traps with
 * "dereferencing a null pointer". **That trap is pre-existing and byte-identical
 * on the base branch**, measured both before and after this change; it is
 * #3912's remaining half (the `import-collector.ts` gate plus
 * `emitNativeStringRefFromExternref`), not something #3907 introduced or can
 * fix. Pinning the observable half here is deliberate: it locks in the
 * representation fix now, and #3912 unlocks the other configuration later.
 */
const FORMATTER_CASES: ReadonlyArray<{ name: string; source: string; expected: string }> = [
  {
    name: "String(n) on a fractional local",
    source: `export function run(): string { const n = 3.5; return String(n); }`,
    expected: "3.5",
  },
  {
    name: "String(n) keeps full f64 precision",
    source: `export function run(): string { const n = Math.sqrt(2); return String(n); }`,
    expected: "1.4142135623730951",
  },
  {
    name: "toFixed on a fractional local",
    source: `export function run(): string { const n = 3.14159; return n.toFixed(2); }`,
    expected: "3.14",
  },
];

describe("#3907 formatter results agree across lanes", () => {
  for (const testCase of FORMATTER_CASES) {
    it(`${testCase.name} — host-call and gc-native agree`, async () => {
      expect(runAsJs(testCase.source)).toBe(testCase.expected);

      for (const options of [{ fast: false }, { fast: true, nativeStrings: false }] as const) {
        const result = await compile(testCase.source, options);
        expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
        const imports = buildImports(result.imports, {}, result.stringPool);
        const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
        imports.setInstance?.(instance);
        const run = (instance.exports as Record<string, unknown>).run as () => string;
        expect(run()).toBe(testCase.expected);
      }
    });
  }
});
