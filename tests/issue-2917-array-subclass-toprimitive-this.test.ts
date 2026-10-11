// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2917 — implicit/zero-argument ToString of a standalone `class J extends
 * Array` instance must run the class's own `toString`, with `this` bound,
 * when the module is compiled through `compileMulti`.
 *
 * The instance is a `$__vec_externref`; its methods live in the #3537 vec
 * expando bag, and `__vec_own_to_primitive` invokes the found method through
 * `__call_accessor_get`. On the MULTI-source finalize path that driver was
 * filled BEFORE `__closure_arity` was registered, so it degraded to a bare
 * `__call_fn_method_0` — which contains no closure with a declared formal. A
 * method like JSBI's `toString(i = 10)` (declared arity 1) then answered
 * `null`, stringified as "null". Single-source `compile` emitted the classifier
 * first and was unaffected.
 */
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

const LIB = `
class J extends Array {
  constructor(n, sign) { super(n); this.sign = sign; }
  toString(i = 10) { return (this.sign ? "-" : "") + "J" + this.length + ":" + i; }
  static make(n, sign) { return new J(n, sign); }
  static any(n) { if (typeof n === "number") return J.make(n, false); return null; }
}
export default J;
`;

const MAIN = `
import J from "./lib.js";
export function noArg() { return J.any(3).toString() === "J3:10" ? 1 : 0; }
export function withArg() { return J.any(3).toString(16) === "J3:16" ? 1 : 0; }
export function template() { const x = J.any(2); return \`\${x}\` === "J2:10" ? 1 : 0; }
export function stringCall() { return String(J.any(4)) === "J4:10" ? 1 : 0; }
export function thisField() { return J.make(1, true).toString() === "-J1:10" ? 1 : 0; }
`;

describe("#2917 — Array-subclass ToString binds this (standalone, compileMulti)", () => {
  it("runs the own toString(i = 10) with the receiver bound", { timeout: 120_000 }, async () => {
    const result = (await compileMulti({ "/lib.js": LIB, "/main.js": MAIN }, "/main.js", {
      target: "standalone",
      hostBridge: "off",
      allowJs: true,
      skipSemanticDiagnostics: true,
    } as never)) as unknown as { success: boolean; errors: { message: string }[]; binary: Uint8Array };
    expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);

    const module = new WebAssembly.Module(result.binary);
    const imports: Record<string, Record<string, () => null>> = {};
    for (const imported of WebAssembly.Module.imports(module)) {
      (imports[imported.module] ??= {})[imported.name] = () => null;
    }
    const exports = (await WebAssembly.instantiate(module, imports)).exports as Record<string, () => number>;
    const answers: Record<string, number> = {};
    for (const name of ["noArg", "withArg", "template", "stringCall", "thisField"]) {
      answers[name] = exports[name]!();
    }
    expect(answers).toEqual({ noArg: 1, withArg: 1, template: 1, stringCall: 1, thisField: 1 });
  });
});
