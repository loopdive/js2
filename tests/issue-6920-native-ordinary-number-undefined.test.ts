// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program/validation.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { analyzeOrdinaryNumberUndefined } from "../src/ir/analysis/allocation-evidence/ordinary-number-undefined-producer.js";
import { inspectOrdinaryNumberUndefinedBodies } from "../src/ir/analysis/allocation-evidence/ordinary-number-undefined-body.js";
import { inspectOrdinaryNumberUndefinedNamespaces } from "../src/ir/analysis/allocation-evidence/ordinary-number-undefined-profile.js";
import { verifyOrdinaryNumberUndefinedEvidence } from "../src/ir/runtime/ordinary-number-undefined-profile.js";
import {
  issueNativeNumberUndefinedRepresentability,
  assertNativeNumberUndefinedLegalityCurrent,
  nativeNumberUndefinedInstructionIsAdmitted,
  nativeNumberUndefinedTypeIsAdmitted,
  nativeNumberUndefinedSignatureResultIsAdmitted,
} from "../src/ir/analysis/allocation-evidence/native-number-undefined-legality.js";
import type { NativeNumberUndefinedLogicalContext } from "../src/ir/analysis/allocation-evidence/native-number-undefined-legality.js";
import {
  assertNativeJsClassAllocations,
  nativeJsClassEvidenceDomainFromProgram,
} from "../src/ir/program/native-js-class-allocation-validation.js";
import { verifyNativeJsClassEvidence } from "../src/ir/runtime/native-js-class-profile.js";
import {
  planNativeNumberUndefinedPhysical,
  nativeNumberUndefinedLegality,
  nativeNumberUndefinedLowering,
  nativeNumberUndefinedSignatureResult,
  issueNativeNumberUndefinedSignatureUse,
  nativeNumberUndefinedPhysicalSignature,
} from "../src/ir/program-number-undefined-resources.js";

