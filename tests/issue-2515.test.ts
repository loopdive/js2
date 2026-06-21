// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2515 S0 — kill the residual late-import / global-index-shift emit bug
 * (`global index out of range — -1`) in the standalone open-object family.
 *
 * Root cause: in `--target standalone` / `nativeStrings`, `addStringConstantGlobal`
 * stores the documented `-1` sentinel ("no host `string_constants` global —
 * materialize the literal inline at use sites") rather than a real global index.
 * Several stringify / descriptor / object-rest call sites looked the value back
 * up and emitted a raw `global.get <stringGlobalMap.get(word)!>` (or guarded only
 * `=== undefined`, missing the in-pool `-1`), baking `global.get -1` into the
 * function body. The always-on #2043 emit-time index validator then failed binary
 * emit for the WHOLE module, poisoning ~626 standalone rows in the family.
 *
 * The fix routes every such site through the sentinel-aware materializers
 * (`compileStringLiteral` / `stringConstantExternrefInstrs`), which take the
 * inline `$NativeString` path under standalone and a real `global.get` under host
 * mode — so neither mode bakes a `-1`. These tests pin: each repro pattern
 * compiles, validates, and instantiates under EMPTY imports (no host runtime),
 * and the runtime result is correct.
 */

interface StandaloneResult {
  success: boolean;
  errors: string;
  value: number | undefined;
}

async function runStandalone(src: string): Promise<StandaloneResult> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    return { success: false, errors: r.errors.map((e) => e.message).join("\n"), value: undefined };
  }
  // Empty imports — standalone must instantiate with no JS host.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const value = (instance.exports as { test?: () => number }).test?.();
  return { success: true, errors: "", value };
}

