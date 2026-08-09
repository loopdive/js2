// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { analyzeSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import {
  IrFunctionBuilder,
  irSupportGlobalRef,
  irVal,
  irUnitFuncRef,
  lowerFunctionAstToIr,
  verifyIrBackendLegality,
  type IrFunction,
  type IrModule,
  type IrObjectShape,
} from "../src/ir/index.js";
import { PORFFOR_KIND_NAMES, porfforRendererOutputText, type PorfforNode } from "../src/ir/backend/porffor/compat.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3297");
const here = dirname(fileURLToPath(import.meta.url));
const porfforRoot = process.env.JS2WASM_PORFFOR_ROOT ?? join(here, "../vendor/Porffor");
const hasOptionalPorffor = existsSync(join(porfforRoot, "compiler/ir.js"));
const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });

const DIFF_SOURCE = `
  let trace = 0;
  function left(): number { trace = 1; return 10; }
  function right(): number { trace = trace * 10 + 2; return 3; }
  export function ordered(): number { trace = 0; return (left() + right()) * 100 + trace; }
  function twice(x: number): number { return x * 2; }
  export function directArgs(): number { return twice(6) + twice(7); }

  export function loopSum(): number {
    let n = 5;
    let total = 0;
    while (n > 0) {
      total = total + n;
      n = n - 1;
    }
    return total;
  }

  export function classify(x: number): number {
    if (x > 0) return 1;
    if (x < 0) return -1;
    return 0;
  }

  export function forSum(): number {
    let total = 0;
    for (let i = 0; i < 5; i = i + 1) total = total + i;
    return total;
  }
`;

function effectFunctions(): IrFunction[] {
  const global = irSupportGlobalRef(identities.unit(100), "effect-trace", "trace");

  const leftIdentity = identities.next("left");
  const left = new IrFunctionBuilder(leftIdentity, [F64]);
  left.openBlock();
  const one = left.emitConst({ kind: "f64", value: 1 }, F64);
  left.emitGlobalSet(global, one);
  const ten = left.emitConst({ kind: "f64", value: 10 }, F64);
  left.terminate({ kind: "return", values: [ten] });

  const rightIdentity = identities.next("right");
  const right = new IrFunctionBuilder(rightIdentity, [F64]);
  right.openBlock();
  const oldTrace = right.emitGlobalGet(global, F64);
  const scale = right.emitConst({ kind: "f64", value: 10 }, F64);
  const shifted = right.emitBinary("f64.mul", oldTrace, scale, F64);
  const two = right.emitConst({ kind: "f64", value: 2 }, F64);
  const nextTrace = right.emitBinary("f64.add", shifted, two, F64);
  right.emitGlobalSet(global, nextTrace);
  const three = right.emitConst({ kind: "f64", value: 3 }, F64);
  right.terminate({ kind: "return", values: [three] });

  const ordered = new IrFunctionBuilder(identities.next("ordered"), [F64], true);
  ordered.openBlock();
  const zero = ordered.emitConst({ kind: "f64", value: 0 }, F64);
  ordered.emitGlobalSet(global, zero);
  const leftResult = ordered.emitCall(irUnitFuncRef(leftIdentity), [], F64)!;
  const rightResult = ordered.emitCall(irUnitFuncRef(rightIdentity), [], F64)!;
  const sum = ordered.emitBinary("f64.add", leftResult, rightResult, F64);
  const hundred = ordered.emitConst({ kind: "f64", value: 100 }, F64);
  const weighted = ordered.emitBinary("f64.mul", sum, hundred, F64);
  const finalTrace = ordered.emitGlobalGet(global, F64);
  const result = ordered.emitBinary("f64.add", weighted, finalTrace, F64);
  ordered.terminate({ kind: "return", values: [result] });

  const twiceIdentity = identities.next("twice");
  const twice = new IrFunctionBuilder(twiceIdentity, [F64]);
  const input = twice.addParam("x", F64);
  twice.openBlock();
  const multiplier = twice.emitConst({ kind: "f64", value: 2 }, F64);
  const doubled = twice.emitBinary("f64.mul", input, multiplier, F64);
  twice.terminate({ kind: "return", values: [doubled] });

  const directArgs = new IrFunctionBuilder(identities.next("directArgs"), [F64], true);
  directArgs.openBlock();
  const six = directArgs.emitConst({ kind: "f64", value: 6 }, F64);
  const seven = directArgs.emitConst({ kind: "f64", value: 7 }, F64);
  const twelve = directArgs.emitCall(irUnitFuncRef(twiceIdentity), [six], F64)!;
  const fourteen = directArgs.emitCall(irUnitFuncRef(twiceIdentity), [seven], F64)!;
  const twentySix = directArgs.emitBinary("f64.add", twelve, fourteen, F64);
  directArgs.terminate({ kind: "return", values: [twentySix] });

  return [left.finish(), right.finish(), ordered.finish(), twice.finish(), directArgs.finish()];
}

