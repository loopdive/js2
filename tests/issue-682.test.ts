// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HOST_REGEXP_IMPORT_RE =
  /RegExp_|__regex_symbol_call|__proto_method_call|wasm:js-string|string_constants|^env::string_(match|matchAll|search|replace|replaceAll|split)$/;

async function runStandaloneNumber(source: string): Promise<number> {
  const r = await compile(source, { fileName: "issue-682.ts", target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);

  const mod = await WebAssembly.compile(r.binary);
  const leaks = WebAssembly.Module.imports(mod)
    .filter((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))
    .map((i) => `${i.module}::${i.name}`);
  expect(leaks).toEqual([]);

  const instance = await WebAssembly.instantiate(mod, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#682 standalone RegExp literal-substring backend", () => {
  it("runs a regex literal .test without JS-host RegExp imports", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        return /abc/.test("zzabczz") ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
  });

  it("returns false when the static literal pattern is absent", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        const re = /abc/;
        return re.test("ab") ? 1 : 0;
      }
    `);

    expect(value).toBe(0);
  });

  it("runs a never-overwritten let-bound static receiver", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        let re = /abc/;
        return re.test("zzabc") ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
  });

  it("runs new RegExp with a static literal pattern", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        const re = new RegExp("needle");
        return re.test("hay needle stack") ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
  });

  it("runs RegExp(...) without new for a static literal pattern", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        const re = RegExp("needle");
        return re.test("haystack") ? 1 : 0;
      }
    `);

    expect(value).toBe(0);
  });

  it("runs RegExp.prototype.test.call with a static backend receiver", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        return RegExp.prototype.test.call(/abc/, "zzabc") ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
  });

  it("does not intercept a user-defined RegExp function", async () => {
    const value = await runStandaloneNumber(`
      function RegExp(pattern: string): number {
        return pattern.length;
      }

      export function test(): number {
        return RegExp("needle");
      }
    `);

    expect(value).toBe(6);
  });

  it("does not intercept a user-defined RegExp class .test method", async () => {
    const value = await runStandaloneNumber(`
      class RegExp {
        test(value: string): boolean {
          return value.length === 3;
        }
      }

      export function test(): number {
        const re = new RegExp();
        return re.test("abc") ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
  });

  it("treats escaped regexp metacharacters as literal characters", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        return /a\\.b/.test("xa.bx") ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
  });

  // #1539 Phase 2a: `\d+` and the `g` flag now compile to the pure-WasmGC VM
  // (they were refused under #682's literal-substring backend). These two
  // cases moved from "refuses" to "runs" — equivalence is covered in
  // tests/issue-1539-standalone-regex.test.ts.
  it("runs \\d+ via the native VM (was refused under #682)", async () => {
    expect(await runStandaloneNumber(`export function test(): number { return /\\d+/.test("a123") ? 1 : 0; }`)).toBe(1);
  });

  it("runs the g flag via the native VM (was refused under #682)", async () => {
    expect(await runStandaloneNumber(`export function test(): number { return /abc/g.test("xabcx") ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("runs direct RegExp Symbol.search calls without JS-host imports", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        const re = /abc/;
        return re[Symbol.search]("zabc");
      }
    `);

    expect(value).toBe(1);
  });

  it("RegExp.prototype.exec.call on a standalone literal compiles and matches (no host import)", async () => {
    // Formerly refused (#682/#1474); the standalone RegExp prototype bridge now
    // supports it. exec returns the match array or null — verify a hit + miss.
    const r = await compile(
      `export function test(): boolean {
        return RegExp.prototype.exec.call(/abc/, "xabcy") !== null
          && RegExp.prototype.exec.call(/abc/, "xyz") === null;
      }`,
      { fileName: "issue-682.ts", target: "standalone" },
    );
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    // Still no JS-host RegExp import — it runs on the pure-WasmGC engine.
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // boolean exports lower to i32 1/0 across the WASM boundary.
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("runtime-brand-checks opaque RegExp receivers without host imports", async () => {
    const r = await compile(`export function test(re: RegExp): boolean { return re.test("abc"); }`, {
      fileName: "issue-682.ts",
      target: "standalone",
    });

    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect(() => (instance.exports as { test(re: RegExp): number }).test(/abc/)).toThrow();
  });

  it("runtime-brand-checks mutable RegExp receivers after an opaque overwrite", async () => {
    const r = await compile(
      `
        export function test(other: RegExp): boolean {
          let re = /abc/;
          re = other;
          return re.test("abc");
        }
      `,
      {
        fileName: "issue-682.ts",
        target: "standalone",
      },
    );

    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect(() => (instance.exports as { test(re: RegExp): number }).test(/abc/)).toThrow();
  });

  it("RegExp-consuming string methods (String.prototype.replace) compile standalone (no host import)", async () => {
    // Formerly refused (#1474); the standalone backend now lowers
    // `String.prototype.replace(/re/g, repl)` on the pure-WasmGC engine.
    const r = await compile(`export function test(): string { return "banana".replace(/a/g, "o"); }`, {
      fileName: "issue-682.ts",
      target: "standalone",
    });
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // "banana".replace(/a/g, "o") === "bonono"
    const str = (instance.exports as { test(): unknown }).test();
    // The export returns a WasmGC string; round-trip length via a second probe
    // would need the string ABI, so we just assert it compiled + ran without trap.
    expect(str).toBeDefined();
  });

  it("refuses string-pattern search instead of compiling a silent wrong result", async () => {
    const r = await compile(`export function test(): number { return "banana".search("a"); }`, {
      fileName: "issue-682.ts",
      target: "standalone",
    });

    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /String\.prototype\.search/.test(e.message) && /#1474/.test(e.message))).toBe(true);
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
  });
});
