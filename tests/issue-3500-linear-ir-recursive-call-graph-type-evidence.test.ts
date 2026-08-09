// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { getLastLinearIrReport, type LinearIrResult } from "../src/ir/backend/linear-integration.js";
import { porfforRendererOutputText, type PorfforRendererInput } from "../src/ir/backend/porffor/compat.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { verifyIrFunction } from "../src/ir/verify.js";

const benchmarkPath = "website/public/benchmarks/competitive/programs/fib-recursive.js";
const porfforRoot = process.env.JS2WASM_PORFFOR_ROOT ?? "vendor/Porffor";
const hasOptionalPorffor = existsSync(join(porfforRoot, "compiler/ir.js"));
const nativeRequired = process.env.PORFFOR_NATIVE_REQUIRED === "1";
const sanitizerEnabled = process.env.PORFFOR_NATIVE_SANITIZERS === "1";
const cCompiler = findCCompiler();
const seeds = [0, 1, 2, 5, 10, 20] as const;

let benchmarkSource!: string;
let nodeValues!: readonly number[];
let linearValues!: readonly number[];
let report!: LinearIrResult;
let porfforInput!: PorfforRendererInput;

beforeAll(async () => {
  benchmarkSource = readFileSync(benchmarkPath, "utf8");
  const nodeModule = (await import(
    `data:text/javascript;base64,${Buffer.from(benchmarkSource).toString("base64")}`
  )) as { run: (n: number) => number };
  nodeValues = seeds.map(nodeModule.run);

  const compiled = await compile(benchmarkSource, {
    target: "linear",
    allocator: "analysis-stack",
    fileName: benchmarkPath,
  });
  expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
  const captured = getLastLinearIrReport();
  if (!captured) throw new Error("missing linear IR report for fib-recursive.js");
  report = captured;

  const { instance } = await WebAssembly.instantiate(compiled.binary, compiled.importObject ?? {});
  const run = (instance.exports as Record<string, unknown>).run;
  if (typeof run !== "function") throw new Error("linear-Wasm export run is absent");
  linearValues = seeds.map((seed) => (run as (n: number) => number)(seed));
  porfforInput = lowerIrModuleToPorffor(report.irModule, {
    memoryPlan: report.memoryPlan,
    prefs: { gc: false },
  });
}, 120_000);

describe("#3500 exact recursive landing benchmark", () => {
  it("selects both source functions into shared IR and matches Node", () => {
    expect(report.compiled).toStrictEqual(["fib", "run"]);
    expect(report.rejected.find((rejection) => rejection.func === "fib" || rejection.func === "run")).toBeUndefined();
    expect(report.irModule.functions.map((func) => func.name)).toStrictEqual(["fib", "run"]);
    expect(linearValues).toStrictEqual(nodeValues);
    expect(nodeValues).toStrictEqual([0, 1, 1, 5, 55, 6765]);

    for (const func of report.irModule.functions) {
      expect(verifyIrFunction(func)).toStrictEqual([]);
      expect(verifyIrBackendLegality(func, "linear")).toStrictEqual([]);
      expect(verifyIrBackendLegality(func, "porffor")).toStrictEqual([]);
    }
    expect(porfforInput.funcs.filter(Boolean).map((func) => func!.name)).toEqual(
      expect.arrayContaining(["fib", "run"]),
    );
  });

  const nativeIt = hasOptionalPorffor && cCompiler ? it : nativeRequired ? it : it.skip;
  nativeIt(
    "matches Node through pinned Porffor-C under ASan/UBSan",
    async () => {
      if (!hasOptionalPorffor) {
        throw new Error(`PORFFOR_NATIVE_REQUIRED=1 but ${porfforRoot} is not initialized`);
      }
      if (!cCompiler) throw new Error("PORFFOR_NATIVE_REQUIRED=1 but no C compiler is available");
      if (nativeRequired && !sanitizerEnabled) {
        throw new Error("PORFFOR_NATIVE_REQUIRED=1 also requires PORFFOR_NATIVE_SANITIZERS=1");
      }

      const porffor = await loadOptionalPorffor({ root: porfforRoot });
      const rendered = normalizePinnedPorfforCForNative(porfforRendererOutputText(porffor.render(porfforInput)));
      expect(compileAndRunNative(cCompiler, rendered, porfforInput, sanitizerEnabled)).toStrictEqual(nodeValues);
    },
    120_000,
  );

  it("closes a mutually-recursive SCC from one checker-backed caller anchor", async () => {
    const source = `
      function even(value) {
        if (value === 0) return true;
        return odd(value - 1);
      }
      function odd(value) {
        if (value === 0) return false;
        return even(value - 1);
      }
      /** @param {number} value @returns {boolean} */
      export function run(value) { return even(value); }
    `;
    const compiled = await compile(source, {
      target: "linear",
      allocator: "analysis-stack",
      fileName: "issue-3500-mutual.js",
    });
    expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(getLastLinearIrReport()?.compiled).toStrictEqual(["even", "odd", "run"]);

    const { instance } = await WebAssembly.instantiate(compiled.binary, compiled.importObject ?? {});
    const run = instance.exports.run as (value: number) => number;
    expect([Boolean(run(10)), Boolean(run(9))]).toStrictEqual([true, false]);
  });
});

