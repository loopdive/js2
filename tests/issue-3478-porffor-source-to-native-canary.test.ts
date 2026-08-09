// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";

import { compile } from "../src/index.js";
import { getLastLinearIrReport, type LinearIrResult } from "../src/ir/backend/linear-integration.js";
import {
  PORFFOR_KIND_NAMES,
  PORFFOR_TYPE_ENTRIES,
  porfforRendererOutputText,
  type PorfforNode,
  type PorfforRendererInput,
} from "../src/ir/backend/porffor/compat.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import { verifyIrFunction } from "../src/ir/verify.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures/porffor-source-to-native-canary.ts");
const porfforRoot = process.env.JS2WASM_PORFFOR_ROOT ?? join(here, "../vendor/Porffor");
const hasOptionalPorffor = existsSync(join(porfforRoot, "compiler/ir.js"));
const nativeRequired = process.env.PORFFOR_NATIVE_REQUIRED === "1";
const sanitizerEnabled = process.env.PORFFOR_NATIVE_SANITIZERS === "1";
const cCompiler = findCCompiler();
const functionName = "porfforSourceNativeCanary";
const fixedSeeds = [-7, 0, 4, 31] as const;
const expectedFixedValues = [-535, 235, 675, 3645] as const;
const stressIterations = 20_000;
const expectedStressChecksum = 4_711_770;
const porfforJsvalType = PORFFOR_TYPE_ENTRIES.find(([name]) => name === "jsval")![1];

interface CanaryRow {
  readonly allocator: "bump" | "analysis-stack";
  readonly policy: "arena-v1" | "analysis-stack-arena-v1";
  readonly allocationClass: "arena" | "stack";
  readonly report: LinearIrResult;
  readonly porfforInput: PorfforRendererInput;
  readonly wasmValues: readonly number[];
  readonly wasmChecksum: number;
}

let directCanary!: (seed: number) => number;
let directValues!: readonly number[];
let directChecksum!: number;
let rows!: readonly CanaryRow[];

beforeAll(async () => {
  const source = readFileSync(fixturePath, "utf8");
  const jsSource = ts.transpileModule(source.replace(/\bexport\s+/g, ""), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    fileName: fixturePath,
  }).outputText;
  directCanary = new Function(`${jsSource}\nreturn ${functionName};`)() as (seed: number) => number;
  directValues = fixedSeeds.map(directCanary);
  directChecksum = stressChecksum(directCanary);

  const matrix = [
    { allocator: "bump", policy: "arena-v1", allocationClass: "arena" },
    { allocator: "analysis-stack", policy: "analysis-stack-arena-v1", allocationClass: "stack" },
  ] as const;
  const compiledRows: CanaryRow[] = [];
  for (const entry of matrix) {
    const compiled = await compile(source, {
      target: "linear",
      allocator: entry.allocator,
      fileName: fixturePath,
    });
    expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);

    // This last-write-wins report must be captured before any other compile.
    const report = getLastLinearIrReport();
    if (!report) throw new Error(`missing linear IR report for allocator ${entry.allocator}`);
    const porfforInput = lowerIrModuleToPorffor(report.irModule, {
      memoryPlan: report.memoryPlan,
      prefs: { gc: false },
    });

    const { instance } = await WebAssembly.instantiate(compiled.binary);
    const wasmCanary = (instance.exports as Record<string, (seed: number) => number>)[functionName];
    if (!wasmCanary) throw new Error(`linear-Wasm export ${functionName} is absent`);
    compiledRows.push({
      ...entry,
      report,
      porfforInput,
      wasmValues: fixedSeeds.map(wasmCanary),
      wasmChecksum: stressChecksum(wasmCanary),
    });
  }
  rows = compiledRows;
}, 120_000);

