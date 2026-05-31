import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #1629 descriptor slice S3 (first sub-slice) — the inline
// `Object.defineProperty(o, k, {get/set})` STORE contract.
//
// Verified bug: `const o:any = {z:0}; Object.defineProperty(o,"p",{get(){return 42}}); o.p`
// returned `undefined`. The accessor branch in `compileObjectDefineProperty`
// (src/codegen/object-ops.ts) used to compile a dead `${structName}_get_p` Wasm
// function + `classAccessorSet` and EARLY-RETURN — feeding *no* runtime sidecar.
// The getter therefore lived in neither `_wasmStructProps[obj]["__get_p"]` nor
// `_wasmStructAccessors` — the canonical slot the read-side `_safeGet`, S1's
// `_readOwnDescriptor`, and `getOwnPropertyDescriptor` all consult. The fix
// disables that dead branch so the accessor case falls through to the existing
// `emitExternDefinePropertyNoValue`, which mirrors get/set into the runtime
// `__defineProperty_accessor` import (the symmetric mirror the data-value path
// already emits). One write reconciles all reader entry points.
//
// Spec basis: §20.1.2.4 Object.defineProperty, §10.1.6.1/.3
// OrdinaryDefineOwnProperty + ValidateAndApply, §10.1.8.1 OrdinaryGet accessor
// branch, §6.2.6.4 CompletePropertyDescriptor (omitted enumerable/configurable
// default to false).
//
// Scope (matches the architect S3-slice spec): the verified externref-backed
// (`const o:any`) case, whose reads route through the host `_safeGet` path.
// Two reads are EXPLICITLY DEFERRED to the broader S3 read-shim / representation
// foundation and are NOT asserted here:
//   * `o.k` *dot*-access on a statically-known struct field redefined as an
//     accessor — lowers to a direct `struct.get` that never touches `_safeGet`
//     (the read-site struct resolver is weaker than the define-site one). Bracket
//     and dynamic-key reads of the same property DO route through `_safeGet` and
//     are covered below.
//   * `o.k = v` setter invocation — the runtime accessor `this`-binding through
//     `_maybeWrapCallable` is a pre-existing write-side gap (documented at
//     runtime.ts ~5550), not part of this STORE-contract slice.

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

describe("#1629 S3 — inline defineProperty accessor STORE", () => {
  it("getter fires on dot read (o.p)", async () => {
    expect(
      await runHost(
        `export function test(): any { const o:any = {z:0}; Object.defineProperty(o,"p",{get(){return 42}}); return o.p; }`,
      ),
    ).toBe(42);
  });

  it('getter fires on bracket read (o["p"])', async () => {
    expect(
      await runHost(
        `export function test(): any { const o:any = {z:0}; Object.defineProperty(o,"p",{get(){return 42}}); return o["p"]; }`,
      ),
    ).toBe(42);
  });

  it("getter fires on forced-dynamic read (o[k])", async () => {
    expect(
      await runHost(
        `export function test(): any { const o:any = {z:0}; const k = "p"; Object.defineProperty(o,"p",{get(){return 42}}); return o[k]; }`,
      ),
    ).toBe(42);
  });

  it("getter receives the receiver as `this`", async () => {
    expect(
      await runHost(
        `export function test(): any { const o:any = {z:7}; Object.defineProperty(o,"p",{get(){return this.z}}); return o.p; }`,
      ),
    ).toBe(7);
  });

  it("getter closes over its defining scope", async () => {
    expect(
      await runHost(
        `export function test(): any { const cap = 13; const o:any = {z:0}; Object.defineProperty(o,"p",{get(){return cap}}); return o.p; }`,
      ),
    ).toBe(13);
  });

  it("get-only accessor: get fires, no setter installed", async () => {
    expect(
      await runHost(
        `export function test(): any { const o:any = {z:0}; Object.defineProperty(o,"p",{get(){return 5}}); return o.p; }`,
      ),
    ).toBe(5);
  });

  it("set-only accessor: reading returns undefined (OrdinaryGet [[Get]] undefined)", async () => {
    expect(
      await runHost(
        `export function test(): any { const o:any = {z:0}; Object.defineProperty(o,"p",{set(v){}}); return o.p; }`,
      ),
    ).toBeUndefined();
  });

  it("get+set accessor: get fires", async () => {
    expect(
      await runHost(
        `export function test(): any { const o:any = {z:0}; Object.defineProperty(o,"p",{get(){return 1},set(v){}}); return o.p; }`,
      ),
    ).toBe(1);
  });

  it("data→accessor flip: bracket read fires the new getter, not the stale field value", async () => {
    // `z` starts as a data field (value 0). Redefining it as an accessor must
    // make a subsequent read fire the getter. The runtime accessor handler drops
    // any stale value-sidecar entry so `_sidecarGet` (checked before the getter)
    // can't shadow it. Bracket access routes through `_safeGet`; the dot-access
    // form is the deferred direct-`struct.get` case (see file header).
    expect(
      await runHost(
        `export function test(): any { const o:any = {z:0}; Object.defineProperty(o,"z",{get(){return 9}}); return o["z"]; }`,
      ),
    ).toBe(9);
  });

  it("GOPD read-back for a bare {get(){}} accessor (S1 consistency)", async () => {
    // §20.1.2.4 / CompletePropertyDescriptor: omitted enumerable/configurable
    // default to false; set defaults to undefined; get is a function.
    // (Booleans returned through the `any` ABI surface as i32 0/1, so assert the
    // descriptor's own enumerable/configurable rather than a compiled `===`.)
    expect(
      await runHost(
        `export function test(): any {
           const o:any = {z:0};
           Object.defineProperty(o,"p",{get(){return 1}});
           const d = Object.getOwnPropertyDescriptor(o,"p") as any;
           return [typeof d.get, typeof d.set, d.enumerable, d.configurable];
         }`,
      ),
    ).toEqual(["function", "undefined", false, false]);
  });
});
