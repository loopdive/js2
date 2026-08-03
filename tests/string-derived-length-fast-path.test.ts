// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function compileAndRun(
  source: string,
  includeHelpers = false,
): Promise<{ value: number; runWat: string; wat: string }> {
  const result = await compile(source, {
    fileName: "derived-length.ts",
    target: "standalone",
    optimize: 4,
    emitWat: true,
    ...(includeHelpers ? {} : { emitWatOnlyFunctions: ["run"] }),
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const runWat = result.wat?.slice(result.wat.indexOf("(func $run"), result.wat.indexOf('(export "run"')) ?? "";
  return { value: (instance.exports.run as () => number)(), runWat, wat: result.wat ?? "" };
}

async function compileHostAndRun(source: string): Promise<{ value: number; runWat: string }> {
  const result = await compile(source, {
    fileName: "host-derived-length.ts",
    nativeStrings: false,
    optimize: 4,
    emitWat: true,
    emitWatOnlyFunctions: ["run"],
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  const wat = result.wat ?? "";
  const runWat = wat.slice(wat.indexOf("(func $run"), wat.indexOf('(export "run"'));
  return { value: (instance.exports.run as () => number)(), runWat };
}

describe("native string derived-length fast paths", () => {
  it("does not allocate ASCII case-conversion results used only for length", async () => {
    const { value, runWat } = await compileAndRun(`
      export function run(): number {
        const variants: string[] = ["Hello World", "Alpha Bravo"];
        let sum = 0;
        for (let i = 0; i < 10; i = i + 1) {
          const value = variants[i % 2];
          sum = sum + value.toLowerCase().length + value.toUpperCase().length;
        }
        return sum;
      }
    `);
    expect(value).toBe(220);
    expect(runWat).not.toContain("call $__str_toLowerCase");
    expect(runWat).not.toContain("call $__str_toUpperCase");
  });

  it("keeps Unicode expansion and mutated tables on the full conversion path", async () => {
    const unicode = await compileAndRun(`export function run(): number { return "ß".toUpperCase().length; }`);
    expect(unicode.value).toBe(2);

    const mutated = await compileAndRun(`
      export function run(): number {
        const variants: string[] = ["ascii"];
        variants[0] = "ß";
        return variants[0].toUpperCase().length;
      }
    `);
    expect(mutated.value).toBe(2);
  });

  it("elides equal-literal replacement only without substitution tokens", async () => {
    const equal = await compileAndRun(`export function run(): number { return "a fox".replace("fox", "cat").length; }`);
    expect(equal.value).toBe(5);
    expect(equal.runWat).not.toContain("call $__str_replace");

    const substituted = await compileAndRun(
      `export function run(): number { return "fox".replace("fox", "$&$&").length; }`,
    );
    expect(substituted.value).toBe(6);
  });

  it("folds uniform split and trim lengths from immutable literal tables", async () => {
    const { value, runWat } = await compileAndRun(`
      export function run(): number {
        const csv: string[] = ["a,b,c", "c,a,b"];
        const padded: string[] = ["  hello ", "\thello\t"];
        let sum = 0;
        for (let i = 0; i < 10; i = i + 1) {
          sum = sum + csv[i % 2].split(",").length;
          sum = sum + padded[i % 2].trim().length;
        }
        return sum;
      }
    `);
    expect(value).toBe(80);
    expect(runWat).not.toContain("call $__str_split");
    expect(runWat).not.toContain("call $__str_trim");
  });

  it("counts a dynamic one-code-unit split without allocating the result array", async () => {
    const { value, runWat } = await compileAndRun(`
      export function run(): number {
        let text = "alpha,beta";
        text = text + ",gamma";
        const parts = text.split(",");
        return parts.length;
      }
    `);
    expect(value).toBe(3);
    expect(runWat).not.toContain("call $__str_split");
    expect(runWat).not.toContain("array.new");
  });

  it("folds uniform literal-table prefix and suffix predicates", async () => {
    const { value, runWat } = await compileAndRun(`
      export function run(): number {
        const values: string[] = ["hello one end", "hello two end"];
        let count = 0;
        for (let i = 0; i < 10; i = i + 1) {
          const value = values[i % 2];
          if (value.startsWith("hello")) count = count + 1;
          if (value.endsWith("end")) count = count + 1;
        }
        return count;
      }
    `);
    expect(value).toBe(20);
    expect(runWat).not.toContain("call $__str_startsWith");
    expect(runWat).not.toContain("call $__str_endsWith");
  });

  it("keeps non-uniform and mutated table results on native helpers", async () => {
    const nonUniform = await compileAndRun(`
      export function run(): number {
        const values: string[] = ["a,b", "plain"];
        return values[0].split(",").length + (values[1].startsWith("a") ? 1 : 0);
      }
    `);
    expect(nonUniform.value).toBe(2);
    // The results differ across table entries, so the compiler must retain
    // runtime string work rather than replacing either expression uniformly.
    expect(nonUniform.runWat).toContain("call ");

    const mutated = await compileAndRun(`
      export function run(): number {
        const values: string[] = [" a ", " b "];
        values[0] = "longer";
        return values[0].trim().length;
      }
    `);
    expect(mutated.value).toBe(6);
    expect(mutated.runWat).toContain("call ");
  });

  it("reuses the flat descriptor of a const substring for charCodeAt", async () => {
    const { value, runWat, wat } = await compileAndRun(
      `
        export function run(): number {
          const value = "abcdef".substring(1, 5);
          return value.charCodeAt(0) + value.charCodeAt(value.length - 1);
        }
      `,
      true,
    );
    expect(value).toBe("b".charCodeAt(0) + "e".charCodeAt(0));
    const helperStart = wat.indexOf("(func $__str_charCodeAt");
    expect(helperStart).toBe(-1);
    expect(runWat).not.toContain("call ");
  });

  it("applies immutable derived-result proofs to host strings without crossing the JS boundary", async () => {
    const { value, runWat } = await compileHostAndRun(`
      export function run(): number {
        const csv: string[] = ["a,b,c", "c,a,b"];
        const words: string[] = ["Hello", "World"];
        const phrases: string[] = ["a fox", "fox a"];
        const padded: string[] = [" x ", "\tx\t"];
        const tagged: string[] = ["hello-a-end", "hello-b-end"];
        const searched: string[] = ["a needle", "needle b"];
        let sum = 0;
        for (let i = 0; i < 10; i = i + 1) {
          const parts = csv[i % 2].split(",");
          sum = sum + parts.length;
          sum = sum + words[i % 2].toLowerCase().length;
          sum = sum + words[i % 2].toUpperCase().length;
          sum = sum + phrases[i % 2].replace("fox", "cat").length;
          sum = sum + padded[i % 2].trim().length;
          if (tagged[i % 2].startsWith("hello")) sum = sum + 1;
          if (tagged[i % 2].endsWith("end")) sum = sum + 1;
          const index = searched[i % 2].indexOf("needle");
          if (index >= 0) sum = sum + 1;
        }
        return sum;
      }
    `);
    expect(value).toBe(220);
    for (const helper of [
      "string_split",
      "string_toLowerCase",
      "string_toUpperCase",
      "string_replace",
      "string_trim",
      "string_startsWith",
      "string_endsWith",
      "string_indexOf",
    ]) {
      expect(runWat).not.toContain(`call $${helper}`);
    }
  });

  it("represents non-escaping host substrings as offset and length descriptors", async () => {
    const { value, runWat } = await compileHostAndRun(`
      export function run(): number {
        const text = "abcdefghijklmnopqrstuvwxyz";
        let hash = 0;
        for (let i = 0; i < 10; i = i + 1) {
          const part = text.substring(i % 5, 20 + (i % 6));
          hash = hash + part.length;
          hash = hash + part.charCodeAt(0);
          hash = hash + part.charCodeAt(part.length - 1);
        }
        return hash;
      }
    `);
    const text = "abcdefghijklmnopqrstuvwxyz";
    let expected = 0;
    for (let i = 0; i < 10; i++) {
      const part = text.substring(i % 5, 20 + (i % 6));
      expected += part.length;
      expected += part.charCodeAt(0);
      expected += part.charCodeAt(part.length - 1);
    }
    expect(value).toBe(expected);
    expect(runWat).not.toContain("call $string_substring");
    expect(runWat).toContain("(loop");
  });
});
