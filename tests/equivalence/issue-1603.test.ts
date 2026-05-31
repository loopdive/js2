import { describe, it, expect } from "vitest";
import { compileToWasm, assertEquivalent, compile } from "./helpers.js";

// #1603 — optional-chaining short-circuit emitted invalid wasm:
// `ref.is_null expected reference type, found local.tee of type i32`.
//
// Root cause: the `?.` lowering unconditionally emitted `ref.is_null` on the
// receiver, but a module-level `const x = undefined` is stored as an i32
// global, so reading it inside a closure yields an i32 — applying `ref.is_null`
// to a non-reference value is invalid wasm. A non-reference receiver here is the
// compiler's representation of `undefined`/`null`, so the chain short-circuits.
describe("optional chaining on non-reference (undefined) receiver (#1603)", () => {
  it("module-level `const x = undefined` accessed via ?. inside a closure compiles to valid wasm", async () => {
    // Mirrors test262 language/expressions/optional-chaining/
    // iteration-statement-for-of-type-error.js, which captures a
    // module-level undefined const inside a callback and short-circuits `?.`.
    const exports = await compileToWasm(`
      const obj = undefined;
      function run(cb: () => void): void { /* don't invoke — undefined would throw */ }
      export function test(): number {
        run(function () {
          const v = (obj as any)?.a;
        });
        return 0;
      }
    `);
    expect(exports.test!()).toBe(0);
  });

  it("optional property access on undefined const short-circuits (?? fallback runs)", async () => {
    await assertEquivalent(
      `
      const obj = undefined;
      export function test(): number {
        return (obj as any)?.a ?? 7;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("optional property AND optional call on an undefined const both compile to valid wasm", async () => {
    // The optional-call lowering carried the same unguarded `ref.is_null`
    // (calls-optional.ts). Both forms must validate when the receiver lowers to
    // a non-reference value type.
    const src = `
      const obj = undefined;
      export function test(): number {
        const a = (obj as any)?.a ?? 1;
        const b = (obj as any)?.foo() ?? 2;
        return a + b;
      }
    `;
    const result = await compile(src);
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });
});
