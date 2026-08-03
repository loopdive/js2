// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { foldGroundCallsInMultiFiles, foldGroundExportCalls } from "../src/compiler/ground-call-fold.js";
import { compile, compileMulti } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";
import { setupClsx } from "./dogfood/setup-clsx.mjs";

const OP_NAME = "op_mixed_all_kinds";
const OP_BODY = "return clsx('base', { active: true, disabled: false }, ['extra', 'classes'], null, 'end');";
const EXPECTED = "base active extra classes end";

function pinnedClsxSource(): string {
  const { entryModulePath } = setupClsx();
  return readFileSync(entryModulePath, "utf8");
}

function clsxWithDriver(): string {
  return `${pinnedClsxSource()}\nexport function ${OP_NAME}() { ${OP_BODY} }\n`;
}

function clsxStandaloneFiles(): Record<string, string> {
  return {
    "clsx.mjs": pinnedClsxSource(),
    "benchmark.mjs": `
      import { clsx } from "./clsx.mjs";
      /** @param {number} iterations */
      export function bench(iterations) {
        var checksum = 0;
        for (var index = 0; index < iterations; index++) {
          checksum += (clsx("foo", "bar")).length;
        }
        return checksum;
      }
    `,
  };
}

describe("#3778 closed ground-call folding", () => {
  it("folds the real pinned clsx operation to a same-length primitive literal", () => {
    const source = clsxWithDriver();
    const folded = foldGroundExportCalls(source, "clsx.mjs");

    expect(folded.folded).toBe(1);
    expect(folded.source.length).toBe(source.length);
    expect(folded.source).toContain(`return ${JSON.stringify(EXPECTED)}`);
  });

  it("emits a constant-only Wasm export and preserves the real package result", async () => {
    const result = await compile(clsxWithDriver(), {
      fileName: "clsx.mjs",
      skipSemanticDiagnostics: true,
      optimize: 4,
      emitWat: true,
      emitWatOnlyFunctions: [OP_NAME],
    });

    expect(result.success).toBe(true);
    expect(result.wat).toContain(`(func $${OP_NAME}`);
    const body = result.wat?.slice(result.wat.indexOf(`(func $${OP_NAME}`), result.wat.indexOf(`(export "clsx"`));
    expect(body).toContain("global.get");
    expect(body).not.toContain("call ");

    const importObject = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, importObject);
    importObject.__setExports?.(instance.exports);
    const exports = wrapExports(instance.exports, { signatures: result.exportSignatures });
    expect(exports[OP_NAME]()).toBe(EXPECTED);
  });

  it("keeps lower optimization levels on the dynamic call path", async () => {
    const result = await compile(clsxWithDriver(), {
      fileName: "clsx.mjs",
      skipSemanticDiagnostics: true,
      optimize: 3,
      emitWat: true,
      emitWatOnlyFunctions: [OP_NAME],
    });

    const body = result.wat?.slice(result.wat.indexOf(`(func $${OP_NAME}`), result.wat.indexOf(`(export "clsx"`));
    expect(body).toContain("call");
    expect(body).not.toContain(`base active extra classes end`);
  });

  it("refuses property mutation, ambient calls, top-level effects, and unrelated exports", () => {
    const cases = [
      `
        function f(o) { o.value = "changed"; return "x"; }
        export function run() { return f({ value: "initial" }); }
      `,
      `
        function f() { return Date.now(); }
        export function run() { return f(); }
      `,
      `
        function f() { return "x"; }
        console.log("effect");
        export function run() { return f(); }
      `,
      `
        function f() { return "x"; }
        export function other() { return "observable"; }
        export function run() { return f(); }
      `,
      `
        function Array() {}
        function f() { return Array.isArray([]); }
        export function run() { return f(); }
      `,
    ];

    for (const source of cases) {
      expect(foldGroundExportCalls(source).folded).toBe(0);
    }
  });

  it("does not fold a wrapper with runtime parameters", () => {
    const source = `
      function join(value) { return "" + value; }
      export function run(value) { return join(value); }
    `;
    expect(foldGroundExportCalls(source).folded).toBe(0);
  });

  it("folds a pure ground local call nested in a runtime-counted loop", async () => {
    const source = `
      function fib(n: number): number {
        if (n <= 1) return n;
        let a = 0;
        let b = 1;
        for (let i = 2; i <= n; i++) {
          const next = a + b;
          a = b;
          b = next;
        }
        return b;
      }
      export function run(iterations: number): number {
        let sum = 0;
        for (let i = 0; i < iterations; i++) sum += fib(30);
        return sum;
      }
    `;
    const folded = foldGroundExportCalls(source);

    expect(folded.folded).toBe(1);
    expect(folded.source.length).toBe(source.length);
    expect(folded.source).toMatch(/sum \+= 832040\s*;/);

    const result = await compile(source, {
      optimize: 4,
      emitWat: true,
      emitWatOnlyFunctions: ["run"],
    });
    expect(result.success).toBe(true);
    const body = result.wat?.slice(result.wat.indexOf("(func $run"), result.wat.indexOf('(export "run"'));
    expect(body).not.toContain("call $fib");
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    expect((instance.exports.run as (iterations: number) => number)(10)).toBe(8_320_400);
  });

  it("does not fold shadowed or effectful nested local calls", () => {
    const shadowed = `
      function value(): number { return 7; }
      export function run(value: () => number): number { return value(); }
    `;
    const effectful = `
      let calls = 0;
      function value(): number { calls++; return 7; }
      export function run(): number { return value(); }
    `;

    expect(foldGroundExportCalls(shadowed).folded).toBe(0);
    expect(foldGroundExportCalls(effectful).folded).toBe(0);
  });

  it("folds a pure linked-package call nested in a runtime-counted benchmark loop", () => {
    const files = clsxStandaloneFiles();
    const folded = foldGroundCallsInMultiFiles(files, "benchmark.mjs");

    expect(folded.folded).toBe(1);
    expect(folded.files["benchmark.mjs"]!.length).toBe(files["benchmark.mjs"]!.length);
    expect(folded.files["benchmark.mjs"]).not.toContain(`clsx("foo", "bar")).length`);
    expect(folded.files["benchmark.mjs"]).toMatch(/checksum \+= 7\s*;/);
    expect(folded.files["benchmark.mjs"]).not.toContain(`import { clsx }`);
    expect(folded.files["clsx.mjs"]!.length).toBe(files["clsx.mjs"]!.length);
    expect(folded.files["clsx.mjs"]).not.toMatch(/\S/);
  });

  it("emits the linked standalone benchmark as a constant scalar loop", async () => {
    const result = await compileMulti(clsxStandaloneFiles(), "benchmark.mjs", {
      allowJs: true,
      skipSemanticDiagnostics: true,
      optimize: 4,
      target: "standalone",
      emitWat: true,
      emitWatOnlyFunctions: ["bench"],
      trackIrOutcomes: true,
    });

    expect(result.success).toBe(true);
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("bench");
    expect(WebAssembly.Module.imports(await WebAssembly.compile(result.binary))).toEqual([]);
    expect(result.wat).toContain("(func $bench");
    const body = result.wat?.slice(result.wat.indexOf("(func $bench"), result.wat.indexOf('(export "bench"'));
    expect(body).not.toContain("array.new");
    expect(body).not.toContain("struct.new");

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.bench as (iterations: number) => number)(0)).toBe(0);
    expect((instance.exports.bench as (iterations: number) => number)(10)).toBe(70);
  });

  it("does not fold linked calls with observable mutation or shadowed imports", () => {
    const impure = foldGroundCallsInMultiFiles(
      {
        "lib.mjs": `
          var calls = 0;
          export function value() { calls++; return "x"; }
        `,
        "entry.mjs": `
          import { value } from "./lib.mjs";
          export function bench() { return value().length; }
        `,
      },
      "entry.mjs",
    );
    expect(impure.folded).toBe(0);

    const shadowed = foldGroundCallsInMultiFiles(
      {
        "lib.mjs": `export function value() { return "x"; }`,
        "entry.mjs": `
          import { value } from "./lib.mjs";
          export function bench(value) { return value().length; }
        `,
      },
      "entry.mjs",
    );
    expect(shadowed.folded).toBe(0);

    const unresolved = foldGroundCallsInMultiFiles(
      {
        "unrelated.mjs": `export function value() { return "wrong"; }`,
        "entry.mjs": `
          import { value } from "external-package";
          export function bench() { return value().length; }
        `,
      },
      "entry.mjs",
    );
    expect(unresolved.folded).toBe(0);
  });
});
