import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #1629 descriptor slice S2 — ToPropertyDescriptor validation + the
// Object.defineProperties two-pass.
//
// Spec basis:
//   * ToPropertyDescriptor — ECMA-262 §6.2.6.5 (validate the descriptor *input*:
//     a non-object descriptor throws; specifying both a data attribute
//     (value/writable) and an accessor (get/set) throws).
//   * ObjectDefineProperties — ECMA-262 §20.1.2.3.1: step 4 runs
//     ToPropertyDescriptor for *every* enumerable own key of Properties and
//     collects the results into a `descriptors` list; step 5 then applies each
//     via DefinePropertyOrThrow in order. So all input-parsing happens before
//     any property is installed — a bad-shape descriptor on a later key must
//     leave earlier keys un-installed.
//
// Scope note: when a per-property descriptor is itself a WasmGC struct whose
// `get`/`set` is a Wasm closure, that closure is not yet host-readable through
// the struct field reader, so the value+get conflict on a *struct* descriptor
// can't be observed (same closure-readability gap as S1's `ds.a` dot-access;
// S3 territory). These tests cover the paths that do not depend on reading a
// closure out of an opaque struct.

async function runHost(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile error: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#1629 S2 — defineProperties two-pass + ToPropertyDescriptor", () => {
  it("defineProperties installs all well-formed descriptors", async () => {
    expect(
      await runHost(`export function test(): number {
        const o: any = {};
        Object.defineProperties(o, { x: { value: 5, enumerable: true }, y: { value: 6, enumerable: true } });
        const dx: any = Object.getOwnPropertyDescriptor(o, "x");
        const dy: any = Object.getOwnPropertyDescriptor(o, "y");
        return (dx && dx.value === 5 && dy && dy.value === 6) ? 0 : 1;
      }`),
    ).toBe(0);
  });

  it("a bad-shape (primitive) descriptor on a later key aborts before earlier keys install (two-pass)", async () => {
    // `bad: 5` is a primitive — ToPropertyDescriptor throws in pass 1, so the
    // well-formed `a` from an earlier key must NOT have been installed.
    expect(
      await runHost(`export function test(): number {
        const o: any = {};
        try {
          Object.defineProperties(o, {
            a: { value: 1, enumerable: true, configurable: true, writable: true },
            bad: 5,
          });
          return 100; // should have thrown
        } catch (e) {
          if (!(e instanceof TypeError)) return 2;
          const da: any = Object.getOwnPropertyDescriptor(o, "a");
          return da === undefined ? 0 : 1; // a must be absent
        }
      }`),
    ).toBe(0);
  });

  it("defineProperty throws TypeError for a value+get descriptor (ToPropertyDescriptor data/accessor conflict)", async () => {
    expect(
      await runHost(`export function test(): number {
        const o: any = {};
        try { Object.defineProperty(o, "p", { value: 1, get: function(){ return 2; } }); return 100; }
        catch (e) { return (e instanceof TypeError) ? 0 : 1; }
      }`),
    ).toBe(0);
  });

  it("defineProperties throws TypeError for a value+get descriptor literal", async () => {
    expect(
      await runHost(`export function test(): number {
        const o: any = {};
        try { Object.defineProperties(o, { p: { value: 2, get: function(){ return 3; } } }); return 100; }
        catch (e) { return (e instanceof TypeError) ? 0 : 1; }
      }`),
    ).toBe(0);
  });

  it("defineProperties throws TypeError when Properties is null/undefined (ToObject)", async () => {
    await expect(
      runHost(`export function test(): any { return Object.defineProperties({} as any, null as any) as any; }`),
    ).rejects.toThrow();
    await expect(
      runHost(`export function test(): any { return Object.defineProperties({} as any, undefined as any) as any; }`),
    ).rejects.toThrow();
  });

  it("defineProperties installs an accessor-only descriptor and the getter is invocable", async () => {
    expect(
      await runHost(`export function test(): number {
        const o: any = {};
        Object.defineProperties(o, { p: { get: function(){ return 99; }, enumerable: true } });
        return (o as any).p === 99 ? 0 : 1;
      }`),
    ).toBe(0);
  });
});
