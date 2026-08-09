// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4120 — `typeof <builtin>` stopped answering "function" once the builtin was
// reified into a value.
//
// A reified builtin constructor is backed in standalone by a plain `$Object`
// singleton (#3006/#2907); the `typeof` natives classify by `ref.test` over
// closure wrapper structs, so that carrier answered `"object"`. `typeof` cannot
// throw, so this was a SILENT wrong answer, and test262's `isConstructor(f)`
// (whose first statement is a `typeof f !== "function"` guard) threw before
// testing anything — 118 standalone official rows.
//
// ⚠ EVERY assertion here goes through a one-parameter indirection. The in-place
// spelling `typeof Set === "function"` is answered at COMPILE time and never
// touches the value carrier, so an in-place-only probe measures the static path
// and reads as "already fine" (the trap recorded in the issue, and in
// [[reference_constant_folded_probe_tests_the_static_path]]). The in-place form
// is asserted too, but only as a CONTROL that must keep working.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const MODES = [
  { label: "host", opts: {} },
  { label: "standalone", opts: { target: "standalone" } },
] as const;

/** `typeof` of `expr`, observed through an `any`-typed parameter hop. */
const INDIRECT_PROLOG = `
function tag(f: any): number {
  const t: any = typeof f;
  if (t === "function") return 1;
  if (t === "object") return 2;
  if (t === "undefined") return 3;
  return 9;
}
`;

async function run(src: string, opts: Record<string, unknown>): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, ...opts });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "binary should validate").toBe(true);
  const importObject: Record<string, unknown> = (result.importObject ?? {}) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(result.binary, importObject as WebAssembly.Imports);
  (importObject as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

/** 1 = "function", 2 = "object", 3 = "undefined" — through a parameter. */
async function indirectTypeof(expr: string, opts: Record<string, unknown>): Promise<unknown> {
  return run(`${INDIRECT_PROLOG}\nexport function test(): number { const v: any = ${expr}; return tag(v); }\n`, opts);
}

describe("#4120 — typeof of a reified builtin", () => {
  for (const { label, opts } of MODES) {
    describe(`[${label}]`, () => {
      // The reified-constructor carriers. All of these read "object" on main in
      // standalone; the host lane already answered "function" (a real JS value),
      // so this arm is a no-regression guard there.
      for (const name of ["Set", "Map", "WeakMap", "WeakSet", "RegExp", "Array", "Object", "Error", "TypeError"]) {
        it(`typeof ${name} through a parameter is "function"`, async () => {
          expect(await indirectTypeof(name, opts)).toBe(1);
        });
      }

      // The namespace carriers are NOT callable — `typeof Math === "object"` is
      // the spec answer, and a brand that claimed otherwise would be the same
      // class of silent wrong answer this issue fixes, pointed the other way.
      for (const name of ["Math", "JSON", "Reflect"]) {
        it(`typeof ${name} through a parameter stays "object"`, async () => {
          expect(await indirectTypeof(name, opts)).toBe(2);
        });
      }

      it('a plain object stays "object" and a user function stays "function"', async () => {
        expect(await indirectTypeof("{ a: 1 }", opts)).toBe(2);
        expect(
          await run(
            `${INDIRECT_PROLOG}\nfunction u(): number { return 1; }\nexport function test(): number { const v: any = u; return tag(v); }\n`,
            opts,
          ),
        ).toBe(1);
      });

      // These two are standalone-only for a HARNESS reason, not a semantic one:
      // a host module whose whole body folds away still declares the
      // `wasm:js-string` / `string_constants` import modules, which this file's
      // minimal `run()` does not synthesise (pre-existing, unrelated to #4120).
      // The standalone lane is the one #4120 is about.
      if (label !== "standalone") return;

      it("CONTROL — the in-place (constant-folded) spelling still answers correctly", async () => {
        expect(
          await run(
            `export function test(): number {
               let n = 0;
               if (typeof Set === "function") n += 1;
               if (typeof Array === "function") n += 2;
               if (typeof Math === "object") n += 4;
               return n;
             }`,
            opts,
          ),
        ).toBe(7);
      });

      it("the MATERIALIZED typeof result agrees with the inline predicate", async () => {
        // `const t = typeof Set` goes through the `__typeof` native rather than
        // the inline tag compare; #2984's path-dependence is that the two used
        // to disagree.
        expect(
          await run(
            `export function test(): number {
               const t: any = typeof Set;
               return t === "function" ? 1 : 0;
             }`,
            opts,
          ),
        ).toBe(1);
      });

      // The `[[Construct]]` half. The carrier brand tracks [[Call]] and
      // [[Construct]] as SEPARATE bits, and `Reflect.construct`'s newTarget
      // check (§7.2.4 IsConstructor) reads the second one. This is the shape
      // test262's `isConstructor` harness uses.
      it("Reflect.construct accepts a reified builtin ctor as newTarget", async () => {
        expect(
          await run(
            `export function test(): number {
               try {
                 Reflect.construct(function () {}, [], Set);
               } catch (e) {
                 return 0;
               }
               return 1;
             }`,
            opts,
          ),
        ).toBe(1);
      });
    });
  }
});
