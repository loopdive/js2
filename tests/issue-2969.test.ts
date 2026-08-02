// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2969 — native Error construction ToString(message) (§20.5.1.1) + numeric
 * exception-payload rendering. Two residuals from #2962:
 *
 *   1. `emitErrorStructConstructor` stored the RAW first argument in
 *      `$Error_struct.$message`, so `new Error(42)` had `message === 42`
 *      (a number, spec says `"42"`) and `String(new Error(42))` degraded to
 *      `"Error"` (§20.5.3.4 treats a non-string message as absent). Spec
 *      §20.5.1.1 step 3 requires `msg = ToString(message)` AT CONSTRUCTION.
 *   2. A thrown raw number rendered `"[object Object]"` through
 *      `__exn_render_prepare` when the module never otherwise stringified a
 *      number (the `__any_to_string` number arm degraded when
 *      `number_toString` was not in `funcMap`).
 *
 * All comparisons happen in-module (a native string returned to the host does
 * not marshal to a JS string), so `test()` returns a 0/1 flag.
 */

async function compileStandalone(src: string, target: "standalone" | "wasi" = "standalone") {
  const r = await compile(src, { fileName: "test.ts", target, hostBridge: "always" });
  expect(r.success, r.success ? undefined : r.errors?.[0]?.message).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { instance, imports };
}

/** Read the rendered exception string back through the #2962 export pair. */
function renderPayload(instance: WebAssembly.Instance, payload: unknown): string | null {
  const prep = instance.exports.__exn_render_prepare as ((p: unknown) => number) | undefined;
  const chr = instance.exports.__exn_render_char as ((i: number) => number) | undefined;
  if (typeof prep !== "function" || typeof chr !== "function") return null;
  const len = prep(payload);
  if (len < 0) return null;
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(chr(i));
  return out;
}

describe("#2969 — ToString(message) at Error construction (§20.5.1.1, standalone)", () => {
  it("new Error(42).message === '42' (numeric arg coerced at construction)", async () => {
    const { instance, imports } = await compileStandalone(`
      export function test(): number {
        const e = new Error(42 as any);
        return e.message === "42" ? 1 : 0;
      }`);
    expect(imports).toHaveLength(0);
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("String(new Error(42)) === 'Error: 42'", async () => {
    const { instance } = await compileStandalone(`
      export function test(): number {
        return String(new Error(42 as any)) === "Error: 42" ? 1 : 0;
      }`);
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("float / boolean messages coerce (RangeError 3.5, Error true)", async () => {
    const { instance } = await compileStandalone(`
      export function test(): number {
        const a = String(new RangeError(3.5 as any)) === "RangeError: 3.5" ? 1 : 0;
        const b = String(new Error(true as any)) === "Error: true" ? 1 : 0;
        return a + b;
      }`);
    expect((instance.exports.test as () => number)()).toBe(2);
  });

  it("zero is a real message, not treated as absent (Error(0) → 'Error: 0')", async () => {
    const { instance } = await compileStandalone(`
      export function test(): number {
        return String(new Error(0 as any)) === "Error: 0" ? 1 : 0;
      }`);
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("string messages are unchanged (idempotent through the coercion)", async () => {
    const { instance } = await compileStandalone(`
      export function test(): number {
        return (String(new Error("boom")) === "Error: boom" ? 1 : 0)
             + (new Error("boom").message === "boom" ? 1 : 0);
      }`);
    expect((instance.exports.test as () => number)()).toBe(2);
  });

  it("argument-less / undefined message still renders the name alone (§20.5.1.1 step 3 guard)", async () => {
    const { instance } = await compileStandalone(`
      export function test(): number {
        const a = String(new Error()) === "Error" ? 1 : 0;
        const b = String(new Error(undefined as any)) === "Error" ? 1 : 0;
        const c = String(new Error("")) === "Error" ? 1 : 0;
        return a + b + c;
      }`);
    expect((instance.exports.test as () => number)()).toBe(3);
  });

  it("WASI target coerces a numeric message identically", async () => {
    const { instance } = await compileStandalone(
      `export function test(): number {
        const e = new Error(42 as any);
        return e.message === "42" ? 1 : 0;
      }`,
      "wasi",
    );
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("host lane control: default target keeps real JS Error objects (unchanged)", async () => {
    const r = await compile(
      `export function test(): number {
        const e = new Error(42 as any);
        return e.message === "42" ? 1 : 0;
      }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const rt = await import("../src/runtime.js");
    const importObj = (rt as any).buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, importObj);
    if (typeof importObj.setExports === "function") importObj.setExports(instance.exports);
    expect((instance.exports.test as () => number)()).toBe(1);
  });
});

describe("#2969 — numeric exception payload renders without a prior number stringification", () => {
  it("a thrown raw number renders its decimal via __exn_render_prepare (bare module)", async () => {
    const { instance, imports } = await compileStandalone(`export function test(): number { throw (42 as any); }`);
    expect(imports).toHaveLength(0);
    let payload: unknown = null;
    try {
      (instance.exports.test as () => number)();
      expect.unreachable("test() must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WebAssembly.Exception);
      const tag = instance.exports.__exn_tag as WebAssembly.Tag;
      payload = (err as WebAssembly.Exception).getArg(tag, 0);
    }
    expect(renderPayload(instance, payload)).toBe("42");
  });

  it("a thrown float renders its decimal (bare module)", async () => {
    const { instance } = await compileStandalone(`export function test(): number { throw (3.5 as any); }`);
    let payload: unknown = null;
    try {
      (instance.exports.test as () => number)();
    } catch (err) {
      const tag = instance.exports.__exn_tag as WebAssembly.Tag;
      payload = (err as WebAssembly.Exception).getArg(tag, 0);
    }
    expect(renderPayload(instance, payload)).toBe("3.5");
  });
});
