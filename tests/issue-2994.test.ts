import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2994 — eliminate the `env::Object_isPrototypeOf` host-import leak.
 *
 * Round-5 leak analysis flagged 12 execution-verified standalone passes whose
 * sole `env::` import was `Object_isPrototypeOf`. They are all
 * `Function.prototype.isPrototypeOf(<callable>)` or
 * `Object.prototype.isPrototypeOf(<object>)` — provably `true` shapes that the
 * WasmGC-native `__isPrototypeOf` cannot answer, because builtin
 * prototypes/constructors are not linked into the native `$Object.$proto`
 * chain in standalone mode (a substrate gap). Instead the compiler now
 * statically folds these provable shapes (mirroring `tryStaticInstanceOf`'s
 * `instanceof Object` short-circuit, #1729), so the host import is never
 * emitted. Undecidable shapes still fall through to the existing host path.
 */

const HOST_IMPORT = "env::Object_isPrototypeOf";

async function standaloneImports(src: string): Promise<string[]> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  return r.imports.map((i) => `${i.module}::${i.name}`);
}

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#2994 Object.prototype/Function.prototype.isPrototypeOf static fold", () => {
  const foldedTrue: Array<[string, string]> = [
    ["Function.prototype.isPrototypeOf(builtin ctor)", "return Function.prototype.isPrototypeOf(Number) ? 1 : 0;"],
    ["Function.prototype.isPrototypeOf(Object)", "return Function.prototype.isPrototypeOf(Object) ? 1 : 0;"],
    [
      "Object.prototype.isPrototypeOf(builtin proto)",
      "return Object.prototype.isPrototypeOf(Number.prototype) ? 1 : 0;",
    ],
    ["Object.prototype.isPrototypeOf(new X())", "return Object.prototype.isPrototypeOf(new Array()) ? 1 : 0;"],
  ];

  for (const [name, body] of foldedTrue) {
    it(`folds ${name} to true with no host import`, async () => {
      const src = `export function test(): number { ${body} }`;
      const imports = await standaloneImports(src);
      expect(imports, `leaked ${HOST_IMPORT}`).not.toContain(HOST_IMPORT);
      expect(await runStandalone(src)).toBe(1);
    });
  }

  it("does NOT mis-fold Function.prototype.isPrototypeOf(non-callable object)", async () => {
    // A plain object is not in Function.prototype's descendants — the correct
    // answer is false. The static fold must decline (it only asserts the
    // provably-true shapes).
    //
    // (#2916) The proof of "not folded" is now the ANSWER, not the presence of
    // `env::Object_isPrototypeOf`: the undecidable shape used to fall through to
    // that host import, which a standalone binary cannot satisfy (9 sole-import
    // leaks in the ≤ES5 scope). It now falls through to the WasmGC-native
    // `$Object.$proto` walk instead, so the module must both answer `0` AND
    // carry no host import.
    const src = `export function test(): number { const o: any = {}; return Function.prototype.isPrototypeOf(o) ? 1 : 0; }`;
    const imports = await standaloneImports(src);
    expect(imports, `standalone must not leak ${HOST_IMPORT}`).not.toContain(HOST_IMPORT);
    expect(await runStandalone(src), "must not mis-fold to a constant true").toBe(0);
  });
});
