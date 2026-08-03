// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2962 — native error-object identity + payload stringification.
 *
 * Standalone binaries throw Wasm-GC `$Error_struct` payloads the host cannot
 * stringify. Two layers under test:
 *
 *   1. In-module §20.5.3.4 `Error.prototype.toString`: `String(e)`,
 *      `` `${e}` ``, `e.toString()`, `"x" + e` must yield "Name: message"
 *      (previously all four yielded "[object Object]" via the
 *      `__any_to_string` fallback).
 *   2. Harness-readable rendering: standalone binaries export
 *      `__exn_render_prepare` / `__exn_render_char` so the test262 harness can
 *      render an uncaught payload ("TypeError: x") with ZERO host imports.
 */

async function compileStandalone(src: string) {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", hostBridge: "always" });
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

describe("#2962 — in-module String(err) per §20.5.3.4 (standalone)", () => {
  it("String(e) renders 'TypeError: boom'", async () => {
    const { instance, imports } = await compileStandalone(`
      export function test(): number {
        try { throw new TypeError("boom"); } catch (e: any) {
          return String(e) === "TypeError: boom" ? 1 : 0;
        }
      }`);
    expect(imports).toHaveLength(0);
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("template interpolation renders 'TypeError: boom'", async () => {
    const { instance } = await compileStandalone(`
      export function test(): number {
        try { throw new TypeError("boom"); } catch (e: any) {
          return \`\${e}\` === "TypeError: boom" ? 1 : 0;
        }
      }`);
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("explicit e.toString() renders 'Error: m'", async () => {
    const { instance } = await compileStandalone(`
      export function test(): number {
        const e = new Error("m");
        return e.toString() === "Error: m" ? 1 : 0;
      }`);
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("string concatenation renders through the error arm", async () => {
    const { instance } = await compileStandalone(`
      export function test(): number {
        try { throw new RangeError("r"); } catch (e: any) {
          return ("got: " + e) === "got: RangeError: r" ? 1 : 0;
        }
      }`);
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("argument-less and empty-message errors render the name alone (§20.5.3.4 step 6)", async () => {
    const { instance } = await compileStandalone(`
      export function test(): number {
        const a = String(new Error()) === "Error" ? 1 : 0;
        const b = String(new Error("")) === "Error" ? 1 : 0;
        return a + b;
      }`);
    expect((instance.exports.test as () => number)()).toBe(2);
  });

  it("user Error subclass renders through the shared parent name", async () => {
    const { instance } = await compileStandalone(`
      class MyErr extends Error {}
      export function test(): number {
        try { throw new MyErr("m"); } catch (e: any) {
          return String(e) === "Error: m" ? 1 : 0;
        }
      }`);
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("controls: plain object and number stringification are unchanged", async () => {
    const { instance } = await compileStandalone(`
      export function test(): number {
        const o: any = {};
        const n: any = 42;
        return (String(o) === "[object Object]" ? 1 : 0) + (String(n) === "42" ? 1 : 0);
      }`);
    expect((instance.exports.test as () => number)()).toBe(2);
  });
});

describe("#2962 — harness-readable render exports (standalone)", () => {
  it("uncaught new TypeError('x') renders 'TypeError: x' with zero imports", async () => {
    const { instance, imports } = await compileStandalone(
      `export function test(): number { throw new TypeError("x"); }`,
    );
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
    expect(renderPayload(instance, payload)).toBe("TypeError: x");
  });

  it("a Test262Error-shaped subclass renders its full assertion message", async () => {
    const { instance } = await compileStandalone(`
      class Test262Error extends Error {}
      export function test(): number { throw new Test262Error("Expected SameValue(1, 2) to be true"); }`);
    let payload: unknown = null;
    try {
      (instance.exports.test as () => number)();
    } catch (err) {
      const tag = instance.exports.__exn_tag as WebAssembly.Tag;
      payload = (err as WebAssembly.Exception).getArg(tag, 0);
    }
    expect(renderPayload(instance, payload)).toBe("Test262Error: Expected SameValue(1, 2) to be true");
  });

  it("a thrown native string passes through the renderer", async () => {
    const { instance } = await compileStandalone(`export function test(): number { throw "bare string payload"; }`);
    let payload: unknown = null;
    try {
      (instance.exports.test as () => number)();
    } catch (err) {
      const tag = instance.exports.__exn_tag as WebAssembly.Tag;
      payload = (err as WebAssembly.Exception).getArg(tag, 0);
    }
    expect(renderPayload(instance, payload)).toBe("bare string payload");
  });

  it("render exports are NOT emitted for a JS-host (default target) binary", async () => {
    const r = await compile(`export function test(): number { throw new TypeError("x"); }`, {
      fileName: "test.ts",
    });
    expect(r.success).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    const names = WebAssembly.Module.exports(mod).map((e) => e.name);
    expect(names).not.toContain("__exn_render_prepare");
    expect(names).not.toContain("__exn_render_char");
  });

  it("host lane control: String(err) still correct under the default target", async () => {
    // Host-lane errors are real JS Error objects; the #2962 arm must not
    // perturb that path (it is only built when $Error_struct is registered,
    // which never happens in JS-host mode).
    const r = await compile(
      `export function test(): number {
        try { throw new TypeError("boom"); } catch (e: any) {
          return String(e) === "TypeError: boom" ? 1 : 0;
        }
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
