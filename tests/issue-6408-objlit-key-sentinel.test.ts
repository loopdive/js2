import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #6408 — standalone object-literal data/method property keys must not bake the
 * `-1` string-global sentinel into a `global.get`.
 *
 * Defect: in `--target standalone` (`nativeStrings` / `ctx.standalone`) there is
 * NO host string-constant global — `addStringConstantGlobal` records the `-1`
 * sentinel (the #51 / #1888 class). The object-literal compiler's accessor arm
 * was fixed (#1888 S5c) to materialize its key via `stringConstantExternrefInstrs`,
 * but the sibling PropertyAssignment + MethodDeclaration arms in the same loop
 * still pushed a raw `{ op: "global.get", index: stringGlobalMap.get(key) }`.
 * So any object literal that takes the accessor path (≥1 getter/setter) AND has
 * a data property or a regular method emitted `global.get -1` for the data/method
 * key → "global index out of range — -1" binary emit error.
 *
 * Fix: route both arms through `stringConstantExternrefInstrs` (native-string
 * inline under standalone; host `global.get` under GC — byte-identical there).
 *
 * These minimal repros each failed to compile under `--target standalone` before
 * the fix; GC mode was always fine.
 */

async function compilesStandalone(source: string): Promise<void> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
}

describe("#6408 — object-literal data/method keys avoid the -1 string-global sentinel (standalone)", () => {
  it("data property + getter (top-level literal)", async () => {
    await compilesStandalone(
      `const o = { index: 0, get val() { return this.index; } };
       export function run(): number { return (o as any).index; }`,
    );
  });

  it("data property + getter inside a returned object literal (method body)", async () => {
    await compilesStandalone(
      `const obj = { make() { return { index: 0, get val() { return this.index; } }; } };
       export function run(): number { (obj as any).make(); return 0; }`,
    );
  });

  it("computed Symbol.iterator method returning a data+getter literal", async () => {
    await compilesStandalone(
      `const obj = {
         [Symbol.iterator]() {
           return { index: 0, next() { return { value: 1, done: false }; }, get val() { return this.index; } };
         }
       };
       export function run(): number { (obj as any)[Symbol.iterator](); return 0; }`,
    );
  });

  it("regular method + getter sibling (method-key arm)", async () => {
    await compilesStandalone(
      `const o = { greet() { return 1; }, get val() { return 2; } };
       export function run(): number { return (o as any).greet(); }`,
    );
  });
});