function frontendFunction(source: string, name: string): IrFunction {
  const ast = analyzeSource(source);
  const declaration = ast.sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`missing function ${name}`);
  return lowerFunctionAstToIr(declaration, {
    exported: true,
    ownerUnitId: identities.next(name).unitId,
  }).main;
}

function selectAndConvertFunction(): IrFunction {
  const builder = new IrFunctionBuilder(identities.next("selectConvert"), [F64], true);
  const condition = builder.addParam("condition", I32);
  const value = builder.addParam("value", I32);
  builder.openBlock();
  const converted = builder.emitUnary("f64.convert_i32_s", value, F64);
  const fallback = builder.emitConst({ kind: "f64", value: 20 }, F64);
  const selected = builder.emitSelect(condition, converted, fallback, F64);
  builder.terminate({ kind: "return", values: [selected] });
  return builder.finish();
}

function unreachableFunction(): IrFunction {
  const builder = new IrFunctionBuilder(identities.next("never"), []);
  builder.openBlock();
  builder.terminate({ kind: "unreachable" });
  return builder.finish();
}

function proofModule(order: "normal" | "shuffled" = "normal"): IrModule {
  const [left, right, ordered, twice, directArgs] = effectFunctions();
  const loop = frontendFunction(DIFF_SOURCE, "loopSum");
  const classify = frontendFunction(DIFF_SOURCE, "classify");
  const forLoop = frontendFunction(DIFF_SOURCE, "forSum");
  const select = selectAndConvertFunction();
  const never = unreachableFunction();
  const functions =
    order === "normal"
      ? [left!, right!, ordered!, twice!, directArgs!, loop, forLoop, classify, select, never]
      : [select, classify, ordered!, forLoop, never, right!, directArgs!, loop, left!, twice!];
  return { functions };
}
function lowerProof(order: "normal" | "shuffled" = "normal") {
  const trace = irSupportGlobalRef(identities.unit(100), "effect-trace", "trace");
  const spare = irSupportGlobalRef(identities.unit(101), "effect-spare", "spare");
  return lowerIrModuleToPorffor(proofModule(order), {
    globals:
      order === "normal"
        ? [
            { ref: trace, type: F64 },
            { ref: spare, type: I32 },
          ]
        : [
            { ref: spare, type: I32 },
            { ref: trace, type: F64 },
          ],
    prefs: { gc: false },
  });
}

function collectNodes(value: unknown, out: PorfforNode[] = []): PorfforNode[] {
  if (!Array.isArray(value)) return out;
  if (value.length === 6 && typeof value[0] === "number" && PORFFOR_KIND_NAMES[value[0]]) {
    const node = value as unknown as PorfforNode;
    out.push(node);
    collectNodes(node[3], out);
    collectNodes(node[4], out);
    collectNodes(node[5], out);
    return out;
  }
  for (const item of value) collectNodes(item, out);
  return out;
}

function nodeName(node: PorfforNode): string {
  return PORFFOR_KIND_NAMES[node[0]]!;
}

describe("#3297 Porffor scalar/control-flow sink", () => {
  it("maps the scalar/control-flow family and retains Porffor FX on direct calls", () => {
    const input = lowerProof();
    const nodes = input.funcs.flatMap((func) => collectNodes(func?.body ?? []));
    const kinds = new Set(nodes.map(nodeName));

    for (const expected of [
      "Const",
      "Local",
      "Global",
      "Assign",
      "Bin",
      "Un",
      "Select",
      "Convert",
      "If",
      "Loop",
      "Break",
      "Continue",
      "Block",
      "Return",
      "Unreachable",
      "Call",
    ]) {
      expect(kinds, `missing Porffor ${expected} mapping`).toContain(expected);
    }

    const ordered = input.funcs.find((func) => func?.name === "ordered")!;
    const calls = collectNodes(ordered.body).filter((node) => nodeName(node) === "Call");
    expect(calls.map((call) => call[3])).toEqual(["left", "right"]);
    expect(calls.every((call) => (call[2] & 4) !== 0)).toBe(true);
  });

  it("preserves stable label order and uses identity only to break label collisions", () => {
    expect(lowerProof("shuffled")).toStrictEqual(lowerProof("normal"));
    expect(lowerProof().funcs.map((func) => func?.name)).toEqual([
      "classify",
      "directArgs",
      "forSum",
      "left",
      "loopSum",
      "never",
      "ordered",
      "right",
      "selectConvert",
      "twice",
    ]);
    expect(lowerProof().globals.map((global) => global.name)).toEqual(["spare", "trace"]);
  });

  it("requires the shared memory plan before heap emission", () => {
    const shape: IrObjectShape = { fields: [{ name: "value", type: F64 }] };
    const builder = new IrFunctionBuilder(identities.next("heapRejected"), [{ kind: "object", shape }]);
    builder.openBlock();
    const value = builder.emitConst({ kind: "f64", value: 1 }, F64);
    const object = builder.emitObjectNew(shape, [value]);
    builder.terminate({ kind: "return", values: [object] });
    const func = builder.finish();

    expect(verifyIrBackendLegality(func, "porffor")).toEqual([]);
    expect(() => lowerIrModuleToPorffor({ functions: [func] })).toThrow(/shared LinearMemoryPlan/);
  });
});