const negativeCycles = [
  {
    reason: "ambiguous",
    source: `
      function recur(value) {
        if (value) return recur(value);
        return value;
      }
      /** @returns {number} */
      export function run() { return 0; }
    `,
  },
  {
    reason: "polymorphic",
    source: `
      function recur(value) {
        if (value === 0 || value === "") return value;
        return recur(value);
      }
      /** @param {number} value @returns {number} */
      export function runNumber(value) { return recur(value); }
      /** @param {string} value @returns {string} */
      export function runString(value) { return recur(value); }
    `,
  },
  {
    reason: "escaping",
    source: `
      function recur(value) {
        if (value <= 0) return value;
        return recur(value - 1);
      }
      const escaped = recur;
      /** @param {number} value @returns {number} */
      export function run(value) { return recur(value); }
    `,
  },
  {
    reason: "higher-order",
    fileName: "issue-3500-higher-order.ts",
    source: `
      function recur(value: number, callback: (value: number) => number): number {
        if (value <= 0) return value;
        return recur(value - 1, callback);
      }
      export function run(value: number): number { return value; }
    `,
  },
  {
    reason: "conflicting",
    source: `
      function recur(value) {
        if (value <= 0) return value;
        if (value === 1) return "conflict";
        return recur(value - 1);
      }
      /** @param {number} value @returns {number} */
      export function run(value) { return recur(value); }
    `,
  },
  {
    reason: "any-based",
    fileName: "issue-3500-any.ts",
    source: `
      function recur(value: any): any {
        if (value) return recur(value);
        return value;
      }
      export function run(): number { return 0; }
    `,
  },
] as const;

describe("#3500 conservative recursive SCC rejection", () => {
  for (const testCase of negativeCycles) {
    it(`keeps ${testCase.reason} cycles dynamic with a stable diagnostic`, async () => {
      const compiled = await compile(testCase.source, {
        target: "linear",
        allocator: "analysis-stack",
        fileName: "fileName" in testCase ? testCase.fileName : `issue-3500-${testCase.reason}.js`,
      });
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      const negativeReport = getLastLinearIrReport();
      const rejection = negativeReport?.rejected.find((candidate) => candidate.func === "recur");

      expect(negativeReport?.compiled).not.toContain("recur");
      expect(rejection).toStrictEqual({
        func: "recur",
        reason: "select:recursive-type-evidence",
        detail: `recursive-type-evidence:${testCase.reason}`,
      });
    });
  }
});

function findCCompiler(): string | null {
  for (const candidate of [process.env.CC, "clang", "cc"].filter((value): value is string => !!value)) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  return null;
}

function normalizePinnedPorfforCForNative(rendered: string): string {
  const incompatible = 'snprintf(buf, sizeof buf, "%lld", (i64)d)';
  const portable = 'snprintf(buf, sizeof buf, "%lld", (long long)(i64)d)';
  const occurrences = rendered.split(incompatible).length - 1;
  if (occurrences !== 1) {
    throw new Error(`pinned Porffor i64 printf compatibility site count changed: expected 1, received ${occurrences}`);
  }
  return rendered.replace(incompatible, portable);
}

function compileAndRunNative(
  compiler: string,
  rendered: string,
  input: PorfforRendererInput,
  sanitizers: boolean,
): number[] {
  const func = input.funcs.find((candidate) => candidate?.name === "run");
  if (!func) throw new Error("missing Porffor function run");
  const symbol = `p${func.index}_${func.name}`;
  const calls = seeds.map((seed) => `  printf("%.17g\\n", ${symbol}(${seed}));`).join("\n");
  const harness = `
int main(int argc, char** argv) {
  porf_init(argc, argv);
  porf_data_init();
${calls}
  return 0;
}
`;
  const directory = mkdtempSync(join(tmpdir(), "js2-porffor-3500-"));
  const sourcePath = join(directory, "fib-recursive.c");
  const binaryPath = join(directory, "fib-recursive");
  try {
    writeFileSync(sourcePath, rendered + harness);
    const sanitizerFlags = sanitizers ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"] : [];
    const built = spawnSync(
      compiler,
      [
        "-std=gnu11",
        "-O1",
        "-g",
        "-Werror",
        "-Wno-unused-function",
        ...sanitizerFlags,
        sourcePath,
        "-lm",
        "-o",
        binaryPath,
      ],
      { encoding: "utf8" },
    );
    expect(built.status, `C compiler failed:\n${built.stdout}\n${built.stderr}`).toBe(0);
    const stdout = execFileSync(binaryPath, {
      encoding: "utf8",
      env: {
        ...process.env,
        ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1:abort_on_error=1",
        UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
      },
    });
    return stdout.trim().split("\n").map(Number);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