import * as numericFacade from "../src/backend/linear/program/native-number-undefined.js";
import * as numericLayout from "../src/backend/linear/program/native-number-undefined-layout.js";
import { JS_TAG_IDS as canonicalTagIds } from "../src/ir/core/js-value-tag-identities.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeNumberUndefinedGc,
  fillNativeNumberUndefinedGc,
  requireCompletedNativeNumberUndefinedGc,
  requireNativeNumberUndefinedGcSignatureCarrier,
  type NativeNumberUndefinedGcReservations,
} from "../src/backend/wasmgc/resources/native-number-undefined.js";
import { planPhysicalSetup } from "../src/ir/program-physical-plan.js";
import { irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import {
  planPreparedLinearMemory,
  reservePreparedLinearMemory,
  fillPreparedLinearMemory,
  requirePreparedLinearNumberUndefinedSignatureCarrier,
  requireCompletedPreparedLinearMemory,
  preparedLinearMemoryBindings,
  requirePreparedLinearNumberUndefinedBindings,
} from "../src/backend/linear/program/memory.js";

const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
const fixtures = [
  {
    name: "Number early completion",
    text: "function effect():void{return 4 as never;}export function run():number{return effect()===undefined?1:0;}",
    families: ["number-f64"],
  },
  {
    name: "mixed normal completion",
    text: "function effect(x:number):void{if(x)return 4 as never;return;}export function run():number{return effect(0)===undefined?1:0;}",
    families: ["number-f64", "undefined"],
  },
  {
    name: "forwarded completion",
    text: "function leaf():void{return 4 as never;}function effect():void{return leaf();}export function run():number{return effect()===undefined?1:0;}",
    families: ["number-f64"],
  },
] as const;
function ops(fn: IrFunction): IrInstr[] {
  const values: IrInstr[] = [];
  for (const block of fn.blocks)
    for (const instr of block.instrs) forEachInstrDeep(instr, (child) => values.push(child));
  return values;
}
function input(text: string, policy: (typeof policies)[number]) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
  });
  expect(source.kind).toBe("prepared");
  if (source.kind !== "prepared") throw Error(JSON.stringify(source));
  return captureTypedIrProgramInput(source);
}
function logical(text: string, policy: (typeof policies)[number]) {
  const captured = input(text, policy),
    module = structuredClone(captured.ir),
    registry = AllocSiteRegistry.fromSnapshot(captured.allocations);
  expect(analyzeOrdinaryNumberUndefined(module, registry, true)).toBe(true);
  const snapshot = registry.snapshot();
  expect(inspectOrdinaryNumberUndefinedNamespaces(module, snapshot)?.kind).toBe("representable");
  expect(verifyOrdinaryNumberUndefinedEvidence(module, snapshot)?.kind).toBe("verified");
  const fn = module.functions.find((fn) => fn.resultTypes.some((type) => type.kind === "dynamic"))!;
  const context: NativeNumberUndefinedLogicalContext = {
    original: module,
    selected: { ...module },
    registry: snapshot,
    function: fn,
    backend: policy.backend,
  };
  const proof = issueNativeNumberUndefinedRepresentability(context);
  expect(proof).toBeDefined();
  return { captured, module, registry, snapshot, fn, context, use: { proof: proof!, context } };
}
afterEach(() => setImmediate());
it.each(policies.flatMap((policy) => fixtures.map((fixture) => ({ policy, fixture }))))(
  "derives actual $fixture.name and source-free codec on $policy.backend:$policy.target",
  ({ policy, fixture }) => {
    const { captured, module, snapshot, fn, use } = logical(fixture.text, policy);
    const census = inspectOrdinaryNumberUndefinedBodies(module, snapshot)!;
    expect(census.calls.length).toBeGreaterThan(0);
    expect(census.functions.find((row) => row.fn === fn)!.normal).toMatchObject({
      completes: true,
      families: fixture.families,
    });
    expect(nativeNumberUndefinedSignatureResultIsAdmitted(use, fn, policy.backend, 0, fn.resultTypes[0]!)).toBe(true);
    for (const box of census.requirements.boxes) {
      const meta = snapshot.metadata.find((row) => row.id === box.allocationId)!;
      expect(meta.entries.find(([key]) => key === "ownership")?.[1]).toEqual({ state: "escaped", ops: ["escape"] });
      expect(meta.entries.find(([key]) => key === "escape")?.[1]).toEqual({
        classification: "returned",
        stackAllocatable: false,
      });
    }
    const prepared = prepareTypedIrProgram(captured, {
      policy,
      runtimePolicies: [policy],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: false,
      },
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
    expect(
      prepared.program.ir.functions
        .flatMap(ops)
        .filter((row) => row.kind === "call" && row.resultType?.kind === "dynamic").length,
    ).toBeGreaterThan(0);
    const encoded = encodePreparedIrProgram(prepared.program),
      decoded = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(decoded)).toBe(encoded);
    assertPreparedIrProgram(decoded);
    for (const projection of decoded.runtime) {
      const helper = projection.prepared.functions.find((body) => body.resultTypes[0]?.kind === "dynamic")!;
      const first = nativeNumberUndefinedLegality(decoded, projection, helper)!;
      const repeat = nativeNumberUndefinedLegality(decoded, projection, helper)!;
      expect(first).toBeDefined();
      expect(repeat).toBeDefined();
      expect(first.context.selected).not.toBe(repeat.context.selected);
      expect(first.context.selected.functions).toBe(repeat.context.selected.functions);
      expect(() =>
        assertNativeNumberUndefinedLegalityCurrent(
          { ...first, context: { ...first.context, selected: repeat.context.selected } },
          helper,
          policy.backend,
        ),
      ).not.toThrow();
      expect(() =>
        assertNativeNumberUndefinedLegalityCurrent(
          {
            ...first,
            context: {
              ...first.context,
              selected: { ...repeat.context.selected, functions: [...repeat.context.selected.functions] },
            },
          },
          helper,
          policy.backend,
        ),
      ).toThrow();
    }
    for (const view of [
      decoded.ir,
      ...decoded.runtime.map((r) => ({ ...decoded.ir, functions: r.prepared.functions })),
    ])
      expect(verifyOrdinaryNumberUndefinedEvidence(view, decoded.allocations)?.kind).toBe("verified");
  },
);
it.each(["ownership", "escape"] as const)("independently rejects returned box %s forgery", (namespace) => {
  const state = logical(fixtures[0].text, policies[0]);
  const snapshot = structuredClone(state.snapshot),
    box = inspectOrdinaryNumberUndefinedBodies(state.module, snapshot)!.requirements.boxes[0]!;
  const row = snapshot.metadata.find((row) => row.id === box.allocationId)!;
  const entries = row.entries as [string, unknown][];
  entries.find(([key]) => key === namespace)![1] =
    namespace === "ownership"
      ? { state: "owned", ops: [], stackCandidate: true }
      : { classification: "local", stackAllocatable: true };
  expect(inspectOrdinaryNumberUndefinedNamespaces(state.module, snapshot)?.kind).toBe("invalid");
});
it("keeps call-result type admission separate from physical instruction ownership", () => {
  const state = logical(fixtures[0].text, policies[0]),
    caller = state.module.functions.find((fn) => ops(fn).some((op) => op.kind === "call"))!;
  const call = ops(caller).find((op) => op.kind === "call")!,
    context = { ...state.context, function: caller };
  const use = { context, proof: issueNativeNumberUndefinedRepresentability(context)! };
  expect(nativeNumberUndefinedInstructionIsAdmitted(use, caller, "wasmgc", call)).toBe(false);
  expect(nativeNumberUndefinedTypeIsAdmitted(use, caller, "wasmgc", call, call.resultType!)).toBe(true);
  let reads = 0;
  const outsider = Object.create(null, {
    kind: {
      get() {
        reads++;
        throw Error("outsider");
      },
    },
  });
  expect(nativeNumberUndefinedTypeIsAdmitted(use, caller, "wasmgc", call, outsider)).toBe(false);
  expect(reads).toBe(0);
});
it("refuses copied proof and current signature mutation", () => {
  const state = logical(fixtures[0].text, policies[0]);
  expect(() =>
    assertNativeNumberUndefinedLegalityCurrent(
      { ...state.use, context: { ...state.context, selected: { ...state.context.selected } } },
      state.fn,
      "wasmgc",
    ),
  ).not.toThrow();
  expect(() =>
    assertNativeNumberUndefinedLegalityCurrent({ ...state.use, proof: { ...state.use.proof } }, state.fn, "wasmgc"),
  ).toThrow();
  const params = state.fn.resultTypes as unknown[];
  params[0] = { kind: "val", val: { kind: "f64" } };
  expect(() => assertNativeNumberUndefinedLegalityCurrent(state.use, state.fn, "wasmgc")).toThrow();
});
it("screens executable module DATA before reading a getter", () => {
  const captured = input(fixtures[0].text, policies[0]);
  let reads = 0;
  const module = structuredClone(captured.ir);
  Object.defineProperty(module, "functions", {
    get() {
      reads++;
      throw Error("getter");
    },
  });
  expect(inspectOrdinaryNumberUndefinedNamespaces(module, captured.allocations)?.kind).toBe("invalid");
  expect(reads).toBe(0);
});

