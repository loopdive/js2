// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it } from "vitest";
import { setImmediate as yieldTestLoop } from "node:timers/promises";
import { irSupportRef } from "../src/ir/core/types.js";
import { forEachInstrDeep, type IrModule, type IrInstr } from "../src/ir/core/nodes.js";
import { preparedIrDataMismatch } from "../src/shared/contracts/prepared-ir-data.js";
import { nativeJsClassEffects } from "../src/ir/analysis/allocation-evidence/native-js-class-effects.js";
import { analyzeNativeJsClass } from "../src/ir/analysis/allocation-evidence/native-js-class-producer.js";
import { verifyNativeJsClassEvidence } from "../src/ir/runtime/native-js-class-profile.js";
import { inspectNativeJsClassNamespaces } from "../src/ir/analysis/allocation-evidence/native-js-class-profile.js";
import {
  nativeJsClassEvidenceDomainFromProgram,
  assertNativeJsClassAllocations,
} from "../src/ir/program/native-js-class-allocation-validation.js";
import type { NativeJsClassEvidenceDomain } from "../src/ir/analysis/allocation-evidence/native-js-class-effects.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";

const diagnostic = (value: Record<string, unknown>) => value as unknown as IrInstr;
function scalarSource() {
  const ast = analyzeMultiSource({ "./entry.ts": "export function run():number{return 1;}" }, "./entry.ts");
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "linear", target: "standalone" },
    linearVectorProjection: "native-f64",
    deferTopLevelInit: false,
  });
  if (source.kind !== "prepared") throw Error(JSON.stringify(source));
  return source;
}
it("complete absent class census preserves actual scalar registry and requires no class domain", () => {
  const source = scalarSource(),
    before = source.allocations.snapshot();
  expect(analyzeNativeJsClass(source.ir, source.allocations, undefined)).toBe(false);
  expect(source.allocations.snapshot()).toEqual(before);
});
it("a forged selected opcode cannot create namespaces without an actual current domain", () => {
  const source = scalarSource(),
    before = source.allocations.snapshot();
  const fn = source.ir.functions[0]!;
  const module = {
    ...source.ir,
    functions: [
      {
        ...fn,
        blocks: [
          {
            ...fn.blocks[0]!,
            instrs: [
              diagnostic({
                kind: "js.class.forged",
                result: null,
                resultType: null,
              }),
            ],
          },
        ],
      },
    ],
  };
  expect(() => analyzeNativeJsClass(module, source.allocations, undefined)).toThrow("no current definition domain");
  expect(source.allocations.snapshot()).toEqual(before);
});
it("module getter refusal precedes population inspection and has zero effects", () => {
  const source = scalarSource();
  let getters = 0;
  const module = { ...source.ir };
  Object.defineProperty(module, "functions", {
    enumerable: true,
    get() {
      getters++;
      throw Error("getter executed");
    },
  });
  expect(() => analyzeNativeJsClass(module, source.allocations, undefined)).toThrow();
  expect(getters).toBe(0);
});
it("class effect inspection refuses an operand getter before reading it", () => {
  let getters = 0;
  const instr = diagnostic({
    kind: "js.class.identity",
    result: 2,
    resultType: { kind: "val", val: { kind: "i32" } },
    right: 1,
  });
  Object.defineProperty(instr, "left", {
    enumerable: true,
    get() {
      getters++;
      return 0;
    },
  });
  expect(() => nativeJsClassEffects(instr)).toThrow();
  expect(getters).toBe(0);
});
it.each([
  { kind: "js.class.forged" },
  { kind: "js.class.identity", left: -1, right: 0 },
  {
    kind: "js.class.frame.new",
    definition: "descriptor",
    environment: 0,
    thisValue: 1,
    homeObject: 2,
    newTarget: 3,
    result: 4,
    resultType: { kind: "val", val: { kind: "f64" } },
    alloc: 0,
  },
  {
    kind: "js.class.property.get",
    receiver: 0,
    key: { kind: "computed", value: "foreign" },
  },
  {
    kind: "js.class.binding.read",
    storage: { kind: "foreign", bindingId: "binding" },
  },
  {
    kind: "js.class.constructor.complete",
    self: 0,
    completion: { kind: "normal" },
    constructorKind: "derived",
  },
])("closed effect grammar refuses malformed $kind without granting proof", (row) => {
  expect(() => nativeJsClassEffects(diagnostic(row))).toThrow();
});

