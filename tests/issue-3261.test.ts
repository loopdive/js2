// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3261 — standalone must not leak `env::__host_loose_eq` / `env::__extern_toString`.
//
// Three runtime helpers historically registered a JS-**host** import with no
// standalone (`--target standalone`, `noJsHost`) native arm, violating the
// dual-mode contract that standalone mode is pure Wasm with no `env::*` host
// imports (CLAUDE.md "Dual-mode: JS host optional"; #1470/#1471/#1180 closed the
// same class for other helpers):
//
//   | Helper              | Reached from (host lane)                         |
//   | ------------------- | ------------------------------------------------ |
//   | `__host_loose_eq`   | binary-ops loose-equality (`==` / `!=`) coercion |
//   | `__extern_toString` | any→string coercion (concat, template, String()) |
//   | `__date_format`     | Date formatting — CARVED OUT to #3174            |
//
// The two core helpers were driven host-free on the standalone lane by the
// intervening native work — `__host_loose_eq` via the native IsLooselyEqual
// tail (#2081 `__any_eq` / #1917 `emitAnyEqFromExternTemps` and the native
// `__str_to_number` string⇄number arm in binary-ops.ts), and `__extern_toString`
// via its native `registerNative` registration in `ensureObjectRuntime`
// (object-runtime.ts) plus the native ToString path (#1470). Contrast the
// gc-host lane, which still (correctly) imports `env::__host_loose_eq` /
// `env::__extern_to_string_default` for the identical programs.
//
// This is the permanent regression guard required by the #2093 probe-coverage
// gate: it locks in the no-`env::*`-leak property so a future refactor of an
// equality / ToString arm that reintroduces a bare host import (an arm that
// forgets the `noJsHost` native route) fails here instead of silently emitting
// an unsatisfiable standalone module.
//
// `__date_format` (native Date-to-string) is the one genuinely harder sub-part
// and overlaps the standalone Date cluster — it is deferred to #3174, so it is
// out of scope here.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Host-import names that MUST NOT appear on the standalone lane (#3261). */
const FORBIDDEN_STANDALONE_HOST_IMPORTS = ["__host_loose_eq", "__extern_toString", "__extern_to_string_default"];

interface StandaloneProbe {
  envImports: string[];
  result: unknown;
}

/**
 * Compile `src` with `target: "standalone"`, assert the module has no `env::*`
 * host imports at all (a standalone module must instantiate against an EMPTY
 * import object), instantiate, and return the `test()` export result plus the
 * observed `env` import names.
 */
async function standaloneProbe(src: string): Promise<StandaloneProbe> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "standalone module failed WebAssembly.validate").toBe(true);
  const mod = new WebAssembly.Module(r.binary);
  const envImports = WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  // Instantiate against an EMPTY import object — any leaked `env::*` import
  // would throw a LinkError here, so this is the strongest possible guard.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const result = (instance.exports as { test: () => unknown }).test();
  return { envImports, result };
}

describe("#3261 — standalone equality has no env::__host_loose_eq leak", () => {
  it("mixed-type loose equality via any operands ('1' == 1) is host-free and correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `function g(): any { return "1"; }
       function h(): any { return 1; }
       export function test(): boolean { return g() == h(); }`,
    );
    expect(envImports).not.toContain("__host_loose_eq");
    expect(result).toBe(1); // JS: "1" == 1 → true
  });

  it("boolean == string ('' == false) is host-free and correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         let b: boolean = false; let s: string = "";
         return (b as any) == (s as any);
       }`,
    );
    expect(envImports).not.toContain("__host_loose_eq");
    expect(result).toBe(1); // JS: false == "" → true (both ToNumber 0)
  });

  it("concrete string == number ('1' == 1) is host-free and correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         let s: string = "1"; let n: number = 1;
         return s == n;
       }`,
    );
    expect(envImports).not.toContain("__host_loose_eq");
    expect(result).toBe(1);
  });

  it("string != number ('x' != 1) is host-free and correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean {
         let s: string = "x"; let n: number = 1;
         return s != n;
       }`,
    );
    expect(envImports).not.toContain("__host_loose_eq");
    expect(result).toBe(1); // JS: "x" != 1 → true (ToNumber("x") is NaN)
  });
});

describe("#3261 — standalone ToString has no env::__extern_toString leak", () => {
  // NOTE: a standalone string-returning export yields a native WasmGC
  // `ref $AnyString` (an opaque `{}` from JS), so the ToString *result* is
  // verified IN-WASM via a native string `===` compare (which is host-free on
  // the standalone lane) and returned as a boolean; the export type stays
  // numeric so the JS boundary round-trips cleanly.
  it("object concat ('' + {}) is host-free and correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `function g(): any { return { x: 1 }; }
       export function test(): boolean { return ("" + g()) === "[object Object]"; }`,
    );
    expect(envImports).not.toContain("__extern_toString");
    expect(envImports).not.toContain("__extern_to_string_default");
    expect(result).toBe(1); // "" + {x:1} === "[object Object]"
  });

  it("String(any-boxed number) is host-free and correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `export function test(): boolean { const a: any = 5; return String(a) === "5"; }`,
    );
    expect(envImports).not.toContain("__extern_toString");
    expect(result).toBe(1);
  });

  it("template literal on an any operand is host-free and correct", async () => {
    const { envImports, result } = await standaloneProbe(
      `function g(): any { return 7; }
       export function test(): boolean { return \`v=\${g()}\` === "v=7"; }`,
    );
    expect(envImports).not.toContain("__extern_toString");
    expect(result).toBe(1);
  });
});

describe("#3261 — standalone lane is fully host-import-free for these programs", () => {
  // A standalone module must instantiate against `{}` — assert ZERO env imports
  // for the representative equality + ToString programs (the umbrella guard).
  const programs: Array<[string, string]> = [
    [
      "loose-eq any==any",
      `function g():any{return "1";} function h():any{return 1;} export function test():boolean{return g()==h();}`,
    ],
    ["concat object", `function g():any{return {x:1};} export function test():string{return ""+g();}`],
    ["String(any number)", `export function test():string{const a:any=5;return String(a);}`],
  ];
  for (const [label, src] of programs) {
    it(`${label}: no env::* imports`, async () => {
      const { envImports } = await standaloneProbe(src);
      const leaked = envImports.filter((n) => FORBIDDEN_STANDALONE_HOST_IMPORTS.includes(n));
      expect(leaked, `leaked host imports: ${leaked.join(", ")}`).toEqual([]);
      expect(envImports, `standalone module must have no env imports, got: ${envImports.join(", ")}`).toEqual([]);
    });
  }
});
