// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4607) `(typeof u).length` answered `NaN` instead of `9`.
 *
 * Root cause: `isStringType` (src/checker/type-mapper.ts) matched only the
 * `String` / `StringLiteral` type flags, never a UNION of string literals — and
 * `typeof x` is exactly that shape (`"string" | "number" | … | "function"`, an
 * 8-member string-literal union). With the predicate answering `false`, the
 * `.length` arm in `property-access-dispatch.ts` (`isStringType(objType) ||
 * receiverIsNativeStringValType(...)`) was skipped and the read fell through to
 * the generic dynamic member-get, whose vec-`$length` ladder misses a
 * `$AnyString` receiver and returns `undefined` → `__unbox_number` → `NaN`.
 *
 * Only the STANDALONE / native-string lane was wrong: in JS-host mode a string
 * is an `externref` and the host answers `.length` correctly, so both lanes are
 * pinned below.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Compile + run for the standalone (native-string) lane. */
async function runStandalone(body: string): Promise<number> {
  const result = await compile(`export function test() { ${body} }`, {
    fileName: "issue-4607.mjs",
    skipSemanticDiagnostics: true,
    target: "standalone",
  } as never);
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/** Compile + run a script-goal source in JS-host mode, returning console output. */
async function runHost(source: string): Promise<string[]> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4607.js",
    skipSemanticDiagnostics: true,
  } as never);
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const logs: string[] = [];
  const consoleProxy = {
    log: (...v: unknown[]) => logs.push(v.map(String).join(" ")),
    error: (...v: unknown[]) => logs.push(v.map(String).join(" ")),
    warn: () => {},
  };
  const imports = buildImports(result.imports, { console: consoleProxy } as never, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
  if (typeof moduleInit === "function") (moduleInit as () => void)();
  return logs;
}

/** The `typeof` census the issue asks for — every result string, its node length. */
const TYPEOF_CENSUS: ReadonlyArray<{ name: string; setup: string; expected: number }> = [
  { name: "an uninitialized var (undefined)", setup: "var u;", expected: 9 },
  { name: "a number", setup: "var u = 1;", expected: 6 },
  { name: "a string", setup: 'var u = "a";', expected: 6 },
  { name: "a boolean", setup: "var u = true;", expected: 7 },
  { name: "an object", setup: "var u = {};", expected: 6 },
  { name: "a function", setup: "var u = function () {};", expected: 8 },
];

describe("#4607 — a typeof result keeps its string carrier through a member access", () => {
  it("answers 9 for the reported repro (standalone)", async () => {
    expect(await runStandalone("var u; return (typeof u).length;")).toBe(9);
  });

  it("answers 9 for the reported repro (JS host)", async () => {
    expect(await runHost("var u; console.log((typeof u).length);")).toEqual(["9"]);
  });

  describe.each(TYPEOF_CENSUS)("typeof $name", ({ setup, expected }) => {
    it(`has .length ${expected} in standalone`, async () => {
      expect(await runStandalone(`${setup} return (typeof u).length;`)).toBe(expected);
    });

    it(`has .length ${expected} in JS host`, async () => {
      expect(await runHost(`${setup} console.log((typeof u).length);`)).toEqual([String(expected)]);
    });
  });

  it("keeps the carrier through a temporary binding", async () => {
    expect(await runStandalone("var u; var t = typeof u; return t.length;")).toBe(9);
  });

  it("keeps the carrier for string methods on the typeof result", async () => {
    // charAt / toUpperCase both TRAPPED ("dereferencing a null pointer") before
    // the fix — same predicate, a different consumer of it.
    expect(await runStandalone('var u; return (typeof u).charAt(0) === "u" ? 1 : 0;')).toBe(1);
    expect(await runStandalone("var u; return (typeof u).toUpperCase().length;")).toBe(9);
    expect(await runStandalone("var u; return (typeof u).slice(1).length;")).toBe(8);
    expect(await runStandalone('var u; return ((typeof u) + "!").length;')).toBe(10);
  });

  it("leaves an ordinary string literal's .length alone", async () => {
    expect(await runStandalone('var t = "undefined"; return t.length;')).toBe(9);
    expect(await runHost('var t = "undefined"; console.log(t.length);')).toEqual(["9"]);
  });

  it("still folds a typeof comparison", async () => {
    expect(await runStandalone('var u; return (typeof u) === "undefined" ? 1 : 0;')).toBe(1);
    expect(await runStandalone('var n = 1; return (typeof n) === "number" ? 1 : 0;')).toBe(1);
  });
});
