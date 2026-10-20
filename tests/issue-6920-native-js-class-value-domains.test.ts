// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { replayNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent.js";
import { normalizeNativeClassValues } from "../src/ir/program/native-js-class-values.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { afterEach, describe, expect, it } from "vitest";
import { setImmediate as yieldValueDomainTestLoop } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { preparedIrJsClassDefinitions } from "../src/ir/program/js-class-definition.js";
import { irUnitFuncRef } from "../src/ir/core/callable-bindings.js";
import { irBindingKey } from "../src/ir/core/declared-types.js";
import { JS_TAG_IDS } from "../src/ir/core/js-value-tag-identities.js";
import { nativeJsClassValueDataKey } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/data.js";
import { indexNativeJsClassValueDomainInput } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/input.js";
import {
  analyzeNativeJsClassValueDomains,
  type NativeJsClassValueDomainInput,
} from "../src/ir/analysis/allocation-evidence/js-class-value-domains/producer.js";

afterEach(() => yieldValueDomainTestLoop());

const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;

/** Actual source production and ABI construction; no authored function, class, body or allocation site. */
function sourceInput(text: string, policy: (typeof policies)[number]): NativeJsClassValueDomainInput {
  const source = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const prepared = prepareIrProgramSources({
    sourceFiles: source.sourceFiles,
    entrySource: source.entryFile,
    checker: source.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  expect(prepared.kind).toBe("prepared");
  if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
  const typed = captureTypedIrProgramInput(prepared),
    entries = prepareIrProgramAbiEntries(typed);
  const definitions = preparedIrJsClassDefinitions(entries);
  const bodies = definitions.flatMap(({ definition }) =>
    [
      definition.constructor,
      ...definition.members.map((member) => member.body),
      ...definition.instanceElements.flatMap((field) => (field.initializer ? [field.initializer] : [])),
    ].map((body) => ({ definition, body })),
  );
  const globals: NativeJsClassValueDomainInput["globals"][number][] = [];
  const signatures: NativeJsClassValueDomainInput["declarations"]["signatures"][number][] = [];
  for (const entry of entries) {
    if (entry.plan.slotPolicy === "alias") continue;
    const contract = entry.contract;
    if (contract.kind === "callable")
      signatures.push({
        key: irBindingKey(contract.ref.binding)!,
        signature: { params: contract.params, result: contract.results[0] ?? null },
      });
    if (contract.kind !== "global") continue;
    const classBinding = definitions
      .flatMap(({ definition }) => [definition.outerBinding, definition.innerBinding])
      .find((binding) => binding?.valueGlobal?.binding.bindingId === contract.ref.binding.bindingId);
    const declaration = typed.startup
      .flatMap((plan) => plan.bindings)
      .find((binding) => binding.globalBindingId === contract.ref.binding.bindingId);
    globals.push({
      ref: contract.ref,
      type: contract.type,
      mutable: contract.mutable,
      initial:
        classBinding || declaration?.initialization === "tdz"
          ? { kind: "uninitialized" }
          : declaration?.initialization === "undefined-at-instantiation"
            ? { kind: "constant", value: { kind: "undefined" } }
            : { kind: "unknown" },
    });
  }
  const exports = entries.flatMap((entry) => {
    if (entry.contract.kind !== "export") return [];
    const exported = entry.contract;
    let target = entries.find((candidate) => candidate.plan.id === exported.targetId);
    const seen = new Set<string>();
    while (target?.plan.slotPolicy === "alias") {
      if (seen.has(target.plan.id)) throw new Error("actual ABI export alias cycle");
      seen.add(target.plan.id);
      target = entries.find((candidate) => candidate.plan.id === target!.plan.aliasOf);
    }
    if (target?.contract.kind !== "callable") return [];
    return [
      {
        externalName: entry.contract.externalName,
        target: target.contract.ref,
        logicalParams: target.contract.params,
        logicalResult: target.contract.results[0] ?? null,
      },
    ];
  });
  const entryIds = new Set(
    exports.flatMap((entry) => (entry.target.binding.kind === "unit" ? [entry.target.binding.unitId] : [])),
  );
  return {
    schema: "native-js-class-value-domain-input-v1",
    namespace: "original",
    module: { functions: typed.ir.functions },
    declarations: {
      signatures,
      globals: globals.map((global) => ({ key: irBindingKey(global.ref.binding)!, type: global.type })),
    },
    units: typed.ir.functions.map((fn) => {
      const body = bodies.find((row) => row.body.unitId === fn.unitId);
      return {
        unitId: fn.unitId,
        kind: "source",
        sourceClassId: body?.definition.sourceClassId ?? null,
        sourceBodyKind: body?.body.sourceBodyKind ?? null,
        target: irUnitFuncRef(fn),
      };
    }),
    definitions,
    globals,
    startupUnits: typed.startup.flatMap((plan) => (plan.executable && plan.unitId ? [plan.unitId] : [])),
    exports,
    entryInputs: typed.ir.functions.flatMap((fn) =>
      entryIds.has(fn.unitId)
        ? fn.params.map((param, parameter) => ({
            unitId: fn.unitId,
            parameter,
            transport: "external-js" as const,
            type: param.type,
          }))
        : [],
    ),
  };
}

const sources = [
  ["actual Number constant", "export function run():number{return 3;}", "number"],
  ["external Number annotation grants no input proof", "export function run(x:number):number{return x;}", "unknown"],
  [
    "real method boxed normal completion",
    "class C{m():number{return 1;}}export function run():number{new C().m();return 7;}",
    "number",
  ],
  [
    "real method Undefined completion",
    "class C{m():void{}}export function run():number{return new C().m()===undefined?1:0;}",
    "number",
  ],
  [
    "field key cannot impersonate internal prototype edge",
    'class C{"[[Prototype]]":number=3;m():number{return 1;}}export function run():number{new C().m();return 7;}',
    "number",
  ],
  [
    "original before-definition class binding TDZ",
    "run();class C{m():number{return 1;}}export function run():number{new C().m();return 7;}",
    "unknown",
  ],
  [
    "declared Number field retains Undefined default",
    "class C{x:number;}export function run():number{const c=new C();return c.x===undefined?1:0;}",
    "number",
  ],
  [
    "real internal Number argument carries value without annotation proof",
    "class C{m(x:number):number{return x;}}export function run():number{new C().m(4);return 7;}",
    "number",
  ],
  [
    "recursive method has no self-supported Number completion",
    "class C{m():number{return this.m();}}export function run():number{new C().m();return 7;}",
    "unknown",
  ],
] as const;

describe("native JS class value-domain descriptions from genuine source (no runtime claim)", () => {
  for (const policy of policies)
    for (const [name, text, decision] of sources)
      it(`${policy.backend}:${policy.target} ${name}`, async () => {
        const input = sourceInput(text, policy),
          result = analyzeNativeJsClassValueDomains(input);
        expect(result.census.functions).toBe(input.module.functions.length);
        expect(result.projections.find((projection) => projection.externalName === "run")?.decision).toBe(decision);
        expect(Object.isFrozen(result)).toBe(true);
        // Plain own DATA roundtrip here; production PreparedIR codec admission is a separate requirement.
        expect(analyzeNativeJsClassValueDomains(JSON.parse(JSON.stringify(input)))).toEqual(result);
        await new Promise<void>((resolve) => setImmediate(resolve));
      });

  it("denies forged scalar transport flags on an actual exported source parameter", () => {
    const input = sourceInput(sources[1][1], policies[0]);
    const mutant = structuredClone(input);
    Object.assign(mutant.entryInputs[0]!, { transport: "scalar-ir" });
    expect(() => analyzeNativeJsClassValueDomains(mutant)).toThrow(/authenticated scalar bridge/);
  });

  it("rejects input accessors before reading the function census", () => {
    const input = sourceInput(sources[0][1], policies[0]);
    let getters = 0;
    for (const target of [input, input.module, input.module.functions[0]!]) {
      const mutant = structuredClone(input);
      const current = target === input ? mutant : target === input.module ? mutant.module : mutant.module.functions[0]!;
      Object.defineProperty(current, "outsider", {
        enumerable: true,
        get() {
          getters++;
          return 0;
        },
      });
      expect(() => analyzeNativeJsClassValueDomains(mutant)).toThrow(/accessors/);
    }
    expect(getters).toBe(0);
  });

  it("screens DATA before the independently callable input index observes schema, units or nested values", () => {
    const input = sourceInput(sources[0][1], policies[0]);
    expect(indexNativeJsClassValueDomainInput(input).size).toBe(input.module.functions.length);
    let getters = 0;
    for (const field of ["schema", "units", "module"] as const) {
      const mutant = structuredClone(input);
      Object.defineProperty(mutant, field, {
        enumerable: true,
        get() {
          getters++;
          return input[field];
        },
      });
      expect(() => indexNativeJsClassValueDomainInput(mutant)).toThrow(/non-executable data/);
    }
    const nested = structuredClone(input);
    Object.defineProperty(nested.module.functions[0]!, "outsider", {
      get() {
        getters++;
        return 0;
      },
    });
    expect(() => indexNativeJsClassValueDomainInput(nested)).toThrow(/non-executable data/);
    expect(getters).toBe(0);
  });

  it("rejects duplicate function, unit, SSA, global, definition and entry-parameter populations", () => {
    const classInput = sourceInput(sources[2][1], policies[0]);
    for (const mutate of [
      (input: NativeJsClassValueDomainInput) => (input.module.functions as unknown[]).push(input.module.functions[0]),
      (input: NativeJsClassValueDomainInput) => (input.units as unknown[]).push(input.units[0]),
      (input: NativeJsClassValueDomainInput) => (input.globals as unknown[]).push(input.globals[0]),
      (input: NativeJsClassValueDomainInput) => (input.definitions as unknown[]).push(input.definitions[0]),
    ]) {
      const mutant = structuredClone(classInput);
      mutate(mutant);
      expect(() => analyzeNativeJsClassValueDomains(mutant)).toThrow(/census/);
    }
    const scalar = structuredClone(sourceInput(sources[0][1], policies[0]));
    (scalar.module.functions[0]!.blocks[0]!.instrs as unknown[]).push(scalar.module.functions[0]!.blocks[0]!.instrs[0]);
    expect(() => analyzeNativeJsClassValueDomains(scalar)).toThrow(/SSA census/);
    const parameter = structuredClone(sourceInput(sources[1][1], policies[0]));
    (parameter.entryInputs as unknown[]).push(parameter.entryInputs[0]);
    expect(() => analyzeNativeJsClassValueDomains(parameter)).toThrow(/duplicate entry/);
  });

  it("does not claim async state-buffer completeness with an unrepresented location port", () => {
    const input = structuredClone(sourceInput(sources[0][1], policies[0]));
    Object.defineProperty(input.module.functions[0]!, "asyncRuntime", { value: {}, enumerable: true });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/async state-buffer census/);
  });

  it("retains captured callable before argument-side shadowing instead of looking up the method again", () => {
    const input = sourceInput(
      "class C{m(x:number):number{return 1;}}export function run():number{const c=new C();c.m(c.m=undefined);return 7;}",
      policies[0],
    );
    const result = analyzeNativeJsClassValueDomains(input);
    const invoked = result.calls.find((call) => call.kind === "invoke")!;
    expect(invoked.calleeDomain).toMatchObject({ kind: "known", families: ["Function"] });
    expect(invoked.argumentDomains).toEqual([{ kind: "known", families: ["Undefined"], roots: [] }]);
    expect(invoked.normalDomain).toMatchObject({ kind: "known", families: ["Number"] });
    expect(
      result.heap.some(
        (cell) =>
          cell.key.kind === "literal" &&
          cell.key.value === "m" &&
          cell.valueDomain.kind === "known" &&
          cell.valueDomain.families.includes("Undefined"),
      ),
    ).toBe(true);
  });

  it("keeps genuine throwing ordinary callee BOTTOM despite its declared Number signature", () => {
    const input = sourceInput(
      "function effect():number{throw 7;}class C{m(x:number):number{return 1;}}export function run():number{new C().m(effect());return 7;}",
      policies[0],
    );
    const result = analyzeNativeJsClassValueDomains(input);
    const target = input.module.functions.find((fn) => fn.name === "effect")!;
    expect(result.functions.find((fn) => fn.unitId === target.unitId)).toMatchObject({
      normalCompletion: false,
      normalResultDomains: [{ kind: "bottom" }],
    });
    expect(result.calls.find((call) => call.kind === "invoke")).toMatchObject({
      targets: [],
      normalDomain: { kind: "bottom" },
      mayThrow: false,
    });
    expect(result.projections[0]!.decision).toBe("unknown");
    expect(result.obligations.some((obligation) => obligation.reason === "opaque-effect")).toBe(true);
  });

  it("retains reached frame/property mutations before an abrupt method exit without making caller continuation normal", () => {
    const input = sourceInput(
      "class C{x:number=3;m():void{this.x=4;throw this.x;}}export function run():number{new C().m();return 7;}",
      policies[0],
    );
    const result = analyzeNativeJsClassValueDomains(input);
    const method = input.definitions[0]!.definition.members[0]!.body.unitId;
    expect(result.functions.find((fn) => fn.unitId === method)?.normalCompletion).toBe(false);
    expect(
      result.heap.some(
        (cell) =>
          cell.root.kind === "allocation" &&
          cell.root.unitId === method &&
          cell.root.view === "frame" &&
          cell.key.kind === "internal" &&
          cell.key.value === "this",
      ),
    ).toBe(true);
    expect(result.heap.some((cell) => cell.key.kind === "literal" && cell.key.value === "x")).toBe(true);
    expect(result.projections[0]!.decision).toBe("unknown");
  });

  it.each([
    ["binary", "function f(x:number){return x+1;}export function run(){return f(2);}"],
    ["unary", "function f(x:number){return -x;}export function run(){return f(2);}"],
  ] as const)("rejects unknown %s opcodes without prefix or getter authority", (kind, text) => {
    const input = sourceInput(text, policies[0]);
    expect(analyzeNativeJsClassValueDomains(input).projections[0]!.decision).toBe("number");
    const find = (current: NativeJsClassValueDomainInput) =>
      current.module.functions
        .flatMap((fn) => fn.blocks.flatMap((block) => block.instrs))
        .find((instr) => instr.kind === kind)!;
    expect(find(input).kind).toBe(kind);
    for (const op of ["f64.future_unknown", kind === "binary" ? "f64.neg" : "f64.add", "constructor"]) {
      const mutant = structuredClone(input);
      Object.assign(find(mutant), { op });
      expect(() => analyzeNativeJsClassValueDomains(mutant)).toThrow(/unknown primitive opcode/);
    }
    const hostile = structuredClone(input);
    let getters = 0;
    Object.defineProperty(find(hostile), "op", {
      enumerable: true,
      get() {
        getters++;
        return "f64.future_unknown";
      },
    });
    expect(() => analyzeNativeJsClassValueDomains(hostile)).toThrow(/accessors/);
    expect(getters).toBe(0);
  });

  it("rejects numeric known transfers with forged carriers before deriving scalar output", () => {
    const input = structuredClone(sourceInput(sources[0][1], policies[0]));
    Object.assign(input.module.functions[0]!.blocks[0]!.instrs[0]!, { resultType: { kind: "dynamic", tag: 999999 } });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/literal tag contradicts/);
    const binary = structuredClone(
      sourceInput("class C{}export function run(x:number):number{const c=new C();return x+1;}", policies[0]),
    );
    const fn = binary.module.functions.find((fn) => fn.name === "run")!;
    const operation = fn.blocks[0]!.instrs.find((instr) => instr.kind === "binary")!;
    const object = fn.blocks[0]!.instrs.find((instr) => instr.kind === "js.class.construct")!;
    Object.assign(operation, { lhs: object.result });
    expect(() => analyzeNativeJsClassValueDomains(binary)).toThrow(/raw numeric operand carrier/);
  });

  it("rejects current call declaration/result drift rather than using a nominal Number signature", () => {
    const input = structuredClone(
      sourceInput("function f(x:number):number{return x;}export function run():number{return f(3);}", policies[0]),
    );
    const f = input.module.functions.find((fn) => fn.name === "f")!;
    const row = input.declarations.signatures.find((row) => row.key === irBindingKey(irUnitFuncRef(f).binding))!;
    Object.assign(row.signature, { result: { kind: "val", val: { kind: "i32", boolean: true } } });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/declaration differs/);
  });

  it("rejects omitted exported parameter census rather than silently supplying an UNKNOWN row", () => {
    const input = structuredClone(sourceInput(sources[1][1], policies[0]));
    Object.assign(input, { entryInputs: [] });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/exported parameter census/);
  });

  it("retains real method environment links and the root escaping through actual module binding storage", () => {
    const input = sourceInput(sources[2][1], policies[0]),
      result = analyzeNativeJsClassValueDomains(input);
    expect(
      result.heap.some(
        (cell) =>
          cell.root.kind === "allocation" &&
          cell.root.view === "method" &&
          cell.key.kind === "internal" &&
          cell.key.value === "environment" &&
          cell.valueDomain.kind === "known" &&
          cell.valueDomain.roots.some((root) => root.kind === "allocation" && root.view === "environment"),
      ),
    ).toBe(true);
    const init = result.functions.find((row) => row.unitId === input.startupUnits[0])!;
    expect(
      init.escapedRoots.some(
        (root) =>
          root.kind === "allocation" &&
          root.view === "constructor" &&
          root.definitionId === input.definitions[0]!.bindingId,
      ),
    ).toBe(true);
  });

  it("records a located-unit obligation for UNKNOWN public normal completion without inventing an instruction", () => {
    const input = sourceInput(sources[1][1], policies[0]),
      result = analyzeNativeJsClassValueDomains(input);
    const obligation = { location: null, unitId: input.units[0]!.unitId, reason: "unsafe-scalar-projection" };
    expect(result.projections[0]!.obligations).toContainEqual(obligation);
    expect(result.obligations).toContainEqual(obligation);
    expect(result.projections[0]!.decision).toBe("unknown");
  });

  it("retains actual callee TDZ reads in the abrupt caller summary and keeps unreachable construction BOTTOM", () => {
    const input = sourceInput(sources[5][1], policies[0]),
      result = analyzeNativeJsClassValueDomains(input);
    const run = result.functions.find(
      (row) => input.module.functions.find((fn) => fn.unitId === row.unitId)?.name === "run",
    )!;
    const startup = result.functions.find((row) => row.unitId === input.startupUnits[0])!;
    expect(run.readsGlobals.length).toBeGreaterThan(0);
    expect(startup.readsGlobals).toEqual(expect.arrayContaining([...run.readsGlobals]));
    expect(startup.normalCompletion).toBe(false);
    expect(result.calls.find((row) => row.kind === "construct")).toMatchObject({
      receiverDomain: { kind: "bottom" },
      targets: [],
      normalDomain: { kind: "bottom" },
    });
  });

  it("does not turn a constructor returning borrowed self into an escape from its allocating caller", () => {
    const input = sourceInput(sources[2][1], policies[0]),
      result = analyzeNativeJsClassValueDomains(input);
    const call = result.calls.find((row) => row.kind === "construct")!;
    const ctor = result.functions.find((row) => row.unitId === call.targets[0]!.unitId)!;
    const caller = result.functions.find((row) => row.unitId === call.location.unitId)!;
    expect(ctor.escapedRoots.some((root) => root.kind === "allocation" && root.view === "object")).toBe(true);
    expect(caller.escapedRoots.some((root) => root.kind === "allocation" && root.view === "object")).toBe(false);
    expect(call.normalDomain).toEqual(call.receiverDomain);
  });

  it("propagates genuine opaque receiver retention through an ordinary callee without granting scalar readiness", () => {
    const input = sourceInput(
      "class C{}function f():number{const c=new C();c.missing(4);return 7;}export function run():number{f();return 7;}",
      policies[0],
    );
    const result = analyzeNativeJsClassValueDomains(input);
    const f = input.module.functions.find((fn) => fn.name === "f")!;
    const run = input.module.functions.find((fn) => fn.name === "run")!;
    expect(result.calls.find((row) => row.kind === "invoke")).toMatchObject({
      normalDomain: { kind: "unknown" },
      mayThrow: true,
      targets: [],
    });
    for (const unitId of [f.unitId, run.unitId])
      expect(
        result.functions
          .find((row) => row.unitId === unitId)!
          .escapedRoots.some(
            (root) => root.kind === "allocation" && root.unitId === f.unitId && root.view === "object",
          ),
      ).toBe(true);
    expect(result.projections[0]!.decision).toBe("unknown");
    expect(result.projections[0]!.obligations.some((row) => row.reason === "unknown-callee")).toBe(true);
  });

  it("rejects a Number global initial value with a forged Boolean carrier", () => {
    const input = structuredClone(sourceInput(sources[2][1], policies[0]));
    const global = input.globals[0]!;
    Object.assign(global, {
      type: { kind: "val", val: { kind: "i32", boolean: true } },
      initial: { kind: "constant", value: { kind: "f64", value: 3 } },
    });
    Object.assign(input.declarations.globals.find((row) => row.key === irBindingKey(global.ref.binding))!, {
      type: global.type,
    });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/global literal carrier differs/);
  });

  it("rejects a global initial literal whose dynamic tag claims a different actual family", () => {
    const input = structuredClone(sourceInput(sources[2][1], policies[0]));
    Object.assign(input.globals[0]!, {
      type: { kind: "dynamic", tag: JS_TAG_IDS.Boolean },
      initial: { kind: "constant", value: { kind: "f64", value: 3 } },
    });
    Object.assign(input.declarations.globals.find((row) => row.key === irBindingKey(input.globals[0]!.ref.binding))!, {
      type: input.globals[0]!.type,
    });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/global literal tag contradicts/);
  });

  it("rejects a global type that contradicts its actual normalized declaration", () => {
    const input = structuredClone(sourceInput(sources[2][1], policies[0]));
    Object.assign(input.globals[0]!, { type: { kind: "dynamic" } });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/global declaration type differs/);
  });

  it.each(["undefined", "null"] as const)(
    "does not let a Number-tagged global claim its actual %s initializer",
    (kind) => {
      const input = structuredClone(sourceInput(sources[2][1], policies[0]));
      const global = input.globals[0]!;
      Object.assign(global, {
        type: { kind: "dynamic", tag: JS_TAG_IDS.NumberF64 },
        initial: { kind: "constant", value: { kind } },
      });
      Object.assign(input.declarations.globals.find((row) => row.key === irBindingKey(global.ref.binding))!, {
        type: global.type,
      });
      expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/global literal tag contradicts/);
    },
  );

  it("does not seed a Number value from a forged literal on a managed-reference global", () => {
    const input = structuredClone(sourceInput(sources[2][1], policies[0]));
    const global = input.globals.find((row) => row.type.kind !== "val" && row.type.kind !== "dynamic")!;
    expect(global).toBeDefined();
    Object.assign(global, { initial: { kind: "constant", value: { kind: "f64", value: 3 } } });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/global literal carrier differs/);
  });

  it("rejects duplicate original member ordinals before they alias method targets", () => {
    const input = structuredClone(
      sourceInput("class C{m(){return 1;}n(){return true;}}export function run(){new C().n();return 7;}", policies[0]),
    );
    const members = input.definitions[0]!.definition.members;
    Object.assign(members[1]!, { sourceOrdinal: members[0]!.sourceOrdinal });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/member ordinal/);
  });

  it("names actual value and TDZ globals in the logical binding operation footprints", () => {
    const input = sourceInput(sources[2][1], policies[0]),
      result = analyzeNativeJsClassValueDomains(input);
    const binding = input.definitions[0]!.definition.outerBinding!;
    const pair = [binding.valueGlobal!.binding.bindingId, binding.tdzGlobal!.binding.bindingId];
    const startup = result.functions.find((row) => row.unitId === input.startupUnits[0])!;
    expect(startup.writesGlobals).toEqual(expect.arrayContaining(pair));
    const caller = result.functions.find(
      (row) => row.unitId === result.calls.find((call) => call.kind === "construct")!.location.unitId,
    )!;
    expect(caller.readsGlobals).toEqual(expect.arrayContaining(pair));
  });

  it("keeps inherited unknown setters opaque rather than assigning a Number property proof", () => {
    class C {
      declare __proto__: unknown;
      m() {
        this.__proto__ = 1;
        return this.__proto__;
      }
    }
    expect(new C().m()).toBe(C.prototype);
    const input = sourceInput(
      "class C{m(){this.__proto__=1;return this.__proto__;}}export function run(){new C().m();return 7;}",
      policies[0],
    );
    const result = analyzeNativeJsClassValueDomains(input);
    const method = result.functions.find(
      (row) => row.unitId === input.definitions[0]!.definition.members[0]!.body.unitId,
    )!;
    expect(method.normalResultDomains).toEqual([{ kind: "unknown" }]);
    const cells = result.heap.filter((cell) => cell.key.kind === "literal" && cell.key.value === "__proto__");
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((cell) => cell.valueDomain.kind === "unknown")).toBe(true);
    expect(result.projections[0]!.decision).toBe("unknown");
  });

  it("does not treat a constructor's nonwritable prototype slot as an ordinary writable property", () => {
    class C {}
    const mutable = C as unknown as { prototype: unknown };
    expect(Object.getOwnPropertyDescriptor(C, "prototype")?.writable).toBe(false);
    expect(() => {
      mutable.prototype = 4;
    }).toThrow(TypeError);
    const input = sourceInput("class C{}export function run(){C.prototype=4;return 7;}", policies[0]);
    const result = analyzeNativeJsClassValueDomains(input);
    expect(result.projections[0]!.decision).toBe("unknown");
    expect(result.projections[0]!.obligations.some((row) => row.reason === "unknown-property")).toBe(true);
  });

  it.each(["writable", "configurable"] as const)(
    "retains unresolved %s:false descriptor semantics at an actual property operation",
    (attribute) => {
      const input = structuredClone(
        sourceInput(
          "class C{x:number=3;m(){this.x=4;this.x=5;return this.x;}}export function run(){new C().m();return 7;}",
          policies[0],
        ),
      );
      const method = input.module.functions.find(
        (fn) => fn.unitId === input.definitions[0]!.definition.members[0]!.body.unitId,
      )!;
      const block = method.blocks.find((row) => row.instrs.some((instr) => instr.kind === "js.class.property.set"))!;
      const instructionOrdinal = block.instrs.findIndex((instr) => instr.kind === "js.class.property.set");
      // A typed adversary changes one real operation; every body, operand and site remains original.
      Object.assign(block.instrs[instructionOrdinal]!, {
        kind: "js.class.property.define",
        attributes: { writable: true, enumerable: true, configurable: true, [attribute]: false },
      });
      const result = analyzeNativeJsClassValueDomains(input);
      expect(
        result.obligations.some(
          (row) =>
            row.reason === "unknown-property" &&
            row.location?.unitId === method.unitId &&
            row.location.instructionOrdinal === instructionOrdinal,
        ),
      ).toBe(true);
      expect(result.projections[0]!.decision).toBe("unknown");
    },
  );

  it("does not turn a caller-authored builtin unit label into scalar transport authority", () => {
    const input = structuredClone(sourceInput(sources[1][1], policies[0]));
    Object.assign(input.units[0]!, { kind: "builtin" });
    Object.assign(input.entryInputs[0]!, { transport: "scalar-ir" });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/authenticated scalar bridge/);
  });

  it("records actual constructed self with the target definition identity in the call receiver row", () => {
    const input = sourceInput(
      "class C{x:number=3;}export function run():number{return new C().x===undefined?1:0;}",
      policies[0],
    );
    const result = analyzeNativeJsClassValueDomains(input),
      call = result.calls.find((row) => row.kind === "construct")!;
    expect(call.targets).toHaveLength(1);
    expect(call.receiverDomain).toMatchObject({
      kind: "known",
      families: ["Object"],
      roots: [
        {
          kind: "allocation",
          definitionId: call.targets[0]!.definitionId,
          view: "object",
          unitId: call.location.unitId,
        },
      ],
    });
    expect(call.normalDomain).toEqual(call.receiverDomain);
  });

  it("rejects forged actual return carriers even when the callable declaration is changed to agree", () => {
    const input = structuredClone(sourceInput(sources[0][1], policies[0]));
    const fn = input.module.functions[0]!,
      type = { kind: "val", val: { kind: "i32", boolean: true } };
    Object.assign(fn, { resultTypes: [type] });
    Object.assign(input.declarations.signatures[0]!.signature, { result: type });
    Object.assign(input.exports[0]!, { logicalResult: type });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/return carrier differs/);
  });

  it("keeps unsupported reachable control UNKNOWN even when a later literal return is Number", () => {
    const input = structuredClone(sourceInput("export function run():number{let x=1;x=2;return 3;}", policies[0]));
    const fn = input.module.functions[0]!;
    const instruction = fn.blocks[0]!.instrs.find((row) => row.result === null)!;
    expect(instruction).toBeDefined();
    Object.assign(instruction, { kind: "raw.wasm" });
    const result = analyzeNativeJsClassValueDomains(input);
    expect(result.functions[0]!.normalResultDomains).toEqual([{ kind: "unknown" }]);
    expect(result.projections[0]!.decision).toBe("unknown");
    expect(result.obligations.some((row) => row.reason === "unsupported-control")).toBe(true);
  });

  it("is independent of own DATA record insertion order without claiming production codec authority", () => {
    const input = sourceInput(sources[2][1], policies[0]);
    const reverse = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverse)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([name, member]) => [name, reverse(member)]),
            )
          : value;
    expect(analyzeNativeJsClassValueDomains(reverse(input) as NativeJsClassValueDomainInput)).toEqual(
      analyzeNativeJsClassValueDomains(input),
    );
  });

  for (const [text, operation] of [
    [
      "class C{x:number=3;m():void{this.x=4;throw 7;}}export function run():number{new C().m();return 7;}",
      "class Number throw",
    ],
    [
      "function effect():number{throw 7;}class C{x:number=3;m():number{return (this.x=4,effect());}}export function run():number{new C().m();return 7;}",
      "original helper throw",
    ],
  ] as const)
    it(`preserves genuine abrupt ${operation} without a fabricated normal completion`, () => {
      const input = sourceInput(text, policies[0]);
      const unit = input.units.find((item) => item.sourceBodyKind === "method");
      expect(unit).toBeDefined();
      const report = analyzeNativeJsClassValueDomains(input);
      expect(report.functions.find((item) => item.unitId === unit!.unitId)).toMatchObject({
        normalCompletion: false,
        normalResultDomains: [{ kind: "bottom" }],
        mayThrow: true,
      });
    });
});

