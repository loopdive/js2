// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

// #4454 — `Missing __make_getter_callback import` on a spread-bearing object
// literal that also carries a plain-named method shorthand.
//
// `objectLiteralSpreadTakesHostPath` (literals.ts) diverts such a literal to the
// host plain-object path, whose MethodDeclaration arm installs the method as a
// real runtime own property via `emitObjectLiteralMethodFn` → JS-host/GC routes
// that through the `this`-forwarding `__make_getter_callback` bridge. The
// single-pass import collector only pre-registered that bridge for get/set
// accessors and computed method keys, so the emit site found no import in
// `ctx.funcMap` and hard-CE'd (closures.ts `Missing ${makeCallbackName} import`).
//
// Found by the #4420 self-hosting sweep: `compileFiles("src/shape-inference.ts")`
// pulls in `src/ts-api.ts`, which synthesizes its TS7 shim as
// `{ ...astMod, ...isMod, factory, createProgram() {…}, createSourceFile() {…},
// createCompilerHost() {…} }` — three methods, three CEs.

describe("#4454 spread + method-shorthand object literal registers the getter-callback bridge", () => {
  it("compiles to an engine-valid module and runs in JS-host mode", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const src: any = { a: 40 };
        const o: any = { ...src, m() { return this.a + 2; } };
        return o.m();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("handles the multi-method / no-annotation shape from src/ts-api.ts", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const astMod: any = { a: 1 };
        const isMod: any = { b: 2 };
        const o = {
          ...astMod,
          ...isMod,
          tag: 4,
          first() { return 10; },
          second() { return 20; },
          third() { return 30; },
        };
        return o.first() + o.second() + o.third() + o.tag;
      }
    `);
    expect(exports.test()).toBe(64);
  });

  it("no longer emits the missing-import error for any spread+method shape", async () => {
    const sources = [
      // no contextual type
      `const s: any = { a: 1 };\nconst o = { ...s, m() { return 1; } };\nexport function test(): number { return o.m(); }`,
      // `any` contextual type
      `const s: any = { a: 1 };\nconst o: any = { ...s, m() { return 1; } };\nexport function test(): number { return o.m(); }`,
      // index-signature contextual type (the src/ts-api.ts shape)
      `const s: Record<string, unknown> = { a: 1 };\nconst o: Record<string, unknown> = { ...s, m() { return 1; } };\nexport function test(): number { return 0; }`,
      // string-literal method key
      `const s: any = { a: 1 };\nconst o: any = { ...s, "m"() { return 1; } };\nexport function test(): number { return 0; }`,
    ];
    for (const src of sources) {
      const r = await compile(src, {});
      const missing = r.errors.filter((e) => e.message.includes("Missing __make_getter_callback import"));
      expect(
        missing.map((e) => e.message),
        src,
      ).toEqual([]);
      expect(r.success, `${src}\n${r.errors.map((e) => e.message).join("\n")}`).toBe(true);
      expect(WebAssembly.validate(r.binary), src).toBe(true);
    }
  });

  it("standalone keeps the method host-free (no env:: bridge import leaked)", async () => {
    const r = await compile(
      `const s: any = { a: 1 };\nconst o: any = { ...s, m() { return 1; } };\nexport function test(): number { return 0; }`,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    const bridge = WebAssembly.Module.imports(mod).filter((i) => i.name === "__make_getter_callback");
    expect(bridge).toHaveLength(0);
  });

  it("a concretely-annotated spread target still takes the struct path (no unused import)", async () => {
    const r = await compile(
      `const s = { a: 1 };\nconst o: { a: number; m(): number } = { ...s, m() { return 2; } };\nexport function test(): number { return o.m(); }`,
      {},
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    const bridge = WebAssembly.Module.imports(mod).filter((i) => i.name === "__make_getter_callback");
    expect(bridge).toHaveLength(0);
  });

  // The original repro is `compileFiles("src/shape-inference.ts")` — the failing
  // literal lives in the imported `src/ts-api.ts`, not in the entry file, so the
  // bug only surfaces through a multi-module graph. Compiling the compiler's own
  // graph needs far more than the 512 MB per-fork heap vitest allots, so the
  // regression test reproduces the same cross-module shape with `compileMulti`;
  // the real-file run is recorded in the issue's Results section.
  it("multi-module: the failing literal in an IMPORTED module compiles", async () => {
    const files = {
      "./ts-api.ts": `
        export function makeShim(): any {
          const astMod: any = { a: 1 };
          const isMod: any = { b: 2 };
          return {
            ...astMod,
            ...isMod,
            createProgram() { return 7; },
            createSourceFile() { return 8; },
            createCompilerHost() { return 9; },
          };
        }
      `,
      "./entry.ts": `
        import { makeShim } from "./ts-api";
        export function test(): number {
          const shim: any = makeShim();
          return shim.createProgram() + shim.createSourceFile() + shim.createCompilerHost();
        }
      `,
    };
    const r = await compileMulti(files, "./entry.ts");
    const missing = r.errors.filter((e) => e.message.includes("Missing __make_getter_callback import"));
    expect(missing.map((e) => e.message)).toEqual([]);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