describe("#3478 real source to shared linear-memory plan", () => {
  it("feeds the exact source-derived typed SSA and plan to both backend adapters", () => {
    expect(directValues).toStrictEqual(expectedFixedValues);
    expect(directChecksum).toBe(expectedStressChecksum);

    for (const row of rows) {
      expect(row.report.compiled).toStrictEqual([functionName]);
      expect(row.report.rejected).toStrictEqual([]);
      expect(row.report.irModule.functions).toHaveLength(1);
      const func = row.report.irModule.functions[0]!;
      expect(func).toMatchObject({ name: functionName, exported: true });
      expect(verifyIrFunction(func)).toStrictEqual([]);
      expect(verifyIrBackendLegality(func, "porffor")).toStrictEqual([]);

      const instrs = collectIrInstructions(func);
      const kinds = instrs.map((instr) => instr.kind);
      expect(kinds).toEqual(expect.arrayContaining(["const", "binary", "object.new", "object.get", "object.set"]));
      const objectNews = instrs.filter((instr) => instr.kind === "object.new");
      expect(objectNews).toHaveLength(2);
      expect(new Set(objectNews.map((instr) => instr.alloc as number)).size).toBe(2);
      expect(objectNews.every((instr) => instr.alloc !== undefined)).toBe(true);

      const allocations = row.report.memoryPlan.allocations.filter(
        (allocation) => allocation.ownerFunction === functionName,
      );
      expect(row.report.memoryPlan.policy).toBe(row.policy);
      expect(allocations).toHaveLength(2);
      expect(allocations.map((allocation) => allocation.id as number)).toStrictEqual(
        objectNews.map((instr) => instr.alloc as number),
      );
      expect(allocations.every((allocation) => allocation.allocationKind === "object")).toBe(true);
      expect(
        allocations.every(
          (allocation) =>
            allocation.allocationClass === row.allocationClass &&
            allocation.root.kind === "none" &&
            allocation.safepoints.kind === "none" &&
            allocation.barrier.kind === "none",
        ),
      ).toBe(true);

      if (row.allocationClass === "stack") {
        expect(
          allocations.every(
            (allocation) =>
              allocation.ownership === "owned" &&
              allocation.escape === "local" &&
              allocation.stackCandidate &&
              allocation.operations.some(
                (operation) => operation.family === "stack" && operation.operation === "mark",
              ) &&
              allocation.operations.some(
                (operation) => operation.family === "stack" && operation.operation === "restore",
              ),
          ),
        ).toBe(true);
      }

      expect(row.wasmValues).toStrictEqual(directValues);
      expect(row.wasmChecksum).toBe(directChecksum);
      assertPorfforPlanNodes(row);
    }
  });

  const nativeIt = hasOptionalPorffor && cCompiler ? it : nativeRequired ? it : it.skip;
  nativeIt(
    "matches JavaScript and linear-Wasm in pinned Porffor-C under ASan/UBSan",
    async () => {
      if (!hasOptionalPorffor) {
        throw new Error(`PORFFOR_NATIVE_REQUIRED=1 but ${porfforRoot} is not initialized`);
      }
      if (!cCompiler) throw new Error("PORFFOR_NATIVE_REQUIRED=1 but no C compiler is available");
      if (nativeRequired && !sanitizerEnabled) {
        throw new Error("PORFFOR_NATIVE_REQUIRED=1 also requires PORFFOR_NATIVE_SANITIZERS=1");
      }

      const porffor = await loadOptionalPorffor({ root: porfforRoot });
      for (const row of rows) {
        const rendered = normalizePinnedPorfforCForNative(porfforRendererOutputText(porffor.render(row.porfforInput)));
        const nativeValues = compileAndRunSanitizedC(cCompiler, rendered, row.porfforInput, sanitizerEnabled);
        expect(nativeValues.slice(0, fixedSeeds.length)).toStrictEqual(directValues);
        expect(nativeValues.at(-1)).toBe(directChecksum);
        expect(nativeValues).toHaveLength(fixedSeeds.length + 1);
      }
    },
    120_000,
  );
});

function stressSeed(index: number): number {
  return ((index * 17) % 257) - 128;
}

function stressChecksum(canary: (seed: number) => number): number {
  let checksum = 0;
  for (let index = 0; index < stressIterations; index++) checksum += canary(stressSeed(index));
  return checksum;
}