it("removing the entire selected class opcode population cannot turn a descriptor into absent generic admission", () => {
  const source = scalarSource(),
    before = source.allocations.snapshot();
  const domain = {
    definitions: [{ id: "forged", definition: null }],
    unitIds: source.ir.functions.map((fn) => fn.unitId),
  } as unknown as NativeJsClassEvidenceDomain;
  expect(() => analyzeNativeJsClass(source.ir, source.allocations, domain)).toThrow("definition occurrence census");
  expect(inspectNativeJsClassNamespaces(source.ir, before, domain)?.kind).toBe("invalid");
  expect(source.allocations.snapshot()).toEqual(before);
});
it("full ABI getter cannot execute through the public extraction entry", () => {
  const source = scalarSource();
  let getters = 0;
  const context = {};
  Object.defineProperty(context, "abi", {
    enumerable: true,
    get() {
      getters++;
      throw Error("getter executed");
    },
  });
  expect(() => nativeJsClassEvidenceDomainFromProgram(context, source.ir)).toThrow("accessor abi");
  expect(getters).toBe(0);
});
it("selected runtime prepared-function getter cannot execute through allocation replay", () => {
  const source = scalarSource();
  let getters = 0;
  const prepared = {};
  Object.defineProperty(prepared, "functions", {
    enumerable: true,
    get() {
      getters++;
      throw Error("getter executed");
    },
  });
  const context = {
    ir: source.ir,
    allocations: source.allocations.snapshot(),
    runtime: [{ prepared }],
  } as unknown as Parameters<typeof assertNativeJsClassAllocations>[0];
  expect(() => assertNativeJsClassAllocations(context)).toThrow("accessor functions");
  expect(getters).toBe(0);
});
it("absent genuine scalar program replay needs no class facade or descriptor attachment", () => {
  const source = scalarSource();
  expect(
    assertNativeJsClassAllocations({
      ir: source.ir,
      allocations: source.allocations.snapshot(),
    }),
  ).toBe(false);
});

it("complete program DATA getter cannot execute through producer or independent runtime replay", () => {
  const source = scalarSource();
  let getters = 0;
  const domain = {
    definitions: [],
    unitIds: source.ir.functions.map((fn) => fn.unitId),
  } as unknown as NativeJsClassEvidenceDomain;
  Object.defineProperty(domain, "programData", {
    enumerable: true,
    get() {
      getters++;
      throw Error("getter executed");
    },
  });
  expect(() => analyzeNativeJsClass(source.ir, source.allocations, domain)).toThrow();
  expect(verifyNativeJsClassEvidence(source.ir, source.allocations.snapshot(), domain)?.kind).toBe("invalid");
  expect(getters).toBe(0);
});

// All positive populations below come from the real SourceFile/class builders.
// No physical capability or backend execution is inferred from logical replay.
import { prepareIrProgramRuntimeCallables } from "../src/ir/program/runtime-abi.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { JS_TAG_IDS } from "../src/ir/runtime/js-tag-domain.js";

