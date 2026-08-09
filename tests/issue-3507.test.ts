// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const TEST262_ROOT = resolve(ROOT, "test262");
const HOST_REGEXP_IMPORT_RE = /(^|::)RegExp_/;

async function compileAndRun(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-3507.ts", target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(
    result.imports.map((entry) => `${entry.module}::${entry.name}`).filter((name) => HOST_REGEXP_IMPORT_RE.test(name)),
  ).toEqual([]);
  const module = await WebAssembly.compile(result.binary);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3507 standalone native RegExp carrier dispatch", () => {
  it("preserves a native RegExp through a typed function parameter", async () => {
    expect(
      await compileAndRun(`
        function accepts(re: RegExp, value: string): boolean {
          return re.test(value);
        }
        export function test(): number {
          return accepts(/\\p{ASCII}+/u, "ASCII") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("routes untyped helper and object-property carriers by runtime brand", async () => {
    expect(
      await compileAndRun(`
        function verify(record, value) {
          return record.regExp.test(value);
        }
        export function test(): number {
          const record = { regExp: /^(?:[\\q{ab|cd}])+$/v };
          return verify(record, "abcd") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("preserves native RegExp identity through array and for-of carriers", async () => {
    expect(
      await compileAndRun(`
        export function test(): number {
          const regexps = [/^\\d+$/, /^\\d+$/u, /^\\d+$/v];
          let matched = 0;
          for (const regexp of regexps) {
            if (regexp.test("123")) matched++;
          }
          return matched;
        }
      `),
    ).toBe(3);
  });

  it("keeps global carrier lastIndex semantics", async () => {
    expect(
      await compileAndRun(`
        function next(re, value) { return re.test(value); }
        export function test(): number {
          const re = /a/g;
          const a = next(re, "aa");
          const b = next(re, "aa");
          const c = next(re, "aa");
          return a && b && !c && re.lastIndex === 0 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps genuinely dynamic literal constructor patterns on the native carrier", async () => {
    expect(
      await compileAndRun(`
        function matches(pattern: string): boolean { return new RegExp(pattern).test("x"); }
        export function test(): number { return matches("x") && !matches("y") ? 1 : 0; }
      `),
    ).toBe(1);
  });

  const representatives = [
    "built-ins/RegExp/property-escapes/generated/Alphabetic.js",
    "built-ins/RegExp/unicodeSets/generated/string-literal-union-character.js",
    "built-ins/RegExp/CharacterClassEscapes/character-class-digit-class-escape-positive-cases.js",
  ];

  for (const relativePath of representatives) {
    it(`does not compile ${relativePath} through env::RegExp_test`, async () => {
      const path = resolve(TEST262_ROOT, "test", relativePath);
      if (!existsSync(path)) return;
      const result = await runTest262File(path, "built-ins/RegExp", 120_000, "standalone");
      expect(result.status, result.error).not.toBe("compile_error");
      expect(result.error ?? "").not.toContain("env::RegExp_test");
    }, 120_000);
  }
});