describe("#3297 JavaScript / linear-Wasm / Porffor-C differential", () => {
  const optionalIt = hasOptionalPorffor && findCCompiler() ? it : it.skip;

  optionalIt(
    "preserves scalar results and left-to-right call effects in rendered C",
    async () => {
      const jsSource = ts.transpileModule(DIFF_SOURCE.replace(/\bexport\s+/g, ""), {
        compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const js = new Function(`${jsSource}\nreturn { ordered, directArgs, loopSum, forSum, classify };`)() as Record<
        string,
        (...args: number[]) => number
      >;
      const expected = [js.ordered!(), js.directArgs!(), js.loopSum!(), js.forSum!(), js.classify!(-4)];

      const linear = await compile(DIFF_SOURCE, { target: "linear", experimentalIR: true });
      expect(linear.success, linear.errors.map((error) => error.message).join("\n")).toBe(true);
      const { instance } = await WebAssembly.instantiate(linear.binary);
      const exports = instance.exports as Record<string, (...args: number[]) => number>;
      const linearValues = [
        exports.ordered!(),
        exports.directArgs!(),
        exports.loopSum!(),
        exports.forSum!(),
        exports.classify!(-4),
      ];

      const input = lowerProof();
      const porffor = await loadOptionalPorffor({ root: porfforRoot });
      const rendered = porfforRendererOutputText(porffor.render(input));
      const porfforValues = compileAndRunC(rendered, input.funcs, [
        { name: "ordered", args: [] },
        { name: "directArgs", args: [] },
        { name: "loopSum", args: [] },
        { name: "forSum", args: [] },
        { name: "classify", args: [-4] },
      ]);

      expect(expected).toEqual([1312, 26, 15, 10, -1]);
      expect(linearValues).toStrictEqual(expected);
      expect(porfforValues).toStrictEqual(expected);
    },
    60_000,
  );
});

function findCCompiler(): string | null {
  const candidates = [process.env.CC, "cc", "clang", "gcc"].filter((candidate): candidate is string => !!candidate);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (result.status === 0) return candidate;
  }
  return null;
}

function compileAndRunC(
  rendered: string,
  funcs: readonly ({ readonly name: string; readonly index: number } | null | undefined)[],
  calls: readonly { readonly name: string; readonly args: readonly number[] }[],
): number[] {
  const compiler = findCCompiler();
  if (!compiler) throw new Error("no C compiler available");
  const symbols = new Map(
    funcs.filter((func): func is NonNullable<typeof func> => !!func).map((func) => [func.name, func]),
  );
  const invocationLines = calls.map((call) => {
    const func = symbols.get(call.name);
    if (!func) throw new Error(`missing Porffor function ${call.name}`);
    const args = call.args.map((arg) => (Number.isInteger(arg) ? `${arg}.0` : String(arg))).join(", ");
    return `  printf("%.17g\\n", p${func.index}_${func.name}(${args}));`;
  });
  const harness = `
int main(int argc, char** argv) {
  porf_init(argc, argv);
  porf_data_init();
${invocationLines.join("\n")}
  return 0;
}
`;

  const directory = mkdtempSync(join(tmpdir(), "js2-porffor-3297-"));
  const sourcePath = join(directory, "proof.c");
  const binaryPath = join(directory, "proof");
  try {
    writeFileSync(sourcePath, rendered + harness);
    const compileResult = spawnSync(
      compiler,
      ["-std=gnu11", "-Werror", "-Wno-unused-function", sourcePath, "-lm", "-o", binaryPath],
      { encoding: "utf8" },
    );
    expect(compileResult.status, `C compiler failed:\n${compileResult.stdout}\n${compileResult.stderr}`).toBe(0);
    const stdout = execFileSync(binaryPath, { encoding: "utf8" });
    return stdout.trim().split("\n").map(Number);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
