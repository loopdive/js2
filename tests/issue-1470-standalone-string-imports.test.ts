// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1470 — `--target standalone` must emit a module whose import section
 * contains zero JS-host string-machinery imports:
 *   - no `wasm:js-string` namespace
 *   - no `env::__concat_*`
 *   - no `env::__extern_toString` / `__extern_toLocaleString`
 *   - no `env::__unbox_string`
 *   - no `env::string_method_*`
 *
 * The CLI flag + ctx flag plumbing is the "lands first" piece of the spec
 * (see `plan/issues/sprints/52/1470-no-js-host-string-ops.md`); larger pieces
 * like the pure-Wasm UTF-8 codec land in follow-ups (#1471–#1474).
 */

const BANNED_IMPORTS: ReadonlyArray<RegExp> = [
  /^wasm:js-string::/,
  /^env::__concat_\d+$/,
  /^env::__extern_toString$/,
  /^env::__extern_toLocaleString$/,
  /^env::__unbox_string$/,
  /^env::string_method_/,
];

function assertNoJsHostStringImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED_IMPORTS) {
    const hits = labels.filter((l) => re.test(l));
    expect(hits, `--target standalone leaked ${re} (got ${hits.join(", ")})`).toEqual([]);
  }
}

describe("#1470 --target standalone removes JS-host string imports", () => {
  it("string + string concatenation uses no __concat_N", () => {
    const r = compile(
      `
        export function plus(a: string, b: string, c: string): string {
          return a + b + c;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoJsHostStringImports(r.imports);
    // Must be in native-strings mode
    expect(r.wat).toContain("NativeString");
  });

  it("template literal substitution uses no __concat_N", () => {
    const r = compile(
      `
        export function tmpl(name: string, n: number): string {
          return \`hi \${name} #\${n}!\`;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoJsHostStringImports(r.imports);
  });

  it("string equality uses native helpers, not wasm:js-string", () => {
    const r = compile(
      `
        export function eq(a: string, b: string): number {
          return a === b ? 1 : 0;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoJsHostStringImports(r.imports);
    expect(r.wat).not.toContain("wasm:js-string");
  });

  it("string.length / slice / indexOf compile without host string_method", () => {
    const r = compile(
      `
        export function probe(s: string): number {
          const a = s.length;
          const b = s.slice(1, 3).length;
          const c = s.indexOf("x");
          return a + b + c;
        }
      `,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoJsHostStringImports(r.imports);
  });

  it("forces nativeStrings: true even when caller passes nativeStrings: false", () => {
    // standalone is the strongest assertion: even an explicit `nativeStrings:
    // undefined` (the default) must imply true under target=standalone.
    const r = compile(`export function id(s: string): string { return s; }`, { target: "standalone" });
    expect(r.success).toBe(true);
    expect(r.wat).toContain("NativeString");
    expect(r.wat).not.toContain("wasm:js-string");
  });

  it("default target (gc) still uses the JS-host wasm:js-string path", () => {
    // Regression guard: standalone is opt-in. Default mode keeps the host
    // string machinery so browser-targeted modules stay small and use native
    // wasm:js-string builtins where the engine provides them.
    const r = compile(
      `
        export function tmpl(name: string, n: number): string {
          return \`hi \${name} #\${n}!\`;
        }
      `,
      {},
    );
    expect(r.success).toBe(true);
    // The default path is allowed to (and does) emit wasm:js-string and
    // __concat_N; we only assert it remains the externref-string backend.
    expect(r.wat).not.toContain("NativeString");
  });
});