// The existing complete class owner includes genuine ordinary helpers; mere op presence never delegates.
it.each(policies.filter((policy) => policy.backend === "wasmgc"))(
  "preserves full class ownership and rejects mixed forgeries on $backend:$target",
  (policy) => {
    const captured = input(
      "function effect():void{return 4 as never;}class C{m(){return effect();}}export function run():number{return new C().m()===undefined?1:0;}",
      policy,
    );
    const result = prepareTypedIrProgram(captured, {
      policy,
      runtimePolicies: [policy],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: false,
      },
    });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw Error(JSON.stringify(result));
    const program = result.program;
    expect(assertNativeJsClassAllocations(program)).toBe(true);
    expect(planNativeNumberUndefinedPhysical(program, program.runtime[0]!)).toBeUndefined();
    const module = structuredClone(program.ir);
    expect(() => inspectOrdinaryNumberUndefinedBodies(module, program.allocations)).toThrow();
    const domain = nativeJsClassEvidenceDomainFromProgram(program, module)!;
    expect(verifyNativeJsClassEvidence(module, program.allocations, domain)?.kind).toBe("verified");
    const forged = structuredClone(domain);
    const descriptor = forged.definitions[0]!.definition;
    Object.defineProperty(descriptor, "sourceClassId", { value: "forged-class-owner" });
    expect(verifyNativeJsClassEvidence(module, program.allocations, forged)?.kind).toBe("invalid");
    const ordinary = structuredClone(module);
    const helper = ordinary.functions.find((fn) => fn.name === "effect")!;
    const original = helper.blocks[0]!.instrs[0]!;
    Object.defineProperty(original, "kind", { value: "js.class.fake" });
    expect(verifyNativeJsClassEvidence(ordinary, program.allocations, domain)?.kind).toBe("invalid");
  },
);

