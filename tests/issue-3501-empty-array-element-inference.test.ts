// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import { compile } from "../src/index.js";
import {
  emptyArrayInferenceDiagnostic,
  inferEmptyArrayElementTypes,
  type EmptyArrayInferenceResult,
} from "../src/ir/array-element-inference.js";
import { LINEAR_ARRAY_FORWARDING } from "../src/ir/analysis/linear-memory-plan.js";
import { irIntrinsicFuncRef, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { PorfforModuleAssembler } from "../src/ir/backend/porffor/assembler.js";
import {
  PORFFOR_KIND_NAMES,
  porfforRendererOutputText,
  type PorfforNode,
  type PorfforRendererInput,
} from "../src/ir/backend/porffor/compat.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";
import { asBlockId, forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const here = dirname(fileURLToPath(import.meta.url));
const exactSourcePath = join(here, "../website/public/benchmarks/competitive/programs/array-sum.js");
const exactSourceBytes = 441;
const exactSourceSha256 = "61affa6e44688788cfdb50f5186078cb55c171f19df2bb104e2dcb9f331cd59c";
const porfforRoot = process.env.JS2WASM_PORFFOR_ROOT ?? join(here, "../vendor/Porffor");
const hasOptionalPorffor = existsSync(join(porfforRoot, "compiler/ir.js"));
const nativeRequired = process.env.PORFFOR_NATIVE_REQUIRED === "1";
const sanitizerEnabled = process.env.PORFFOR_NATIVE_SANITIZERS === "1";
const cCompiler = findCCompiler();
const porfforIdentities = createTestIrFunctionIdentityFactory("issue-3501-porffor-bindings");

const vectorProbeSource = `
/** @param {number} n @returns {number} */
export function vectorProbe(n) {
  const values = [];
  const alias = values;
  for (let i = 0; i < n; i++) {
    alias[i] = i * 2;
  }
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i];
  }
  return values.length * 100000 - total;
}
`;

describe("#3501 empty-array element inference", () => {
  it("closes aliases and control-flow joins before selecting the numeric vector type", () => {
    const result = inferenceFor(`
      function probe(flag) {
        const values = [];
        const alias = values;
        const joined = flag ? values : alias;
        joined[0] = 1;
        return joined[0];
      }
    `);

    expect(result).toEqual({
      kind: "resolved",
      elementKind: "number",
      elementValType: { kind: "f64" },
      aliases: ["values", "alias", "joined"],
      evidence: ["number"],
      int32Narrowed: false,
    });
  });

  it("rejects mixed, escaping, and unresolved groups with stable diagnostics", () => {
    const mixed = inferenceFor(`
      function probe() {
        const values = [];
        values[0] = 1;
        values[1] = "x";
        return 0;
      }
    `);
    const escaping = inferenceFor(`
      function probe() {
        const values = [];
        const alias = values;
        alias[0] = 1;
        consume(alias);
        return 0;
      }
    `);
    const unresolved = inferenceFor(`
      function probe() {
        const values = [];
        return values.length;
      }
    `);

    expect(mixed).toMatchObject({ kind: "rejected", reason: "mixed", evidence: ["number", "string"] });
    expect(escaping).toMatchObject({ kind: "rejected", reason: "escaping", aliases: ["values", "alias"] });
    expect(unresolved).toMatchObject({ kind: "rejected", reason: "unresolved", evidence: [] });
    expect(emptyArrayInferenceDiagnostic(mixed, "probe")).toBe(
      "ir/from-ast: empty array 'values' has mixed element evidence [number, string] (probe)",
    );
    expect(emptyArrayInferenceDiagnostic(escaping, "probe")).toBe(
      "ir/from-ast: empty array 'values' escapes before its element type is closed (probe)",
    );
    expect(emptyArrayInferenceDiagnostic(unresolved, "probe")).toBe(
      "ir/from-ast: empty array 'values' has unresolved supported element evidence (probe)",
    );
  });

  it("keeps mixed and unresolved source functions on stable conservative demotions", async () => {
    const cases = [
      {
        source: `
          /** @param {number} n @returns {number} */
          export function run(n) {
            const values = [];
            values[0] = n;
            values[1] = "x";
            return n;
          }
        `,
        detail: "ir/from-ast: empty array 'values' has mixed element evidence [number, string] (run)",
      },
      {
        source: `
          /** @param {number} n @returns {number} */
          export function run(n) {
            const values = [];
            return values.length + n;
          }
        `,
        detail: "ir/from-ast: empty array 'values' has unresolved supported element evidence (run)",
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const { report } = await compileLinear(entry.source, `issue-3501-negative-${index}.js`);
      expect(report.compiled).toEqual([]);
      expect(report.rejected).toContainEqual({ func: "run", reason: "build", detail: entry.detail });
    }
  });
});

describe("#3501 shared planned-vector backend operations", () => {
  it("derives reusable grow/set/get/length operations from source and the shared plan", async () => {
    const { compiled, report } = await compileLinear(vectorProbeSource, "issue-3501-vector-probe.js");
    const expected = [100000, 1699728, 99001000];
    const inputs = [1, 17, 1000];

    expect(report.compiled).toEqual(["vectorProbe"]);
    expect(report.rejected).toEqual([]);
    const func = report.irModule.functions.find((candidate) => candidate.name === "vectorProbe")!;
    const instructions: IrInstr[] = [];
    for (const block of func.blocks) {
      for (const instruction of block.instrs) {
        forEachInstrDeep(instruction, (nested) => instructions.push(nested));
      }
    }
    expect(instructions.some((instruction) => instruction.kind === "vec.new_fixed")).toBe(true);
    const callTargets = instructions
      .filter((instruction): instruction is Extract<IrInstr, { kind: "call" }> => instruction.kind === "call")
      .map((instruction) => instruction.target.name);
    expect(callTargets).toEqual(expect.arrayContaining(["__ir_vec_elem_set_f64", "__arr_get", "__arr_len"]));
    expect(callTargets).not.toContain("__vec_elem_set_0");

    const allocations = report.memoryPlan.allocations.filter(
      (allocation) => allocation.ownerFunction === "vectorProbe",
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      allocationKind: "array",
      allocationClass: "arena",
      layoutId: "vector:scalar:f64",
      size: { kind: "constant", bytes: 144 },
    });
    expect(allocations[0]!.operations).toContainEqual(
      expect.objectContaining({ family: "vector", operation: "grow", elementStorage: "f64" }),
    );
    const layout = report.memoryPlan.layoutForVector({ kind: "val", val: { kind: "f64" } });
    expect(layout).toBeDefined();
    expect(LINEAR_ARRAY_FORWARDING).toEqual({ tag: 0x06, tagOffset: 0, pointerOffset: 4, pointerBytes: 4 });
    expect(LINEAR_ARRAY_FORWARDING.pointerOffset + LINEAR_ARRAY_FORWARDING.pointerBytes).toBeLessThanOrEqual(
      layout!.lengthOffset,
    );

    const { instance } = await WebAssembly.instantiate(compiled.binary, compiled.importObject ?? {});
    const wasmProbe = instance.exports.vectorProbe as (n: number) => number;
    expect(inputs.map(wasmProbe)).toEqual(expected);

    const porfforInput = lowerIrModuleToPorffor(report.irModule, {
      memoryPlan: report.memoryPlan,
      prefs: { gc: false },
    });
    expect(porfforInput.funcs.map((candidate) => candidate?.name)).toEqual(
      expect.arrayContaining([
        "#js2_vec_grow",
        "#js2_vec_resolve",
        "__arr_get",
        "__arr_len",
        "__ir_vec_elem_set_f64",
        "vectorProbe",
      ]),
    );
    expect(porfforInput.funcs.map((candidate) => candidate?.name)).not.toContain("__vec_elem_set_0");
    const runtimeNodes = porfforInput.funcs
      .filter((candidate) => candidate && candidate.name !== "vectorProbe")
      .flatMap((candidate) => collectPorfforNodes(candidate!.body));
    const runtimeKinds = runtimeNodes.map((node) => PORFFOR_KIND_NAMES[node[0]]);
    expect(runtimeKinds).toEqual(expect.arrayContaining(["Alloc", "Load", "Store", "Loop", "Call"]));
    expect(runtimeKinds).not.toContain("RawC");
    expect(runtimeKinds).not.toContain("ArrGet");
    expect(runtimeKinds).not.toContain("ArrSet");
    expect(runtimeKinds).not.toContain("ArrLenSet");
    const getRuntime = porfforInput.funcs.find((candidate) => candidate?.name === "__arr_get");
    expect(getRuntime).toBeDefined();
    expect(
      collectPorfforNodes(getRuntime!.body).some(
        (node) => PORFFOR_KIND_NAMES[node[0]] === "Const" && typeof node[3] === "number" && Number.isNaN(node[3]),
      ),
    ).toBe(true);
  });

  it("rejects an ambiguous second allocation with the same f64 vector layout", async () => {
    const { report } = await compileLinear(
      `
        /** @param {number} n @returns {number} */
        export function twoVectors(n) {
          const left = [];
          const right = [];
          for (let i = 0; i < n; i++) {
            left[i] = i;
            right[i] = i * 2;
          }
          return left.length + right.length;
        }
      `,
      "issue-3501-two-vector-sites.js",
    );
    const layout = report.memoryPlan.layoutForVector({ kind: "val", val: { kind: "f64" } });
    expect(layout).toBeDefined();
    expect(report.memoryPlan.allocationsForLayout(layout!.id)).toHaveLength(2);
    expect(() =>
      lowerIrModuleToPorffor(report.irModule, {
        memoryPlan: report.memoryPlan,
        prefs: { gc: false },
      }),
    ).toThrow(`porffor assembler: array runtime requires one exact allocation for '${layout!.id}', found 2`);
  });

  it("rejects non-f64 vector helper suffixes instead of mapping them to the f64 runtime", () => {
    const assembler = new PorfforModuleAssembler();
    expect(() => assembler.resolveFunc(irIntrinsicFuncRef("__vec_elem_set_1"))).toThrow(
      "porffor assembler: unsupported non-f64 vector helper '__vec_elem_set_1' (expected type index 0)",
    );
  });

  it("does not treat a builtin-looking source unit as an intrinsic", () => {
    const assembler = new PorfforModuleAssembler();
    const identity = porfforIdentities.next("__vec_elem_set_1");
    const func: IrFunction = {
      ...identity,
      params: [],
      resultTypes: [],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "return", values: [] },
        },
      ],
      exported: false,
      valueCount: 0,
    };

    const handle = assembler.declareIrFunction(func);

    expect(assembler.resolveFunc(irUnitFuncRef(identity))).toBe(handle);
    expect(() => assembler.resolveFunc(irIntrinsicFuncRef(identity.name))).toThrow(/unsupported non-f64 vector/);
  });

  it("demotes inferred array reads without an in-bounds proof", async () => {
    const { report } = await compileLinear(
      `
        /** @param {number} n @returns {number} */
        export function readMaybeOutOfBounds(n) {
          const values = [];
          values[0] = 1;
          return values[n];
        }
      `,
      "issue-3501-oob-read.js",
    );
    expect(report.compiled).toEqual([]);
    expect(report.rejected).toContainEqual({
      func: "readMaybeOutOfBounds",
      reason: "build",
      detail: "ir/from-ast: inferred linear vector read is not proven in bounds (readMaybeOutOfBounds)",
    });
  });

  const nativeIt = hasOptionalPorffor && cCompiler ? it : nativeRequired ? it : it.skip;
  nativeIt(
    "executes allocation growth and alias-forwarded reads in native Porffor C under ASan/UBSan",
    async () => {
      requireNativeEnvironment();
      const { report } = await compileLinear(vectorProbeSource, "issue-3501-vector-probe.js");
      const input = lowerIrModuleToPorffor(report.irModule, {
        memoryPlan: report.memoryPlan,
        prefs: { gc: false },
      });
      expect(await renderAndRunNative(input, "vectorProbe", [1, 17, 1000])).toEqual([100000, 1699728, 99001000]);
    },
    120_000,
  );
});

