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

async function compileHostAndRun(source: string): Promise<{
  value: number;
  runWat: string;
  imports: Awaited<ReturnType<typeof compile>>["imports"];
}> {
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
  return { value: (instance.exports.run as () => number)(), runWat, imports: result.imports };
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

  it("scalar-replaces non-escaping ASCII case results", async () => {
    const source = `
        export function run(): number {
          const values: string[] = ["Hello", "WORLD"];
          let sum = 0;
          for (let i = 0; i < 10; i = i + 1) {
            const value = values[i % 2];
            const lower = value.toLowerCase();
            const upper = value.toUpperCase();
            sum = sum + lower.charCodeAt(i % 5) + upper.charCodeAt(i % 5);
          }
          return sum;
        }
      `;
    const proven = await compileAndRun(source);
    const saved = process.env.JS2WASM_NATIVE_ASCII_CASE_SCALAR;
    let unicode: Awaited<ReturnType<typeof compileAndRun>>;
    try {
      process.env.JS2WASM_NATIVE_ASCII_CASE_SCALAR = "0";
      unicode = await compileAndRun(source);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_ASCII_CASE_SCALAR");
      else process.env.JS2WASM_NATIVE_ASCII_CASE_SCALAR = saved;
    }
    expect(proven.value).toBe(1848);
    expect(unicode.value).toBe(proven.value);
    expect(proven.runWat).not.toBe(unicode.runWat);
    expect(proven.runWat.match(/\bcall\b/g)?.length ?? 0).toBeLessThan(unicode.runWat.match(/\bcall\b/g)?.length ?? 0);
  });

  it("routes escaping proven-ASCII results through compact helpers", async () => {
    const source = `
      export function run(): number {
        const values: string[] = ["Hello", "WORLD"];
        const upper = values[0].toUpperCase();
        return upper === "HELLO" ? upper.length : 0;
      }
    `;
    const proven = await compileAndRun(source);
    const saved = process.env.JS2WASM_NATIVE_PROVEN_ASCII_CASE;
    let unicode: Awaited<ReturnType<typeof compileAndRun>>;
    try {
      process.env.JS2WASM_NATIVE_PROVEN_ASCII_CASE = "0";
      unicode = await compileAndRun(source);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_PROVEN_ASCII_CASE");
      else process.env.JS2WASM_NATIVE_PROVEN_ASCII_CASE = saved;
    }
    expect(proven.value).toBe(5);
    expect(unicode.value).toBe(proven.value);
    expect(proven.runWat).not.toBe(unicode.runWat);
  });

  it("keeps non-ASCII and mutable case receivers on Unicode helpers", async () => {
    const nonAscii = await compileAndRun(
      `
        export function run(): number {
          const values: string[] = ["éx"];
          return values[0].toUpperCase().charCodeAt(0);
        }
      `,
    );
    expect(nonAscii.value).toBe("É".charCodeAt(0));
    expect(nonAscii.runWat).not.toContain("call $__str_toUpperCase_ascii");

    const mutable = await compileAndRun(`
      export function run(): number {
        const values: string[] = ["ascii"];
        values[0] = "ß";
        return values[0].toUpperCase().length;
      }
    `);
    expect(mutable.value).toBe(2);
  });

  it("preserves ASCII case charCodeAt bounds and declines escaping results", async () => {
    const bounded = await compileAndRun(`
      export function run(): number {
        const lower = "Ab".toLowerCase();
        const inBounds = lower.charCodeAt(0);
        const below = lower.charCodeAt(-1);
        const above = lower.charCodeAt(2);
        return inBounds + (below !== below ? 1 : 0) + (above !== above ? 1 : 0);
      }
    `);
    expect(bounded.value).toBe("a".charCodeAt(0) + 2);

    const escaped = await compileAndRun(`
      export function run(): number {
        const upper = "ab".toUpperCase();
        function read(): number { return upper.charCodeAt(0); }
        return upper === "AB" ? read() : 0;
      }
    `);
    expect(escaped.value).toBe("A".charCodeAt(0));
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

  it("computes non-uniform trim lengths without allocating substring views", async () => {
    const { value, runWat } = await compileAndRun(`
      export function run(): number {
        const padded: string[] = ["  a ", "\\u2003beta\\uFEFF", "\\t\\n", " gamma"];
        let sum = 0;
        for (let i = 0; i < 16; i = i + 1) {
          sum = sum + padded[i % 4].trim().length;
        }
        return sum;
      }
    `);
    expect(value).toBe(40);
    // Binaryen may inline the narrow length kernel, so the stable emitted-code
    // proof is that the allocating general trim helper is absent.
    expect(runWat).not.toContain("call $__str_trim");

    const custom = await compileAndRun(`
      export function run(): number {
        const value = { trim(): string { return "xy"; } };
        return value.trim().length;
      }
    `);
    expect(custom.value).toBe(2);
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

  it("scalarizes split count and final-field length in one scan", async () => {
    const source = `
      export function run(): number {
        const rows: string[] = ["a,b,c", "solo", "x,y,", "", ",a", "a,,b"];
        let sum = 0;
        for (let i = 0; i < 12; i = i + 1) {
          const columns = rows[i % 6].split(",");
          sum = sum + columns.length + columns[columns.length - 1].length;
        }
        return sum;
      }
    `;
    const scalar = await compileAndRun(source);
    const saved = process.env.JS2WASM_NATIVE_SPLIT_TAIL_SCALAR;
    let allocated: Awaited<ReturnType<typeof compileAndRun>>;
    try {
      process.env.JS2WASM_NATIVE_SPLIT_TAIL_SCALAR = "0";
      allocated = await compileAndRun(source);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_SPLIT_TAIL_SCALAR");
      else process.env.JS2WASM_NATIVE_SPLIT_TAIL_SCALAR = saved;
    }
    expect(scalar.value).toBe(40);
    expect(allocated.value).toBe(scalar.value);
    expect(scalar.runWat).toContain("__split_tail_len");
    expect(allocated.runWat).not.toContain("__split_tail_len");
    expect(scalar.runWat).not.toBe(allocated.runWat);
  });

  it("retains split arrays that escape or mutate", async () => {
    const escaped = await compileAndRun(`
      export function run(): number {
        const columns = "a,b".split(",");
        function tail(): number { return columns[columns.length - 1].length; }
        return columns.length + tail();
      }
    `);
    expect(escaped.value).toBe(3);
    expect(escaped.runWat).not.toContain("__split_tail_len");

    const mutated = await compileAndRun(`
      export function run(): number {
        const columns = "a,b".split(",");
        columns[columns.length - 1] = "tail";
        return columns.length + columns[columns.length - 1].length;
      }
    `);
    expect(mutated.value).toBe(6);
    expect(mutated.runWat).not.toContain("__split_tail_len");
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

  it("retains the outer split while scalarizing nested length-only splits", async () => {
    const { value, runWat, imports } = await compileHostAndRun(`
      export function run(): number {
        const documents: string[] = [
          "name,age,city\\nAlice,30,Berlin\\nBob,25,Munich",
          "name,age,city\\nBob,25,Munich\\nAlice,30,Berlin"
        ];
        let total = 0;
        for (let documentIndex = 0; documentIndex < 2; documentIndex = documentIndex + 1) {
          const lines = documents[documentIndex].split("\\n");
          for (let lineIndex = 1; lineIndex < lines.length; lineIndex = lineIndex + 1) {
            const columns = lines[lineIndex].split(",");
            total = total + columns.length;
          }
        }
        return total;
      }
    `);
    expect(value).toBe(12);
    const splitFuncIndex = imports
      .filter((descriptor) => descriptor.kind === "func")
      .findIndex((descriptor) => descriptor.module === "env" && descriptor.name === "string_split");
    expect(splitFuncIndex).toBeGreaterThanOrEqual(0);
    const splitCalls = runWat.match(new RegExp(`call ${splitFuncIndex}(?:\\s|$)`, "g")) ?? [];
    expect(splitCalls).toHaveLength(1);
    expect(runWat.match(/\(loop/g)).toHaveLength(2);
  });

  it("retains both runtime splits when nested row widths are non-uniform", async () => {
    const { value, runWat, imports } = await compileHostAndRun(`
      export function run(): number {
        const documents: string[] = ["a,b\\nc"];
        const lines = documents[0].split("\\n");
        let total = 0;
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex = lineIndex + 1) {
          const columns = lines[lineIndex].split(",");
          total = total + columns.length;
        }
        return total;
      }
    `);
    expect(value).toBe(3);
    const splitFuncIndex = imports
      .filter((descriptor) => descriptor.kind === "func")
      .findIndex((descriptor) => descriptor.module === "env" && descriptor.name === "string_split");
    expect(splitFuncIndex).toBeGreaterThanOrEqual(0);
    const splitCalls = runWat.match(new RegExp(`call ${splitFuncIndex}(?:\\s|$)`, "g")) ?? [];
    expect(splitCalls).toHaveLength(2);
  });
});