function classSource(
  text: string,
  policy: { backend: "wasmgc" | "linear"; target: "standalone" | "wasi" } = {
    backend: "wasmgc",
    target: "standalone",
  } as const,
) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    linearVectorProjection: "native-f64",
    deferTopLevelInit: false,
  });
  if (source.kind !== "prepared") throw Error(JSON.stringify(source));
  const typed = captureTypedIrProgramInput(source);
  const restored = AllocSiteRegistry.restorePreparationData(typed.allocations, typed);
  const input = restored.data;
  const runtime = prepareIrProgramRuntimeCallables(input);
  if (runtime.kind !== "prepared") throw Error(JSON.stringify(runtime));
  const context = {
    ...input,
    abi: { entries: prepareIrProgramAbiEntries(input, runtime.declarations) },
  };
  const domain = nativeJsClassEvidenceDomainFromProgram(context, input.ir);
  if (!domain) throw Error("genuine class source unexpectedly absent");
  return { input, context, domain, allocations: restored.allocations };
}
function replay(fixture: ReturnType<typeof classSource>, module: IrModule = fixture.input.ir) {
  expect(analyzeNativeJsClass(module, fixture.allocations, fixture.domain)).toBe(true);
  const neutral = inspectNativeJsClassNamespaces(module, fixture.allocations.snapshot(), fixture.domain);
  expect(neutral, JSON.stringify(neutral)).toMatchObject({
    kind: "representable",
  });
  return verifyNativeJsClassEvidence(module, fixture.allocations.snapshot(), fixture.domain);
}
it.each([
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const)(
  "genuine original class Number/Boolean initializers have complete canonical logical evidence $backend:$target",
  (policy) => {
    const f = classSource(
      "class C{n:number=3;b:boolean=true;}export function run():number{return new C().n===undefined?1:0;}",
      policy,
    );
    const boxes = f.input.ir.functions.flatMap((fn) =>
      fn.blocks.flatMap((block) => block.instrs.filter((instr) => instr.kind === "box")),
    );
    expect(boxes).toHaveLength(2);
    expect(boxes.map((box) => box.resultType)).toEqual([
      { kind: "dynamic", tag: JS_TAG_IDS.NumberF64 },
      { kind: "dynamic", tag: JS_TAG_IDS.Boolean },
    ]);
    const report = replay(f);
    expect(report, JSON.stringify(report)).toMatchObject({
      kind: "verified",
      profile: "native-js-class-v1",
      namespaces: "ownership-and-escape",
    });
    expect(report?.kind === "verified" && report.census.allocations).toBe(f.allocations.size);
    expect(
      assertNativeJsClassAllocations({
        ...f.context,
        allocations: f.allocations.snapshot(),
      }),
    ).toBe(true);
  },
);

it.each(["unbranded-i32", "NumberI32-tag"] as const)(
  "canonical replay refuses a real Boolean box mutated to %s despite unchanged site evidence",
  (mutation) => {
    const f = classSource("class C{b:boolean=true;}export function run():number{return 7;}");
    const initializer = f.input.ir.functions.find(
      (fn) => fn.unitId === f.domain.definitions[0]!.definition.instanceElements[0]!.initializer!.unitId,
    )!;
    const box = initializer.blocks[0]!.instrs.find((instr) => instr.kind === "box")!;
    if (box.kind !== "box" || box.resultType?.kind !== "dynamic") throw Error("missing actual Boolean box");
    if (mutation === "unbranded-i32") {
      const payload = initializer.blocks[0]!.instrs.find((instr) => instr.result === box.value)!;
      Object.assign(payload, {
        resultType: { kind: "val", val: { kind: "i32" } },
        value: { kind: "i32", value: 1 },
      });
    } else {
      // The genuine box site/result/toType share their captured DATA type. Preserve
      // that join, so only canonical JS partition replay can refuse the forgery.
      Object.assign(box.resultType, { tag: JS_TAG_IDS.NumberI32 });
      Object.assign(box.toType, { tag: JS_TAG_IDS.NumberI32 });
      Object.assign(f.allocations.resolve(box.alloc!)!.type, {
        tag: JS_TAG_IDS.NumberI32,
      });
    }
    expect(analyzeNativeJsClass(f.input.ir, f.allocations, f.domain)).toBe(true);
    expect(inspectNativeJsClassNamespaces(f.input.ir, f.allocations.snapshot(), f.domain)).toMatchObject({
      kind: "representable",
    });
    expect(verifyNativeJsClassEvidence(f.input.ir, f.allocations.snapshot(), f.domain)?.kind).not.toBe("verified");
  },
);
it.each(["constructor", "method", "initializer"] as const)(
  "plain IR call cannot bypass genuine class-owned %s protocol",
  (kind) => {
    const f = classSource("class C{x:number=3;read():number{return 7;}}export function run():number{return 7;}");
    const d = f.domain.definitions[0]!.definition;
    const body =
      kind === "constructor"
        ? d.constructor
        : kind === "method"
          ? d.members[0]!.body
          : d.instanceElements[0]!.initializer!;
    const run = f.input.ir.functions.find((fn) => fn.name === "run")!;
    const original = run.blocks[0]!.instrs[0]!;
    const module = {
      ...f.input.ir,
      functions: f.input.ir.functions.map((fn) =>
        fn !== run
          ? fn
          : {
              ...fn,
              blocks: [
                {
                  ...fn.blocks[0]!,
                  instrs: [
                    {
                      ...original,
                      kind: "call",
                      target: body.target,
                      args: [],
                    } as IrInstr,
                  ],
                },
              ],
            },
      ),
    };
    const before = f.allocations.snapshot();
    expect(() => analyzeNativeJsClass(module, f.allocations, f.domain)).toThrow(
      "class-owned callable requires its explicit protocol",
    );
    expect(f.allocations.snapshot()).toEqual(before);
    expect(inspectNativeJsClassNamespaces(module, before, f.domain)?.kind).not.toBe("representable");
    expect(verifyNativeJsClassEvidence(module, before, f.domain)?.kind).not.toBe("verified");
  },
);
it("dynamic refinement can be forgotten by a real initializer result but cannot be claimed or crossed", () => {
  const f = classSource("class C{x:number=3;}export function run():number{return 7;}");
  expect(replay(f)?.kind).toBe("verified");
  const initializer = f.input.ir.functions.find(
    (fn) => fn.unitId === f.domain.definitions[0]!.definition.instanceElements[0]!.initializer!.unitId,
  )!;
  const module = {
    ...f.input.ir,
    functions: f.input.ir.functions.map((fn) =>
      fn !== initializer
        ? fn
        : {
            ...fn,
            resultTypes: [{ kind: "dynamic", tag: JS_TAG_IDS.Boolean } as const],
          },
    ),
  };
  expect(inspectNativeJsClassNamespaces(module, f.allocations.snapshot(), f.domain)?.kind).toBe("invalid");
  expect(verifyNativeJsClassEvidence(module, f.allocations.snapshot(), f.domain)?.kind).not.toBe("verified");
});

it.each([false, true])(
  "actual GC preparation seals original/all-selected class evidence with ordinary analysis controls %s",
  (enabled) => {
    const f = classSource(
      "class C{n:number=3;b:boolean=true;}export function run():number{return new C().n===undefined?1:0;}",
    );
    const policy = { backend: "wasmgc", target: "standalone" } as const;
    const result = prepareTypedIrProgram(f.input, {
      policy,
      runtimePolicies: [policy, { backend: "wasmgc", target: "wasi" }],
      controls: {
        gvnMode: "off",
        ownership: enabled,
        escape: enabled,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: true,
      },
    });
    expect(result.kind, JSON.stringify(result)).toBe("prepared");
    if (result.kind !== "prepared") throw Error(JSON.stringify(result));
    expect(result.program.runtime).toHaveLength(2);
    expect(assertNativeJsClassAllocations(result.program)).toBe(true);
    const encoded = encodePreparedIrProgram(result.program);
    const decoded = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(decoded)).toBe(encoded);
    expect(assertNativeJsClassAllocations(decoded)).toBe(true);
    expect(decoded.runtime).toHaveLength(2);
  },
);

