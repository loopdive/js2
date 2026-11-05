// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 compareArray.format — `Array.prototype.<m>.call(recv, …)` on the
// ambient `Array` lowers as ONE reflective call to the per-(method, arity)
// wrapper `__ir_arr_borrow_<m>_<n>` on the host-free lanes. The wrapper is
// legacy's own borrow compiler (`array-prototype-borrow.ts`) over a template
// whose parameters are the dynamic carrier, so the IR never materializes
// `Array.prototype.<m>` as a value (#7123). A method call ON the borrow's
// result (`….join(", ")`) is a dynamic-receiver call through the #7119 wrapper.
//
// Every program is also run under node and must agree; every subject must be
// an IR body that calls a borrow wrapper, and a shadowed `Array` must not.
// Each subject is called with an array-like AND a real array, as the harness
// does: legacy types a parameter from its call sites, and a vec-only caller
// set would give legacy a typed-vec ABI the IR's carrier cannot match
// (`abi-signature-parity`, a safe demote — not what this test measures).
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

function node(source: string): number {
  return new Function(`"use strict";\n${source.replace(/\bexport /g, "")}\nreturn run();`)() as number;
}

function outcome(result: CompileResult, name: string) {
  return (result.irOutcomes ?? []).find((entry) => entry.displayName === name);
}

async function compileStandalone(source: string): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "test.js",
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    experimentalIR: true,
    emitWat: true,
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

async function run(result: CompileResult): Promise<number> {
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.run as () => number)();
}

/** Each check is a boolean expression; `run()` sets bit i when check i holds. */
function program(subjects: string, checks: readonly string[]): string {
  return `${subjects}
export function run() {
  var n = 0;
  var like = { length: 3, 0: "a", 1: 2, 2: true };
  var arr = [1, 2, 3];
  function S(x) { return "" + x; }
  function add(acc, x) { return acc + x; }
  function big(x) { return x > 1; }
${checks.map((check, i) => `  if (${check}) n += ${2 ** i};`).join("\n")}
  return n;
}`;
}

function wrong(checks: readonly string[], got: number, expected: number): string[] {
  return checks.filter((_, i) => (expected & (2 ** i)) !== 0 && (got & (2 ** i)) === 0);
}

const SUBJECTS = `function fmt(arrayLike, S) { return "[" + Array.prototype.map.call(arrayLike, S).join(", ") + "]"; }
function joined(a, sep) { return Array.prototype.join.call(a, sep); }
function summed(a, f, init) { return Array.prototype.reduce.call(a, f, init); }
function kept(a, f) { return Array.prototype.filter.call(a, f).join("|"); }
function anyBig(a, f) { return String(Array.prototype.some.call(a, f)); }`;

const CHECKS = [
  'fmt(like, S) === "[a, 2, true]"',
  'fmt(arr, S) === "[1, 2, 3]"',
  'fmt([], S) === "[]"',
  'fmt([1, "a", undefined], S) === "[1, a, undefined]"', // compareArray.format's own row shape
  'joined(like, "-") === "a-2-true"',
  'joined(arr, "") === "123"',
  "summed(arr, add, 10) === 16",
  "summed({ length: 2, 0: 5, 1: 6 }, add, 1) === 12",
  'kept(arr, big) === "2|3"',
  'kept(like, big) === "2"',
  'anyBig(like, big) === "true"',
  'anyBig([0, 1], big) === "false"',
];

/**
 * Borrows legacy types past the IR's carrier when the value reaches a typed
 * slot: `any[]` (a vec ref) for the array-producing methods, `void` (no result
 * slot) for `forEach`. In return position each one used to claim, build, and
 * demote at finalize (`abi-signature-parity`) with an orphaned wrapper left in
 * the module; the selector now refuses them there. Each row is `[method,
 * extra arguments]`, called on a receiver `a` with callback `S` in scope.
 */
const TYPED_SLOT_REFUSED: readonly (readonly [string, string])[] = [
  ["slice", ""],
  ["splice", ", 0, 1"],
  ["reverse", ""],
  ["sort", ""],
  ["fill", ", 1"],
  ["flat", ""],
  ["with", ", 0, 1"],
  ["copyWithin", ", 0, 1"],
  ["map", ", S"],
  ["filter", ", S"],
  ["concat", ", 1"],
  ["flatMap", ", S"],
  ["toReversed", ""],
  ["toSorted", ""],
  ["toSpliced", ", 0, 1"],
  ["forEach", ", S"],
];