const publicHistorySources = [
  ["healthy method", "class C{static m(){return 1;}}export function run(){C.m();return 7;}"],
  [
    "normal Number shadow",
    "class C{static m(){return 1;}}export function mutate(){C.m=3;return 0;}export function run(){C.m();return 7;}",
  ],
  [
    "callable replacement",
    "class C{static m(){return 1;}}class D{static n(){return true;}}export function mutate(){C.m=D.n;return 0;}export function run(){return C.m()===true?1:0;}",
  ],
  [
    "transitive abrupt shadow",
    "class C{static m(){return 1;}}function write(){C.m=3;throw 7;}export function mutate(){write();return 0;}export function run(){C.m();return 7;}",
  ],
] as const;

describe("persistent public entry worlds and isolated original startup (conditional IR descriptions)", () => {
  for (const policy of policies) {
    for (const [name, text] of publicHistorySources)
      it(`${policy.backend}:${policy.target} ${name} survives arbitrary prior public invocations`, async () => {
        const input = sourceInput(text, policy),
          result = analyzeNativeJsClassValueDomains(input);
        const run = input.exports.find((row) => row.externalName === "run")!;
        const unit = input.units.find((row) => irBindingKey(row.target.binding) === irBindingKey(run.target.binding))!;
        const call = result.calls.find((row) => row.location.unitId === unit.unitId && row.kind === "invoke")!;
        expect(call).toBeDefined();
        const js = new Function(
          `${text.replaceAll("export ", "")} ;return {run,${name === "healthy method" ? "" : "mutate"}};`,
        )() as { run(): unknown; mutate?(): unknown };
        expect(js.run()).toBe(name === "callable replacement" ? 0 : 7);
        if (name === "healthy method") {
          expect(call.calleeDomain).toMatchObject({ kind: "known", families: ["Function"] });
          expect(call.targets).toHaveLength(1);
          expect(call.normalDomain).toMatchObject({ kind: "known", families: ["Number"] });
        } else if (name === "callable replacement") {
          expect(js.mutate!()).toBe(0);
          expect(js.run()).toBe(1);
          expect(call.targets).toHaveLength(2);
          expect(call.normalDomain).toMatchObject({ kind: "known", families: ["Number", "Boolean"] });
        } else if (name === "normal Number shadow") {
          expect(js.mutate!()).toBe(0);
          expect(js.run).toThrow(TypeError);
          expect(call.calleeDomain).toMatchObject({ kind: "known", families: ["Number", "Function"] });
          expect(call.mayThrow).toBe(true);
          const cells = result.heap.filter(
            (row) =>
              row.key.kind === "literal" &&
              row.key.value === "m" &&
              row.root.kind === "allocation" &&
              row.root.view === "constructor",
          );
          expect(cells).toHaveLength(1);
          expect(cells[0]!.presence).toBe("present");
          // A Number target throws; surviving Function paths still return Number.
          expect(call.normalDomain).toMatchObject({ kind: "known", families: ["Number"] });
        } else {
          let thrown: unknown;
          try {
            js.mutate!();
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBe(7);
          expect(js.run).toThrow(TypeError);
          expect(call.calleeDomain).toEqual({ kind: "unknown" });
          expect(call.obligations.some((row) => row.reason === "unknown-callee")).toBe(true);
          expect(result.projections.find((row) => row.externalName === "run")?.decision).toBe("unknown");
        }
        expect(analyzeNativeJsClassValueDomains(JSON.parse(JSON.stringify(input)))).toEqual(result);
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
    it(`${policy.backend}:${policy.target} public parameter worlds cannot backfeed a shared startup callee`, async () => {
      const input = sourceInput(
        "class C{}function shared(x:number){return x;}shared(1);export function run(x:number){return shared(x);}",
        policy,
      );
      const result = analyzeNativeJsClassValueDomains(input);
      const startup = result.calls.find((row) => input.startupUnits.includes(row.location.unitId))!;
      const publicCall = result.calls.find((row) => !input.startupUnits.includes(row.location.unitId))!;
      expect(startup.argumentDomains).toEqual([{ kind: "known", families: ["Number"], roots: [] }]);
      expect(startup.normalDomain).toEqual({ kind: "known", families: ["Number"], roots: [] });
      expect(publicCall.normalDomain).toEqual({ kind: "unknown" });
      expect(result.projections.find((row) => row.externalName === "run")?.decision).toBe("unknown");
      expect(analyzeNativeJsClassValueDomains(JSON.parse(JSON.stringify(input)))).toEqual(result);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
});

describe("complete unresolved call/value obligation taxonomy", () => {
  it("records both actual unknown callability and its opaque effects after abrupt public mutation", () => {
    const input = sourceInput(publicHistorySources[3][1], policies[0]);
    const result = analyzeNativeJsClassValueDomains(input);
    const run = input.exports.find((row) => row.externalName === "run")!;
    const unit = input.units.find((row) => irBindingKey(row.target.binding) === irBindingKey(run.target.binding))!;
    const invoked = result.calls.find((row) => row.kind === "invoke" && row.location.unitId === unit.unitId)!;
    expect(invoked.calleeDomain).toEqual({ kind: "unknown" });
    expect(invoked.obligations.map((row) => row.reason).sort()).toEqual(["opaque-effect", "unknown-callee"]);
    for (const reason of ["opaque-effect", "unknown-callee"])
      expect(
        result.obligations.some(
          (row) =>
            row.reason === reason &&
            row.location?.unitId === invoked.location.unitId &&
            row.location.instructionOrdinal === invoked.location.instructionOrdinal,
        ),
      ).toBe(true);
  });
  it("records unavailable value transfer separately from opaque effects of actual numeric boxing intrinsic", () => {
    const input = sourceInput(
      "function effect():number{throw 7;}class C{m(x:number):number{return 1;}}export function run():number{new C().m(effect());return 7;}",
      policies[0],
    );
    const result = analyzeNativeJsClassValueDomains(input);
    const effect = input.module.functions.find((fn) => fn.name === "effect")!;
    const ordinal = effect.blocks[0]!.instrs.findIndex((instr) => instr.kind === "intrinsic" && instr.result !== null);
    expect(ordinal).toBeGreaterThanOrEqual(0);
    const reasons = result.obligations
      .filter(
        (row) =>
          row.location?.unitId === effect.unitId &&
          row.location.blockOrdinal === 0 &&
          row.location.instructionOrdinal === ordinal,
      )
      .map((row) => row.reason)
      .sort();
    expect(reasons).toEqual(["opaque-effect", "unsupported-value"]);
    expect(result.functions.find((row) => row.unitId === effect.unitId)).toMatchObject({
      normalCompletion: false,
      normalResultDomains: [{ kind: "bottom" }],
    });
  });
});

describe("canonical complete obligation rows", () => {
  it("keeps both unresolved invocation labels in canonical order without losing either", () => {
    const result = analyzeNativeJsClassValueDomains(sourceInput(publicHistorySources[3][1], policies[0]));
    const unresolved = result.calls.filter((row) =>
      row.obligations.some((problem) => problem.reason === "unknown-callee"),
    );
    expect(unresolved.length).toBeGreaterThan(0);
    for (const call of unresolved)
      expect(call.obligations.map((row) => row.reason)).toEqual(["opaque-effect", "unknown-callee"]);
  });
  it("projects all actual abrupt value/effect and unsafe labels in canonical coordinate/key order", () => {
    const result = analyzeNativeJsClassValueDomains(
      sourceInput(
        "function effect():number{throw 7;}class C{m(x:number):number{return 1;}}export function run():number{new C().m(effect());return 7;}",
        policies[0],
      ),
    );
    const projection = result.projections.find((row) => row.externalName === "run")!;
    expect(projection.obligations.map((row) => row.reason).sort()).toEqual([
      "opaque-effect",
      "opaque-effect",
      "unknown-callee",
      "unknown-property",
      "unsafe-scalar-projection",
      "unsupported-value",
    ]);
    for (const rows of [result.obligations, projection.obligations, ...result.calls.map((row) => row.obligations)]) {
      const keys = rows.map(nativeJsClassValueDataKey);
      expect(keys).toEqual([...new Set(keys)].sort((a, b) => a.localeCompare(b)));
    }
  });
});

/** Explicit typed-IR adversaries around genuine source units, operands and sites.
 * New scalar instructions have no allocation; no source/physical readiness is claimed.
 */
function carrierFixture() {
  const input = structuredClone(sourceInput(sources[2][1], policies[0]));
  const unit = input.units.find((row) => row.sourceBodyKind === "method")!;
  const fn = input.module.functions.find((row) => row.unitId === unit.unitId)!;
  const block = fn.blocks[0]!;
  const box = block.instrs.find((instr) => instr.kind === "box")!;
  if (box.kind !== "box") throw new Error("genuine Number box missing");
  let insertion = block.instrs.findIndex((instr) => instr.kind === "early.return");
  if (insertion < 0) throw new Error("genuine original return missing");
  const append = (instruction: Record<string, unknown>): number => {
    const result = fn.valueCount;
    Object.assign(fn, { valueCount: result + 1 });
    (block.instrs as unknown[]).splice(insertion++, 0, { ...instruction, result });
    return result;
  };
  return { input, fn, box, append };
}

describe("finite raw scalar and reference carrier coherence", () => {
  for (const op of ["js.bitand", "js.bitor", "js.bitxor", "js.shl", "js.shr_s", "js.shr_u"])
    it(`rejects real boxed Number operands for raw ${op} without an unbox`, () => {
      const { input, box, append } = carrierFixture();
      append({
        kind: "binary",
        op,
        lhs: box.result,
        rhs: box.result,
        resultType: { kind: "val", val: { kind: "f64" } },
      });
      expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/JS bitwise raw carrier/);
    });
  for (const reverse of [false, true])
    for (const resultKind of ["i32", "f64"])
      it(`retains genuine raw mixed ${reverse ? "i32/f64" : "f64/i32"} bitwise operands and ${resultKind} result`, () => {
        const { input, fn, box, append } = carrierFixture();
        const integer = append({
          kind: "const",
          value: { kind: "i32", value: 3 },
          resultType: { kind: "val", val: { kind: "i32" } },
        });
        const result = append({
          kind: "binary",
          op: "js.bitand",
          lhs: reverse ? integer : box.value,
          rhs: reverse ? box.value : integer,
          resultType: { kind: "val", val: { kind: resultKind } },
        });
        expect(() => indexNativeJsClassValueDomainInput(input)).not.toThrow();
        const row = analyzeNativeJsClassValueDomains(input).values.find(
          (row) => row.unitId === fn.unitId && row.value === result,
        )!;
        expect(row.domain).toEqual(
          resultKind === "f64" ? { kind: "known", families: ["Number"], roots: [] } : { kind: "unknown" },
        );
      });
  it("refuses unsupported bitwise result carriers rather than manufacturing a value family", () => {
    for (const resultType of [
      { kind: "val", val: { kind: "f32" } },
      { kind: "dynamic", tag: JS_TAG_IDS.NumberF64 },
    ]) {
      const { input, box, append } = carrierFixture();
      append({ kind: "binary", op: "js.bitand", lhs: box.value, rhs: box.value, resultType });
      expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/JS bitwise raw carrier/);
    }
  });
  it("refuses a false Boolean result brand on an actual Number bitwise operation", () => {
    const { input, box, append } = carrierFixture();
    append({
      kind: "binary",
      op: "js.bitand",
      lhs: box.value,
      rhs: box.value,
      resultType: { kind: "val", val: { kind: "i32", boolean: true } },
    });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/Number result cannot claim Boolean/);
  });
  it("preserves Boolean raw operands as valid JS ToInt32 input", () => {
    const { input, box, append } = carrierFixture();
    const boolean = append({
      kind: "const",
      value: { kind: "bool", value: true },
      resultType: { kind: "val", val: { kind: "i32", boolean: true } },
    });
    append({
      kind: "binary",
      op: "js.bitand",
      lhs: boolean,
      rhs: box.value,
      resultType: { kind: "val", val: { kind: "f64" } },
    });
    expect(() => indexNativeJsClassValueDomainInput(input)).not.toThrow();
  });
  for (const operand of ["numeric", "dynamic"])
    it(`rejects ${operand} Number as a raw reference null-test operand`, () => {
      const { input, box, append } = carrierFixture();
      append({
        kind: "unary",
        op: "ref.is_null",
        rand: operand === "numeric" ? box.value : box.result,
        resultType: { kind: "val", val: { kind: "i32", boolean: true } },
      });
      expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/null-test reference\/i32 carrier/);
    });
  it("requires the actual i32 null-test result even on a genuine support-ref frame", () => {
    const { input, fn, append } = carrierFixture();
    const frame = fn.blocks[0]!.instrs.find((instr) => instr.kind === "js.class.frame.new")!;
    append({ kind: "unary", op: "ref.is_null", rand: frame.result, resultType: { kind: "val", val: { kind: "f64" } } });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/null-test reference\/i32 carrier/);
  });
  it("retains a genuine logical support-ref null-test without inferring a scalar family from its declaration", () => {
    const { input, fn, append } = carrierFixture();
    const frame = fn.blocks[0]!.instrs.find((instr) => instr.kind === "js.class.frame.new")!;
    const result = append({
      kind: "unary",
      op: "ref.is_null",
      rand: frame.result,
      resultType: { kind: "val", val: { kind: "i32", boolean: true } },
    });
    expect(() => indexNativeJsClassValueDomainInput(input)).not.toThrow();
    expect(
      analyzeNativeJsClassValueDomains(input).values.find((row) => row.unitId === fn.unitId && row.value === result)
        ?.domain,
    ).toEqual({ kind: "unknown" });
  });
  it("retains raw nullable externref input and i32 null-test output", () => {
    const { input, append } = carrierFixture();
    const type = { kind: "val", val: { kind: "externref" } };
    const reference = append({ kind: "const", value: { kind: "null", ty: type }, resultType: type });
    append({
      kind: "unary",
      op: "ref.is_null",
      rand: reference,
      resultType: { kind: "val", val: { kind: "i32", boolean: true } },
    });
    expect(() => indexNativeJsClassValueDomainInput(input)).not.toThrow();
  });
});

describe("finite Symbol carrier exclusions retain raw Number brands", () => {
  it("rejects Symbol handle operands and retains a numeric int32 operand", () => {
    for (const reverse of [false, true]) {
      const mutant = carrierFixture();
      const symbol = mutant.append({
        kind: "const",
        value: { kind: "i32", value: 3 },
        resultType: { kind: "val", val: { kind: "i32", symbol: true } },
      });
      mutant.append({
        kind: "binary",
        op: "js.bitand",
        lhs: reverse ? mutant.box.value : symbol,
        rhs: reverse ? symbol : mutant.box.value,
        resultType: { kind: "val", val: { kind: "f64" } },
      });
      expect(() => analyzeNativeJsClassValueDomains(mutant.input)).toThrow(/JS bitwise raw carrier/);
    }
    const valid = carrierFixture();
    const integer = valid.append({
      kind: "const",
      value: { kind: "i32", value: 3 },
      resultType: { kind: "val", val: { kind: "i32", int32: true } },
    });
    const result = valid.append({
      kind: "binary",
      op: "js.bitand",
      lhs: integer,
      rhs: valid.box.value,
      resultType: { kind: "val", val: { kind: "f64" } },
    });
    expect(
      analyzeNativeJsClassValueDomains(valid.input).values.find(
        (row) => row.unitId === valid.fn.unitId && row.value === result,
      )?.domain,
    ).toEqual({ kind: "known", families: ["Number"], roots: [] });
  });
  it("refuses a Symbol result brand on a genuine raw Number bitwise operation", () => {
    const { input, box, append } = carrierFixture();
    append({
      kind: "binary",
      op: "js.bitand",
      lhs: box.value,
      rhs: box.value,
      resultType: { kind: "val", val: { kind: "i32", symbol: true } },
    });
    expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/JS bitwise raw carrier/);
  });
});

