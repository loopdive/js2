// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { getLastLinearIrReport, type LinearIrResult } from "../src/ir/backend/linear-integration.js";
import {
  PORFFOR_KIND_NAMES,
  porfforRendererOutputText,
  type PorfforNode,
  type PorfforRendererInput,
} from "../src/ir/backend/porffor/compat.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/nodes.js";
import { verifyIrFunction } from "../src/ir/verify.js";

const here = dirname(fileURLToPath(import.meta.url));
const exactSourcePath = join(here, "../website/public/benchmarks/competitive/programs/string-hash.js");
const exactSourceBytes = 601;
const exactSourceSha256 = "66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c";
const inputs = [0, 1, 100, 20_000] as const;
const expectedValues = [0, 96_500, 36_729_899, 862_771_296] as const;
const methodInputs = [-1, 0, 1, 2] as const;
const expectedMethodValues = [777, 1065, 1122, 777, 1065] as const;
const methodSource = `
/** @param {number} index @returns {number} */
export function asciiBounds(index) {
  const value = "Az";
  const char = value.charAt(index);
  const code = value.charCodeAt(index);
  return char.length * 1000 + (code !== code ? 777 : code);
}

/** @returns {number} */
export function asciiOmitted() {
  const value = "Az";
  return value.charAt().length * 1000 + value.charCodeAt();
}
`;
const porfforRoot = process.env.JS2WASM_PORFFOR_ROOT ?? join(here, "../vendor/Porffor");
const hasOptionalPorffor = existsSync(join(porfforRoot, "compiler/ir.js"));
const nativeRequired = process.env.PORFFOR_NATIVE_REQUIRED === "1";
const sanitizerEnabled = process.env.PORFFOR_NATIVE_SANITIZERS === "1";
const cCompiler = findCCompiler();

let source!: string;
let report!: LinearIrResult;
let porfforInput!: PorfforRendererInput;
let nodeValues!: readonly number[];
let wasmGcValues!: readonly number[];
let linearWasmValues!: readonly number[];
let methodPorfforInput!: PorfforRendererInput;
let methodNodeValues!: readonly number[];
let methodWasmGcValues!: readonly number[];
let methodLinearWasmValues!: readonly number[];

beforeAll(async () => {
  source = readExactSource();
  nodeValues = exactNodeValues();
  methodNodeValues = [
    ...methodInputs.map((index) => {
      const value = "Az";
      const char = value.charAt(index);
      const code = value.charCodeAt(index);
      return char.length * 1000 + (Number.isNaN(code) ? 777 : code);
    }),
    "Az".charAt().length * 1000 + "Az".charCodeAt(),
  ];

  const wasmGc = await compile(source, {
    target: "gc",
    experimentalIR: true,
    fileName: exactSourcePath,
  });
  expect(wasmGc.success, wasmGc.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance: wasmGcInstance } = await WebAssembly.instantiate(wasmGc.binary, wasmGc.importObject ?? {});
  const wasmGcRun = (wasmGcInstance.exports as Record<string, (n: number) => number>).run;
  if (!wasmGcRun) throw new Error("WasmGC export run is absent");
  wasmGcValues = inputs.map(wasmGcRun);

  const linear = await compile(source, {
    target: "linear",
    allocator: "bump",
    fileName: exactSourcePath,
  });
  expect(linear.success, linear.errors.map((error) => error.message).join("\n")).toBe(true);
  const capturedReport = getLastLinearIrReport();
  if (!capturedReport) throw new Error("linear compilation did not publish a shared IR report");
  report = capturedReport;
  porfforInput = lowerIrModuleToPorffor(report.irModule, {
    memoryPlan: report.memoryPlan,
    prefs: { gc: false },
  });
  const { instance: linearInstance } = await WebAssembly.instantiate(linear.binary, linear.importObject ?? {});
  const linearRun = (linearInstance.exports as Record<string, (n: number) => number>).run;
  if (!linearRun) throw new Error("linear-Wasm export run is absent");
  linearWasmValues = inputs.map(linearRun);

  const methodWasmGc = await compile(methodSource, {
    target: "gc",
    experimentalIR: true,
    fileName: "issue-3502-ascii-methods.js",
  });
  expect(methodWasmGc.success, methodWasmGc.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance: methodWasmGcInstance } = await WebAssembly.instantiate(
    methodWasmGc.binary,
    methodWasmGc.importObject ?? {},
  );
  const methodGcExports = methodWasmGcInstance.exports as Record<string, (...args: number[]) => number>;
  methodWasmGcValues = [
    ...methodInputs.map((input) => methodGcExports.asciiBounds!(input)),
    methodGcExports.asciiOmitted!(),
  ];

  const methodLinear = await compile(methodSource, {
    target: "linear",
    allocator: "bump",
    fileName: "issue-3502-ascii-methods.js",
  });
  expect(methodLinear.success, methodLinear.errors.map((error) => error.message).join("\n")).toBe(true);
  const methodReport = getLastLinearIrReport();
  if (!methodReport) throw new Error("method linear compilation did not publish a shared IR report");
  expect(methodReport.compiled).toStrictEqual(["asciiBounds", "asciiOmitted"]);
  expect(methodReport.rejected).toStrictEqual([]);
  methodPorfforInput = lowerIrModuleToPorffor(methodReport.irModule, {
    memoryPlan: methodReport.memoryPlan,
    prefs: { gc: false },
  });
  const { instance: methodLinearInstance } = await WebAssembly.instantiate(
    methodLinear.binary,
    methodLinear.importObject ?? {},
  );
  const methodLinearExports = methodLinearInstance.exports as Record<string, (...args: number[]) => number>;
  methodLinearWasmValues = [
    ...methodInputs.map((input) => methodLinearExports.asciiBounds!(input)),
    methodLinearExports.asciiOmitted!(),
  ];
}, 120_000);

