import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2029 (ta-subclass slice) — a builtin (TypedArray / Error / …) subclass leaked
// two host imports standalone that have no JS host to satisfy them:
//
//  1. `__get_undefined` — `compileNewExpression` → `pushDefaultValue` →
//     `emitUndefinedValue` (type-coercion.ts) called `ensureLateImport` DIRECTLY,
//     bypassing the canonical `ensureGetUndefined` `ctx.nativeStrings` guard, so
//     the host import leaked into the implicit derived-ctor forwarder.
//  2. `__tag_user_class` — the externref-backed-class instanceof tag (class-bodies.ts)
//     was emitted unconditionally; its ONLY consumer is the host `__instanceof`
//     import, which does not exist standalone, so it was dead weight that leaked.
//
// Both fixes are `ctx.nativeStrings`-gated: standalone emits the native
// `ref.null.extern` sentinel / skips the tag; gc/host keeps the host imports.
// The remaining `__new_<Builtin>` construction leak is a separate slice (native
// vec-struct construction).

async function compileStandalone(src: string) {
  return compile(src, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
}

function leakedImports(r: Awaited<ReturnType<typeof compile>>): string[] {
  return r.imports.map((i) => i.name);
}

describe("#2029 builtin-subclass host-import leak (standalone)", () => {
  it("TypedArray subclass new X() no longer leaks __get_undefined", async () => {
    const r = await compileStandalone(
      `class X extends Uint8Array {} export function test(): number { const a: any = new X(); return 1; }`,
    );
    expect(r.success).toBe(true);
    expect(leakedImports(r)).not.toContain("__get_undefined");
  });

  it("TypedArray subclass no longer leaks __tag_user_class", async () => {
    const r = await compileStandalone(
      `class X extends Int32Array {} export function test(): number { const a: any = new X(); return 1; }`,
    );
    expect(r.success).toBe(true);
    expect(leakedImports(r)).not.toContain("__tag_user_class");
  });

  it("Error subclass no longer leaks __get_undefined or __tag_user_class", async () => {
    const r = await compileStandalone(
      `class E extends Error {} export function test(): number { const e: any = new E(); return 1; }`,
    );
    expect(r.success).toBe(true);
    const names = leakedImports(r);
    expect(names).not.toContain("__get_undefined");
    expect(names).not.toContain("__tag_user_class");
  });

  it("empty TypedArray subclass declaration no longer leaks __tag_user_class", async () => {
    const r = await compileStandalone(`class X extends Uint8Array {} export function test(): number { return 1; }`);
    expect(r.success).toBe(true);
    expect(leakedImports(r)).not.toContain("__tag_user_class");
  });

  it("host (gc) mode still emits the instanceof tag + __get_undefined (unchanged)", async () => {
    // The fix is native-strings-gated; gc/host keeps the host-backed instanceof
    // path so `instance instanceof Sub` still resolves via the tag chain.
    const r = await compile(
      `class X extends Uint8Array {} export function test(): number { const a: any = new X(); return (a instanceof X) ? 1 : 0; }`,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
    expect(leakedImports(r)).toContain("__tag_user_class");
  });
});