describe("#3501 exact landing array-sum source", () => {
  it("matches Node through WasmGC and source-derived shared linear IR", async () => {
    const source = readExactSource();
    const inputs = [0, 1, 16, 17, 2000];
    const expected = exactNodeValues(inputs);

    const gc = await compile(source, { target: "gc", experimentalIR: true, fileName: exactSourcePath });
    expect(gc.success, gc.errors.map((error) => error.message).join("\n")).toBe(true);
    const gcImports = buildImports(gc.imports, undefined, gc.stringPool);
    const { instance: gcInstance } = await WebAssembly.instantiate(gc.binary, gcImports as WebAssembly.Imports);
    const gcRun = gcInstance.exports.run as (n: number) => number;
    expect(inputs.map(gcRun)).toEqual(expected);

    const { compiled: linear, report } = await compileLinear(source, exactSourcePath);
    expect(report.compiled).toEqual(["run"]);
    expect(report.rejected).toEqual([]);
    const { instance: linearInstance } = await WebAssembly.instantiate(linear.binary, linear.importObject ?? {});
    const linearRun = linearInstance.exports.run as (n: number) => number;
    expect(inputs.map(linearRun)).toEqual(expected);
  });

  const nativeIt = hasOptionalPorffor && cCompiler ? it : nativeRequired ? it : it.skip;
  nativeIt(
    "matches Node for the untouched public source in native Porffor C under ASan/UBSan",
    async () => {
      requireNativeEnvironment();
      const inputs = [0, 17, 2000, 1_000_000];
      const expected = exactNodeValues(inputs);
      const source = readExactSource();
      const { report } = await compileLinear(source, exactSourcePath);
      const input = lowerIrModuleToPorffor(report.irModule, {
        memoryPlan: report.memoryPlan,
        prefs: { gc: false },
      });

      expect(await renderAndRunNative(input, "run", inputs)).toEqual(expected);
    },
    180_000,
  );
});