it.each(["missing", "mutable", "foreign-binding"] as const)(
  "full canonical replay refuses %s real realm ABI while neutral namespaces remain valid",
  (mutation) => {
    const f = classSource("class C{x:number=3;}export function run():number{return 7;}");
    expect(replay(f)?.kind).toBe("verified");
    const id = f.domain.definitions[0]!.definition.realm.objectPrototype;
    const data = f.domain.programData!;
    const entries = f.context.abi.entries.flatMap((entry) =>
      entry.plan.id !== id
        ? [entry]
        : mutation === "missing"
          ? []
          : [
              {
                ...entry,
                contract:
                  entry.contract.kind !== "global"
                    ? entry.contract
                    : {
                        ...entry.contract,
                        ...(mutation === "mutable"
                          ? { mutable: true }
                          : {
                              ref: {
                                ...entry.contract.ref,
                                binding: {
                                  kind: "support" as const,
                                  bindingId: f.domain.definitions[0]!.definition.realm.functionPrototype,
                                },
                              },
                            }),
                      },
              },
            ],
    );
    const domain = {
      ...f.domain,
      programData: { ...data, abiEntries: entries },
    };
    expect(inspectNativeJsClassNamespaces(f.input.ir, f.allocations.snapshot(), domain)).toMatchObject({
      kind: "representable",
    });
    expect(verifyNativeJsClassEvidence(f.input.ir, f.allocations.snapshot(), domain)?.kind).toBe("invalid");
  },
);

import {
  collectNativeJsClassErrorDemands,
  assertNativeJsClassErrorDemandsCurrent,
  nativeJsClassRealmErrorDeclarations,
  TYPE_ERROR_DECLARATION,
  TYPE_ERROR_RUNTIME_PROVIDERS,
  nativeJsClassTypeErrorProviderMismatch,
} from "../src/ir/runtime/native-js-class-error-callables.js";
import { RuntimeManifestBuilder } from "../src/ir/runtime/manifest.js";
import { nativeJsClassAllocationTopology } from "../src/ir/program/native-js-class-allocation-validation.js";

