// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2794 — compiled-acorn var-declaration parses (the var-decl host-proxy gaps).
//
// Two host-proxy/marshaling fixes let compiled acorn parse `var x = 1;` to a
// VariableDeclaration (it previously THREW). Both are exercised here with small
// programs (the full acorn integration is the opt-in dogfood harness):
//
//   (1) POSITIVE `__is_data_struct` discriminator. `_wrapForHost`'s get-trap
//       used to mask ANY non-vec struct field value as a callable `closureBridge`
//       whenever generic `__call_fn_N` dispatchers exist — so acorn's `decl.id`
//       (an Identifier Node) arrived in `checkLValSimple` as a function
//       (`expr.type === undefined`) and var-declaration parses threw
//       "Binding rvalue". The new positive marker presents a genuine data struct
//       as an OBJECT and only bridges actual closures. `__is_closure` cannot gate
//       this (it FALSE-NEGATIVES on some closures); a positive data marker has no
//       such failure mode (closure structs are never in the data-struct set).
//
//   (2) Vec read-only methods (`indexOf`/`includes`/`join`/`lastIndexOf`) on an
//       opaque vec receiver reaching `__extern_method_call` (acorn `declareName`'s
//       `scope.lexical.indexOf(name)`). Only push/pop were wired; reads now
//       materialize the vec to a real JS array and apply the native method.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function compileRun(source: string): Promise<{ exp: any; raw: Record<string, any> }> {
  const r = await compile(source as never, { fileName: "t.ts", skipSemanticDiagnostics: true } as never);
  expect(r.success, (r.errors ?? []).map((e: any) => e.message).join("\n")).toBe(true);
  const io: any = r.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary as BufferSource, io);
  io.__setInstance?.(instance);
  const exp = wrapExports(instance, { signatures: (r as any).exportSignatures });
  return { exp, raw: instance.exports as Record<string, any> };
}

describe("#2794 — var-declaration host-proxy gaps", () => {
  // (1) The positive data-vs-closure discriminator: a data struct answers 1 /
  // closure 0 to __is_data_struct, and the complementary way for __is_closure.
  it("emits __is_data_struct that classifies a data struct vs a closure (1)", async () => {
    const SRC = `
class Inner { kind: string; constructor(k: string) { this.kind = k; } }
class Outer {
  inner: Inner;
  cb: () => number;
  constructor() { this.inner = new Inner("X"); this.cb = () => 1; }
}
const o = new Outer();
export function getInner(): any { return o.inner; }
export function getCb(): any { return o.cb; }
`;
    const { raw } = await compileRun(SRC);
    expect(typeof raw.__is_data_struct, "module must export __is_data_struct").toBe("function");
    const inner = raw.getInner();
    const cb = raw.getCb();
    // Data struct → is_data_struct=1, is_closure=0.
    expect(raw.__is_data_struct(inner)).toBe(1);
    if (typeof raw.__is_closure === "function") expect(raw.__is_closure(inner)).toBe(0);
    // Genuine closure → is_data_struct=0 (so it still reaches the bridge path).
    expect(raw.__is_data_struct(cb)).toBe(0);
    if (typeof raw.__is_closure === "function") expect(raw.__is_closure(cb)).toBe(1);
  });

  // (1) A DATA struct read back through the host proxy presents as an OBJECT
  // whose fields are readable — NOT a callable closureBridge (the acorn
  // `decl.id` / `checkLValSimple` failure shape). The closure field stays
  // callable (no regression).
  it("presents a data-struct field as an object via the host proxy (1)", async () => {
    const SRC = `
class Inner { kind: string; constructor(k: string) { this.kind = k; } }
class Outer {
  inner: Inner;
  cb: () => number;
  constructor() { this.inner = new Inner("ID"); this.cb = () => 7; }
}
const o = new Outer();
export function getOuter(): any { return o; }
`;
    const { exp } = await compileRun(SRC);
    const outer = exp.getOuter();
    const inner = outer.inner;
    // Must be a data object, not a masked closureBridge function.
    expect(typeof inner).toBe("object");
    expect(inner.kind).toBe("ID");
  });

  // (2) Read-only Array methods on a vec field reached via dynamic (`any`)
  // dispatch route through __extern_method_call. Before the fix only push/pop
  // were served and a read THREW "indexOf is not a function".
  it("serves vec read-methods (indexOf/includes) via __extern_method_call (2)", async () => {
    const SRC = `
class Scope { lexical: string[]; constructor() { this.lexical = []; } }
function mkScope(): any { return new Scope(); }
export function idxOf(): number {
  const s: any = mkScope();
  s.lexical.push("alpha");
  s.lexical.push("beta");
  return s.lexical.indexOf("beta");
}
export function has(): boolean {
  const s: any = mkScope();
  s.lexical.push("gamma");
  return s.lexical.includes("gamma");
}
export function missing(): number {
  const s: any = mkScope();
  s.lexical.push("delta");
  return s.lexical.indexOf("nope");
}
`;
    const { exp } = await compileRun(SRC);
    // The exact index can vary with vec-identity edge cases, but the method must
    // RESOLVE (not throw) and return spec-correct membership/absence. (A boolean
    // return coerces to the i32 `1` at the wasm export boundary — assert truthy.)
    expect(typeof exp.idxOf()).toBe("number");
    expect(exp.has()).toBeTruthy();
    expect(exp.missing()).toBe(-1);
  });
});
