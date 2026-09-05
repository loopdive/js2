// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5223 — a dynamic property READ of a compiled class's ACCESSOR answered
// `undefined`, while a method CALL on the same receiver answered correctly.
//
// ROOT CAUSE (measured, not inferred). The host-side member surface
// (`__member_kind_<key>` + `__call_get_<key>`, #3123) is emitted only for keys
// some site registered in `ctx.hostDynamicClassMethodNames`. Every writer of
// that set is a CALL site (`expressions/calls.ts`, `call-receiver-method.ts`),
// a WRITE site (`assignment.ts::compilePropertyAssignmentExternSet`), or a
// class-VALUE crossing (`extern.ts::emitLazyClassObjectGet`). A bare READ
// registered nothing, so `function f(a: any) { return a.y; }` produced a module
// with NO getter bridge at all and the host resolver fell through to
// `undefined`. #5204 had already noticed this hole and closed it only for
// EXTERNREF-BACKED classes (`class D extends Array`), whose members are bridged
// unconditionally; an ordinary WasmGC-struct class stayed on the demand-driven
// path and kept the gap.
//
// WHY THE OBVIOUS REPRO DOES NOT REPRODUCE. `const a: any = new P(3); a.y`
// works on base — the initializer is statically visible, so the read resolves
// to a direct getter call and never reaches the host. The defect needs the
// instance to arrive through a receiver the compiler cannot narrow: a
// parameter, or an `Object.create(P.prototype)` result. That asymmetry is
// pinned below as a control.
//
// SCOPE. Host lane only (`!standalone && !wasi`): standalone installs class
// accessors as real `$Object` accessor properties on the prototype singleton
// (#4455), which is a different mechanism with no demand gate.
//
// NOT FIXED HERE, measured and reported rather than hidden:
//   * `Object.getOwnPropertyDescriptor(P.prototype, "y")` still answers
//     `undefined` in the host lane — the reflective descriptor surface for
//     class accessors is separate from the dispatch surface. Pinned below so a
//     future fix has a base reading.
//   * `Temporal.PlainDate.from(...)` results still answer `undefined` for
//     getters THROUGH A LINKED PROVIDER. That is a different defect: the host
//     boundary resolves compiled class members against the CALLING module's
//     exports, and a consumer that does not itself declare `year` has no
//     `__member_kind_year` to call. See the PR body for the measurement.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

async function runHost(source: string): Promise<unknown> {
  const exports = await compileToWasm(source);
  return exports.test!();
}

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone", fileName: "issue-5223.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

const DECL = `class P {
  v: number;
  constructor(v: number) { this.v = v; }
  get y(): number { return this.v + 1; }
  toString(): string { return "x" + this.v; }
  other(): string { return "o" + this.v; }
}`;

describe("#5223 dynamic read of a compiled class accessor", () => {
  it("reads the getter through an any-typed PARAMETER (the reduced repro — undefined on base)", async () => {
    await expect(
      runHost(`${DECL}
function f(a: any): any { return a.y; }
export function test(): any { const p = new P(3); return f(p); }`),
    ).resolves.toBe(4);
  });

  it("reads the getter through a bracket key on the same receiver (undefined on base)", async () => {
    await expect(
      runHost(`${DECL}
function f(a: any): any { return a["y"]; }
export function test(): any { return f(new P(3)); }`),
    ).resolves.toBe(4);
  });

  it("reads the getter off an Object.create(P.prototype) object (undefined on base)", async () => {
    await expect(
      runHost(`${DECL}
function f(a: any): any { return a.y; }
export function test(): any { const d: any = Object.create(P.prototype); d.v = 3; return f(d); }`),
    ).resolves.toBe(4);
  });

  it("keeps the getter answering when the SAME name is also called as a method elsewhere", async () => {
    // The read registration must not disturb the method-bridge admission that
    // `hostDynamicClassMethodNames` drives — the two sets stay separate.
    await expect(
      runHost(`class Q {
  v: number;
  constructor(v: number) { this.v = v; }
  get y(): number { return this.v + 1; }
  m(n: number): number { return this.v + n; }
}
function read(a: any): any { return a.y; }
function call(a: any): any { return a.m(10); }
export function test(): any { const q = new Q(3); return read(q) + call(q); }`),
    ).resolves.toBe(17);
  });

  it("control: a method call through the same dynamic receiver already worked on base", async () => {
    await expect(
      runHost(`${DECL}
function f(a: any): any { return a.other(); }
export function test(): any { return f(new P(3)); }`),
    ).resolves.toBe("o3");
  });

  it("control: a statically visible initializer resolved the getter on base", async () => {
    await expect(
      runHost(`${DECL}
export function test(): any { const a: any = new P(3); return a.y; }`),
    ).resolves.toBe(4);
  });

  it("control: prototype toString dispatch through String()/template/concat was already correct", async () => {
    const shapes = [
      `function f(a: any): any { return String(a); }`,
      `function f(a: any): any { return \`\${a}\`; }`,
      `function f(a: any): any { return "" + a; }`,
      `function f(a: any): any { return a.toString(); }`,
    ];
    for (const shape of shapes) {
      await expect(
        runHost(`${DECL}
${shape}
export function test(): any { return f(new P(3)); }`),
      ).resolves.toBe("x3");
    }
  });

  it("standalone is untouched — the accessor answers through the $Object prototype (#4455)", async () => {
    await expect(
      runStandalone(`${DECL}
function f(a: any): any { return a.y; }
export function test(): any { const p = new P(3); return f(p); }`),
    ).resolves.toBe(4);
  });

  it("REPORTED, NOT FIXED: the class accessor has no own descriptor on P.prototype (host lane)", async () => {
    // Base reading, kept so a future descriptor fix has something to flip.
    await expect(
      runHost(`${DECL}
export function test(): any {
  const d: any = Object.getOwnPropertyDescriptor(P.prototype, "y");
  return d === undefined ? "none" : typeof d.get;
}`),
      // A descriptor object comes back, but with no `get` slot — the accessor's
      // §15.7.14 `{get, set, enumerable:false, configurable:true}` shape is not
      // synthesized in the host lane. Standalone gets it right via #4455.
    ).resolves.toBe("undefined");
  });
});
