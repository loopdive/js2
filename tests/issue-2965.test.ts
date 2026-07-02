// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2965 — standalone dynamic-descriptor/defineProperty cluster: three root
 * causes found by the measure-first triage of the 694 host-pass →
 * standalone-fail tests under built-ins/Object/{defineProperty,
 * getOwnPropertyDescriptor,defineProperties}.
 *
 * 1. **Module-init double-compile state leak** (declarations.ts). The
 *    `__module_init` body is compiled twice (the recompile lets call sites see
 *    the final inlinable-function registry). Statement compilation mutates
 *    program-order-sensitive ctx state (`definedPropertyFlags`,
 *    `frozenVars`/`sealedVars`/`nonExtensibleVars`), so pass 2 treated pass 1's
 *    own defineProperty/freeze effects as PRE-EXISTING: every first top-level
 *    `Object.defineProperty(o, k, {value: v})` emitted the non-writable
 *    redefine guard comparing the struct field's zero-init default against
 *    `v` → spurious "Cannot redefine property" throw for any non-zero value;
 *    defines preceding an `Object.freeze` compiled as already-frozen. Fixed by
 *    snapshotting the state before pass 1 and restoring before pass 2.
 *
 * 2. **`__typeof` native stub** (index.ts). The standalone/wasi native form of
 *    the string-returning `__typeof` helper was a `ref.null.extern` stub, so
 *    every MATERIALIZED typeof (`var t = typeof x`, typeof flowing through a
 *    param — incl. the test262 runner's untransformed paren-form
 *    `typeof(o.p)`) produced null: `t === "undefined"` false for every tag,
 *    `t.length` trapped. Replaced with a real classifier mirroring the
 *    `__typeof_*` predicates (null → "undefined", box_number → "number",
 *    box_boolean → "boolean", $BigInt → "bigint", $AnyString → "string",
 *    else → "object"), returning inline NativeString constants (no funcidx
 *    baked — late-import-shift safe).
 *
 * 3. **gOPD literal-key ToPropertyKey** (calls.ts). The struct fast path for
 *    `Object.getOwnPropertyDescriptor` required a STRING literal key;
 *    `gOPD(obj, -20)` / `gOPD(obj, true)` fell to the dynamic native, which
 *    answers undefined for typed-struct receivers. Standalone now
 *    canonicalizes numeric/boolean literal keys to their ToPropertyKey string
 *    form so they hit the same fast path (host/gc lane unrerouted).
 */

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, {
    fileName: "test.ts",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(r.success, `compile failed:\n${(r.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const envImports = (r.imports ?? []).filter((i) => String(i).startsWith("env"));
  expect(envImports, "expected host-free standalone binary").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  // Top-level-only programs run via the wasm start section during instantiate;
  // programs with an exported test() return its value.
  return exports.test ? exports.test() : undefined;
}

describe("#2965 slice 1 — module-init double-compile state leak", () => {
  it("top-level defineProperty with a non-zero value does not throw", async () => {
    // Threw "Cannot redefine property" before the fix (pass 2 saw pass 1's
    // flags → zero-init vs 7 SameValue guard).
    await expect(
      runStandalone(`var obj = {};
Object.defineProperty(obj, "x", { value: 7 });`),
    ).resolves.toBeUndefined();
  });

  it("same-value top-level redefine is allowed (§10.1.6.3)", async () => {
    await expect(
      runStandalone(`var obj = {};
Object.defineProperty(obj, "x", { value: 7 });
Object.defineProperty(obj, "x", { value: 7 });`),
    ).resolves.toBeUndefined();
  });

  it("differing-value redefine on non-writable still throws catchable TypeError", async () => {
    await expect(
      runStandalone(`var obj = {};
Object.defineProperty(obj, "x", { value: 7 });
var caught = false;
try { Object.defineProperty(obj, "x", { value: 8 }); } catch (e) { caught = (e instanceof TypeError); }
if (!caught) { throw new Error("expected TypeError"); }`),
    ).resolves.toBeUndefined();
  });

  it("a define BEFORE Object.freeze is not compiled as already-frozen", async () => {
    await expect(
      runStandalone(`var obj = { x: 1 };
Object.defineProperty(obj, "x", { value: 7, writable: true, configurable: true });
Object.freeze(obj);`),
    ).resolves.toBeUndefined();
  });
});

describe("#2965 slice 2 — materialized typeof (native __typeof classifier)", () => {
  it("var t = typeof <undefined var> compares and has length", async () => {
    const ret = await runStandalone(`export function test(): number {
  var x;
  var t = typeof x;
  if (t !== "undefined") return 0;
  return t.length; // 9
}`);
    expect(ret).toBe(9);
  });

  it("typeof result through an any param classifies all tags", async () => {
    const ret = await runStandalone(`function f(v: any): string { return typeof v; }
export function test(): number {
  if (f(undefined) !== "undefined") return 1;
  if (f(5) !== "number") return 2;
  if (f(true) !== "boolean") return 3;
  if (f("s") !== "string") return 4;
  if (f({ a: 1 }) !== "object") return 5;
  return 42;
}`);
    expect(ret).toBe(42);
  });

  it("paren-form typeof(o.p) of a no-value defined property is 'undefined'", async () => {
    // The test262 runner's typeof transform misses the paren form, so the
    // string is materialized — the exact corpus shape of 15.2.3.7-5-b-113.
    const ret = await runStandalone(`function check(actual: any, expected: string): number {
  return actual === expected ? 1 : 0;
}
export function test(): number {
  var obj = {};
  Object.defineProperties(obj, { property: { writable: true } });
  return check(typeof(obj.property), "undefined");
}`);
    expect(ret).toBe(1);
  });
});

describe("#2965 slice 3 — gOPD literal-key ToPropertyKey canonicalization", () => {
  it("negative number key: gOPD(obj, -20) finds '-20'", async () => {
    const ret = await runStandalone(`export function test(): number {
  var obj = { "-20": 1 };
  var desc = Object.getOwnPropertyDescriptor(obj, -20);
  return desc.value === 1 ? 1 : 0;
}`);
    expect(ret).toBe(1);
  });

  it("float key: gOPD(obj, 1.5) finds '1.5'", async () => {
    const ret = await runStandalone(`export function test(): number {
  var obj = { "1.5": 3 };
  var desc = Object.getOwnPropertyDescriptor(obj, 1.5);
  return desc.value === 3 ? 1 : 0;
}`);
    expect(ret).toBe(1);
  });

  it("boolean key: gOPD(obj, true) finds 'true'", async () => {
    const ret = await runStandalone(`export function test(): number {
  var obj = { "true": 9 };
  var desc = Object.getOwnPropertyDescriptor(obj, true);
  return desc.value === 9 ? 1 : 0;
}`);
    expect(ret).toBe(1);
  });

  it("absent number key still yields undefined", async () => {
    const ret = await runStandalone(`export function test(): number {
  var obj = { "5": 7 };
  var desc = Object.getOwnPropertyDescriptor(obj, 6);
  return desc === undefined ? 1 : 0;
}`);
    expect(ret).toBe(1);
  });
});
