import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2999 — eliminate the `env::Object_get_constructor` host-import leak.
 *
 * Round-5 leak analysis flagged 9 execution-verified standalone passes whose
 * sole `env::` import was `Object_get_constructor`. They are all
 * `<Builtin>.prototype.constructor === <Builtin>` (Set / WeakMap / WeakRef /
 * WeakSet / RegExp / FinalizationRegistry / DisposableStack / SuppressedError)
 * plus instance forms `(new WeakMap()).constructor` / `/re/.constructor`.
 *
 * Reading `.constructor` on a builtin extern-class receiver walks the extern
 * inheritance chain to the `Object` base class (its only declarer) and emits an
 * `Object_get_constructor` host import. In standalone mode that host read
 * resolves to `undefined` and a bare builtin identifier compiles to the same
 * null-externref carrier (builtins have no native constructor-object identity
 * yet), so the comparisons already pass tautologically — the import is pure dead
 * weight. The compiler now folds `.constructor` on a builtin receiver to that
 * same bare-builtin carrier (`ref.null.extern`), host-free. The gc/host lane is
 * untouched (the fold is `ctx.standalone`-gated) and keeps the real import.
 */

const HOST_IMPORT = "env::Object_get_constructor";

async function standaloneImports(src: string): Promise<string[]> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  return r.imports.map((i) => `${i.module}::${i.name}`);
}

async function gcImports(src: string): Promise<string[]> {
  const r = await compile(src, { skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  return r.imports.map((i) => `${i.module}::${i.name}`);
}

async function runsStandalone(src: string): Promise<void> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  // The test export must exist and execute without trapping.
  (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#2999 builtin .constructor host-import fold (standalone)", () => {
  const shapes: Array<[string, string]> = [
    ["Set.prototype.constructor", "const c: any = Set.prototype.constructor; return c ? 0 : 0;"],
    ["WeakMap.prototype.constructor", "const c: any = WeakMap.prototype.constructor; return c ? 0 : 0;"],
    ["WeakRef.prototype.constructor", "const c: any = WeakRef.prototype.constructor; return c ? 0 : 0;"],
    ["WeakSet.prototype.constructor", "const c: any = WeakSet.prototype.constructor; return c ? 0 : 0;"],
    ["RegExp.prototype.constructor", "const c: any = RegExp.prototype.constructor; return c ? 0 : 0;"],
    ["(new WeakMap()).constructor", "const c: any = (new WeakMap()).constructor; return c ? 0 : 0;"],
    ["regexp literal .constructor", "const re = /[^a]*/; const c: any = re.constructor; return c ? 0 : 0;"],
  ];

  for (const [name, body] of shapes) {
    it(`drops ${HOST_IMPORT} for ${name}`, async () => {
      const src = `export function test(): number { ${body} }`;
      const imports = await standaloneImports(src);
      expect(imports, `leaked ${HOST_IMPORT}`).not.toContain(HOST_IMPORT);
      await runsStandalone(src);
    });
  }

  it("keeps the real Object_get_constructor read in gc/host mode (fold is standalone-only)", async () => {
    // The fold is gated on ctx.standalone. In the default gc/host lane
    // `Object_get_constructor` returns a genuine host value, so the import MUST
    // remain — proving the change did not broaden into the host lane.
    const src = `export function test(): number { const c: any = Set.prototype.constructor; return c ? 0 : 0; }`;
    const imports = await gcImports(src);
    expect(imports, "gc/host lane must keep the real constructor read").toContain(HOST_IMPORT);
  });
});