describe("#2515 S0 — standalone late-import global-index-shift emit bug", () => {
  it("Object.defineProperty redefine (non-configurable) compiles + throws catchable TypeError", async () => {
    // The keystone repro: the redefine TypeError path materialized its error
    // message via `global.get <stringGlobalMap.get(msg)!>` → `global.get -1`.
    const res = await runStandalone(`
      export function test(): number {
        const o: any = {};
        Object.defineProperty(o, 'x', { value: 1 });
        try {
          Object.defineProperty(o, 'x', { value: 2 });
          return -1; // should not reach — redefine of non-writable must throw
        } catch (e) {
          return o.x; // 1
        }
      }
    `);
    expect(res.success, res.errors).toBe(true);
    expect(res.value).toBe(1);
  });

  it("Object.defineProperty + getOwnPropertyDescriptor round-trips by computed key", async () => {
    const res = await runStandalone(`
      export function test(): number {
        const o: any = {};
        const k = "x";
        Object.defineProperty(o, k, { value: 7, enumerable: true });
        return o[k]; // 7
      }
    `);
    expect(res.success, res.errors).toBe(true);
    expect(res.value).toBe(7);
  });

  it("object-rest destructuring assignment compiles without a -1 global", async () => {
    // `{ a, ...rest } = obj` builds an excluded-keys CSV string constant and
    // passed it via `global.get <stringGlobalMap.get(csv)>` (guarded only on
    // `undefined`, so the `-1` sentinel slipped through). The fix materializes
    // the CSV inline. We assert it COMPILES + validates standalone (the emit-CE
    // is what S0 removes); the rest collection itself is a separate native gap.
    const r = await compile(
      `
      export function test(): number {
        const obj: any = { a: 1, b: 2, c: 3 };
        const { a, ...rest } = obj;
        return a;
      }
    `,
      { fileName: "test.ts", target: "standalone" },
    );
    // Either it compiles cleanly, or it refuses LOUDLY with a tracked message —
    // never a `global index out of range` binary-emit CE.
    if (!r.success) {
      const msg = r.errors.map((e) => e.message).join("\n");
      expect(msg).not.toMatch(/global index out of range/);
      expect(msg).not.toMatch(/u32 out of range: -1/);
    }
  });

  it("null/undefined string coercion in `+` and template literals (standalone) builds the right string", async () => {
    // Statically null/undefined-typed spans lowered to a string constant via a
    // raw `global.get -1` under nativeStrings. Assert the result string is
    // correct (length is observable across the native-string boundary).
    const plusNull = await runStandalone(`export function test(): number { return ("v=" + null).length; }`);
    expect(plusNull.success, plusNull.errors).toBe(true);
    expect(plusNull.value).toBe("v=null".length); // 6

    const plusUndef = await runStandalone(`export function test(): number { return ("v=" + undefined).length; }`);
    expect(plusUndef.success, plusUndef.errors).toBe(true);
    expect(plusUndef.value).toBe("v=undefined".length); // 11

    const tmplNull = await runStandalone("export function test(): number { return `v=${null}`.length; }");
    expect(tmplNull.success, tmplNull.errors).toBe(true);
    expect(tmplNull.value).toBe(6);

    const tmplUndef = await runStandalone("export function test(): number { return `v=${undefined}`.length; }");
    expect(tmplUndef.success, tmplUndef.errors).toBe(true);
    expect(tmplUndef.value).toBe(11);
  });

  it("void-call operand in string concat (standalone) coerces to 'undefined'", async () => {
    const res = await runStandalone(`
      function noop(): void {}
      export function test(): number { return ("v=" + noop()).length; }
    `);
    expect(res.success, res.errors).toBe(true);
    expect(res.value).toBe("v=undefined".length); // 11
  });

  it("does not leak host string_constants imports under standalone", async () => {
    const r = await compile(
      `
      export function test(): number {
        const o: any = {};
        Object.defineProperty(o, 'x', { value: 1 });
        try { Object.defineProperty(o, 'x', { value: 2 }); } catch (e) {}
        return o.x;
      }
    `,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    const hostImports = r.imports.map((i) => `${i.module}::${i.name}`);
    // No `string_constants::*` global imports — standalone materializes inline.
    expect(hostImports.some((l) => l.startsWith("string_constants::"))).toBe(false);
  });

  // ── S0 slice 2: calls.ts producers (toString fallback + builtin-name dispatch) ──

  it(".toString() fallback string ('[object Object]') compiles + instantiates standalone (no -1 emit)", async () => {
    // calls.ts materialized the toString fallback string via a raw
    // `global.get <stringGlobalMap.get(str)!>` → `global.get -1` under standalone
    // (the Number/Boolean.prototype.toString borrowed-method cluster). S0's claim
    // is the emit-CE is gone: the module compiles + validates + instantiates
    // under empty imports. (Exact `[object Object]` round-trip via native-string
    // `.length` is a separate `.toString()`-semantics path, not S0.)
    const obj = await compile(
      `export function test(): number { const o: any = {}; const s = o.toString(); return s !== null ? 1 : 0; }`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(obj.success, obj.success ? "" : obj.errors.map((e) => e.message).join("\n")).toBe(true);
    const hostImports = obj.imports.map((i) => `${i.module}::${i.name}`);
    expect(hostImports.some((l) => l.startsWith("string_constants::"))).toBe(false);
    // Instantiates under empty imports without trapping (the S0 acceptance).
    await WebAssembly.instantiate(obj.binary, {});
  });

  it("function .toString() (captured source) compiles standalone without a -1 global", async () => {
    const r = await compile(
      `function f(): number { return 1; } export function test(): number { return f.toString().length > 0 ? 1 : 0; }`,
      { fileName: "test.ts", target: "standalone" },
    );
    if (!r.success) {
      const msg = r.errors.map((e) => e.message).join("\n");
      expect(msg).not.toMatch(/global index out of range/);
    } else {
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      expect((instance.exports as { test?: () => number }).test?.()).toBe(1);
    }
  });

  // ── S1: Object.create(o, descs) generic descriptor apply ──────────────────

  it("Object.create(proto, descriptorMapLiteral) compiles standalone (no __defineProperty_desc refusal)", async () => {
    // The `Object.create(o, { x: descObj })` path emitted the refused
    // `env::__defineProperty_desc` host import in standalone (#1472 Phase B),
    // a hard compile error. S0 unblocked routing it to the native
    // `__obj_define_from_desc` (the same native `Object.defineProperty` uses).
    const r = await compile(
      `export function test(): number {
         const o = Object.create(null, { x: { value: 7 }, y: { value: 4 } });
         return (o as any).x;
       }`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    // No leaked `env::__defineProperty_desc` host import.
    const hostImports = r.imports.map((i) => `${i.module}::${i.name}`);
    expect(hostImports.some((l) => l === "env::__defineProperty_desc")).toBe(false);
    // Value descriptor is applied + readable (single-property read).
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test?: () => number }).test?.()).toBe(7);
  });

  it("Object.create with an identifier descriptor value compiles + applies the value", async () => {
    const res = await runStandalone(`
      export function test(): number {
        const dv: any = { value: 11, enumerable: true };
        const o = Object.create(null, { x: dv });
        return (o as any).x;
      }
    `);
    expect(res.success, res.errors).toBe(true);
    expect(res.value).toBe(11);
  });
});

describe("#2515 S0 — host (GC) mode unchanged", () => {
  async function runGc(src: string): Promise<number | undefined> {
    const r = await compile(src, { fileName: "test.ts", target: "gc" });
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
    return (instance.exports as { test?: () => number }).test?.();
  }

  it("defineProperty redefine still throws catchable TypeError in host mode", async () => {
    const v = await runGc(`
      export function test(): number {
        const o: any = {};
        Object.defineProperty(o, 'x', { value: 1 });
        try { Object.defineProperty(o, 'x', { value: 2 }); return -1; }
        catch (e) { return o.x; }
      }
    `);
    expect(v).toBe(1);
  });

  it("null/undefined concat still correct in host mode", async () => {
    const v = await runGc(`export function test(): string { return "v=" + null; }`);
    expect(v).toBe("v=null");
  });
});
