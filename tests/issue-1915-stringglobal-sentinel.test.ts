// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1915 — standalone `Binary emit error: u32 out of range: -1` bucket.
 *
 * Under `--target standalone` (nativeStrings auto-on), `addStringConstantGlobal`
 * stores the documented -1 sentinel in `ctx.stringGlobalMap` instead of adding
 * a `string_constants` host-global import. Call sites that guarded only
 * `undefined` baked `global.get -1` into function bodies, which the #1923
 * emit-time index validation rejects ("global index out of range — -1").
 *
 * The confirmed producer was `emitSetSubclassProto` (builtin subclassing), with
 * the same hole in ~20 other `stringGlobalMap.get` consumers (object literals
 * on the extern path, defineProperty flag checks, for-in/for-of destructuring
 * keys, TDZ/instanceof/RangeError message strings, …). All now route through
 * `stringConstantExternrefInstrs`, which is byte-identical in JS-host mode and
 * materializes an inline NativeString under nativeStrings.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  return compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, target: "standalone" as const });
}

function firstError(r: { errors?: { message: string }[] }): string {
  return r.errors?.[0]?.message ?? "";
}

describe("#1915 standalone emit — stringGlobalMap -1 sentinel producers", () => {
  it("builtin subclass (extends Uint8Array) compiles — the minimal repro", async () => {
    const r = await compileStandalone(`
      class MyArr extends Uint8Array {}
      const a = new MyArr();
      console.log(a instanceof MyArr);
    `);
    expect(r.success, firstError(r)).toBe(true);
    // The fix must not paper over the emit error with a leaked host import:
    // neither __set_subclass_proto nor __tag_user_class may appear standalone.
    const mod = await WebAssembly.compile(r.binary);
    const leaked = WebAssembly.Module.imports(mod)
      .filter((i) => i.name === "__set_subclass_proto" || i.name === "__tag_user_class")
      .map((i) => `${i.module}::${i.name}`);
    expect(leaked, "host-only proto/tag imports must not leak into standalone").toEqual([]);
  });

  it("builtin subclass of Error compiles standalone", async () => {
    const r = await compileStandalone(`
      class MyErr extends Error {}
      try {
        throw new MyErr("boom");
      } catch (e) {
        console.log((e as Error).message);
      }
    `);
    expect(r.success, firstError(r)).toBe(true);
  });

  it("never emits the raw u32-out-of-range / index-out-of-range emit error", async () => {
    // Shapes drawn from the four bucket clusters (#1915): builtin subclassing,
    // object-literal methods via the extern path, for-in over a typed object,
    // and number RangeError message strings.
    const sources = [
      `class A extends BigUint64Array {}\nnew A();`,
      `const proto = { greet() { return 1; } };\nconst o = Object.create(proto);\nconsole.log(o.greet());`,
      `const obj = { a: 1, b: 2 };\nlet acc = 0;\nfor (const k in obj) { acc++; }\nconsole.log(acc);`,
      `const n: any = 255;\nconsole.log(n.toString(16));`,
    ];
    for (const src of sources) {
      const r = await compileStandalone(src);
      if (!r.success) {
        // A loud, specific refusal is acceptable; a poisoned-index emit error is not.
        expect(firstError(r)).not.toMatch(/u32 out of range|index out of range/);
      }
    }
  });

  it("host-mode (default GC) compilation of the repro is unchanged and passes", async () => {
    const r = await compile(
      `class MyArr extends Uint8Array {}
       const a = new MyArr();
       console.log(a instanceof MyArr);`,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(r.success, firstError(r)).toBe(true);
  });
});
