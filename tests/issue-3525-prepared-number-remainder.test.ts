// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  acceptPreparedIrProgram,
  acceptedPhysicalSetupPlan,
  emitAcceptedIrProgram,
  emittedSupportFunctionReceipts,
  emittedProgramBindingIndex,
} from "../src/ir/program-consumer.js";
import {
  PreparedIrProgramInvariantError,
  type PreparedIrProgram,
  type PreparedIrBackendOptions,
} from "../src/ir/program.js";
import { buildNumberRemainderBody } from "../src/wasm/physical/number-remainder.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";
import * as consumer from "../src/ir/program-consumer.js";

const SOURCE = {
  "./entry.ts": `export function remainder(left: number, right: number): number { return left % right; }
export function large(left: number): number { return left % 65536; }`,
};
const BACKENDS = ["wasmgc", "linear"] as const;
const CASES = [
  [5.5, 2],
  [-5.5, 2],
  [1e16, 0.0001],
  [123456789.123, 0.001],
  [1e308, 1e-308],
  [Number.MIN_VALUE * 3, Number.MIN_VALUE * 2],
  [-0, 3],
  [-6, 3],
  [-2147483648, -1],
  [1, 0],
  [1, -0],
  [Infinity, 3],
  [-Infinity, 3],
  [2, Infinity],
  [NaN, 3],
  [2, NaN],
] as const;

function program(files: Record<string, string> = SOURCE): PreparedIrProgram {
  const ast = analyzeMultiSource(files, "./entry.ts");
  expect(ast.syntacticDiagnostics).toEqual([]);
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "wasmgc", target: "host" },
    deferTopLevelInit: false,
    runtimePolicies: BACKENDS.map((backend) => ({ backend, target: "host" as const })),
  });
  expect(result.kind, result.kind === "prepared" ? undefined : result.detail).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(result.detail);
  return result.program;
}
function options(backend: (typeof BACKENDS)[number]): PreparedIrBackendOptions {
  return {
    backend,
    target: "host",
    sharedExceptionTag: false,
    utf8Storage: false,
    sourceMap: false,
    moduleName: "number-remainder",
  };
}
function accepted(source: PreparedIrProgram, backend: (typeof BACKENDS)[number]) {
  const result = acceptPreparedIrProgram(source, options(backend));
  expect(result.kind, result.kind === "accepted" ? undefined : result.detail).toBe("accepted");
  if (result.kind !== "accepted") throw new Error(result.detail);
  return result;
}
function execute(source: PreparedIrProgram, backend: (typeof BACKENDS)[number]) {
  const token = accepted(source, backend);
  const plan = acceptedPhysicalSetupPlan(token);
  expect(plan.numberRemainders.map((row) => row.symbol).sort()).toEqual(["__fmod", "__fmod_early_magnitude"]);
  const emitted = emitAcceptedIrProgram(token);
  const receipts = emittedSupportFunctionReceipts(emitted);
  expect(receipts).toHaveLength(2);
  expect(new Set(receipts.map((receipt) => receipt.index)).size).toBe(2);
  expect(emitted.emittedUnitIds).toEqual(token.runtime.prepared.functions.map((fn) => fn.unitId));
  expect(emitted.emittedUnitIds).toHaveLength(2);
  expect(emitted.module.functions).toHaveLength(4);
  for (const row of plan.numberRemainders) {
    const binding = emittedProgramBindingIndex(emitted, row.bindingId);
    expect(binding?.space).toBe("function");
    expect(receipts).toContainEqual({ key: row.bindingId, index: binding?.index });
    expect(emitted.module.functions[binding!.index]?.name).toBe(row.symbol);
  }
  const bytes = emitBinary(emitted.module);
  expect(WebAssembly.validate(new Uint8Array(bytes))).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)));
  const remainder = instance.exports.remainder as (left: number, right: number) => number;
  const large = instance.exports.large as (left: number) => number;
  for (const [left, right] of CASES)
    expect(Object.is(remainder(left, right), left % right), `${left} % ${right}`).toBe(true);
  for (const left of [-0, -65536, 65535.5, 1e16, 1e308, Infinity, NaN])
    expect(Object.is(large(left), left % 65536), `${left} % 65536`).toBe(true);
  return emitted;
}

