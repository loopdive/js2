// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2917 — standalone `class X extends Array`: methods, `super` calls and
 * `length` on a real `$__vec_externref` subclass instance.
 *
 * Each row returns 1 when the behaviour matches the spec (Node answers 1 for
 * every row). Rows and the defect each one pins:
 *  - protoCall     `J.prototype.m.call(x)` was refused as a borrowed builtin
 *                  method, and the rolled-back refusal compiled to a default.
 *  - pushInh       `p.push(v)` on a subclass WITHOUT an own `push` dispatched
 *                  to a sibling subclass's `push` override.
 *  - inhSlice      inherited Array methods had no receiver lowering for an
 *                  externref-typed subclass instance.
 *  - superMeth(Any) `super.push(v)` inside an override did not reach the
 *                  Array method, and the any-typed dispatcher's vec arm
 *                  bypassed the own override.
 *  - lenSet(Any)   `p.length = 1` left the truncated elements readable.
 *  - ctorMulti     `super(a, b)` forwarded only the declared arity.
 *  - gopdLen       `Object.getOwnPropertyDescriptor(p, "length")` folded to
 *                  undefined (test262 `subclass/builtin-objects/Array/length.js`).
 */
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

const SOURCE = `
function id(v) { if (typeof v === "object") return v; return null; }
class J extends Array {
  constructor(n) { super(n); }
  m() { return 42; }
  push(v) { return super.push(v) + 100; }
}
class P extends Array { }
class Two extends Array { constructor(a, b) { super(a, b); } }
class Plain { m() { return 3; } }
function filled() { const j = new P(3); j[0] = 1; j[1] = 2; j[2] = 3; return j; }
export function protoCall()    { const x = id(new J(1)); return J.prototype.m.call(x) === 42 ? 1 : 0; }
export function pushInh()      { const j = new P(0); j.push(4); return j.length === 1 && j[0] === 4 ? 1 : 0; }
export function inhSlice()     { const r = filled().slice(1); return r.length === 2 && r[0] === 2 ? 1 : 0; }
export function inhReverse()   { const r = filled().reverse(); return r[0] === 3 && r[2] === 1 ? 1 : 0; }
export function superMeth()    { const j = new J(0); return j.push(1) === 101 && j.length === 1 ? 1 : 0; }
export function superMethAny() { const x = id(new J(0)); return x.push(1) === 101 && x.length === 1 ? 1 : 0; }
export function lenSet()       { const j = filled(); j.length = 1; return j.length === 1 && j[1] === undefined ? 1 : 0; }
export function lenSetAny()    { const x = id(filled()); x.length = 1; return x.length === 1 && x[1] === undefined ? 1 : 0; }
export function ctorMulti()    { const t = new Two(42, "foo"); return t.length === 2 && t[0] === 42 && t[1] === "foo" ? 1 : 0; }
export function gopdLen()      { const d = Object.getOwnPropertyDescriptor(new P(1, 2), "length"); return d !== undefined && d.writable === true ? 1 : 0; }
export function ctrlPlainCall(){ return Plain.prototype.m.call(new Plain()) === 3 ? 1 : 0; }
export function ctrlPlainLen() { const a = [1, 2, 3]; a.length = 1; return a.length === 1 && a[1] === undefined ? 1 : 0; }
export function ctrlPlainPush(){ const a = [1]; a.push(2); return a.length === 2 && a[1] === 2 ? 1 : 0; }
`;

const ROWS = [...SOURCE.matchAll(/export function (\w+)/g)].map((m) => m[1]!);

describe("#2917 — standalone Array subclass methods, super calls and length", () => {
  it("answers every row like the spec", { timeout: 120_000 }, async () => {
    const result = (await compileMulti({ "/main.js": SOURCE }, "/main.js", {
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
    const answers: Record<string, number | string> = {};
    for (const name of ROWS) {
      try {
        answers[name] = exports[name]!();
      } catch (e) {
        answers[name] = e instanceof WebAssembly.Exception ? "THROW" : `TRAP ${(e as Error).message}`;
      }
    }
    expect(answers).toEqual(Object.fromEntries(ROWS.map((name) => [name, 1])));
  });
});