describe("actual opaque calls and unsafe numeric transfers", () => {
  const text =
    "let count:number=0;function effect():number{count=count+1;return 4;}class C{m(){effect();return;}}export function run():number{new C().m();return count;}";
  for (const policy of policies)
    it(`${policy.backend}:${policy.target} genuine global-effect helper keeps call and numeric obligations`, async () => {
      const input = sourceInput(text, policy);
      const result = analyzeNativeJsClassValueDomains(input);
      expect(replayNativeJsClassValueDomains(input, result)).toEqual([]);
      const unresolved = result.calls.filter(
        (row) =>
          row.kind === "direct" &&
          !row.targets.length &&
          row.obligations.some((reason) => reason.reason === "unknown-callee"),
      );
      expect(unresolved.length).toBeGreaterThan(0);
      for (const call of unresolved) {
        expect(call.mayThrow).toBe(true);
        expect(call.obligations.map((row) => row.reason)).toEqual(["opaque-effect", "unknown-callee"]);
      }
      const forged = structuredClone(result);
      const first = unresolved[0]!;
      const changed = forged.calls.find(
        (row) => nativeJsClassValueDataKey(row.location) === nativeJsClassValueDataKey(first.location),
      )!;
      Object.assign(changed, { mayThrow: false });
      expect(replayNativeJsClassValueDomains(input, forged).length).toBeGreaterThan(0);
      const effect = input.module.functions.find((fn) => fn.name === "effect")!;
      const actualUnsafe = result.obligations.filter(
        (row) => row.location?.unitId === effect.unitId && row.reason === "unsafe-scalar-projection",
      );
      expect(actualUnsafe.length).toBeGreaterThan(0);
      const source = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
      const prepared = prepareIrProgramSources({
        sourceFiles: source.sourceFiles,
        entrySource: source.entryFile,
        checker: source.checker,
        policy,
        runtimePolicies: [policy],
        deferTopLevelInit: false,
        linearVectorProjection: "native-f64",
      });
      if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
      const typed = prepareTypedIrProgram(captureTypedIrProgramInput(prepared), {
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
      if (typed.kind !== "prepared") throw new Error(JSON.stringify(typed));
      const bytes = encodePreparedIrProgram(typed.program);
      expect(encodePreparedIrProgram(decodePreparedIrProgram(bytes))).toBe(bytes);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

  for (const [name, expression, operation] of [
    ["unary", "-x", "f64.neg"],
    ["binary", "x+1", "f64.add"],
  ] as const)
    it(`real external UNKNOWN ${name} transfer cannot lose its actual scalar projection reason`, () => {
      const input = sourceInput(`class C{}export function run(x:number):number{return ${expression};}`, policies[0]);
      const result = analyzeNativeJsClassValueDomains(input);
      expect(replayNativeJsClassValueDomains(input, result)).toEqual([]);
      const fn = input.module.functions.find((fn) => fn.name === "run")!;
      const ordinal = fn.blocks[0]!.instrs.findIndex(
        (instr) => (instr.kind === "unary" || instr.kind === "binary") && instr.op === operation,
      );
      expect(ordinal).toBeGreaterThanOrEqual(0);
      const obligation = result.obligations.find(
        (row) =>
          row.location?.unitId === fn.unitId &&
          row.location.blockOrdinal === 0 &&
          row.location.instructionOrdinal === ordinal &&
          row.reason === "unsafe-scalar-projection",
      );
      expect(obligation).toBeDefined();
      const forged = structuredClone(result);
      Object.assign(forged, {
        obligations: forged.obligations.filter(
          (row) => nativeJsClassValueDataKey(row) !== nativeJsClassValueDataKey(obligation),
        ),
      });
      expect(replayNativeJsClassValueDomains(input, forged).length).toBeGreaterThan(0);
      expect(result.projections.find((row) => row.externalName === "run")?.decision).toBe("unknown");
    });
});

const constructorEquationSources = [
  {
    name: "actual Boolean despite Number annotation",
    text: "class C{x:number;constructor(x:number){this.x=x;}}export function run():number{return new C(true).x===undefined?1:0;}",
    argc: 1,
    family: "Boolean",
  },
  {
    name: "missing required actual USER",
    text: "class C{x:number;constructor(x:number){this.x=x;}}export function run():number{return new C().x===undefined?1:0;}",
    argc: 0,
    family: "Undefined",
  },
  {
    name: "explicit actual Undefined",
    text: "class C{x:number;constructor(x:number){this.x=x;}}export function run():number{return new C(undefined).x===undefined?1:0;}",
    argc: 1,
    family: "Undefined",
  },
  {
    name: "erased optional USER",
    text: "class C{x:number;constructor(x?:number){this.x=x;}}export function run():number{return new C().x===undefined?1:0;}",
    argc: 0,
    family: "Undefined",
  },
  {
    name: "all extra argument effects precede construction",
    text: "let order:number=0;function mark(v:number):number{order=order*10+v;return v;}class C{}export function run():number{new C(mark(1),mark(2));return order;}",
    argc: 2,
    family: null,
  },
  {
    name: "arguments then field then constructor body",
    text: "let order:number=0;function mark(v:number):number{order=order*10+v;return v;}class C{x:number=(order=order*10+3);constructor(x:number){order=order*10+4;}}export function run():number{new C(mark(1),mark(2));return order;}",
    argc: 2,
    family: null,
  },
] as const;

/** The complete actual owner pipeline also replays its post-middleend original and selected views. */
function preparedConstructorEquationInput(text: string, policy: (typeof policies)[number]) {
  const source = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const prepared = prepareIrProgramSources({
    sourceFiles: source.sourceFiles,
    entrySource: source.entryFile,
    checker: source.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
  const typed = prepareTypedIrProgram(captureTypedIrProgramInput(prepared), {
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
  if (typed.kind !== "prepared") throw new Error(JSON.stringify(typed));
  const encoded = encodePreparedIrProgram(typed.program);
  expect(encodePreparedIrProgram(decodePreparedIrProgram(encoded))).toBe(encoded);
  const normalized = normalizeNativeClassValues(typed.program, typed.program.ir, "original");
  if (normalized.kind !== "normalized") throw new Error(JSON.stringify(normalized));
  return normalized.input;
}

describe("actual class constructor adaptation and reached field stores", () => {
  for (const fixture of constructorEquationSources)
    for (const policy of policies)
      it(`${policy.backend}:${policy.target} ${fixture.name} preserves logical constructor equations`, async () => {
        const input = sourceInput(fixture.text, policy);
        const result = analyzeNativeJsClassValueDomains(input);
        expect(replayNativeJsClassValueDomains(input, result)).toEqual([]);
        const constructs = result.calls.filter((row) => row.kind === "construct");
        expect(constructs).toHaveLength(1);
        expect(constructs[0]!.argumentDomains).toHaveLength(fixture.argc);
        expect(result.obligations.some((row) => row.reason === "missing-argument-adaptation")).toBe(false);
        if (fixture.family !== null) {
          const body = input.definitions[0]!.definition.constructor;
          const summary = result.functions.find((row) => row.unitId === body.unitId)!;
          expect(summary.parameterDomains[4]).toEqual({ kind: "known", families: [fixture.family], roots: [] });
        }
        if (fixture.argc === 2) {
          const mark = input.units.find((unit) => unit.target.name === "mark")!;
          const calls = result.calls.filter((row) => row.targets.some((target) => target.unitId === mark.unitId));
          expect(calls).toHaveLength(2);
          expect(calls.every((call) => call.argumentDomains.length === 1)).toBe(true);
          expect(result.functions.find((row) => row.unitId === mark.unitId)!.writesGlobals.length).toBeGreaterThan(0);
        }
        const current = preparedConstructorEquationInput(fixture.text, policy);
        const description = analyzeNativeJsClassValueDomains(current);
        expect(replayNativeJsClassValueDomains(current, description)).toEqual([]);
        expect(
          description.heap.some(
            (cell) => cell.key.kind === "literal" && cell.key.value === "x" && cell.valueDomain.kind === "bottom",
          ),
        ).toBe(false);
        await new Promise<void>((resolve) => setImmediate(resolve));
      });

  it("preserves a genuine normal Undefined field store", () => {
    const input = sourceInput(
      "class C{x:number;constructor(){}}export function run():number{return new C().x===undefined?1:0;}",
      policies[0],
    );
    const result = analyzeNativeJsClassValueDomains(input);
    expect(replayNativeJsClassValueDomains(input, result)).toEqual([]);
    const fields = result.heap.filter((cell) => cell.key.kind === "literal" && cell.key.value === "x");
    expect(fields).toHaveLength(1);
    expect(fields[0]!.presence).not.toBe("absent");
    expect(fields[0]!.valueDomain).toEqual({ kind: "known", families: ["Undefined"], roots: [] });
  });

  it("keeps ordinary direct-unit actual arity and declaration validation", () => {
    const original = sourceInput(constructorEquationSources[4].text, policies[1]);
    const report = analyzeNativeJsClassValueDomains(original);
    expect(replayNativeJsClassValueDomains(original, report)).toEqual([]);
    const mutant = structuredClone(original);
    const call = mutant.module.functions
      .flatMap((fn) => fn.blocks.flatMap((block) => block.instrs))
      .find((instr) => instr.kind === "call" && instr.target.binding.kind === "unit" && instr.args.length === 1)!;
    expect(call.kind).toBe("call");
    Object.assign(call, { args: [] });
    expect(() => analyzeNativeJsClassValueDomains(mutant)).toThrow(/actual call declaration differs/);
    expect(replayNativeJsClassValueDomains(mutant, report).length).toBeGreaterThan(0);
  });

  it("rejects a counterfeit construct adaptation obligation", () => {
    const input = sourceInput(constructorEquationSources[1].text, policies[0]);
    const report = analyzeNativeJsClassValueDomains(input);
    expect(replayNativeJsClassValueDomains(input, report)).toEqual([]);
    const forged = structuredClone(report);
    const call = forged.calls.find((row) => row.kind === "construct")!;
    expect(call.obligations).toEqual([]);
    Object.assign(call, {
      obligations: [{ location: call.location, unitId: call.location.unitId, reason: "missing-argument-adaptation" }],
    });
    expect(replayNativeJsClassValueDomains(input, forged).length).toBeGreaterThan(0);
  });

  it("rejects erasing an already evaluated extra argument from the construct census", () => {
    const input = sourceInput(constructorEquationSources[4].text, policies[0]);
    const report = analyzeNativeJsClassValueDomains(input);
    expect(replayNativeJsClassValueDomains(input, report)).toEqual([]);
    const forged = structuredClone(report);
    const call = forged.calls.find((row) => row.kind === "construct")!;
    expect(call.argumentDomains).toHaveLength(2);
    Object.assign(call, { argumentDomains: call.argumentDomains.slice(0, 1) });
    expect(replayNativeJsClassValueDomains(input, forged).length).toBeGreaterThan(0);
  });

  it("retains actual opaque effects while adapting constructor USER arguments", () => {
    const input = sourceInput(constructorEquationSources[5].text, policies[0]);
    const report = analyzeNativeJsClassValueDomains(input);
    expect(replayNativeJsClassValueDomains(input, report)).toEqual([]);
    expect(report.obligations.some((row) => row.reason === "opaque-effect")).toBe(true);
    const forged = structuredClone(report);
    Object.assign(forged, { obligations: forged.obligations.filter((row) => row.reason !== "opaque-effect") });
    expect(replayNativeJsClassValueDomains(input, forged).length).toBeGreaterThan(0);
  });

  it("rejects reinjecting a speculative BOTTOM field write from an unfinished initializer", () => {
    const input = preparedConstructorEquationInput(constructorEquationSources[5].text, policies[1]);
    const report = analyzeNativeJsClassValueDomains(input);
    expect(replayNativeJsClassValueDomains(input, report)).toEqual([]);
    const prototype = report.heap.find(
      (cell) =>
        cell.root.kind === "allocation" &&
        cell.root.view === "object" &&
        cell.key.kind === "internal" &&
        cell.key.value === "prototype",
    )!;
    expect(prototype).toBeDefined();
    expect(
      report.heap.some(
        (cell) => cell.key.kind === "literal" && cell.key.value === "x" && cell.valueDomain.kind === "bottom",
      ),
    ).toBe(false);
    const forged = structuredClone(report);
    Object.assign(forged, {
      heap: [
        ...forged.heap,
        {
          root: prototype.root,
          key: { kind: "literal", value: "x" },
          presence: "maybe",
          valueDomain: { kind: "bottom" },
          prototypeRoots: [],
        },
      ],
    });
    expect(replayNativeJsClassValueDomains(input, forged).length).toBeGreaterThan(0);
  });
});

describe("direct call rows describe the current operation's throw effect", () => {
  for (const [order, text] of [
    ["class-before", "class C{}function pure():number{return 7;}export function run():number{new C();return pure();}"],
    [
      "class-after",
      "class C{}function pure():number{return 7;}export function run():number{const value=pure();new C();return value;}",
    ],
  ] as const)
    it(`${order} keeps a nonthrowing callee false while its actual caller can throw`, () => {
      const input = sourceInput(text, policies[0]);
      const result = analyzeNativeJsClassValueDomains(input);
      expect(replayNativeJsClassValueDomains(input, result)).toEqual([]);
      const pure = input.units.find((unit) => unit.target.name === "pure")!;
      const run = input.units.find((unit) => unit.target.name === "run")!;
      const calls = result.calls.filter((call) => call.targets.some((target) => target.unitId === pure.unitId));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.kind).toBe("direct");
      expect(calls[0]!.mayThrow).toBe(false);
      expect(result.functions.find((fn) => fn.unitId === pure.unitId)!.mayThrow).toBe(false);
      expect(result.functions.find((fn) => fn.unitId === run.unitId)!.mayThrow).toBe(true);
      const forged = structuredClone(result);
      const call = forged.calls.find((call) => call.targets.some((target) => target.unitId === pure.unitId))!;
      Object.assign(call, { mayThrow: true });
      expect(replayNativeJsClassValueDomains(input, forged).length).toBeGreaterThan(0);
    });

  it("retains a genuinely throwing known callee and its nonreturning completion", () => {
    const input = sourceInput(
      "class C{}function fail():number{throw 7;}export function run():number{new C();return fail();}",
      policies[0],
    );
    const result = analyzeNativeJsClassValueDomains(input);
    expect(replayNativeJsClassValueDomains(input, result)).toEqual([]);
    const fail = input.units.find((unit) => unit.target.name === "fail")!;
    const call = result.calls.find((call) => call.targets.some((target) => target.unitId === fail.unitId))!;
    expect(call.kind).toBe("direct");
    expect(call.mayThrow).toBe(true);
    expect(call.normalDomain).toEqual({ kind: "bottom" });
    expect(result.functions.find((fn) => fn.unitId === fail.unitId)).toMatchObject({
      mayThrow: true,
      normalCompletion: false,
    });
    const forged = structuredClone(result);
    Object.assign(
      forged.calls.find((row) => nativeJsClassValueDataKey(row.location) === nativeJsClassValueDataKey(call.location))!,
      { mayThrow: false },
    );
    expect(replayNativeJsClassValueDomains(input, forged).length).toBeGreaterThan(0);
  });

  it("retains actual unresolved runtime call throw effects and opaque obligations", () => {
    const input = sourceInput(constructorEquationSources[4].text, policies[1]);
    const result = analyzeNativeJsClassValueDomains(input);
    expect(replayNativeJsClassValueDomains(input, result)).toEqual([]);
    const calls = result.calls.filter(
      (call) =>
        call.kind === "direct" &&
        call.targets.length === 0 &&
        call.obligations.some((row) => row.reason === "unknown-callee"),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.mayThrow).toBe(true);
      expect(call.obligations.map((row) => row.reason)).toEqual(["opaque-effect", "unknown-callee"]);
    }
    const forged = structuredClone(result);
    Object.assign(
      forged.calls.find(
        (row) => nativeJsClassValueDataKey(row.location) === nativeJsClassValueDataKey(calls[0]!.location),
      )!,
      { mayThrow: false },
    );
    expect(replayNativeJsClassValueDomains(input, forged).length).toBeGreaterThan(0);
  });
});

// Public report roots originate only in actual source; private Map tie/alias behavior is statically preserved.
for (const policy of policies)
  for (const [name, text] of [publicHistorySources[0], publicHistorySources[2], publicHistorySources[3]])
    it(`${policy.backend}:${policy.target} closed root keys retain canonical fields and order for ${name}`, () => {
      const input = sourceInput(text, policy),
        report = analyzeNativeJsClassValueDomains(input);
      expect(replayNativeJsClassValueDomains(input, report)).toEqual([]);
      const domains = [
        ...report.values.map((row) => row.domain),
        ...report.globals.map((row) => row.domain),
        ...report.heap.map((row) => row.valueDomain),
        ...report.functions.flatMap((row) => [...row.parameterDomains, ...row.normalResultDomains]),
        ...report.calls.flatMap((row) => [row.calleeDomain, row.normalDomain, ...row.argumentDomains]),
      ];
      const roots = [
        ...domains.flatMap((domain) => (domain.kind === "known" ? domain.roots : [])),
        ...report.heap.flatMap((cell) => [cell.root, ...cell.prototypeRoots]),
        ...report.functions.flatMap((row) => row.escapedRoots),
      ];
      const allocations = roots.filter((root) => root.kind === "allocation");
      expect(allocations.length).toBeGreaterThan(0);
      expect(roots.some((root) => root.kind === "external")).toBe(true);
      expect(allocations.some((root) => root.memberOrdinal !== null)).toBe(true);
      expect(allocations.some((root) => root.memberOrdinal === null)).toBe(true);
      expect(new Set(allocations.map((root) => root.view)).size).toBeGreaterThanOrEqual(4);
      expect(report.heap.some((cell) => cell.prototypeRoots.length > 0)).toBe(true);
      if (name === "callable replacement") {
        expect(new Set(allocations.map((root) => root.site)).size).toBeGreaterThan(1);
        expect(new Set(allocations.map((root) => root.definitionId)).size).toBeGreaterThan(1);
      }
      for (const domain of domains) {
        if (domain.kind !== "known") continue;
        const keys = domain.roots.map(nativeJsClassValueDataKey);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
      }
      for (const root of roots)
        expect(Object.keys(root).sort()).toEqual(
          root.kind === "allocation"
            ? ["definitionId", "kind", "memberOrdinal", "site", "unitId", "view"]
            : ["bindingId", "kind"],
        );
    });
