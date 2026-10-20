import {
  checkNativeClassValueEquations,
  prepareNativeClassValueEquations,
} from "../src/ir/program/native-js-class-values.js";
import {
  assertPreparedIrProgram,
  assertPreparedIrProgramLinearAllocationEvidence,
} from "../src/ir/program/validation.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { irUnitCallableBindingId } from "../src/ir/core/callable-bindings.js";
import * as valueProducer from "../src/ir/analysis/allocation-evidence/js-class-value-domains/producer.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrRuntimeProjection } from "../src/ir/program/runtime-validation.js";
import { normalizeNativeClassValues } from "../src/ir/program/native-js-class-values.js";
import { analyzeNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/producer.js";
import { replayNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent.js";
const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
function prepareInput(
  policy: (typeof policies)[number] | { readonly backend: "wasmgc"; readonly target: "host" },
  text = "class C{m():number{return 1;}}export function run(x:number):number{new C().m();return x;}",
  defer = false,
) {
  const source = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const result = prepareIrProgramSources({
    sourceFiles: source.sourceFiles,
    entrySource: source.entryFile,
    checker: source.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: defer,
    ...(policy.target === "host" ? {} : { linearVectorProjection: "native-f64" as const }),
  });
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  return captureTypedIrProgramInput(result);
}
function prepare(...args: Parameters<typeof prepareInput>) {
  const typed = prepareInput(...args);
  return { ...typed, abi: { entries: prepareIrProgramAbiEntries(typed) } };
}
describe("native JS class value context normalization", () => {
  for (const policy of policies)
    for (const defer of [false, true])
      it(`${policy.backend}:${policy.target} defer=${defer} complete genuine bodies in both analysis namespaces`, () => {
        const actual = prepare(policy, undefined, defer);
        const original = normalizeNativeClassValues(actual, actual.ir, "original");
        expect(original.kind).toBe("normalized");
        if (original.kind !== "normalized") throw new Error(JSON.stringify(original));
        expect(original.input.module.functions.map((fn) => fn.unitId)).toEqual(
          actual.ir.functions.map((fn) => fn.unitId),
        );
        expect(original.input.globals.length).toBe(
          actual.abi.entries.filter((row) => row.plan.slotPolicy !== "alias" && row.contract.kind === "global").length,
        );
        expect(original.input.entryInputs.length).toBe(1);
        expect(original.input.entryInputs[0]!.transport).toBe("external-js");
        const description = analyzeNativeJsClassValueDomains(original.input);
        expect(description.projections.find((row) => row.externalName === "run")?.decision).toBe("unknown");
        expect(replayNativeJsClassValueDomains(original.input, description)).toEqual([]);
        // Reusing genuine semantic bodies tests only the pure namespace. This is NOT an authenticated runtime projection.
        const selected = normalizeNativeClassValues(actual, actual.ir, "selected");
        expect(selected.kind).toBe("normalized");
        if (selected.kind !== "normalized") throw new Error(JSON.stringify(selected));
        expect(selected.input.namespace).toBe("selected");
        expect(original.invocation[0]!.kind).toBe(
          policy.target === "wasi" ? "wasi-start-export" : defer ? "deferred-export" : "wasm-start",
        );
      });
  it("class-free source is explicitly classified", () => {
    const actual = prepare(policies[0], "export function run(){return 7;}");
    expect(normalizeNativeClassValues(actual, actual.ir, "original")).toEqual({ kind: "class-free" });
  });
  it("raw exported global remains in global census with explicit export classification", () => {
    const actual = prepare(policies[0], "class C{} export let count:number=1; export function run(){return 7;}");
    const result = normalizeNativeClassValues(actual, actual.ir, "original");
    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") throw new Error(JSON.stringify(result));
    expect(result.globalExports.map((row) => row.externalName)).toContain("count");
    expect(
      result.input.globals.some(
        (row) =>
          row.ref.binding.bindingId === result.globalExports.find((row) => row.externalName === "count")!.bindingId,
      ),
    ).toBe(true);
    expect(result.input.exports.map((row) => row.externalName)).not.toContain("count");
  });
  it("body deletion, duplicate ABI and missing startup refuse independently after a successful normalization", () => {
    const actual = prepare(policies[0]);
    expect(normalizeNativeClassValues(actual, actual.ir, "original").kind).toBe("normalized");
    expect(() =>
      normalizeNativeClassValues(actual, { ...actual.ir, functions: actual.ir.functions.slice(1) }, "selected"),
    ).toThrow();
    expect(() =>
      normalizeNativeClassValues(
        { ...actual, abi: { entries: [...actual.abi.entries, actual.abi.entries[0]!] } },
        actual.ir,
        "original",
      ),
    ).toThrow();
    expect(() => normalizeNativeClassValues({ ...actual, startup: [] }, actual.ir, "original")).toThrow();
  });
  it("context and module accessors never execute", () => {
    const actual = prepare(policies[0]);
    let reads = 0;
    const context = { ...actual };
    Object.defineProperty(context, "abi", {
      get() {
        reads++;
        return actual.abi;
      },
    });
    expect(() => normalizeNativeClassValues(context, actual.ir, "original")).toThrow();
    const module = { ...actual.ir };
    Object.defineProperty(module, "functions", {
      get() {
        reads++;
        return actual.ir.functions;
      },
    });
    expect(() => normalizeNativeClassValues(actual, module, "original")).toThrow();
    expect(reads).toBe(0);
  });
  it("startup metadata cannot turn a genuine realm prototype global into an issued callable", () => {
    const actual = prepare(policies[0], "class C{}export function run(){return 7;}");
    expect(normalizeNativeClassValues(actual, actual.ir, "original").kind).toBe("normalized");
    const exported = actual.abi.entries.find(
      (row) => row.contract.kind === "export" && row.contract.externalName === "run",
    )!;
    if (exported.contract.kind !== "export") throw new Error("missing actual run export");
    const targetId = exported.contract.targetId;
    const callable = actual.abi.entries.find((row) => row.plan.id === targetId)!;
    if (callable.contract.kind !== "callable" || callable.contract.ref.binding.kind !== "unit")
      throw new Error("missing actual callable");
    const unitId = callable.contract.ref.binding.unitId;
    const global = actual.abi.entries.find((row) => row.contract.kind === "global" && !row.contract.mutable)!;
    if (!global) throw new Error("missing actual realm global");
    const startup = actual.startup.map((plan, index) =>
      index === 0
        ? {
            ...plan,
            liveSeeds: [
              ...plan.liveSeeds,
              {
                name: "run",
                unitId,
                callableBindingId: callable.plan.id,
                liveGlobalBindingId: global.plan.id,
                declarationOrdinal: 0,
                legacyKey: "live:run",
              },
            ],
          }
        : plan,
    );
    expect(() => normalizeNativeClassValues({ ...actual, startup }, actual.ir, "original")).toThrow(/live seed owner/);
  });
  for (const policy of policies)
    it(`${policy.backend}:${policy.target} genuine sealed and codec original/selected contexts`, () => {
      const outcome = prepareTypedIrProgram(prepareInput(policy), {
        policy,
        runtimePolicies: [policy],
        controls: {
          gvnMode: "off",
          ownership: false,
          escape: false,
          verifyIntermediateAllocations: true,
          verifyDominanceNaive: true,
        },
      });
      if (outcome.kind !== "prepared") throw new Error(JSON.stringify(outcome));
      const bytes = encodePreparedIrProgram(outcome.program);
      const decoded = decodePreparedIrProgram(bytes);
      expect(encodePreparedIrProgram(decoded)).toBe(bytes);
      for (const program of [outcome.program, decoded]) {
        const original = normalizeNativeClassValues(program, program.ir, "original");
        expect(original.kind).toBe("normalized");
        if (original.kind !== "normalized") throw new Error(JSON.stringify(original));
        expect(
          replayNativeJsClassValueDomains(original.input, analyzeNativeJsClassValueDomains(original.input)),
        ).toEqual([]);
        expect(program.runtime.length).toBe(1);
        for (const projection of program.runtime) {
          assertPreparedIrRuntimeProjection(program, projection);
          const selected = normalizeNativeClassValues(
            program,
            { functions: projection.prepared.functions },
            "selected",
          );
          expect(selected.kind).toBe("normalized");
          if (selected.kind !== "normalized") throw new Error(JSON.stringify(selected));
          expect(selected.input.namespace).toBe("selected");
          expect(
            replayNativeJsClassValueDomains(selected.input, analyzeNativeJsClassValueDomains(selected.input)),
          ).toEqual([]);
        }
      }
    });
  it("derives a genuine dependency re-export and retains the empty entry startup source", () => {
    const ast = analyzeMultiSource(
      {
        "./entry.ts": 'export {observe as run} from "./lib.js";',
        "./lib.ts": "class C{}export function observe(x:number):number{return x;}",
      },
      "./entry.ts",
    );
    const policy = policies[0];
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    if (source.kind !== "prepared") throw new Error(JSON.stringify(source));
    const result = prepareTypedIrProgram(captureTypedIrProgramInput(source), {
      policy,
      runtimePolicies: [policy],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: true,
      },
    });
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    const program = result.program;
    expect(program.inventory.sources.map((row) => row.originalFileName)).toEqual(["lib.ts", "entry.ts"]);
    expect(program.startup.map((row) => row.executable)).toEqual([true, false]);
    expect(program.startup[1]!.unitId).toBeNull();
    const normalized = normalizeNativeClassValues(program, program.ir, "original");
    if (normalized.kind !== "normalized") throw new Error(JSON.stringify(normalized));
    expect(normalized.input.exports.map((row) => row.externalName)).toEqual(["run"]);
    expect(normalized.input.entryInputs).toHaveLength(1);
    expect(normalized.input.entryInputs[0]!.transport).toBe("external-js");
    expect(
      replayNativeJsClassValueDomains(normalized.input, analyzeNativeJsClassValueDomains(normalized.input)),
    ).toEqual([]);
    expect(() =>
      normalizeNativeClassValues({ ...program, startup: [...program.startup].reverse() }, program.ir, "original"),
    ).toThrow(/dependency order/);
  });
});

// Let normal reporter RPCs run between synchronous compiler cases.
afterEach(() => setImmediate());

// These checks exercise the program boundary, not a caller-provided report capability.
describe("native class value equation program hooks", () => {
  function sealed(runtimePolicies: readonly (typeof policies)[number][] = [policies[0]]) {
    const result = prepareTypedIrProgram(prepareInput(policies[0]), {
      policy: policies[0],
      runtimePolicies,
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: true,
      },
    });
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    return result.program;
  }
  it("internal equations retain conditional global exports and invocation metadata", () => {
    const actual = prepare(policies[0], "class C{}export let count:number=1;export function run(){return 7;}", true);
    const checked = checkNativeClassValueEquations(actual, actual.ir, "original");
    if (checked.kind !== "normalized") throw new Error(JSON.stringify(checked));
    expect(checked.globalExports.map((row) => row.externalName)).toEqual(["count"]);
    expect(checked.invocation[0]!.kind).toBe("deferred-export");
    expect(checked.input.namespace).toBe("original");
    expect(Object.keys(checked).sort()).toEqual(["globalExports", "input", "invocation", "kind"]);
  });
  it("a malformed internally generated report is independently refused", () => {
    const actual = prepare(policies[0]);
    const normalized = normalizeNativeClassValues(actual, actual.ir, "original");
    if (normalized.kind !== "normalized") throw new Error(JSON.stringify(normalized));
    const report = analyzeNativeJsClassValueDomains(normalized.input);
    const spy = vi
      .spyOn(valueProducer, "analyzeNativeJsClassValueDomains")
      .mockReturnValue({ ...report, values: report.values.slice(1) });
    try {
      expect(() => checkNativeClassValueEquations(actual, actual.ir, "original")).toThrow(
        /independent value equations disagree/,
      );
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
  it("whole unattached GC entry screens getters before schema/population/projection access", () => {
    const program = sealed();
    expect(Object.hasOwn(program, "linearAllocationFacts")).toBe(false);
    assertPreparedIrProgram(program);
    for (const field of ["schema", "ir", "abi", "startup", "runtime"] as const) {
      let reads = 0;
      const mutant = { ...program };
      Object.defineProperty(mutant, field, {
        enumerable: true,
        get() {
          reads++;
          return program[field];
        },
      });
      expect(() => assertPreparedIrProgram(mutant)).toThrow(PreparedIrProgramInvariantError);
      expect(reads).toBe(0);
    }
  });
  it("every current selected view is checked even while acquiring the first native Linear view", () => {
    const program = sealed([policies[2], policies[0]]);
    expect(program.runtime).toHaveLength(2);
    const first = program.runtime[0]!,
      last = program.runtime[1]!;
    expect(first.backend).toBe("linear");
    const fn = last.prepared.functions.find((fn) => fn.name === "run")!;
    let changed = 0;
    const blocks = fn.blocks.map((block) => ({
      ...block,
      instrs: block.instrs.map((instr) => {
        if (instr.kind !== "const" || instr.value.kind !== "f64" || instr.value.value !== 7) return instr;
        changed++;
        return { ...instr, value: { ...instr.value, value: 99 } };
      }),
    }));
    // The default fixture returns its external input; mutate its actual class method literal instead.
    const method = last.prepared.functions.find((fn) => fn.sourceClassBody?.sourceBodyKind === "method")!;
    const methodBlocks = method.blocks.map((block) => ({
      ...block,
      instrs: block.instrs.map((instr) => {
        if (instr.kind !== "const" || instr.value.kind !== "f64") return instr;
        changed++;
        return { ...instr, value: { ...instr.value, value: 99 } };
      }),
    }));
    expect(changed).toBeGreaterThan(0);
    const functions = last.prepared.functions.map((actual) =>
      actual === fn ? { ...fn, blocks } : actual === method ? { ...method, blocks: methodBlocks } : actual,
    );
    const altered = { ...last, prepared: { ...last.prepared, functions } };
    const mutant = { ...program, runtime: [first, altered] };
    expect(() => assertPreparedIrProgramLinearAllocationEvidence(mutant, first)).toThrow(/runtime projection/);
    const copied = { ...first };
    expect(() => assertPreparedIrProgramLinearAllocationEvidence(program, copied)).toThrow(
      /not an original current program attachment/,
    );
    expect(encodePreparedIrProgram(decodePreparedIrProgram(encodePreparedIrProgram(program)))).toBe(
      encodePreparedIrProgram(program),
    );
  });
  it("actual source async context is located unrepresented while its earlier fullprep gap stays distinct", () => {
    const text = "class C{}export async function run():Promise<number>{return 7;}";
    const input = prepareInput(policies[0], text);
    const actual = { ...input, abi: { entries: prepareIrProgramAbiEntries(input) } };
    const fn = actual.ir.functions.find((fn) => fn.funcKind === "async")!;
    expect(fn).toBeDefined();
    const diagnostic = prepareNativeClassValueEquations(actual);
    expect(diagnostic?.kind).toBe("unsupported");
    expect(diagnostic?.code).toBe("class-projection-unsupported");
    expect(diagnostic?.unitId).toBe(fn.unitId);
    expect(diagnostic?.location?.sourceId).toBe(actual.inventory.sources[0]!.id);
    const full = prepareTypedIrProgram(input, {
      policy: policies[0],
      runtimePolicies: [policies[0]],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: true,
      },
    });
    expect(full.kind).toBe("unsupported");
    if (full.kind !== "unsupported") throw new Error(JSON.stringify(full));
    expect(full.code).toBe("body-shape-rejected");
    expect(full.detail).toContain("async-plan producer");
  });
  it("multiple result ABI drift is invariant rather than an unrepresented-model excuse", () => {
    const actual = prepare(policies[0]);
    const fn = actual.ir.functions.find((fn) => fn.name === "run")!;
    const id = irUnitCallableBindingId(fn.unitId);
    const entries = actual.abi.entries.map((entry) => {
      if (entry.plan.id !== id || entry.contract.kind !== "callable") return entry;
      return {
        ...entry,
        contract: {
          ...entry.contract,
          results: [...entry.contract.results, { kind: "val" as const, val: { kind: "f64" as const } }],
        },
      };
    });
    expect(() => prepareNativeClassValueEquations({ ...actual, abi: { entries } })).toThrow(
      /exact complete ABI signature/,
    );
  });
  it.each(["asyncPlan", "asyncRuntime"] as const)("malformed %s hidden native state cannot be class-free", (field) => {
    const ordinary = prepare(policies[0], "export function run(){return 7;}");
    const native = prepare(policies[0]);
    const instruction = native.ir.functions
      .flatMap((fn) => fn.blocks.flatMap((block) => block.instrs))
      .find((instr) => instr.kind.startsWith("js.class."))!;
    expect(instruction).toBeDefined();
    // Intentionally malformed state DATA, not a claimed genuine async body/proof.
    const original = ordinary.ir.functions[0]!;
    const altered = { ...original, [field]: { states: [{ body: [instruction] }] } };
    const module = { functions: ordinary.ir.functions.map((fn) => (fn === original ? altered : fn)) };
    expect(() => checkNativeClassValueEquations(ordinary, module, "original")).toThrow(
      /instructions\/startup lack actual definitions/,
    );
  });
});
