// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5194 r3 — dyn-view method RESOLUTION (step r3-1) and the search helpers
 * (step r3-2).
 *
 * The corpus shape behind clusters C0–C3 is
 * `testWithTypedArrayConstructors(function (TA) { var sample = new TA([…]); … })`:
 * a receiver whose static type is `any` and whose runtime brand is
 * `$__ta_dyn_view`. Before r3-1 an ordinary string key on such a receiver never
 * left the expando side-table, so every inherited `%TypedArray%.prototype`
 * member read back `undefined` and every method call fell to the generic
 * `$__vec_base` arms — `includes(42)` answered the NUMBER 1.
 *
 * Each control below is asserted on BOTH lanes: the standalone lane must also
 * emit ZERO host imports (CI fails a standalone module that emits any `env::*`,
 * and the in-process path probe does not apply that check — #5272).
 */
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

type Lane = "host" | "standalone";

const CONTROL_TIMEOUT = 180_000;

async function runControl(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5194-es2015-typedarray-r3.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(
    result.success,
    `${lane} control compile failed:\n${result.errors?.map((error) => `L${error.line}: ${error.message}`).join("\n") ?? ""}`,
  ).toBe(true);
  if (!result.success) return -1;

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  if (lane === "standalone") {
    expect(imports, "standalone TypedArray dyn-view controls must emit zero imports").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

/**
 * r3-1 — an inherited `%TypedArray%.prototype` member RESOLVES off an instance,
 * an own expando still shadows it, and the intrinsic named props are unchanged.
 */
const RESOLUTION_SOURCE = `
  export function test(): number {
    const TypedArray: any = Object.getPrototypeOf(Int8Array);
    const TA: any = Float64Array;
    const sample: any = new TA([42, 43, 44]);

    if (typeof sample.includes !== "function") return 1;
    if (sample.includes !== TypedArray.prototype.includes) return 2;
    if (typeof sample.sort !== "function") return 3;
    if (!("includes" in sample)) return 4;
    if ("nosuch" in sample) return 5;
    if (typeof sample.nosuch !== "undefined") return 6;

    // The expando side-table still answers its own keys, both ways.
    sample.foo = 7;
    if (sample.foo !== 7) return 7;
    if (!("foo" in sample)) return 8;

    // An own function property shadows the inherited method (7.3.2).
    sample.includes = function (): number { return 99; };
    if (sample.includes() !== 99) return 9;

    // Intrinsic named props keep their pre-r3 answers.
    const other: any = new TA([1, 2, 3]);
    if (other.length !== 3) return 10;
    if (other.constructor !== TA) return 11;
    if (Object.getPrototypeOf(other) !== TA.prototype) return 12;
    if (other[0] !== 1) return 13;
    return 0;
  }
`;

/** r3-2 — the three §23.2.3 search methods on a dyn view. */
const SEARCH_SOURCE = `
  export function test(): number {
    const TA: any = Float64Array;
    const sample: any = new TA([42, 43, 44]);

    if (sample.includes(42) !== true) return 1;
    if (sample.includes(43, 1) !== true) return 2;
    if (sample.includes(42, 1) !== false) return 3;
    if (sample.includes(7) !== false) return 4;
    if (sample.indexOf(43) !== 1) return 5;
    if (sample.indexOf(7) !== -1) return 6;
    if (sample.indexOf() !== -1) return 7;
    if (sample.lastIndexOf(44) !== 2) return 8;
    if (sample.lastIndexOf(42, -1) !== 0) return 9;

    // A zero-length view answers before fromIndex is observed.
    const empty: any = new TA([]);
    if (empty.includes(1) !== false) return 10;
    if (empty.indexOf(1) !== -1) return 11;

    // -0 fromIndex behaves as +0; +Infinity misses; -Infinity clamps to 0.
    if (sample.includes(42, -0) !== true) return 12;
    if (sample.includes(42, Infinity) !== false) return 13;
    if (sample.includes(42, -Infinity) !== true) return 14;

    // SameValueZero: includes finds NaN, indexOf never does.
    const withNan: any = new TA([NaN, 1]);
    if (withNan.includes(NaN) !== true) return 15;
    if (withNan.indexOf(NaN) !== -1) return 16;

    // A non-number search element can never match, and its valueOf must not run.
    let touched = 0;
    const weird: any = { valueOf: function (): number { touched = 1; return 42; } };
    if (sample.includes(weird) !== false) return 17;
    if (touched !== 0) return 18;

    // An abrupt fromIndex propagates unchanged.
    let caught = 0;
    try {
      sample.includes(42, { valueOf: function (): number { throw new Error("boom"); } });
    } catch (e) {
      caught = 1;
    }
    if (caught !== 1) return 19;

    // A zero-argument call is the miss result, not the arity-gate sentinel.
    if (sample.includes() !== false) return 20;
    if (sample.indexOf() !== -1) return 21;
    if (sample.lastIndexOf() !== -1) return 22;

    // The result is a BOOLEAN, and stays one through every consumer.
    if (typeof sample.includes(42) !== "boolean") return 23;
    if (!sample.includes(42)) return 24;
    if (String(sample.includes(42)) !== "true") return 25;
    return 0;
  }
`;

/**
 * The dispatcher route must not swallow a user method of the same name: an own
 * property shadows §23.2.3, and its own return value survives (the boolean
 * unbox on that path used to turn `99` into `true`).
 */
const SHADOW_SOURCE = `
  export function test(): number {
    const TA: any = Float64Array;
    const view: any = new TA([1, 2, 3]);
    view.tag = 1;
    if (view.includes(2) !== true) return 1;
    view.includes = function (): number { return 99; };
    if (view.includes() !== 99) return 2;
    if (view.includes(1) !== 99) return 3;
    if (typeof view.includes !== "function") return 4;
    return 0;
  }
`;

/**
 * The shapes that already worked and must not move: a plain `any` array keeps
 * the `$__vec_base` arms (the new arm is `ref.test $__ta_dyn_view`-gated), and
 * so does an `any` string.
 */
const NEIGHBOUR_SOURCE = `
  export function test(): number {
    const a: any = [1, NaN, 3];
    if (a.includes(NaN) !== true) return 1;
    if (a.indexOf(3) !== 2) return 2;
    if (a.lastIndexOf(1) !== 0) return 3;
    const s: any = "abc";
    if (s.includes("b") !== true) return 4;
    if (s.indexOf("c") !== 2) return 5;
    const TA: any = Int8Array;
    const view: any = new TA([3, 1, 2]);
    if (view.join("-") !== "3-1-2") return 6;
    view.fill(7);
    if (view[0] !== 7) return 7;
    return 0;
  }
`;

describe("#5194 r3 — TypedArray dyn-view method resolution (standalone)", () => {
  it(
    "resolves inherited %TypedArray%.prototype members off an instance (standalone)",
    async () => expect(await runControl(RESOLUTION_SOURCE, "standalone")).toBe(0),
    CONTROL_TIMEOUT,
  );
  it(
    "resolves inherited %TypedArray%.prototype members off an instance (host)",
    async () => expect(await runControl(RESOLUTION_SOURCE, "host")).toBe(0),
    CONTROL_TIMEOUT,
  );
  it(
    "includes/indexOf/lastIndexOf answer per §23.2.3 (standalone)",
    async () => expect(await runControl(SEARCH_SOURCE, "standalone")).toBe(0),
    CONTROL_TIMEOUT,
  );
  it(
    "includes/indexOf/lastIndexOf answer per §23.2.3 (host)",
    async () => expect(await runControl(SEARCH_SOURCE, "host")).toBe(0),
    CONTROL_TIMEOUT,
  );
  it(
    "an own method shadows the helper and keeps its own return value (standalone)",
    async () => expect(await runControl(SHADOW_SOURCE, "standalone")).toBe(0),
    CONTROL_TIMEOUT,
  );
  it(
    "an own method shadows the helper and keeps its own return value (host)",
    async () => expect(await runControl(SHADOW_SOURCE, "host")).toBe(0),
    CONTROL_TIMEOUT,
  );
  it(
    "leaves plain arrays, strings and the mutators untouched (standalone)",
    async () => expect(await runControl(NEIGHBOUR_SOURCE, "standalone")).toBe(0),
    CONTROL_TIMEOUT,
  );
  it(
    "leaves plain arrays, strings and the mutators untouched (host)",
    async () => expect(await runControl(NEIGHBOUR_SOURCE, "host")).toBe(0),
    CONTROL_TIMEOUT,
  );
});