function inferenceFor(source: string): EmptyArrayInferenceResult {
  const { sourceFile, checker } = analyzeSource(source, "issue-3501-inference.js");
  const fn = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("inference fixture has no function declaration");
  let literal: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) literal ??= node;
    ts.forEachChild(node, visit);
  };
  visit(fn);
  if (!literal) throw new Error("inference fixture has no empty array literal");
  const result = inferEmptyArrayElementTypes(fn, new TsCheckerOracle(checker)).resultForLiteral(literal);
  if (!result) throw new Error("empty array inference produced no result");
  return result;
}

async function compileLinear(source: string, fileName: string) {
  const compiled = await compile(source, {
    target: "linear",
    allocator: "analysis-stack",
    fileName,
  });
  expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
  const report = getLastLinearIrReport();
  if (!report) throw new Error("linear compilation produced no shared IR report");
  return { compiled, report };
}

function exactNodeValues(inputs: readonly number[]): number[] {
  const moduleUrl = pathToFileURL(exactSourcePath).href;
  const script = `const m = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(${JSON.stringify(
    inputs,
  )}.map((value) => m.run(value))));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" }),
  ) as number[];
}

function readExactSource(): string {
  const source = readFileSync(exactSourcePath);
  expect(source.byteLength).toBe(exactSourceBytes);
  expect(createHash("sha256").update(source).digest("hex")).toBe(exactSourceSha256);
  return source.toString("utf8");
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

function requireNativeEnvironment(): void {
  if (!hasOptionalPorffor) {
    throw new Error(`PORFFOR_NATIVE_REQUIRED=1 but ${porfforRoot} is not initialized`);
  }
  if (!cCompiler) throw new Error("PORFFOR_NATIVE_REQUIRED=1 but no C compiler is available");
  if (nativeRequired && !sanitizerEnabled) {
    throw new Error("PORFFOR_NATIVE_REQUIRED=1 also requires PORFFOR_NATIVE_SANITIZERS=1");
  }
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
  return rendered.replace(incompatible, portable);
}

async function renderAndRunNative(
  input: PorfforRendererInput,
  functionName: string,
  args: readonly number[],
): Promise<number[]> {
  const porffor = await loadOptionalPorffor({ root: porfforRoot });
  const rendered = normalizePinnedPorfforCForNative(porfforRendererOutputText(porffor.render(input)));
  const func = input.funcs.find((candidate) => candidate?.name === functionName);
  if (!func) throw new Error(`missing Porffor function ${functionName}`);
  const symbol = `p${func.index}_${func.name}`;
  const calls = args.map((arg) => `  printf("%.17g\\n", ${symbol}(${arg}));`).join("\n");
  const harness = `
int main(int argc, char** argv) {
  porf_init(argc, argv);
  porf_data_init();
${calls}
  return 0;
}
`;
  const directory = mkdtempSync(join(tmpdir(), "js2-porffor-3501-"));
  const sourcePath = join(directory, "array-vector.c");
  const binaryPath = join(directory, "array-vector");
  try {
    writeFileSync(sourcePath, rendered + harness);
    const sanitizerFlags = sanitizerEnabled ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"] : [];
    const built = spawnSync(
      cCompiler!,
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
    const executed = spawnSync(binaryPath, [], {
      encoding: "utf8",
      env: {
        ...process.env,
        ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1:abort_on_error=1",
        UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
      },
    });
    expect(executed.status, `native execution failed:\n${executed.stdout}\n${executed.stderr}`).toBe(0);
    return executed.stdout.trim().split("\n").map(Number);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
