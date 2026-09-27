// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

/**
 * #6651 N1 — a module that imports its OWN namespace.
 *
 * Test262's `language/module-code/namespace/internals/*` family is written this
 * way (`import * as ns from './<own-file>.js'`), and before this change every
 * one of those rows failed on `ns` being null/undefined rather than on the
 * §10.4.6 behaviour it was written to test: `namespaceFunctionExports` declined
 * the WHOLE namespace object as soon as one export was a mutable `var`/`let` or
 * an `export default <expression>`.
 *
 * Measured on the base commit `3a891033` this test is RED, and not by one bit:
 * `ns` reads `undefined`, so `test()` never returns a score at all — it throws
 * a bare `WebAssembly.Exception` at the first property read. Every one of the
 * six bits below is therefore unreachable on base: object identity, live
 * binding, default export, null prototype, non-extensibility, and code-unit
 * key order.
 */
const SELF_IMPORT_MODULE = `
export var local1 = 23;
export let local2 = 45;
export default 444;

import * as ns from "./self.js";

export function test(): number {
  local1 = 99;
  const anyNs = ns as any;
  let score = 0;
  if (anyNs !== null && anyNs !== undefined) score += 1;
  // Live binding, not a snapshot: §16.2.1.6.4 reads the binding, and the
  // reassignment above happens after module initialization.
  if (anyNs.local1 === 99) score += 2;
  if (anyNs.default === 444) score += 4;
  // §10.4.6.1 [[GetPrototypeOf]] is always null.
  if (Object.getPrototypeOf(anyNs) === null) score += 8;
  // §10.4.6.4 [[IsExtensible]] is always false.
  if (Object.isExtensible(anyNs) === false) score += 16;
  // §10.4.6.7 sorts the export names in code-unit order.
  if (Object.getOwnPropertyNames(anyNs).join(",") === "default,local1,local2,test") score += 32;
  return score;
}
`;

describe("#6651 N1 module namespace: live bindings, null prototype, non-extensible", () => {
  it("materializes the self-imported namespace with every §10.4.6 property this slice covers", async () => {
    const result = await compileMulti({ "./self.js": SELF_IMPORT_MODULE }, "./self.js", {
      allowJs: true,
      skipSemanticDiagnostics: true,
      emitWat: false,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    (instance.exports.__module_init as (() => void) | undefined)?.();

    // 1 | 2 | 4 | 8 | 16 | 32
    expect((instance.exports.test as () => number)()).toBe(63);
  });
});
