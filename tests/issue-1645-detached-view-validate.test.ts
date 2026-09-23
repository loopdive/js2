// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1645 S1 — `%TypedArray%.prototype.buffer` identity, and the §23.2.4.4
// ValidateTypedArray step-5 detached-buffer throw on a DYNAMIC view.
//
// Two halves, and the split matters because the issue's own plan had them the
// wrong way round (measured on 68bcd9eb4d; see the S1 correction in
// `plan/issues/1645-…md`):
//
//  1. `.buffer` identity was ALREADY correct on every path that has a buffer —
//     all seven element types constructed over an ArrayBuffer, the DataView
//     half of the #2596 arm (#3173), and the dynamic-MOP route. The plan's
//     table reported `0` for those because its probe wrote `(t as any).buffer`,
//     and the `as any` erases the receiver type, which is exactly what
//     `taViewReceiverTypeIdx` (property-access.ts) discriminates on: it takes
//     only an IDENTIFIER whose local/global slot type is a `$__ta_view`. With
//     the cast the read falls past `emitTaViewAccessor` to the #2596
//     synthesize-a-fresh-zero-filled-vec floor. Pinned here so the working
//     mechanism cannot silently rot behind an `as any`-shaped probe again.
//
//  2. What was actually broken is the THROW. A `$__ta_dyn_view` IS a
//     `$__vec_base` subtype, so every `%TypedArray%.prototype` method with no
//     native `__ta_dyn_<m>` helper (`some`, `every`, `forEach`, `sort`, `keys`,
//     `values`, `entries`, `find`, `findIndex`, …) was claimed by the generic
//     vec arm of its `__call_m_<name>_<arity>` dispatcher, which reads the
//     view's post-detach length of 0, iterates zero times and RETURNS — where
//     §23.2.4.4 step 5 requires a TypeError. That is the literal
//     "Expected a TypeError to be thrown but no exception was thrown at all"
//     on 24 of the 33 ES2015 detached rows.
//
// The guard is `ctx.standalone`-gated and fires only when the shared backing
// vec's length is the `-1` detach marker, so the js-host/gc lane is untouched —
// asserted below rather than assumed.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Probes = Record<string, number>;

async function runStandalone(src: string): Promise<Probes> {
  const r = await compile(src, { target: "standalone" } as never);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  // A host import on the standalone lane is an automatic fail — the whole point
  // of the arms under test is that they answer without one.
  expect(r.imports ?? [], "standalone module must import nothing").toStrictEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const out: Probes = {};
  for (const [name, value] of Object.entries(instance.exports)) {
    if (name.startsWith("probe_")) out[name] = (value as () => number)();
  }
  return out;
}

async function runGc(src: string): Promise<Probes> {
  const r = await compile(src, {} as never);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(
    r.binary,
    buildImports(r.imports, undefined, r.stringPool) as never,
  );
  const out: Probes = {};
  for (const [name, value] of Object.entries(instance.exports)) {
    if (name.startsWith("probe_")) out[name] = (value as () => number)();
  }
  return out;
}

// `new <TA>(buffer)` builds a shared-backing `$__ta_view_<name>` whose field 1
// IS the buffer's `$__vec_i32_byte` struct, so `.buffer` is a `struct.get`, not
// a synthesized copy. The receiver stays an unannotated identifier on purpose.
const IDENTITY_SRC = `
export function probe_u8(): number { const b = new ArrayBuffer(8); const t = new Uint8Array(b); return (t.buffer === b) ? 1 : 0; }
export function probe_i8(): number { const b = new ArrayBuffer(8); const t = new Int8Array(b); return (t.buffer === b) ? 1 : 0; }
export function probe_u16(): number { const b = new ArrayBuffer(8); const t = new Uint16Array(b); return (t.buffer === b) ? 1 : 0; }
export function probe_i32(): number { const b = new ArrayBuffer(8); const t = new Int32Array(b); return (t.buffer === b) ? 1 : 0; }
export function probe_f32(): number { const b = new ArrayBuffer(8); const t = new Float32Array(b); return (t.buffer === b) ? 1 : 0; }
export function probe_f64(): number { const b = new ArrayBuffer(8); const t = new Float64Array(b); return (t.buffer === b) ? 1 : 0; }
export function probe_u8c(): number { const b = new ArrayBuffer(8); const t = new Uint8ClampedArray(b); return (t.buffer === b) ? 1 : 0; }
export function probe_dv(): number { const b = new ArrayBuffer(8); const d = new DataView(b); return (d.buffer === b) ? 1 : 0; }
export function probe_byteLength64(): number { const b = new ArrayBuffer(64); const t = new Float64Array(b); return t.buffer.byteLength; }
export function probe_aliasWriteThrough(): number { const b = new ArrayBuffer(8); const t = new Float64Array(b); t[0] = 2; return new DataView(b).getUint8(7); }
`;