it("actual operations declare distinct exceptional aggregates without adding source sites or calls", () => {
  const f = classSource(
    "class C{x:number=3;constructor(){return 2;}}export function run():number{const c=new C();c.x=4;return c.x===undefined?1:0;}",
  );
  const before = f.allocations.snapshot();
  const demands = collectNativeJsClassErrorDemands(f.input.ir.functions);
  expect(demands.length).toBeGreaterThan(2);
  expect(new Set(demands.map((row) => row.error))).toEqual(new Set(["ReferenceError", "TypeError"]));
  expect(
    demands.some((row) => row.instruction.kind === "js.class.construct" && row.partition === "nonconstructible-target"),
  ).toBe(true);
  expect(
    demands.some(
      (row) => row.instruction.kind === "js.class.property.set" && row.partition === "failed-strict-mutation",
    ),
  ).toBe(true);
  expect(
    demands.some(
      (row) =>
        row.instruction.kind === "js.class.binding.init" || row.instruction.kind === "js.class.constructor.complete",
    ),
  ).toBe(false);
  for (const demand of demands) {
    expect(demand.allocation).toEqual({
      kind: "fresh-provider-error",
      lifetime: "exception-escaped",
      aliases: [],
      message: "undefined",
    });
    expect(Object.hasOwn(demand.allocation, "site")).toBe(false);
  }
  expect(assertNativeJsClassErrorDemandsCurrent(f.input.ir.functions, demands)).toBeUndefined();
  expect(f.allocations.snapshot()).toEqual(before);
  expect(replay(f)?.kind).toBe("verified");
  const topology = nativeJsClassAllocationTopology(
    { ...f.context, allocations: f.allocations.snapshot() },
    f.input.ir,
  )!;
  expect(topology.implicitErrorAllocations.map((row) => [row.unitId, row.root, row.partition])).toEqual(
    demands.map((row) => [row.unitId, row.root, row.partition]),
  );
  expect(topology.roots).toHaveLength(f.allocations.size);
});
it.each(["copied", "missing", "mutated-body"] as const)(
  "error demand currentness refuses %s catalogue without borrowed authority",
  (mutation) => {
    const f = classSource("class C{x:number=3;}export function run():number{return new C().x===undefined?1:0;}");
    const demands = collectNativeJsClassErrorDemands(f.input.ir.functions);
    if (mutation === "mutated-body") {
      const run = f.input.ir.functions.find((fn) => fn.name === "run")!;
      Object.assign(run, { name: "changed-after-census" });
      expect(() => assertNativeJsClassErrorDemandsCurrent(f.input.ir.functions, demands)).toThrow(
        "stale class error census",
      );
    } else {
      const supplied = mutation === "copied" ? [...demands] : demands.slice(1);
      expect(() => assertNativeJsClassErrorDemandsCurrent(f.input.ir.functions, supplied)).toThrow("foreign or stale");
    }
  },
);
it.each([
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const)(
  "native class realm error callable providers remain distinct on $backend:$target without host capability",
  (policy) => {
    const f = classSource("class C{}export function run():number{return 7;}", policy);
    expect(collectNativeJsClassErrorDemands(f.input.ir.functions)).toEqual([]);
    const declarations = nativeJsClassRealmErrorDeclarations(f.input.ir.functions);
    expect(declarations.map((row) => row.feature)).toEqual(["error.reference.construct", "error.type.construct"]);
    const builder = new RuntimeManifestBuilder(policy);
    for (const declaration of declarations) builder.requestFeature(declaration.feature);
    const manifest = builder.freeze();
    expect(manifest.hostCapabilities).toEqual([]);
    expect(manifest.providers.map((row) => row.id)).toEqual([
      "native.error.reference.construct",
      "native.error.type.construct",
    ]);
    expect(manifest.providers.map((row) => row.implementation)).toEqual([
      { kind: "runtime-callable", symbol: "__new_ReferenceError" },
      { kind: "runtime-callable", symbol: "__new_TypeError" },
    ]);
  },
);
it("the new TypeError provider cannot create a JavaScript host capability or accept a forged signature", () => {
  const host = new RuntimeManifestBuilder({ backend: "wasmgc", target: "host" });
  host.requestFeature(TYPE_ERROR_DECLARATION.feature);
  expect(() => host.freeze()).toThrow();
  const bad = {
    ...TYPE_ERROR_RUNTIME_PROVIDERS[0]!,
    signature: { version: 1 as const, params: [], result: TYPE_ERROR_DECLARATION.results[0]! },
  };
  expect(nativeJsClassTypeErrorProviderMismatch(bad)).toMatch(/contradicts/);
  let getters = 0;
  const getter = { ...TYPE_ERROR_RUNTIME_PROVIDERS[0]! };
  Object.defineProperty(getter, "feature", {
    enumerable: true,
    get() {
      getters++;
      return TYPE_ERROR_DECLARATION.feature;
    },
  });
  expect(() => nativeJsClassTypeErrorProviderMismatch(getter)).toThrow();
  expect(getters).toBe(0);
});
it.each(["removed", "wrong-signature"] as const)(
  "canonical class evidence independently refuses %s implicit error ABI",
  (mutation) => {
    const f = classSource("class C{x:number=3;}export function run():number{return 7;}");
    expect(replay(f)?.kind).toBe("verified");
    const entries = f.context.abi.entries.flatMap((entry) =>
      entry.contract.kind !== "callable" ||
      entry.contract.ref.binding.kind !== "runtime" ||
      entry.contract.ref.binding.symbol !== "__new_TypeError"
        ? [entry]
        : mutation === "removed"
          ? []
          : [{ ...entry, contract: { ...entry.contract, params: [] } }],
    );
    const domain = { ...f.domain, programData: { ...f.domain.programData!, abiEntries: entries } };
    expect(inspectNativeJsClassNamespaces(f.input.ir, f.allocations.snapshot(), domain)?.kind).toBe("representable");
    expect(verifyNativeJsClassEvidence(f.input.ir, f.allocations.snapshot(), domain)?.kind).toBe("invalid");
  },
);

it.each(["missing-feature", "aliased-TypeError", "changed-signature", "getter"] as const)(
  "full original/all-selected error provider replay refuses %s",
  (mutation) => {
    const f = classSource("class C{x:number=3;}export function run():number{return new C().x===undefined?1:0;}");
    const policy = { backend: "wasmgc", target: "standalone" } as const;
    const prepared = prepareTypedIrProgram(f.input, {
      policy,
      runtimePolicies: [policy, { backend: "wasmgc", target: "wasi" }],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: true,
      },
    });
    if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
    const program = prepared.program;
    const domain = nativeJsClassEvidenceDomainFromProgram(program, program.ir)!;
    expect(verifyNativeJsClassEvidence(program.ir, program.allocations, domain)?.kind).toBe("verified");
    let getters = 0;
    const manifests = domain.programData!.runtimeManifests!.map((view, index) => {
      if (index === 0) return view;
      const manifest = program.runtime[index]!.prepared.manifest;
      const changed = {
        ...manifest,
        features:
          mutation === "missing-feature"
            ? manifest.features.filter((value) => value !== "error.type.construct")
            : manifest.features,
        providers: manifest.providers.map((row) =>
          row.feature !== "error.type.construct"
            ? row
            : mutation === "aliased-TypeError"
              ? { ...row, implementation: { kind: "runtime-callable" as const, symbol: "__new_ReferenceError" } }
              : mutation === "changed-signature"
                ? { ...row, signature: { version: 1 as const, params: [], result: TYPE_ERROR_DECLARATION.results[0]! } }
                : row,
        ),
      };
      if (mutation === "getter")
        Object.defineProperty(changed, "providers", {
          enumerable: true,
          get() {
            getters++;
            return manifest.providers;
          },
        });
      return { ...view, manifest: changed };
    });
    const bad = { ...domain, programData: { ...domain.programData!, runtimeManifests: manifests } };
    expect(verifyNativeJsClassEvidence(program.ir, program.allocations, bad)?.kind).toBe("invalid");
    expect(getters).toBe(0);
  },
);

