// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7353 slice 1: a dynamic parameter, or a member or element read through one,
// beside a carrier operand is the carrier too (`familyBesideCarrier`). The
// selector used to call it `unknown`, so `d.e !== g(o)` with a carrier `g(o)`
// was refused as `expr-binary-operand-families` although from-ast lowers both
// sides to the carrier. The claimed units must compute what node computes; a
// pair the refinement does not reach keeps its refusal.
import { afterAll, describe, expect, it, vi } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

const previousShapeDiag = vi.hoisted(() => {
  const previous = process.env.JS2WASM_IR_SHAPE_DIAG;
  process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  return previous;
});
afterAll(() => {
  if (previousShapeDiag === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
  else process.env.JS2WASM_IR_SHAPE_DIAG = previousShapeDiag;
});

async function build(source: string): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-7353.js",
    allowJs: true,
    target: "standalone",
    trackIrOutcomes: true,
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

function outcome(result: CompileResult, name: string) {
  return (result.irOutcomes ?? []).find((row) => row.displayName === name);
}

const CARRIER = "function g(o) { return o.x; }";

const CLAIMED: Record<string, string> = {
  "member read, strict equality": "function f(d, o) { return d.e === g(o) ? 1 : 0; }",
  "member read, loose equality": "function f(d, o) { return d.e == g(o) ? 1 : 0; }",
  "element read with a carrier key": "function f(d, o) { return d[o.k] !== g(o) ? 1 : 0; }",
  "nested member read, relational": "function f(d, o) { return d.a.b < g(o) ? 1 : 0; }",
  "carrier on the left": "function f(d, o) { return g(o) >= d.e ? 1 : 0; }",
  "numeric reader": "function f(d, o) { return d.e - g(o); }",
};

/** Every value pair through `f`, folded so one export reports the whole matrix. */
const DRIVER = `export function test() {
  var v = [5, "5", 0, null, undefined, true, "abc", 7];
  var acc = 0;
  for (var i = 0; i < v.length; i++) {
    for (var j = 0; j < v.length; j++) {
      var r = f({ e: v[i], k: "e", a: { b: v[i] } }, { x: v[j], k: "e" });
      acc = (acc * 7 + (r === r ? r : 3)) % 1000003;
    }
  }
  return acc;
}`;

describe("#7353 slice 1 — a read through a dynamic parameter beside a carrier", () => {
  for (const [label, fn] of Object.entries(CLAIMED)) {
    it(`claims and matches node: ${label}`, async () => {
      const source = `${CARRIER}\n${fn}\n${DRIVER}`;
      const result = await build(source);
      expect(outcome(result, "f")?.irBodyEmitted).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      const expected = new Function(`${source.replace("export ", "")}\nreturn test();`)();
      expect((instance.exports.test as () => unknown)()).toBe(expected);
    });
  }

  it("leaves an unproven operand refused beside the carrier", async () => {
    // A method call on the carrier proves nothing (it may answer a boolean).
    const result = await build(
      `${CARRIER}\nfunction f(d, o) { return d.m() === g(o) ? 1 : 0; }\nf({ m: function () { return 1; } }, { x: 1 });`,
    );
    const row = outcome(result, "f");
    expect(row?.irBodyEmitted).toBe(false);
    expect(String((row as { detail?: string } | undefined)?.detail)).toContain("expr-binary-operand-families");
  });

  it("does not read a nested function's same-named binding as the parameter", async () => {
    const result = await build(
      `${CARRIER}\nfunction f(d, o) { function h(d) { return d.e === g(o) ? 1 : 0; } return h(1); }\nf({}, { x: 1 });`,
    );
    expect(outcome(result, "f")?.irBodyEmitted).not.toBe(true);
  });
});
