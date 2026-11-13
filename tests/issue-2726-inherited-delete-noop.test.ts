// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2726 group (g) — `delete o.p` where `p` is NOT an own property of `o` is a
// spec-mandated true no-op.
//
// §10.5.7 OrdinaryDelete step 2: `Let desc be O.[[GetOwnProperty]](P); if desc
// is undefined, return true.` — deleting a property the receiver does not own
// (it lives only on the prototype chain) must return `true` and mutate nothing.
//
// Previously `__delete_property` unconditionally recorded a tombstone on the
// receiver even when the key was inherited, so the next prototype-chain read of
// that key returned `undefined` instead of the still-present inherited value
// (test262 language/expressions/delete/S8.12.7_A2_T2.js CHECK#3 failed; this
// fix flips it fail→pass, +1 conformance, 0 delete-dir regressions).
//
// The body is declared LOCAL to `test()` and compiled with
// `skipSemanticDiagnostics: true` to mirror the test262 runner's `wrapTest`
// envelope (the production conformance path).

async function run(source: string): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>).test();
}

describe("#2726 (g) delete of an inherited (non-own) property is a true no-op", () => {
  // Mirrors test262 S8.12.7_A2_T2: delete an inherited property, then the
  // prototype-chain read must still see it (the delete must NOT tombstone the
  // instance for a key it does not own).
  const src = `export function test() {
    function Palette() {}
    Palette.prototype = { red: 0xff0000, green: 0x00ff00 };
    var p = new Palette();
    if (p.red !== 0xff0000) return 10;        // CHECK#1: inherited read
    if ((delete p.red) !== true) return 11;   // CHECK#2: delete non-own -> true
    if (p.red !== 0xff0000) return 12;         // CHECK#3: still inherited (no tombstone)
    return 1;
  }`;

  it("delete of an inherited property returns true and does not shadow it (host)", async () => {
    expect(await run(src)).toBe(1);
  });
});