it.each(["raw-store", "managed-read", "tagged-read"] as const)(
  "real source mutation %s cannot use an annotation or hidden box as property representation",
  (mutation) => {
    const f = classSource(
      "class C{x:number=3;}export function run():number{const c=new C();c.x=4;return c.x===undefined?1:0;}",
    );
    const run = f.input.ir.functions.find((fn) => fn.name === "run")!;
    const store = run.blocks[0]!.instrs.find((instr) => instr.kind === "js.class.property.set")!;
    if (store.kind !== "js.class.property.set") throw Error("missing genuine property store");
    const box = run.blocks[0]!.instrs.find((instr) => instr.kind === "box" && instr.result === store.value)!;
    if (box.kind !== "box") throw Error("missing genuine stored value box");
    const module = {
      ...f.input.ir,
      functions: f.input.ir.functions.map((fn) =>
        fn !== run
          ? fn
          : {
              ...fn,
              blocks: [
                {
                  ...fn.blocks[0]!,
                  instrs: fn.blocks[0]!.instrs.map((instr) => {
                    if (mutation === "raw-store" && instr === store) return { ...instr, value: box.value };
                    if (mutation !== "raw-store" && instr.kind === "js.class.property.get")
                      return {
                        ...instr,
                        resultType:
                          mutation === "managed-read"
                            ? irSupportRef(f.domain.definitions[0]!.definition.roles.method, false)
                            : { kind: "dynamic" as const, tag: JS_TAG_IDS.NumberF64 },
                      };
                    return instr;
                  }),
                },
              ],
            },
      ),
    };
    const before = f.allocations.snapshot();
    expect(() => analyzeNativeJsClass(module, f.allocations, f.domain)).toThrow(
      mutation === "raw-store" ? "existing immutable JSValue" : "unrefined JSValue",
    );
    expect(f.allocations.snapshot()).toEqual(before);
    expect(inspectNativeJsClassNamespaces(module, before, f.domain)?.kind).not.toBe("representable");
    expect(verifyNativeJsClassEvidence(module, before, f.domain)?.kind).not.toBe("verified");
  },
);

