// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5197 R3-10 — an initializer-less `var` is a NARROWING, not a proof of
// `undefined`.
//
// `provablyNullishReceiver` (builtin-prototype-brand.ts) folds a borrowed
// `Object.prototype.hasOwnProperty.call(receiver, k)` to a static TypeError
// when the receiver is provably nullish. TypeScript's control-flow analysis
// narrows an initializer-less, annotation-less `var` to `undefined` at a use
// no assignment dominates — an evolving `any` — and the gate took that
// narrowing as a proof. `var resolveFunction;` filled only inside a nested
// executor therefore compiled to an unconditional throw.
//
// This file pins BOTH directions: the evolving `var` must stay dynamic, and
// the genuine proofs (the `null` keyword, an explicitly `undefined`-typed
// binding) must still take the static throw.

import { describe, expect, it } from "vitest";
import { compile, instantiateWasm } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";

type Lane = "host" | "standalone";

// `settleFn` is exactly the shape the Test262 rows use: declared with no
// initializer and no annotation, assigned only inside the executor, then
// reflected on at top level. It holds a function by the time the reads run.
//
// The `null` and `undefined` KEYWORD receivers are the proofs that must keep
// throwing: the borrowed method is called on them and the TypeError must
// surface, in both lanes.
const SOURCE = `
  export function test(): number {
    var settleFn;
    new Promise(function (resolve: any) {
      settleFn = resolve;
    });

    if (typeof settleFn !== "function") return 1;
    // The evolving \`var\` must be read dynamically, not folded to a throw.
    if (Object.prototype.hasOwnProperty.call(settleFn, "prototype") !== false) return 2;
    if (Object.prototype.hasOwnProperty.call(settleFn, "name") !== true) return 3;

    let threwOnNull = false;
    try {
      Object.prototype.hasOwnProperty.call(null, "x");
    } catch (e: any) {
      threwOnNull = e instanceof TypeError;
    }
    if (!threwOnNull) return 4;

    let threwOnUndefined = false;
    try {
      Object.prototype.hasOwnProperty.call(undefined, "x");
    } catch (e: any) {
      threwOnUndefined = e instanceof TypeError;
    }
    if (!threwOnUndefined) return 5;

    return 0;
  }
`;

async function runControl(lane: Lane): Promise<number> {
  try {
    const result = await compile(SOURCE, {
      fileName: "issue-5197-nullish-receiver-proof-control.ts",
      ...(lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {}),
    });
    expect(
      result.success,
      result.success ? "" : result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"),
    ).toBe(true);
    if (!result.success) return -1;
    if (lane === "standalone") {
      expect(result.imports?.length ?? 0, "standalone control must remain host-free").toBe(0);
    }
    const built = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      built.env,
      built.string_constants,
      built.string_constants16,
    );
    built.setInstance?.(instance);
    return (instance.exports as { test: () => number }).test();
  } finally {
    restoreHostBuiltins();
  }
}

describe("#5197 R3-10 — evolving `var` is not a nullish proof", () => {
  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: reflects on an evolving var while keeping the null/undefined proofs`, async () => {
      await expect(runControl(lane)).resolves.toBe(0);
    });
  }
});

// (#5197 round-3 review F1) The `.ts` control above is blind to the defect the
// review found: in a `.ts` file `var settleFn;` is a plain `any`, so the read
// takes the externref runtime path anyway. Under `allowJs` (the test262 shape)
// the checker NARROWS the same declaration to `undefined` at the use, and the
// lowering then fell into `compilePropertyIntrospection`'s struct-field fold — a
// constant `false` that never read the receiver. Two consequences this file
// now pins with JS input: a genuinely-undefined `var` must still throw the
// §20.1.3 TypeError (it did on base), and the executor-filled `var` must
// answer for an EXISTING own key (`length`/`name` → true), not only for the
// absent `prototype` whose correct answer coincides with the constant.
const JS_SOURCE = `
  export function test() {
    var resolveFunction;
    new Promise(function (resolve) { resolveFunction = resolve; });
    if (typeof resolveFunction !== "function") return 1;
    if (Object.prototype.hasOwnProperty.call(resolveFunction, "prototype") !== false) return 2;
    if (Object.prototype.hasOwnProperty.call(resolveFunction, "length") !== true) return 3;
    if (Object.prototype.hasOwnProperty.call(resolveFunction, "name") !== true) return 4;
    if (Object.prototype.propertyIsEnumerable.call(resolveFunction, "length") !== false) return 5;

    var u;
    var threw = false;
    try { Object.prototype.hasOwnProperty.call(u, "a"); } catch (e) { threw = e instanceof TypeError; }
    if (!threw) return 6;
    var pe;
    threw = false;
    try { Object.prototype.propertyIsEnumerable.call(pe, "a"); } catch (e) { threw = e instanceof TypeError; }
    if (!threw) return 7;

    var later;
    threw = false;
    try { Object.prototype.hasOwnProperty.call(later, "a"); } catch (e) { threw = e instanceof TypeError; }
    if (!threw) return 8;
    later = { a: 1 };
    if (Object.prototype.hasOwnProperty.call(later, "a") !== true) return 9;
    if (Object.prototype.hasOwnProperty.call(later, "b") !== false) return 10;
    return 0;
  }
`;

async function runJsControl(lane: Lane): Promise<number> {
  try {
    const result = await compile(JS_SOURCE, {
      fileName: "issue-5197-nullish-receiver-proof-control.js",
      ...(lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {}),
    });
    expect(
      result.success,
      result.success ? "" : result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"),
    ).toBe(true);
    if (!result.success) return -1;
    if (lane === "standalone") {
      expect(result.imports?.length ?? 0, "standalone control must remain host-free").toBe(0);
    }
    const built = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      built.env,
      built.string_constants,
      built.string_constants16,
    );
    built.setInstance?.(instance);
    return (instance.exports as { test: () => number }).test();
  } finally {
    restoreHostBuiltins();
  }
}

describe("#5197 round-3 F1 — the JS-input (narrowed) spelling reads the receiver", () => {
  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: existing own keys answer true, a nullish var throws, a later-filled var answers`, async () => {
      await expect(runJsControl(lane)).resolves.toBe(0);
    });
  }
});
