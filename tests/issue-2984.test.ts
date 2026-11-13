// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2984 — boolean-typed DYNAMIC property reads must not narrow through the
// numeric unbox pipeline.
//
// Defect: a property access whose TS type is boolean-like (the lib shape
// `PropertyDescriptor.writable?: boolean` → `boolean | undefined`) and whose
// receiver resolves through the dynamic fallback (`__extern_get` host-MOP read)
// was narrowed to i32 via `__unbox_number` + `i32.trunc_sat_f64_s`. That
// pipeline is a ToNumber, not a boolean read: the standalone native
// `__unbox_number` yields NaN for a boxed boolean (→ i32 0), and an any-context
// consumer then RE-boxed the 0 as a NUMBER. Net effect:
//   assert.sameValue(Object.getOwnPropertyDescriptor(o, k).writable, true)
// failed for EVERY descriptor-attribute assertion in the standalone test262
// gOPD cluster (41 flips in built-ins/Object/getOwnPropertyDescriptor* alone,
// +32 in built-ins/Object/defineProperty). The host lane only "passed" the
// harness shape by a double coincidence (host ToNumber(true)=1, then a numeric
// compare) and still failed the local-bound shape (`var w = desc.writable;
// typeof w` was "undefined" on BOTH lanes).
//
// Fix: in `compilePropertyAccess`'s dynamic-fallback region, a boolean-like
// access type keeps the raw externref (preserving both the boolean box and
// `undefined` for an absent attribute) instead of narrowing to i32.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

async function runHost(body: string): Promise<number> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { skipSemanticDiagnostics: true });
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
  (imports as { setInstance?: (e: WebAssembly.Instance) => void }).setInstance?.(instance);
  return (instance.exports as { test(): number }).test();
}

// The test262 harness shape: descriptor attributes flow as `any`-typed
// function arguments into assert.sameValue-style strict comparisons.
const HARNESS_SHAPE_PLAIN = `
  var hits = 0;
  var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
  var desc = Object.getOwnPropertyDescriptor({ x: 5 }, "x");
  check(desc.writable, true);
  check(desc.enumerable, true);
  check(desc.configurable, true);
  check(desc.value, 5);
  return hits;
`;

const HARNESS_SHAPE_BUILTIN_PROTO = `
  var hits = 0;
  var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
  var desc = Object.getOwnPropertyDescriptor(Array.prototype, "concat");
  check(desc.writable, true);
  check(desc.enumerable, false);
  check(desc.configurable, true);
  return hits;
`;

// Local-bound shape: reading the attribute into an untyped local must keep the
// boolean (typeof was "undefined" on BOTH lanes before the fix).
const LOCAL_BOUND_TYPEOF = `
  var desc = Object.getOwnPropertyDescriptor({ x: 5 }, "x");
  var w = desc.writable;
  if (typeof w === "boolean") return 1;
  if (typeof w === "undefined") return 2;
  return 3;
`;

// Absent attribute: an accessor descriptor has NO writable key — the read must
// surface `undefined` (the old i32 narrowing erased it to `false`).
const ABSENT_ATTR_UNDEFINED = `
  var obj = { get x() { return 1; } };
  var desc = Object.getOwnPropertyDescriptor(obj, "x");
  var w = desc.writable;
  if (typeof w === "undefined") return 1;
  return 0;
`;

describe("#2984 — boolean-typed dynamic property reads (descriptor attributes)", () => {
  it("standalone: harness-shape attribute asserts on a plain-object descriptor", async () => {
    expect(await runStandalone(HARNESS_SHAPE_PLAIN)).toBe(4);
  });

  it("host: harness-shape attribute asserts on a plain-object descriptor", async () => {
    expect(await runHost(HARNESS_SHAPE_PLAIN)).toBe(4);
  });

  it("standalone: harness-shape attribute asserts on a builtin-proto descriptor", async () => {
    expect(await runStandalone(HARNESS_SHAPE_BUILTIN_PROTO)).toBe(3);
  });

  it("standalone: local-bound attribute read keeps typeof boolean", async () => {
    expect(await runStandalone(LOCAL_BOUND_TYPEOF)).toBe(1);
  });

  it("host: local-bound attribute read keeps typeof boolean", async () => {
    expect(await runHost(LOCAL_BOUND_TYPEOF)).toBe(1);
  });

  it("standalone: absent attribute (accessor descriptor .writable) stays undefined", async () => {
    expect(await runStandalone(ABSENT_ATTR_UNDEFINED)).toBe(1);
  });
});

// (#2984) gOPD(this, "NaN"|"Infinity"|"undefined") — the sloppy-mode global
// receiver folds to the spec §19.1.1–19.1.3 all-false value descriptor when
// `this` is nullish at runtime; a REAL receiver keeps the dynamic read.
// Pre-fix these were phantom passes riding the undefined→ToNumber coincidence
// the boolean-read fix retired (the merge_group park on PR #2845).
const GLOBAL_NAN_DESCRIPTOR = `
  var hits = 0;
  var check = function (a: any, b: any): void { if (a === b) { hits = hits + 1; } };
  var desc = Object.getOwnPropertyDescriptor(this, "NaN");
  check(desc.writable, false);
  check(desc.enumerable, false);
  check(desc.configurable, false);
  return hits;
`;