afterEach(() => vi.restoreAllMocks());
describe("#3525 genuine prepared exact Number remainder support", () => {
  for (const backend of BACKENDS) {
    it(`executes both exact variants and IEEE edge values on ${backend}/host`, () => {
      execute(program(), backend);
    });
    it(`keeps a real source callable named __fmod separate from intrinsic support on ${backend}`, () => {
      const source = program({
        "./entry.ts": `
export function __fmod(left: number, right: number): number { return left + right + 1000; }
export function combine(left: number, right: number): number { return __fmod(left, right) + left % right; }`,
      });
      const token = accepted(source, backend);
      const plan = acceptedPhysicalSetupPlan(token);
      expect(plan.numberRemainders).toHaveLength(1);
      const emitted = emitAcceptedIrProgram(token);
      const support = emittedSupportFunctionReceipts(emitted);
      expect(emitted.emittedUnitIds).toHaveLength(2);
      expect(support).toHaveLength(1);
      expect(emitted.module.functions).toHaveLength(3);
      const userExport = emitted.module.exports.find((row) => row.name === "__fmod");
      expect(userExport?.desc.kind).toBe("func");
      if (userExport?.desc.kind !== "func") throw new Error("real source export missing");
      expect(userExport.desc.index).not.toBe(support[0]!.index);
      expect(emittedProgramBindingIndex(emitted, plan.numberRemainders[0]!.bindingId)).toEqual({
        space: "function",
        index: support[0]!.index,
      });
      const bytes = emitBinary(emitted.module);
      expect(WebAssembly.validate(new Uint8Array(bytes))).toBe(true);
      const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)));
      const combine = instance.exports.combine as (left: number, right: number) => number;
      const user = instance.exports.__fmod as (left: number, right: number) => number;
      for (const [left, right] of [
        [5, 2],
        [-5.5, 2],
        [1e16, 0.0001],
      ]) {
        expect(Object.is(user(left!, right!), left! + right! + 1000)).toBe(true);
        expect(Object.is(combine(left!, right!), left! + right! + 1000 + (left! % right!))).toBe(true);
      }
    });
    it(`refuses a missing helper fill and restores productive ${backend} emission`, () => {
      const source = program();
      execute(source, backend);
      const token = accepted(source, backend);
      const key = acceptedPhysicalSetupPlan(token).numberRemainders[0]!.bindingId;
      const original = PhysicalModuleReservations.prototype.fillFunction;
      let suppressed = 0;
      const fill = vi.spyOn(PhysicalModuleReservations.prototype, "fillFunction").mockImplementation(function (
        this: PhysicalModuleReservations,
        reservation,
        definition,
      ) {
        if (reservation.key === key) {
          suppressed++;
          return;
        }
        original.call(this, reservation, definition);
      });
      expect(() => emitAcceptedIrProgram(token)).toThrow(/missing function fill/);
      expect(suppressed).toBe(1);
      fill.mockRestore();
      execute(source, backend);
    });
    it(`rejects an unowned helper substitution through authenticated ${backend} support receipts`, () => {
      const source = program();
      const emitted = execute(source, backend);
      const receipt = emittedSupportFunctionReceipts(emitted)[0]!;
      const original = emitted.module.functions[receipt.index]!;
      emitted.module.functions[receipt.index] = structuredClone(original);
      expect(() => emittedSupportFunctionReceipts(emitted)).toThrow(
        /^physical module reservations: missing, substituted or reordered functions population slot \d+$/,
      );
      emitted.module.functions[receipt.index] = original;
      expect(() => emittedSupportFunctionReceipts(emitted)).toThrow(/completion requested in failed/);
      execute(source, backend);
    });
  }
  it("returns fresh independent recipe instructions and local arrays for both exact variants", () => {
    for (const variant of [false, true]) {
      const first = buildNumberRemainderBody(variant);
      const second = buildNumberRemainderBody(variant);
      expect(first).toEqual(second);
      expect(first.body).not.toBe(second.body);
      expect(first.locals).not.toBe(second.locals);
      first.body.push({ op: "unreachable" });
      expect(second.body.at(-1)).toEqual({ op: "f64.copysign" });
    }
  });
  it("refuses missing, foreign variant, wrong-signature and substituted-provider canonical joins before emission", () => {
    const source = program();
    execute(source, "wasmgc");
    const helper = source.abi.entries.find(
      (row) =>
        row.contract.kind === "callable" &&
        row.contract.ref.binding.kind === "intrinsic" &&
        row.contract.ref.binding.symbol === "__fmod",
    )!;
    expect(helper).toBeDefined();
    if (helper.contract.kind !== "callable") throw new Error("missing authentic helper ABI");
    const contract = helper.contract;
    const missing: PreparedIrProgram = {
      ...source,
      abi: { entries: source.abi.entries.filter((row) => row !== helper) },
    };
    const replace = (replacement: typeof helper): PreparedIrProgram => ({
      ...source,
      abi: { entries: source.abi.entries.map((row) => (row === helper ? replacement : row)) },
    });
    const foreign = replace({
      ...helper,
      contract: {
        ...contract,
        ref: { ...contract.ref, binding: { kind: "intrinsic", symbol: "__fmod_early_magnitude" } },
      },
    });
    const signature = replace({ ...helper, contract: { ...contract, params: contract.params.slice(0, 1) } });
    const provider: PreparedIrProgram = {
      ...source,
      runtime: source.runtime.map((row) => ({
        ...row,
        prepared: {
          ...row.prepared,
          manifest: {
            ...row.prepared.manifest,
            providers: row.prepared.manifest.providers.map((selected) =>
              selected.feature === "js.number.remainder"
                ? { ...selected, implementation: { kind: "runtime-callable", symbol: "__fmod_early_magnitude" } }
                : selected,
            ),
          },
        },
      })),
    };
    const missingProvider: PreparedIrProgram = {
      ...source,
      runtime: source.runtime.map((row) => ({
        ...row,
        prepared: {
          ...row.prepared,
          manifest: {
            ...row.prepared.manifest,
            providers: row.prepared.manifest.providers.filter((selected) => selected.feature !== "js.number.remainder"),
          },
        },
      })),
    };
    const emit = vi.spyOn(consumer, "emitAcceptedIrProgram");
    for (const mutant of [missing, foreign, signature, provider, missingProvider])
      expect(() => acceptPreparedIrProgram(mutant, options("wasmgc"))).toThrow(PreparedIrProgramInvariantError);
    expect(emit).not.toHaveBeenCalled();
    emit.mockRestore();
    execute(source, "wasmgc");
  });
});