describe("#7106 — Array.prototype.<m>.call on the ambient Array lowers through the borrow wrapper", () => {
  it("answers like node, from IR bodies that call the wrappers (standalone)", async () => {
    const source = program(SUBJECTS, CHECKS);
    const expected = node(source);
    expect(expected).toBe(2 ** CHECKS.length - 1);
    const result = await compileStandalone(source);
    for (const name of ["fmt", "joined", "summed", "kept", "anyBig"]) {
      const row = outcome(result, name);
      expect(row?.irBodyEmitted, `${name}: ${JSON.stringify(row)}`).toBe(true);
    }
    const wat = result.wat ?? "";
    for (const wrapper of ["__ir_arr_borrow_map_1", "__ir_arr_borrow_join_1", "__ir_arr_borrow_reduce_2"]) {
      expect(wat).toContain(wrapper);
    }
    const got = await run(result);
    expect(wrong(CHECKS, got, expected), `got ${got}, expected ${expected}`).toEqual([]);
  });

  it("refuses, before any claim, a borrow legacy types past the carrier in a typed slot", async () => {
    const subjects = TYPED_SLOT_REFUSED.map(
      ([method, extra]) => `function ret_${method}(a, S) { return Array.prototype.${method}.call(a${extra}); }`,
    ).join("\n");
    const checks = TYPED_SLOT_REFUSED.map(([method]) => `ret_${method}(arr, big) !== undefined`);
    const source = program(subjects, checks);
    // `compileStandalone` asserts the post-claim ledger is EMPTY: none of these
    // may claim and then demote.
    const result = await compileStandalone(source);
    for (const [method] of TYPED_SLOT_REFUSED) {
      const row = outcome(result, `ret_${method}`);
      expect(row?.irBodyEmitted, `${method}: ${JSON.stringify(row)}`).toBe(false);
    }
    // A refused borrow publishes no wrapper — not even an unreferenced one.
    expect(result.wat ?? "").not.toContain("__ir_arr_borrow_");
    expect(await run(result)).toBe(node(source));
  });

  it("admits the same methods where the value stays the carrier: a member receiver", async () => {
    const source = program(
      `function first(a) { return Array.prototype.slice.call(a)[0]; }
       function last(a) { return Array.prototype.toReversed.call(a)[0]; }`,
      ["first(like) === 'a'", "first(arr) === 1", "last(arr) === 3", "last(like) === true"],
    );
    const expected = node(source);
    expect(expected).toBe(2 ** 4 - 1);
    const result = await compileStandalone(source);
    for (const name of ["first", "last"]) {
      expect(outcome(result, name)?.irBodyEmitted, name).toBe(true);
    }
    expect(result.wat ?? "").toContain("__ir_arr_borrow_slice_0");
    expect(await run(result)).toBe(expected);
  });

  it("refuses before claiming the #6972 review shapes, and keeps the harness row claimed", async () => {
    // `fmt` called only with a vec / typed array: legacy types `x` from the
    // call sites, past the carrier (`dynamicCarrierDivergesFromLegacy`). With
    // an object literal the IR projects `x` as a struct the carrier cannot
    // box: the move-only scan proves every concrete operand boxable first.
    const fmt = `function fmt(x) { return Array.prototype.map.call(x, String).join(", "); }`;
    const repros = [
      `${fmt}\nexport function run() { return fmt([1, 2]) === "1, 2" ? 1 : 0; }`,
      `${fmt}\nexport function run() { return fmt([]) === "" ? 1 : 0; }`,
      `${fmt}\nexport function run() { return fmt([1, , 3]) === "1, , 3" ? 1 : 0; }`,
      `${fmt}\nexport function run() { return fmt(new Int8Array([4, 5])) === "4, 5" ? 1 : 0; }`,
      `${fmt}\nexport function run() { return fmt({ length: 2, 0: "a", 1: "b" }) === "a, b" ? 1 : 0; }`,
    ];
    for (const source of repros) {
      const result = await compileStandalone(source);
      expect(outcome(result, "fmt")?.irBodyEmitted, source).toBe(false);
      const legacy = await compile(source, {
        fileName: "test.js",
        allowJs: true,
        target: "standalone",
        skipSemanticDiagnostics: true,
        experimentalIR: false,
      } as Parameters<typeof compile>[1]);
      expect(await run(result), source).toBe(await run(legacy));
    }
    // node parity except the hole row (legacy's own `[1, , 3]` gap, unchanged).
    for (const source of repros.filter((_, i) => i !== 2)) {
      expect(await run(await compileStandalone(source)), source).toBe(node(source));
    }
    // The harness row: the borrow result feeds `+`, not a typed return, and the
    // receiver is the carrier (array-like and array callers) — still claimed.
    const harness = `function f(arrayLike) { return "[" + Array.prototype.map.call(arrayLike, String).join(", ") + "]"; }
export function run() { return f([1, 2]) === "[1, 2]" && f({ length: 1, 0: "a" }) === "[a]" ? 1 : 0; }`;
    const claimed = await compileStandalone(harness);
    expect(outcome(claimed, "f")?.irBodyEmitted).toBe(true);
    expect(await run(claimed)).toBe(node(harness));
  }, 90_000);

  it("never borrows through a shadowed `Array`, and still answers like node", async () => {
    const source = program(
      `function shadowed(Array, a) { return Array.prototype.join.call(a, "-"); }
       function Fake() {}
       Fake.prototype = { join: function (a) { return "fake:" + a; } };`,
      ['shadowed({ prototype: { join: function (x) { return "own:" + x.length; } } }, like) === "own:3"'],
    );
    const result = await compileStandalone(source);
    // The parameter `Array` is an ordinary dynamic value: its `.prototype.join`
    // reads and the `.call` are generic dynamic member operations, never the borrow.
    expect(result.wat ?? "").not.toContain("__ir_arr_borrow_");
    expect(await run(result)).toBe(node(source));
  });
});