it.each(
  policies
    .filter((policy) => policy.backend === "wasmgc")
    .flatMap((policy) => [
      {
        policy,
        name: "Boolean payload",
        text: "function effect():void{return true as never;}export function run():number{return effect()===undefined?1:0;}",
      },
      {
        policy,
        name: "global effect",
        text: "let count:number=0;function effect():void{count=count+1;return 4 as never;}export function run():number{effect();return count;}",
      },
    ]),
)("keeps declined $name annotation on genuine generic GC $policy.target", ({ policy, text }) => {
  const captured = input(text, policy);
  const result = prepareTypedIrProgram(captured, {
    policy,
    runtimePolicies: [policy],
    controls: {
      gvnMode: "off",
      ownership: false,
      escape: false,
      verifyIntermediateAllocations: true,
      verifyDominanceNaive: false,
    },
  });
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  expect(verifyOrdinaryNumberUndefinedEvidence(result.program.ir, result.program.allocations)?.kind).toBe(
    "not-covered",
  );
  assertPreparedIrProgram(result.program);
  const encoded = encodePreparedIrProgram(result.program);
  expect(encodePreparedIrProgram(decodePreparedIrProgram(encoded))).toBe(encoded);
  // The generic typed path is not a carrier or native physical grant.
  expect(() => planNativeNumberUndefinedPhysical(result.program, result.program.runtime[0]!)).toThrow();
});

