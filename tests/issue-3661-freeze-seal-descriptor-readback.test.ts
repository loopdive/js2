import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #3661 (freeze/seal slice) — `Object.freeze`/`seal` must be visible to
 * `getOwnPropertyDescriptor` for EVERY property shape, not just sidecar-backed
 * ones.
 *
 * `freeze`/`seal` record per-property flags in the sidecar descriptor table,
 * which covers properties that HAVE a sidecar entry (dynamically added, or
 * `defineProperty`-created). It did NOT cover the two shapes whose value lives
 * outside the sidecar — a **bare struct field** (object-literal property) and a
 * **vec element** (array index). Measured on the merge base, a frozen plain
 * field read back `writable,configurable,enumerable = true,true,true` where V8
 * gives `false,false,true`; a frozen array element likewise.
 *
 * Enforcement and bookkeeping were already correct (`isFrozen`/`isSealed`
 * return true, and the write IS rejected) — only the read-back lied. The fix
 * clamps on the READ side (`_clampFrozenDescriptor`), which is exactly the spec
 * statement for SetIntegrityLevel (§7.3.15) and covers every value-carrier
 * uniformly.
 *
 * SCOPE HONESTY: this is the freeze/seal defect only — ~13 of the 229 measured
 * "should not be writable/configurable" regressions (6 %). The other ~94 %
 * (126 in the `defineProperty`/`defineProperties` families, 18 in mapped
 * `arguments`) is a DIFFERENT mechanism and is NOT addressed here.
 *
 * Descriptor state is encoded as `100*writable + 10*configurable + enumerable`
 * so a partial fix is visible rather than collapsing to a boolean. Every
 * expectation below was verified against plain V8 (node) first.
 */
async function runEncoded(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports as never);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as unknown as { test: () => number }).test();
}

describe("#3661 — freeze/seal descriptor read-back", () => {
  // Proves the instrument can report a NON-zero value. Without this, "1" from a
  // harness never seen returning anything else proves nothing.
  it("sentinel: the harness reports a distinguishing value", async () => {
    expect(await runEncoded(`export function test(): number { return 999; }`)).toBe(999);
  });

  // RED on the merge base: read back 111 (w,c,e all true) instead of 1.
  it("frozen object-literal field reports w=false, c=false, e=true", async () => {
    const ret = await runEncoded(`
      const o: any = { a: 1 };
      Object.freeze(o);
      export function test(): number {
        const d: any = Object.getOwnPropertyDescriptor(o, 'a');
        return 100 * (d.writable ? 1 : 0) + 10 * (d.configurable ? 1 : 0) + (d.enumerable ? 1 : 0);
      }`);
    expect(ret).toBe(1);
  });

  // RED on the merge base: vec elements were never clamped at all.
  it("frozen array element reports w=false, c=false, e=true", async () => {
    const ret = await runEncoded(`
      const arr: any = [1, 2];
      Object.freeze(arr);
      export function test(): number {
        const d: any = Object.getOwnPropertyDescriptor(arr, '0');
        return 100 * (d.writable ? 1 : 0) + 10 * (d.configurable ? 1 : 0) + (d.enumerable ? 1 : 0);
      }`);
    expect(ret).toBe(1);
  });

  // RED on the merge base: sealed literal field reported 111 instead of 101.
  // Seal must clear ONLY configurable — writable stays true.
  it("sealed object-literal field reports w=true, c=false, e=true", async () => {
    const ret = await runEncoded(`
      const o: any = { a: 1 };
      Object.seal(o);
      export function test(): number {
        const d: any = Object.getOwnPropertyDescriptor(o, 'a');
        return 100 * (d.writable ? 1 : 0) + 10 * (d.configurable ? 1 : 0) + (d.enumerable ? 1 : 0);
      }`);
    expect(ret).toBe(101);
  });

  // Narrowness guard: a property on a NON-frozen object must be untouched.
  // Green on both sides — it exists to catch the clamp firing too broadly.
  it("leaves a non-frozen object's descriptor untouched", async () => {
    const ret = await runEncoded(`
      const o: any = {};
      o.y = 1;
      export function test(): number {
        const d: any = Object.getOwnPropertyDescriptor(o, 'y');
        return 100 * (d.writable ? 1 : 0) + 10 * (d.configurable ? 1 : 0) + (d.enumerable ? 1 : 0);
      }`);
    expect(ret).toBe(111);
  });

  // Narrowness guard: `defineProperty` defaults must stay false, i.e. the clamp
  // must not be what makes them false (they already were).
  it("keeps defineProperty omitted-attribute defaults at false", async () => {
    const ret = await runEncoded(`
      const o: any = {};
      Object.defineProperty(o, 'x', { value: 1 });
      export function test(): number {
        const d: any = Object.getOwnPropertyDescriptor(o, 'x');
        return 100 * (d.writable ? 1 : 0) + 10 * (d.configurable ? 1 : 0) + (d.enumerable ? 1 : 0);
      }`);
    expect(ret).toBe(0);
  });

  // Bookkeeping and enforcement were ALREADY correct — assert they stay so, so a
  // future read-side change cannot mask a regression in them.
  it("keeps isFrozen/isSealed and write rejection correct", async () => {
    const ret = await runEncoded(`
      const f: any = { a: 1 }; Object.freeze(f);
      const s: any = { a: 1 }; Object.seal(s);
      export function test(): number {
        const frozenOk = Object.isFrozen(f) ? 1 : 0;
        const sealedOk = Object.isSealed(s) ? 1 : 0;
        let writeRejected = 0;
        try { f.a = 2; } catch (e) { /* strict-mode throw is correct */ }
        if (f.a === 1) writeRejected = 1;
        return 100 * frozenOk + 10 * sealedOk + writeRejected;
      }`);
    expect(ret).toBe(111);
  });
});