/** Real mapped SourceFiles with an explicit constructor avoid the separate implicit-constructor projector gap. */
function mappedClassSource(policy: { backend: "wasmgc" | "linear"; target: "standalone" | "wasi" }) {
  const text = "class C{constructor(){}m():number{return 1;}}export function run():number{new C().m();return 7;}";
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    linearVectorProjection: "native-f64",
    deferTopLevelInit: false,
    sourceMap: {
      kind: "capture-source-map",
      sources: ast.sourceFiles.map((sourceFile) => ({
        sourceFile,
        projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
      })),
    },
  });
  if (source.kind !== "prepared") throw Error(JSON.stringify(source));
  const typed = captureTypedIrProgramInput(source);
  const restored = AllocSiteRegistry.restorePreparationData(typed.allocations, typed);
  const input = restored.data;
  const runtime = prepareIrProgramRuntimeCallables(input);
  if (runtime.kind !== "prepared") throw Error(JSON.stringify(runtime));
  const context = { ...input, abi: { entries: prepareIrProgramAbiEntries(input, runtime.declarations) } };
  const domain = nativeJsClassEvidenceDomainFromProgram(context, input.ir);
  if (!domain) throw Error("actual mapped class domain absent");
  return { input, domain, allocations: restored.allocations };
}
it.each([
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const)(
  "mapped allocation origins preserve exact DATA across independent registry copies $backend:$target",
  async (policy) => {
    const f = mappedClassSource(policy);
    expect(f.input.sourceMap).toBeDefined();
    expect(analyzeNativeJsClass(f.input.ir, f.allocations, f.domain)).toBe(true);
    const snapshot = f.allocations.snapshot();
    const detached = structuredClone(snapshot);
    expect(preparedIrDataMismatch(snapshot, detached)).toBeUndefined();
    const occurrences: IrInstr[] = [];
    for (const fn of f.input.ir.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (instruction) => {
            if (instruction.alloc !== undefined) occurrences.push(instruction);
          });
    expect(occurrences.length).toBeGreaterThan(0);
    for (const instruction of occurrences) {
      const entry = detached.entries.find((entry) => entry.state === "live" && entry.site.id === instruction.alloc);
      if (!entry || entry.state !== "live" || instruction.site?.origin?.kind !== "source")
        throw Error("actual mapped allocation missing");
      expect(entry.site.origin).not.toBe(instruction.site);
      expect(preparedIrDataMismatch(entry.site.origin, instruction.site)).toBeUndefined();
    }
    expect(analyzeNativeJsClass(f.input.ir, AllocSiteRegistry.fromSnapshot(detached), f.domain)).toBe(true);
    expect(inspectNativeJsClassNamespaces(f.input.ir, detached, f.domain)?.kind).toBe("representable");
    expect(verifyNativeJsClassEvidence(f.input.ir, detached, f.domain)?.kind).toBe("verified");
    for (const mutation of [
      "source",
      "donor",
      "analyzed",
      "original",
      "mapping",
      "line",
      "column",
      "missing",
      "generated",
    ] as const) {
      const changed = structuredClone(detached);
      const entry = changed.entries.find(
        (entry) => entry.state === "live" && entry.site.origin?.origin?.kind === "source",
      );
      if (!entry || entry.state !== "live" || entry.site.origin?.origin?.kind !== "source")
        throw Error("actual origin missing");
      const origin = entry.site.origin;
      if (origin.origin?.kind !== "source") throw Error("actual source origin missing");
      const point = origin.origin.point;
      if (typeof origin.line !== "number" || typeof origin.column !== "number")
        throw Error("actual mapped source coordinates missing");
      if (mutation === "source") Object.assign(point, { sourceId: `${point.sourceId}:foreign` });
      if (mutation === "donor") Object.assign(point, { donorUnitId: `${point.donorUnitId}:foreign` });
      if (mutation === "analyzed") Object.assign(point.analyzed, { start: point.analyzed.start + 1 });
      if (mutation === "original") Object.assign(point.original, { end: point.original.end + 1 });
      if (mutation === "mapping") Object.assign(point, { mapping: "rewrite" });
      if (mutation === "line") Object.assign(origin, { line: origin.line + 1 });
      if (mutation === "column") Object.assign(origin, { column: origin.column + 1 });
      if (mutation === "missing") Reflect.deleteProperty(entry.site, "origin");
      if (mutation === "generated")
        Object.assign(entry.site, {
          origin: {
            origin: {
              kind: "generated",
              phase: "middleend",
              role: "cfg-scaffold",
              ownerUnitId: point.donorUnitId,
              cause: point,
            },
          },
        });
      expect(preparedIrDataMismatch(snapshot, changed), mutation).not.toBeUndefined();
      const registry = AllocSiteRegistry.fromSnapshot(changed);
      const before = registry.snapshot();
      expect(() => analyzeNativeJsClass(f.input.ir, registry, f.domain), mutation).toThrow("source origin changed");
      expect(registry.snapshot()).toEqual(before);
      expect(inspectNativeJsClassNamespaces(f.input.ir, changed, f.domain)?.kind, mutation).toBe("invalid");
      expect(verifyNativeJsClassEvidence(f.input.ir, changed, f.domain)?.kind, mutation).toBe("invalid");
    }
    const getter = structuredClone(detached);
    const entry = getter.entries.find(
      (entry) => entry.state === "live" && entry.site.origin?.origin?.kind === "source",
    );
    if (!entry || entry.state !== "live" || entry.site.origin?.origin?.kind !== "source")
      throw Error("actual origin missing");
    let reads = 0;
    Object.defineProperty(entry.site.origin.origin.point, "sourceId", {
      enumerable: true,
      get() {
        reads++;
        return "foreign";
      },
    });
    expect(inspectNativeJsClassNamespaces(f.input.ir, getter, f.domain)?.kind).toBe("invalid");
    expect(verifyNativeJsClassEvidence(f.input.ir, getter, f.domain)?.kind).toBe("invalid");
    expect(() => AllocSiteRegistry.fromSnapshot(getter)).toThrow();
    expect(reads).toBe(0);
    const prototype = structuredClone(detached);
    const first = prototype.entries.find(
      (entry) => entry.state === "live" && entry.site.origin?.origin?.kind === "source",
    );
    if (!first || first.state !== "live" || first.site.origin?.origin?.kind !== "source")
      throw Error("actual origin missing");
    Object.setPrototypeOf(first.site.origin.origin.point, { foreign: true });
    expect(inspectNativeJsClassNamespaces(f.input.ir, prototype, f.domain)?.kind).toBe("invalid");
    expect(verifyNativeJsClassEvidence(f.input.ir, prototype, f.domain)?.kind).toBe("invalid");
    expect(() => AllocSiteRegistry.fromSnapshot(prototype)).toThrow();
    const full = prepareTypedIrProgram(f.input, {
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
    if (full.kind !== "prepared") throw Error(JSON.stringify(full));
    const bytes = encodePreparedIrProgram(full.program);
    expect(encodePreparedIrProgram(decodePreparedIrProgram(bytes))).toBe(bytes);
    await new Promise<void>((resolve) => setImmediate(resolve));
  },
);

// Let worker RPC updates flush between genuine synchronous preparation cases.
afterEach(() => yieldTestLoop());