// A host-dispatched object-literal method receives a REAL `this` (installed
// via __current_this) — the runtime guard must take the dynamic else-arm and
// find the receiver's OWN "NaN" prop, not the global fold.
const REAL_RECEIVER_KEEPS_DYNAMIC = `
  var o: any = {
    NaN: 42,
    m: function () {
      var d = Object.getOwnPropertyDescriptor(this, "NaN");
      if (d === undefined) return -1;
      return d.value === 42 ? 1 : 0;
    }
  };
  return o.m();
`;

describe("#2984 — gOPD(this, <global value prop>) fold", () => {
  it("standalone: gOPD(this, 'NaN') yields the all-false spec descriptor", async () => {
    expect(await runStandalone(GLOBAL_NAN_DESCRIPTOR)).toBe(3);
  });

  it("host: gOPD(this, 'NaN') yields the all-false spec descriptor", async () => {
    expect(await runHost(GLOBAL_NAN_DESCRIPTOR)).toBe(3);
  });

  it("host: a real receiver with an own 'NaN' prop keeps the dynamic read", async () => {
    expect(await runHost(REAL_RECEIVER_KEEPS_DYNAMIC)).toBe(1);
  });
});

// ─── Phase 2 (#2984): un-reified proto receivers ────────────────────────────
//
// Pre-phase-2, gOPD on Date/Object/Number/Boolean/Function/Error prototypes
// (and String members outside the #2875 wired slice) returned `undefined`:
// their glue's `emitMemberBody` REFUSES (returns null), which aborted
// `ensureStandaloneNativeMethodClosure`, so the #2885 Site-2 synthesis fell
// through to the dynamic fallback. The `refusalBodyFallback` opt-in mints an
// identity-stable throwing closure instead (the #2193/#2651 degrade-to-
// catchable pattern), shared by the gOPD synthesis AND the plain value read,
// so the ES5 identity assertion (`desc.value === Date.prototype.getTime`)
// holds. The reflective `.call` route deliberately does NOT opt in — the
// hasOwnProperty.call fall-through guard below pins that.

const ES5_FULL_SHAPE_DATE = `
  var desc = Object.getOwnPropertyDescriptor(Date.prototype, "getTime");
  if (desc === undefined) return -1;
  if (desc.value !== Date.prototype.getTime) return -2;
  if (desc.writable !== true) return -3;
  if (desc.enumerable !== false) return -4;
  if (desc.configurable !== true) return -5;
  if (typeof desc.value !== "function") return -6;
  return 1;
`;

const ES5_FULL_SHAPE_OBJECT_PROTO = `
  var desc = Object.getOwnPropertyDescriptor(Object.prototype, "hasOwnProperty");
  if (desc === undefined) return -1;
  if (desc.value !== Object.prototype.hasOwnProperty) return -2;
  if (desc.writable !== true) return -3;
  return 1;
`;

const STRING_NON_WIRED_MEMBER = `
  var desc = Object.getOwnPropertyDescriptor(String.prototype, "slice");
  if (desc === undefined) return -1;
  if (desc.value !== String.prototype.slice) return -2;
  if (desc.writable !== true) return -3;
  return 1;
`;

const UNKNOWN_MEMBER_UNDEFINED = `
  var desc = Object.getOwnPropertyDescriptor(Date.prototype, "notARealMethod");
  return desc === undefined ? 1 : -1;
`;

const REFUSAL_CLOSURE_META = `
  var f = Date.prototype.getTime;
  if (typeof f !== "function") return -1;
  if (f.name !== "getTime") return -2;
  if (f.length !== 0) return -3;
  return 1;
`;

// GUARD: the reflective-call route must keep its working fall-through — the
// factory's refusal fallback is opt-in precisely so this harness idiom
// (`propertyHelper.js` uses it on every verifyProperty) never routes into a
// throwing refusal body.
const HAS_OWN_PROPERTY_CALL_GUARD = `
  var o = { a: 1 };
  if (Object.prototype.hasOwnProperty.call(o, "a") !== true) return -1;
  if (Object.prototype.hasOwnProperty.call(o, "b") !== false) return -2;
  if (Object.prototype.propertyIsEnumerable.call(o, "a") !== true) return -3;
  return 1;
`;

describe("#2984 Phase 2 — gOPD on un-reified builtin proto receivers (standalone)", () => {
  it("Date.prototype method: full ES5 descriptor shape incl. .value identity", async () => {
    expect(await runStandalone(ES5_FULL_SHAPE_DATE)).toBe(1);
  });

  it("Object.prototype method: descriptor + .value identity", async () => {
    expect(await runStandalone(ES5_FULL_SHAPE_OBJECT_PROTO)).toBe(1);
  });

  it("String.prototype member outside the wired slice: descriptor + identity", async () => {
    expect(await runStandalone(STRING_NON_WIRED_MEMBER)).toBe(1);
  });

  it("unknown member still yields an undefined descriptor (no phantom closure)", async () => {
    expect(await runStandalone(UNKNOWN_MEMBER_UNDEFINED)).toBe(1);
  });

  it("refusal closure carries spec .name/.length meta", async () => {
    expect(await runStandalone(REFUSAL_CLOSURE_META)).toBe(1);
  });

  it("GUARD: hasOwnProperty.call / propertyIsEnumerable.call fall-through intact", async () => {
    expect(await runStandalone(HAS_OWN_PROPERTY_CALL_GUARD)).toBe(1);
  });

  it("host lane: Date.prototype descriptor shape unchanged", async () => {
    expect(await runHost(ES5_FULL_SHAPE_DATE)).toBe(1);
  });
});
