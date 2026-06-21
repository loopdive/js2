// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2510 — a tagged template whose result is BOUND (`const r = tag`…`;`) emitted
 * an INVALID module under `--target standalone`:
 *
 *   array.new_fixed[0] expected type externref, found struct.new of (ref $NativeString)
 *
 * The strings/raw arrays of the template object are typed `externref`, but in
 * native-strings mode `compileStringLiteral` materializes a `(ref $NativeString)`
 * struct, not an externref — pushing the struct straight into the externref
 * `array.new_fixed` mistyped the element. `compileTaggedTemplateExpression` now
 * bridges each native-string literal to externref (`extern.convert_any`) before
 * `array.new_fixed`, matching the array element type. (Host-string mode already
 * returns externref, so the bridge is a no-op there.)
 *
 * These assert the module is VALID + JS-host-free and that the structurally
 * observable template shape is correct: `strings.length` (number of cooked
 * parts) and the rest-substitutions count. (Reading an element's string CONTENT
 * back via `strings[0].length` is a separate externref-boundary introspection
 * gap, #2190/#35 family — it returns 0 on the gc target too — so it is out of
 * scope here.)
 */

async function instantiateStandalone(source: string) {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  // No JS-host string imports must leak.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(
    labels.filter((l) => l.startsWith("wasm:js-string::") || /^env::__(unbox|extern)_/.test(l)),
    `leaked host imports: ${labels.join(", ")}`,
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number>;
}

describe("#2510 — tagged template (bound result) is valid standalone Wasm", () => {
  it("multi-substitution tagged template: valid module, correct cooked-parts count", async () => {
    // Pre-fix: invalid module ("array.new_fixed[0] expected externref, found
    // struct.new"). `t` reads strings.length — the structurally observable shape.
    const ex = await instantiateStandalone(`
      function t(s: any, ...v: any[]): number { return s.length; }
      export function partsCount(): number { return t\`a\${1}b\${2}c\`; }
    `);
    // "a${1}b${2}c" → 3 cooked parts ("a","b","c").
    expect(ex.partsCount!()).toBe(3);
  });

  it("no-substitution tagged template: valid module, single cooked part", async () => {
    const ex = await instantiateStandalone(`
      function w(s: any): number { return s.length; }
      export function noSubst(): number { return w\`just one part\`; }
    `);
    expect(ex.noSubst!()).toBe(1);
  });

  it("bound tagged-template result instantiates (the headline `const r = tag\`…\`` shape)", async () => {
    const ex = await instantiateStandalone(`
      function t(s: any, ...v: any[]): number { return s.length; }
      export function run(): number { const bound = t\`x\${1}y\`; return bound; }
    `);
    // "x${1}y" → 2 cooked parts ("x","y"). The point is it INSTANTIATES (valid).
    expect(ex.run!()).toBe(2);
  });
});
