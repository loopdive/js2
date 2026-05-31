// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1473 — Eliminate JS host error/exception ops for standalone Wasm.
//
// Before this change, every implicit/explicit throw and every catch that
// inspected the caught value routed through JS host imports:
//   - __throw_type_error      (spec-mandated TypeError throws)
//   - __throw_reference_error  (TDZ / unresolved-identifier ReferenceError)
//   - __get_caught_exception   (catch_all binding via a JS sidecar)
//   - __new_<Name> / __instanceof (JS-constructed Error + instanceof)
// None of those resolve under wasmtime / pure standalone Wasm.
//
// This issue makes `--target standalone` (and, for parity, `--target wasi`)
// build Error instances with the in-module `__new_<Name>` constructors
// (emitWasiErrorConstructor → $Error_struct), throw them through the existing
// `$exc` tag, bind the caught value directly from the tag payload (no
// catch_all sidecar), and discriminate `instanceof TypeError` / `Error` via
// the struct's `$tag` field — all without any JS host.
//
// Scope of the assertions below:
//   1. Import-section: a standalone build emits none of the banned error/
//      exception host imports.
//   2. Runtime (Node WebAssembly, no JS host): throw/catch binds a real Error
//      instance; instanceof + subtype discrimination behave per spec.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const BANNED_STANDALONE_IMPORTS = [
  "__throw_type_error",
  "__throw_reference_error",
  "__get_caught_exception",
  "__new_TypeError",
  "__new_ReferenceError",
  "__new_RangeError",
  "__new_SyntaxError",
  "__new_Error",
];

function envImportNames(r: { imports: { module: string; name: string }[] }): string[] {
  return r.imports.filter((i) => i.module === "env").map((i) => i.name);
}

describe("#1473 — no-JS-host error/exception ops (standalone mode)", () => {
  describe("import section", () => {
    it("emits no banned error/exception host imports for throw + catch + instanceof", async () => {
      const src = `
        export function test(): number {
          try {
            throw new TypeError("x");
          } catch (e: any) {
            return e instanceof TypeError ? 1 : 0;
          }
        }
      `;
      const r = await compile(src, { fileName: "t.ts", target: "standalone" });
      expect(r.success).toBe(true);
      const env = envImportNames(r);
      for (const banned of BANNED_STANDALONE_IMPORTS) {
        expect(env).not.toContain(banned);
      }
    });

    it("emits no __throw_reference_error import for a TDZ access", async () => {
      const src = `
        export function test(): number {
          let n = 0;
          try {
            n = x;
            let x = 1;
          } catch (e: any) {
            n = e instanceof ReferenceError ? 1 : 0;
          }
          return n;
        }
      `;
      const r = await compile(src, { fileName: "t.ts", target: "standalone" });
      expect(r.success).toBe(true);
      expect(envImportNames(r)).not.toContain("__throw_reference_error");
    });

    it("the __new_<Name> error constructors are in-module functions, not imports", async () => {
      const src = `
        export function test(): number {
          try { throw new RangeError("r"); } catch (e: any) { return 1; }
        }
      `;
      const r = await compile(src, { fileName: "t.ts", target: "standalone" });
      expect(r.success).toBe(true);
      const env = envImportNames(r);
      expect(env).not.toContain("__new_RangeError");
      // The in-module function should appear in the emitted module text.
      expect(r.wat).toContain("__new_RangeError");
    });
  });

  describe("runtime (no JS host)", () => {
    // The standalone error path still relies on a couple of generic, non-error
    // host functions (number boxing, generic property get) that are out of
    // scope for #1473's banned list. Supply minimal stubs so the module can be
    // exercised under Node; the *error/exception* behaviour is pure Wasm.
    const stubs = {
      env: {
        __box_number: (n: number) => n,
        __extern_get: (obj: any, key: string) => (obj == null ? undefined : obj[key]),
      },
    };

    async function run(src: string): Promise<unknown> {
      const r = await compile(src, { fileName: "t.ts", target: "standalone" });
      expect(r.success).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, stubs);
      return (instance.exports.test as () => unknown)();
    }

    it("catch binds a TypeError instance: `e instanceof TypeError`", async () => {
      const got = await run(`
        export function test(): number {
          try { throw new TypeError("x"); } catch (e: any) { return e instanceof TypeError ? 1 : 0; }
        }
      `);
      expect(got).toBe(1);
    });

    it("subtype discrimination: a RangeError is not a TypeError", async () => {
      const got = await run(`
        export function test(): number {
          try { throw new RangeError("r"); } catch (e: any) { return e instanceof TypeError ? 0 : 1; }
        }
      `);
      expect(got).toBe(1);
    });

    it("a RangeError IS a RangeError", async () => {
      const got = await run(`
        export function test(): number {
          try { throw new RangeError("r"); } catch (e: any) { return e instanceof RangeError ? 1 : 0; }
        }
      `);
      expect(got).toBe(1);
    });

    it("every error subtype is `instanceof Error`", async () => {
      const got = await run(`
        export function test(): number {
          let ok = 0;
          try { throw new TypeError("a"); } catch (e: any) { if (e instanceof Error) ok++; }
          try { throw new RangeError("b"); } catch (e: any) { if (e instanceof Error) ok++; }
          try { throw new SyntaxError("c"); } catch (e: any) { if (e instanceof Error) ok++; }
          try { throw new Error("d"); } catch (e: any) { if (e instanceof Error) ok++; }
          return ok;
        }
      `);
      expect(got).toBe(4);
    });

    it("typed catch + nested try/catch preserve the Error payload across rethrow", async () => {
      const got = await run(`
        export function test(): number {
          try {
            try { throw new TypeError("inner"); } catch (e: any) { throw e; }
          } catch (e: any) {
            return e instanceof TypeError ? 1 : 0;
          }
        }
      `);
      expect(got).toBe(1);
    });
  });
});
