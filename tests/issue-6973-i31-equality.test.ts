// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6973 stage 2) Standalone `==` / `===` on two externref operands that are
// both i31-boxed compares the integers directly. An i31 is only ever a Number in
// this runtime (and never -0 or NaN, which stay `$BoxedNumber`), so integer
// equality IS IsLooselyEqual / IsStrictlyEqual for that pair. Deltablue's
// `this.direction == Direction.FORWARD` used to run the full ToPrimitive /
// nullish / typeof cascade — about ten helper calls — per comparison.
import { afterEach, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SRC = `
function mk(v) { return v; }
var vals = [mk(1), mk(0), mk(-0), mk(-1), mk(2147483647), mk(1073741823), mk(1073741824), mk(-1073741824), mk(1.5), mk(NaN), mk("1"), mk(true), mk(null), mk(undefined)];
export function t_eq_matrix() {
  var h = 0;
  for (var i = 0; i < vals.length; i++) {
    for (var j = 0; j < vals.length; j++) {
      var a = vals[i], b = vals[j];
      h = (h * 31 + ((a == b) ? 1 : 0) * 2 + ((a === b) ? 1 : 0)) % 1000000007;
    }
  }
  return h;
}
export function t_ne() {
  var a = vals[0], b = vals[0], c = vals[3];
  return (a != b ? 1 : 0) + (a !== c ? 10 : 0) + (a == c ? 100 : 0);
}
var Direction = new Object();
Direction.FORWARD = 1;
Direction.BACKWARD = -1;
function Con() { this.direction = Direction.BACKWARD; }
Con.prototype.pick = function () { return (this.direction == Direction.FORWARD) ? 1 : 2; };
export function t_loop() {
  var c = new Con(), s = 0;
  for (var i = 0; i < 200; i++) { s += c.pick(); c.direction = i % 2 ? Direction.FORWARD : Direction.BACKWARD; }
  return s;
}
`;

async function run(): Promise<Record<string, number>> {
  const result = await compile(SRC, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const census = instance.exports.__exec_count___typeof_object as WebAssembly.Global | undefined;
  const out: Record<string, number> = {};
  for (const name of ["t_eq_matrix", "t_ne", "t_loop"]) {
    const before = (census?.value as number | undefined) ?? 0;
    out[name] = (instance.exports[name] as () => number)();
    out[`calls:${name}`] = ((census?.value as number | undefined) ?? 0) - before;
  }
  return out;
}

describe("#6973 stage 2 — i31 fast path for standalone ==/===", () => {
  const saved = process.env.JS2WASM_EXEC_CENSUS;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EXEC_CENSUS");
    else process.env.JS2WASM_EXEC_CENSUS = saved;
  });

  it("answers what Node answers", async () => {
    const out = await run();
    expect(out.t_eq_matrix).toBe(772733683);
    expect(out.t_ne).toBe(10);
    expect(out.t_loop).toBe(301);
  });

  it("compares two small-integer Numbers without the ToPrimitive cascade", async () => {
    process.env.JS2WASM_EXEC_CENSUS = "__typeof_object";
    const out = await run();
    expect(out.t_loop).toBe(301);
    // 200 comparisons of two i31 Numbers; the cascade asked `__typeof_object`
    // twice per comparison before this fast path.
    expect(out["calls:t_loop"]).toBeLessThan(50);
  });
});