function gcReservation(key = "signature") {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  tx.reserveType(key + ":prefix", { kind: "func", params: [], results: [] });
  const pack = reserveNativeNumberUndefinedGc(tx, key);
  return { module, tx, pack };
}
it("reserves an actual nonzero GC carrier without claiming unfilled completion", () => {
  const { tx, pack } = gcReservation();
  expect(pack.carrier.typeIndex).toBeGreaterThan(0);
  expect(requireNativeNumberUndefinedGcSignatureCarrier(tx, pack)).toEqual({
    kind: "ref_null",
    typeIdx: pack.carrier.typeIndex,
  });
  tx.reserveFunction("actual-result", "actual-result", {
    params: [],
    results: [requireNativeNumberUndefinedGcSignatureCarrier(tx, pack)],
  });
  tx.freezeReservations();
  expect(() => requireCompletedNativeNumberUndefinedGc(tx, pack)).toThrow("missing global fill");
});
it("maps the same completed GC reservation after filling and refuses sealed phase", () => {
  const { tx, pack } = gcReservation();
  const reserved = requireNativeNumberUndefinedGcSignatureCarrier(tx, pack);
  tx.freezeReservations();
  fillNativeNumberUndefinedGc(tx, pack);
  requireCompletedNativeNumberUndefinedGc(tx, pack);
  expect(requireNativeNumberUndefinedGcSignatureCarrier(tx, pack)).toEqual(reserved);
  tx.seal();
  expect(() => requireNativeNumberUndefinedGcSignatureCarrier(tx, pack)).toThrow();
});
it("does not observe copied pack getters or accept a fake/no-op transaction", () => {
  const { tx, pack } = gcReservation();
  let reads = 0;
  const fake = {
    get carrier() {
      reads++;
      return pack.carrier;
    },
  } as NativeNumberUndefinedGcReservations;
  expect(() => requireNativeNumberUndefinedGcSignatureCarrier(tx, fake)).toThrow();
  expect(reads).toBe(0);
  expect(() => requireNativeNumberUndefinedGcSignatureCarrier(tx, { ...pack })).toThrow();
  expect(() =>
    requireNativeNumberUndefinedGcSignatureCarrier(new PhysicalModuleReservations(createEmptyModule()), pack),
  ).toThrow();
  const nope = {
    reserveType() {
      throw Error("must not dispatch");
    },
    reserveGlobal() {
      throw Error("must not dispatch");
    },
  };
  expect(() => reserveNativeNumberUndefinedGc(nope as unknown as PhysicalModuleReservations, "fake")).toThrow();
});
it("uses captured canonical GC issuance instead of overridden reservation getters", () => {
  const tx = new PhysicalModuleReservations(createEmptyModule());
  let reads = 0;
  Object.defineProperty(tx, "reserveType", {
    get() {
      reads++;
      throw Error("outsider callback");
    },
  });
  Object.defineProperty(tx, "reserveGlobal", {
    get() {
      reads++;
      throw Error("outsider callback");
    },
  });
  Object.defineProperty(tx, "state", {
    get() {
      reads++;
      throw Error("outsider phase");
    },
  });
  const pack = reserveNativeNumberUndefinedGc(tx, "canonical");
  expect(requireNativeNumberUndefinedGcSignatureCarrier(tx, pack).kind).toBe("ref_null");
  expect(reads).toBe(0);
});
it.each(["initializer", "type", "global", "failed"] as const)(
  "refuses changed GC %s before signature issuance",
  (mode) => {
    const { tx, pack } = gcReservation();
    if (mode === "initializer") pack.singleton.object.init.push({ op: "i32.const", value: 0 });
    if (mode === "type" && pack.carrier.object.kind === "struct") pack.carrier.object.fields[0]!.name = "forged";
    if (mode === "global") pack.singleton.object.type = { kind: "i32" };
    if (mode === "failed") expect(() => tx.assertReservationKeysAvailable([pack.carrier.key])).toThrow();
    expect(() => requireNativeNumberUndefinedGcSignatureCarrier(tx, pack)).toThrow();
  },
);
function physicalOrdinary(policy: (typeof policies)[number]) {
  const result = prepareTypedIrProgram(input(fixtures[0]!.text, policy), {
    policy,
    runtimePolicies: [policy],
    controls: {
      gvnMode: "off",
      ownership: true,
      escape: true,
      verifyIntermediateAllocations: true,
      verifyDominanceNaive: false,
    },
  });
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const program = result.program,
    projection = program.runtime[0]!;
  const options = {
    ...policy,
    moduleName: "signature",
    sourceMap: false,
    utf8Storage: false,
    sharedExceptionTag: false,
  };
  return { program, projection, options };
}
it("binds exact current ordinary result slots; copied token/slot/getters cannot grant signatures", () => {
  const { program, projection, options } = physicalOrdinary(policies[0]);
  const planned = planPhysicalSetup(program, options, projection);
  expect(planned.kind).toBe("planned");
  if (planned.kind !== "planned") throw Error(JSON.stringify(planned));
  const { tx, pack } = gcReservation();
  const token = issueNativeNumberUndefinedSignatureUse(program, projection, planned.plan.functions, tx, pack)!;
  expect(token).toBeDefined();
  const slot = planned.plan.functions.find((s) => s.results.some((t) => t.kind === "dynamic"))!;
  const fn = projection.prepared.functions.find((f) => f.unitId === slot.unitId)!;
  expect(nativeNumberUndefinedSignatureResult(program, projection, fn, 0)).toBe(true);
  expect(nativeNumberUndefinedSignatureResult(program, projection, fn, -1)).toBe(false);
  const mapped = nativeNumberUndefinedPhysicalSignature(token, slot)!;
  expect(mapped.results).toEqual([requireNativeNumberUndefinedGcSignatureCarrier(tx, pack)]);
  expect(nativeNumberUndefinedPhysicalSignature(token, { ...slot })).toBeUndefined();
  let reads = 0;
  const outsider = {
    get results() {
      reads++;
      throw Error("outsider");
    },
  };
  expect(nativeNumberUndefinedPhysicalSignature(token, outsider)).toBeUndefined();
  expect(reads).toBe(0);
  const fakeGc = {
    get carrier(): NativeNumberUndefinedGcReservations["carrier"] {
      reads++;
      throw Error("outsider GC");
    },
  } as NativeNumberUndefinedGcReservations;
  expect(() => nativeNumberUndefinedLowering(program, projection, fn, tx, () => {}, fakeGc)).toThrow();
  expect(reads).toBe(0);
  expect(() => nativeNumberUndefinedPhysicalSignature({ ...token }, slot)).toThrow("unissued");
  expect(() =>
    issueNativeNumberUndefinedSignatureUse(program, { ...projection }, planned.plan.functions, tx, pack),
  ).toThrow();
  expect(() =>
    issueNativeNumberUndefinedSignatureUse(program, projection, planned.plan.functions.slice(1), tx, pack),
  ).toThrow("census");
  expect(() => issueNativeNumberUndefinedSignatureUse(program, projection, planned.plan.functions, tx)).toThrow(
    "reservation",
  );
  const wrong = planned.plan.functions.map((s) =>
    s === slot
      ? { ...s, bindingId: irUnitCallableBindingId(projection.prepared.functions.find((f) => f !== fn)!.unitId) }
      : s,
  );
  expect(() => issueNativeNumberUndefinedSignatureUse(program, projection, wrong, tx, pack)).toThrow("slot");
  const parameterDrift = planned.plan.functions.map((s) =>
    s === slot ? { ...s, params: [{ kind: "dynamic" as const }] } : s,
  );
  expect(() => issueNativeNumberUndefinedSignatureUse(program, projection, parameterDrift, tx, pack)).toThrow("slot");
  const mutableSlots = structuredClone(planned.plan.functions);
  const mutableToken = issueNativeNumberUndefinedSignatureUse(program, projection, mutableSlots, tx, pack)!;
  const mutableSlot = mutableSlots.find((s) => s.unitId === slot.unitId)!;
  Object.defineProperty(mutableSlot, "results", {
    get() {
      reads++;
      throw Error("stale getter");
    },
  });
  expect(() => nativeNumberUndefinedPhysicalSignature(mutableToken, mutableSlot)).toThrow();
  expect(reads).toBe(0);
  const missing = {
    ...program,
    abi: {
      ...program.abi,
      entries: program.abi.entries.filter((row) => row.plan.id !== planned.plan.numberUndefined!.singletonBindingId),
    },
  };
  expect(() => nativeNumberUndefinedSignatureResult(missing, projection, fn, 0)).toThrow("carrier ABI");
  expect(() => issueNativeNumberUndefinedSignatureUse(missing, projection, planned.plan.functions, tx, pack)).toThrow(
    "carrier ABI",
  );
  tx.freezeReservations();
  fillNativeNumberUndefinedGc(tx, pack);
  expect(nativeNumberUndefinedPhysicalSignature(token, slot)).toEqual(mapped);
});
it("refuses public dynamic transport rather than inferring scalar export readiness", () => {
  const policy = policies[0];
  const result = prepareTypedIrProgram(input("export function run():void{return 4 as never;}", policy), {
    policy,
    runtimePolicies: [policy],
    controls: {
      gvnMode: "off",
      ownership: true,
      escape: true,
      verifyIntermediateAllocations: true,
      verifyDominanceNaive: false,
    },
  });
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const p = result.program,
    v = p.runtime[0]!,
    fn = v.prepared.functions.find((f) => f.resultTypes[0]?.kind === "dynamic")!;
  expect(() => nativeNumberUndefinedSignatureResult(p, v, fn, 0)).toThrow("public dynamic");
});
it("authenticates a real once-reserved Linear pack before and after filling", () => {
  expect(numericFacade.requirePreparedLinearNumberUndefinedSignatureCarrier).toBe(
    requirePreparedLinearNumberUndefinedSignatureCarrier,
  );
  expect(numericFacade.requirePreparedLinearNumberUndefinedBindings).toBe(requirePreparedLinearNumberUndefinedBindings);
  expect(numericFacade.describeNativeNumberUndefinedMemory).toBe(numericLayout.describeNativeNumberUndefinedMemory);
  expect(numericFacade.requireNativeNumberUndefinedBoxLayout).toBe(numericLayout.requireNativeNumberUndefinedBoxLayout);
  expect(numericLayout.JS_TAG_IDS).toBe(canonicalTagIds);

  const { program, projection, options } = physicalOrdinary(policies[2]);
  const planned = planPreparedLinearMemory({ program, projection, options });
  expect(planned.kind).toBe("supported");
  if (planned.kind !== "supported") throw Error(JSON.stringify(planned));
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const pack = reservePreparedLinearMemory(
    tx,
    planned.plan,
    () => {},
    (data) => {
      expect(module.dataSegments.length).toBe(data ? 1 : 0);
      if (data) expect(module.dataSegments[0]).toBe(data.object);
    },
  );
  expect(requirePreparedLinearNumberUndefinedSignatureCarrier(tx, pack)).toEqual({ kind: "i32" });
  expect(() => requirePreparedLinearNumberUndefinedSignatureCarrier(tx, { ...pack })).toThrow("unissued");
  expect(() => reservePreparedLinearMemory(tx, planned.plan, () => {})).toThrow("consumed");
  let reads = 0;
  const outsider = {
    get kind(): "prepared-linear-memory-reservations" {
      reads++;
      throw Error("outsider");
    },
  } as Parameters<typeof requirePreparedLinearNumberUndefinedSignatureCarrier>[1];
  expect(() => requirePreparedLinearNumberUndefinedSignatureCarrier(tx, outsider)).toThrow("unissued");
  expect(reads).toBe(0);
  tx.freezeReservations();
  const bindings = preparedLinearMemoryBindings(tx, pack).numberUndefined!;
  fillPreparedLinearMemory(tx, pack);
  requireCompletedPreparedLinearMemory(tx, pack);
  requirePreparedLinearNumberUndefinedBindings(tx, bindings);
  expect(() => requirePreparedLinearNumberUndefinedBindings(tx, { ...bindings })).toThrow("unissued");
  const fakeBindings = {
    ...bindings,
    get assertCurrent(): () => void {
      reads++;
      throw Error("outsider callback");
    },
  };
  expect(() => requirePreparedLinearNumberUndefinedBindings(tx, fakeBindings)).toThrow("unissued");
  expect(reads).toBe(0);
  expect(requirePreparedLinearNumberUndefinedSignatureCarrier(tx, pack)).toEqual({ kind: "i32" });
});