function collectIrInstructions(func: IrFunction): IrInstr[] {
  const instrs: IrInstr[] = [];
  for (const block of func.blocks) {
    for (const instr of block.instrs) forEachInstrDeep(instr, (nested) => instrs.push(nested));
  }
  return instrs;
}

function collectPorfforNodes(value: unknown, out: PorfforNode[] = []): PorfforNode[] {
  if (!Array.isArray(value)) return out;
  if (value.length === 6 && typeof value[0] === "number" && PORFFOR_KIND_NAMES[value[0]]) {
    const node = value as unknown as PorfforNode;
    out.push(node);
    collectPorfforNodes(node[3], out);
    collectPorfforNodes(node[4], out);
    collectPorfforNodes(node[5], out);
    return out;
  }
  for (const item of value) collectPorfforNodes(item, out);
  return out;
}

function assertPorfforPlanNodes(row: CanaryRow): void {
  expect(row.porfforInput.prefs.gc).toBe(false);
  const func = row.porfforInput.funcs.find((candidate) => candidate?.name === functionName);
  if (!func) throw new Error(`Porffor function ${functionName} is absent`);
  const nodes = collectPorfforNodes(func.body);
  const names = nodes.map((node) => PORFFOR_KIND_NAMES[node[0]]!);
  const calls = nodes.filter((node) => PORFFOR_KIND_NAMES[node[0]] === "Call").map((node) => node[3]);

  expect(names).toContain("Load");
  expect(names).toContain("Store");
  if (row.allocationClass === "arena") {
    expect(names.filter((name) => name === "Alloc")).toHaveLength(2);
    expect(calls).not.toContain("#js2_stack_allocate");
  } else {
    expect(names).not.toContain("Alloc");
    expect(calls.filter((target) => target === "#js2_stack_allocate")).toHaveLength(2);
    expect(calls).toContain("#js2_stack_mark");
    expect(calls).toContain("#js2_stack_restore");
  }

  for (const forbidden of ["GcBarrier", "ArrGet", "ArrSet", "ArrLenSet", "LenGet", "LenSet", "RawC"] as const) {
    expect(names).not.toContain(forbidden);
  }
  expect(names.some((name) => name.startsWith("Jv"))).toBe(false);
  expect(nodes.some((node) => node[1] === porfforJsvalType)).toBe(false);
  expect(func.retType).not.toBe(porfforJsvalType);
  expect(func.params.some((param) => param.type === porfforJsvalType)).toBe(false);
  expect(Object.values(func.locals).some((local) => local.type === porfforJsvalType)).toBe(false);
}

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

  // The pinned renderer's i64 is long on LP64 Linux, while %lld requires a
  // long long vararg. Make that exact site type-correct without suppressing
  // Clang's format diagnostics or changing the value being rendered.
  return rendered.replace(incompatible, portable);
}

function compileAndRunSanitizedC(
  compiler: string,
  rendered: string,
  input: PorfforRendererInput,
  sanitizers: boolean,
): number[] {
  const func = input.funcs.find((candidate) => candidate?.name === functionName);
  if (!func) throw new Error(`missing Porffor function ${functionName}`);
  const symbol = `p${func.index}_${func.name}`;
  const fixedCalls = fixedSeeds.map((seed) => `  printf("%.17g\\n", ${symbol}(${seed}));`).join("\n");
  const harness = `
int main(int argc, char** argv) {
  porf_init(argc, argv);
  porf_data_init();
${fixedCalls}
  double checksum = 0;
  for (int index = 0; index < ${stressIterations}; index++) {
    double seed = (double)((index * 17) % 257 - 128);
    checksum += ${symbol}(seed);
  }
  printf("%.17g\\n", checksum);
  return 0;
}
`;
  const directory = mkdtempSync(join(tmpdir(), "js2-porffor-3478-"));
  const sourcePath = join(directory, "canary.c");
  const binaryPath = join(directory, "canary");
  try {
    writeFileSync(sourcePath, rendered + harness);
    const sanitizerFlags = sanitizers ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"] : [];
    const result = spawnSync(
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
    expect(result.status, `C compiler failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
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
