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
  'joined(like, "-") === "a-2-true"',
  'joined(arr, "") === "123"',
  "summed(arr, add, 10) === 16",
  "summed({ length: 2, 0: 5, 1: 6 }, add, 1) === 12",
  'kept(arr, big) === "2|3"',
  'kept(like, big) === "2"',
  'anyBig(like, big) === "true"',
  'anyBig([0, 1], big) === "false"',
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
