// #1914 — standalone RegExp reflection (.source/.flags/flag booleans/.lastIndex)
// and exec/match result shape (.index/.input), plus the any-boundary string
// equality fix that the whole assertion family depends on.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.success) {
    throw new Error("compile failed: " + result.errors.map((e) => e.message).join("; "));
  }
  // Acceptance criterion: no env.RegExp_* (or any env) imports in standalone.
  const envImports = result.imports.filter((i) => i.module === "env");
  expect(envImports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1914 standalone RegExp reflection", () => {
  it("reads .source (escaped per EscapeRegExpPattern §22.2.6.13.1)", async () => {
    expect(
      await runStandalone(`
        const re = /ab+c/gi;
        function test(): number { return re.source === "ab+c" ? 1 : 0; }
        export { test };
      `),
    ).toBe(1);
  });

  it("escapes / in .source and maps empty pattern to (?:)", async () => {
    expect(
      await runStandalone(`
        const slash = new RegExp("/");
        const empty = new RegExp("");
        function test(): number {
          if (slash.source !== "\\\\/") return 1;
          if (empty.source !== "(?:)") return 2;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("reads .flags in spec order (§22.2.6.4)", async () => {
    expect(
      await runStandalone(`
        const re = /a/gim;
        function test(): number { return re.flags === "gim" ? 1 : 0; }
        export { test };
      `),
    ).toBe(1);
  });

  it("reads flag booleans via RegExpHasFlag", async () => {
    expect(
      await runStandalone(`
        const re = /a/gi;
        function test(): number {
          if (!re.global) return 1;
          if (!re.ignoreCase) return 2;
          if (re.multiline) return 3;
          if (re.sticky) return 4;
          if (re.dotAll) return 5;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("reads and writes .lastIndex (plain data property, §22.2.7.1)", async () => {
    expect(
      await runStandalone(`
        const re = /a/;
        function test(): number {
          if (re.lastIndex !== 0) return 1;
          re.lastIndex = 7;
          if (re.lastIndex !== 7) return 2;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });
});

describe("#1914 standalone exec/match result shape", () => {
  it("exposes .index, .input, [0], and .length on a local exec result", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const m = /\\d{2,4}/.exec("the answer is 42");
          if (m === null) return 1;
          if (m.length !== 1) return 2;
          if (m.index !== 14) return 3;
          if (m.input !== "the answer is 42") return 4;
          if (m[0] !== "42") return 5;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("exposes the same shape on a module-global var exec result (S15 pattern)", async () => {
    expect(
      await runStandalone(`
        var __executed = /\\d{2,4}/.exec("the answer is 42");
        function test(): number {
          if (__executed === null) return 1;
          if (__executed.length !== 1) return 2;
          if (__executed.index !== 14) return 3;
          if (__executed.input !== "the answer is 42") return 4;
          if (__executed[0] !== "42") return 5;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("carries captures and index on String.prototype.match results", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const m = "xx2026-06yy".match(/(\\d{4})-(\\d{2})/);
          if (m === null) return 1;
          if (m.index !== 2) return 2;
          if (m[1] !== "2026") return 3;
          if (m[2] !== "06") return 4;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });
});

describe("#1914 any-boundary string equality (isSameValue gateway)", () => {
  it("compares string content for any === any (both sides dynamic)", async () => {
    expect(
      await runStandalone(`
        function sameValue(a: any, b: any): boolean { return a === b; }
        function test(): number {
          if (!sameValue("answer", "answer")) return 1;
          if (sameValue("answer", "other")) return 2;
          if (sameValue("answer", 42)) return 3;
          const arr = ["42"];
          if (!sameValue(arr[0], "42")) return 4;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("compares string content for any === string-typed (mixed sides)", async () => {
    expect(
      await runStandalone(`
        function check(actual: any, expected: string): boolean { return actual === expected; }
        function test(): number {
          if (!check("answer", "answer")) return 1;
          if (check("answer", "other")) return 2;
          const m = /\\d+/.exec("a 42");
          if (m === null) return 3;
          if (!check(m[0], "42")) return 4;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("preserves identity semantics for non-string refs", async () => {
    expect(
      await runStandalone(`
        function same(a: any, b: any): boolean { return a === b; }
        function test(): number {
          const o = { x: 1 };
          const p = { x: 1 };
          if (!same(o, o)) return 1;
          if (same(o, p)) return 2;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });
});