describe("#3502 untouched string-hash four-lane acceptance", () => {
  it("matches Node through JS2 WasmGC and shared linear Wasm", () => {
    expect(nodeValues).toStrictEqual([...expectedValues]);
    expect(wasmGcValues).toStrictEqual(nodeValues);
    expect(linearWasmValues).toStrictEqual(nodeValues);
    expect(report.compiled).toStrictEqual(["run"]);
    expect(report.rejected).toStrictEqual([]);

    const run = report.irModule.functions.find((func) => func.name === "run");
    if (!run) throw new Error("source-derived IR function run is absent");
    expect(verifyIrFunction(run)).toStrictEqual([]);
    expect(verifyIrBackendLegality(run, "linear")).toStrictEqual([]);
    expect(verifyIrBackendLegality(run, "porffor")).toStrictEqual([]);

    const instructions: IrInstr[] = [];
    for (const block of run.blocks) {
      for (const instruction of block.instrs) {
        forEachInstrDeep(instruction, (nested) => instructions.push(nested));
      }
    }
    const concats = instructions.filter(
      (instruction): instruction is Extract<IrInstr, { kind: "string.concat" }> => instruction.kind === "string.concat",
    );
    expect(concats).toHaveLength(3);
    expect(concats.every((concat) => concat.concatMode === "owned-append")).toBe(true);
    expect(concats.every((concat) => concat.encodingEvidence === "ascii")).toBe(true);
    expect(instructions.some((instruction) => instruction.kind === "string.char_at")).toBe(true);
    expect(instructions.some((instruction) => instruction.kind === "string.char_code_at")).toBe(true);
    expect(
      report.memoryPlan.allocations
        .filter((allocation) => allocation.allocationKind === "string")
        .every((allocation) => allocation.encoding === "ascii"),
    ).toBe(true);

    const porfforRun = porfforInput.funcs.find((func) => func?.name === "run");
    if (!porfforRun) throw new Error("Porffor IR function run is absent");
    const porfforKinds = collectPorfforNodes(porfforRun.body).map((node) => PORFFOR_KIND_NAMES[node[0]]!);
    expect(porfforKinds).toEqual(expect.arrayContaining(["Alloc", "Load", "Store", "If"]));
    expect(porfforKinds).not.toContain("RawC");
  });

  it("preserves ASCII bounds, NaN, and omitted-index semantics through both Wasm lanes", () => {
    expect(methodNodeValues).toStrictEqual([...expectedMethodValues]);
    expect(methodWasmGcValues).toStrictEqual(methodNodeValues);
    expect(methodLinearWasmValues).toStrictEqual(methodNodeValues);
  });

  const nativeIt = hasOptionalPorffor && cCompiler ? it : nativeRequired ? it : it.skip;
  nativeIt(
    "matches all three lanes in native Porffor C under ASan/UBSan",
    async () => {
      requireNativeEnvironment();
      expect(
        await renderAndRunNative(
          porfforInput,
          inputs.map((arg) => ({ functionName: "run", args: [arg] })),
          "string-hash",
        ),
      ).toStrictEqual(nodeValues);
      expect(
        await renderAndRunNative(
          methodPorfforInput,
          [
            ...methodInputs.map((arg) => ({ functionName: "asciiBounds", args: [arg] })),
            { functionName: "asciiOmitted", args: [] },
          ],
          "string-methods",
        ),
      ).toStrictEqual([...expectedMethodValues]);
    },
    180_000,
  );
});

function readExactSource(): string {
  const bytes = readFileSync(exactSourcePath);
  expect(bytes.byteLength).toBe(exactSourceBytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(exactSourceSha256);
  return bytes.toString("utf8");
}

function exactNodeValues(): number[] {
  const script = `const m = await import(${JSON.stringify(pathToFileURL(exactSourcePath).href)}); console.log(JSON.stringify(${JSON.stringify(
    inputs,
  )}.map((value) => m.run(value))));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" }),
  ) as number[];
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
  if (!hasOptionalPorffor) throw new Error(`PORFFOR_NATIVE_REQUIRED=1 but ${porfforRoot} is not initialized`);
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

function normalizePinnedPorfforC(rendered: string): string {
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
  calls: readonly { readonly functionName: string; readonly args: readonly number[] }[],
  artifactName: string,
): Promise<number[]> {
  const porffor = await loadOptionalPorffor({ root: porfforRoot });
  const rendered = normalizePinnedPorfforC(porfforRendererOutputText(porffor.render(input)));
  const callSource = calls
    .map(({ functionName, args }) => {
      const func = input.funcs.find((candidate) => candidate?.name === functionName);
      if (!func) throw new Error(`missing Porffor function ${functionName}`);
      return `  printf("%.17g\\n", p${func.index}_${func.name}(${args.join(", ")}));`;
    })
    .join("\n");
  const harness = `
int main(int argc, char** argv) {
  porf_init(argc, argv);
  porf_data_init();
${callSource}
  return 0;
}
`;
  const directory = mkdtempSync(join(tmpdir(), "js2-porffor-3502-"));
  const sourcePath = join(directory, `${artifactName}.c`);
  const binaryPath = join(directory, artifactName);
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