// The test262 detached-buffer shape: a dynamically constructed view (`TA` is a
// parameter, so the carrier is `$__ta_dyn_view`), detached through the buffer
// the `.buffer` getter handed back, then a §23.2.3 method call.
// 1 = threw a TypeError, 2 = threw something else, 0 = returned normally.
//
// The constructor MUST arrive as a function PARAMETER, exactly as
// `testWithTypedArrayConstructors(function (TA, makeCtorArg) { … })` delivers
// it: that is what makes the carrier a `$__ta_dyn_view`. Writing
// `new (Float64Array as any)(1)` instead keeps the construction static, builds
// a plain `$__vec_f64`, and the program stops exercising this code path at all
// — a vacuous green. Do not "simplify" it.
const DETACH_METHODS: readonly (readonly [string, string])[] = [
  ["some", "sample.some(function () { return true; });"],
  ["every", "sample.every(function () { return true; });"],
  ["forEach", "sample.forEach(function () {});"],
  ["sort", "sample.sort();"],
  ["keys", "sample.keys();"],
  ["values", "sample.values();"],
  ["entries", "sample.entries();"],
  ["find", "sample.find(function () { return true; });"],
  ["findIndex", "sample.findIndex(function () { return true; });"],
];

function detachSrc(ctorExpr: string): string {
  const arms = DETACH_METHODS.map(([, expr], i) => `  ${i === 0 ? "if" : "else if"} (which === ${i}) { ${expr} }`).join(
    "\n",
  );
  const exports = DETACH_METHODS.map(
    ([name], i) => `export function probe_${name}(): number { return detachThenCall(${ctorExpr}, ${i}); }`,
  ).join("\n");
  return `
function detachThenCall(TA: any, which: number): number {
  const sample: any = new TA(1);
  const b: any = sample.buffer;
  b.__detached__ = true;
  try {
${arms}
    return 0;
  } catch (e) { return (e instanceof TypeError) ? 1 : 2; }
}
${exports}
`;
}

// §7.3.2 — an own member installed on the view still shadows the prototype
// method, detached or not. The guard declines on any view carrying an expando,
// so a shadowed call can never be preempted by the throw.
const SHADOW_SRC = `
function ownShadow(TA: any): number {
  const sample: any = new TA(1);
  const b: any = sample.buffer;
  b.__detached__ = true;
  sample.some = function (): number { return 42; };
  try { return sample.some(); } catch (e) { return -1; }
}
function liveView(TA: any): number {
  const sample: any = new TA(3);
  try { return sample.some(function () { return true; }) ? 1 : 0; } catch (e) { return -1; }
}
export function probe_ownShadowWins(): number { return ownShadow(Float64Array); }
export function probe_liveViewStillWorks(): number { return liveView(Float64Array); }
`;

describe("#1645 S1 — TypedArray .buffer identity and the detached-view TypeError", () => {
  it("hands back the VIEWED buffer — reference identity, for every element type", async () => {
    const p = await runStandalone(IDENTITY_SRC);
    expect({
      u8: p.probe_u8,
      i8: p.probe_i8,
      u16: p.probe_u16,
      i32: p.probe_i32,
      f32: p.probe_f32,
      f64: p.probe_f64,
      u8c: p.probe_u8c,
      dataView: p.probe_dv,
    }).toStrictEqual({ u8: 1, i8: 1, u16: 1, i32: 1, f32: 1, f64: 1, u8c: 1, dataView: 1 });
  });

  it("reports the viewed buffer's real byteLength, and the backing is shared, not copied", async () => {
    const p = await runStandalone(IDENTITY_SRC);
    expect(p.probe_byteLength64, "new Float64Array(new ArrayBuffer(64)).buffer.byteLength").toBe(64);
    // little-endian f64 `2` is 00 00 00 00 00 00 00 40 — byte 7 is 0x40.
    expect(p.probe_aliasWriteThrough, "a write through the view is visible on the buffer").toBe(0x40);
  });

  it("§23.2.4.4 step 5 — every validating method throws TypeError on a detached dynamic view", async () => {
    for (const ctor of ["Float64Array", "Uint8Array", "Int32Array"]) {
      const p = await runStandalone(detachSrc(ctor));
      const verdicts = Object.fromEntries(Object.entries(p).map(([k, v]) => [k.replace("probe_", ""), v]));
      expect(verdicts, `${ctor}: 1 = TypeError, 2 = wrong error, 0 = no throw`).toStrictEqual({
        some: 1,
        every: 1,
        forEach: 1,
        sort: 1,
        keys: 1,
        values: 1,
        entries: 1,
        find: 1,
        findIndex: 1,
      });
    }
  });

  it("keeps §7.3.2 own-member shadowing, and leaves a LIVE view alone", async () => {
    const p = await runStandalone(SHADOW_SRC);
    expect(p.probe_ownShadowWins, "an own `some` still wins over the prototype method").toBe(42);
    expect(p.probe_liveViewStillWorks, "an attached view is unaffected").toBe(1);
  });

  it("does not move the js-host/gc lane — the guard is standalone-gated", async () => {
    const p = await runGc(detachSrc("Float64Array"));
    // The host lane routes `.buffer` and the proto methods through host imports,
    // which have never observed the `__detached__` sidecar on this shape. The
    // value asserted is what main produced before this change; the point is that
    // it did not MOVE, not that 0 is spec-correct there.
    expect(
      Object.values(p).every((v) => v === 0),
      "gc-lane verdicts must be unchanged (all 0)",
    ).toBe(true);
  });
});
