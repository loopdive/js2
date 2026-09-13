// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEmptyModule, type Instr, type ValType } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { forEachInstrDeep, type IrFunction } from "../src/ir/core/nodes.js";
import {
  deriveNativeVectorResourcePlan,
  type NativeVectorResourceInput,
} from "../src/ir/program/native-vector-resources.js";
import { collectVectorCallableDemands } from "../src/ir/runtime/vector-callables.js";
import { planPhysicalSetup, planNativeVectorResources } from "../src/ir/program-physical-plan.js";
import {
  reserveNativeVectorTypes,
  reserveNativeVectorHelper,
  fillNativeVectorHelper,
  resolveNativeVector,
  resolveNativeVectorForElement,
  nativeVectorPhysicalType,
  nativeVectorPhysicalSignature,
} from "../src/backend/wasmgc/resources/native-vectors.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
const options = {
  ...policy,
  sharedExceptionTag: false,
  utf8Storage: false,
  sourceMap: false,
  moduleName: "vector-resource-proof",
};
const sourceText = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
function census(functions: readonly IrFunction[]) {
  let calls = 0;
  for (const fn of functions)
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ])
      for (const root of buffer)
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "call") calls++;
        });
  return { owners: functions.length, calls };
}
function prepare(gvnMode: "off" | "on", replay: boolean) {
  const source = prepareIrProgramSources({
    ...sourceInput({ "./entry.ts": sourceText }),
    policy,
    promiseDelayProjection: "standalone-native",
    asyncFamilyProjection: "standalone-native",
  });
  if (source.kind !== "prepared") throw new Error(source.detail);
  expect(census(source.ir.functions)).toEqual({ owners: 5, calls: 22 });
  const packet = captureTypedIrProgramInput(source);
  const input = replay ? decodeTypedPacket(encodeTypedPacket(packet)) : packet;
  expect(input.allocations).toEqual(packet.allocations);
  const program = requireProgram(
    prepareTypedIrProgram(input, {
      ...typedOptions,
      policy,
      runtimePolicies: [policy],
      controls: { ...typedOptions.controls, gvnMode },
    }),
  );
  expect(census(program.ir.functions)).toEqual({ owners: 16, calls: 33 });
  const selected = replay ? decodePreparedIrProgram(encodePreparedIrProgram(program)) : program;
  const encoded = encodePreparedIrProgram(selected);
  const plan = planNativeVectorResources(selected, options, selected.runtime[0]!);
  expect(encodePreparedIrProgram(selected)).toBe(encoded);
  return { program: selected, plan };
}
let cached: ReturnType<typeof prepare> | undefined;
const prepared = () => (cached ??= prepare("off", false));

/** Isolated resource harness driven by the real complete-family plan, NOT whole-family execution. */
function reserve(shared = false, importOffset = false) {
  const { plan } = prepared();
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const tag = tx.reserveTag(
    "exception",
    { params: [{ kind: "externref" }], results: [] },
    shared ? { kind: "import", module: "env", name: "__exn" } : { kind: "defined", name: "__exn" },
  );
  const types = reserveNativeVectorTypes(tx, plan);
  if (importOffset) tx.reserveFunctionImport("kernel-offset", "control", "noop", { params: [], results: [] });
  const layout = resolveNativeVectorForElement(types, { kind: "externref" })!;
  const ref: ValType = { kind: "ref_null", typeIdx: layout.vecStructTypeIdx };
  const i32: ValType = { kind: "i32" },
    extern: ValType = { kind: "externref" };
  const make = tx.reserveFunction("harness:make", "make", { params: [i32], results: [ref] });
  const get = tx.reserveFunction("harness:get", "get", { params: [ref, i32], results: [extern] });
  const length = tx.reserveFunction("harness:length", "length", { params: [ref], results: [i32] });
  const capacity = tx.reserveFunction("harness:capacity", "capacity", { params: [ref], results: [i32] });
  const store = tx.reserveFunction("harness:store", "store", { params: [ref, i32, extern], results: [] });
  const helper = reserveNativeVectorHelper(tx, plan, types, tag)!;
  return { module, tx, tag, types, layout, make, get, length, capacity, store, helper };
}
function execute(shared = false, importOffset = false) {
  const state = reserve(shared, importOffset);
  const { module, tx, tag, layout, make, get, length, capacity, store, helper } = state;
  tx.freezeReservations();
  fillNativeVectorHelper(tx, helper);
  const data: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: layout.vecStructTypeIdx, fieldIdx: 1 },
  ];
  tx.fillFunction(make, {
    locals: [],
    body: [
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 0 },
      { op: "array.new_default", typeIdx: layout.arrayTypeIdx },
      { op: "struct.new", typeIdx: layout.vecStructTypeIdx },
    ],
  });
  tx.fillFunction(get, {
    locals: [],
    body: [...data, { op: "local.get", index: 1 }, { op: "array.get", typeIdx: layout.arrayTypeIdx }],
  });
  tx.fillFunction(length, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: layout.vecStructTypeIdx, fieldIdx: 0 },
    ],
  });
  tx.fillFunction(capacity, { locals: [], body: [...data, { op: "array.len" }] });
  tx.fillFunction(store, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: helper.function.handle },
    ],
  });
  for (const fn of [make, get, length, capacity, store])
    tx.defineExport(`export:${fn.object.name}`, fn.object.name, fn);
  tx.defineExport("export:exception", "exception", tag);
  tx.seal();
  const binary = emitBinary(module);
  expect(WebAssembly.validate(binary)).toBe(true);
  const externalTag = new WebAssembly.Tag({ parameters: ["externref"] });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), {
    env: { __exn: externalTag },
    control: { noop() {} },
  });
  const api = instance.exports as unknown as {
    make(capacity: number): unknown;
    get(vec: unknown, index: number): unknown;
    store(vec: unknown, index: number, value: unknown): void;
    length(vec: unknown): number;
    capacity(vec: unknown): number;
    exception: WebAssembly.Tag;
  };
  return { ...state, api, externalTag };
}

describe("native vector physical resource planning from the complete source family", () => {
  for (const mutation of ["foreign-id-and-feature", "missing-provider", "duplicate-provider"] as const)
    it(`pure derivation rejects ${mutation} independently of whole-program authentication`, () => {
      const { program, plan } = prepared();
      const manifest = program.runtime[0]!.prepared.manifest;
      const input: NativeVectorResourceInput = {
        anchor: plan.anchor,
        functions: program.ir.functions,
        abiEntries: program.abi.entries,
        policy: manifest.policy,
        providers: manifest.providers,
        backend: options.backend,
        target: options.target,
      };
      // Positive first: identical genuine inputs work through the pure boundary.
      expect(deriveNativeVectorResourcePlan(input)).toEqual(plan);
      const canonical = input.providers.find((provider) => provider.feature === "js.vector.elem-set.externref")!;
      expect(canonical.implementation).toMatchObject({
        kind: "runtime-callable",
        symbol: "__ir_vec_elem_set_externref",
      });
      const others = input.providers.filter((provider) => provider !== canonical);
      const providers =
        mutation === "missing-provider"
          ? others
          : mutation === "duplicate-provider"
            ? [...input.providers, canonical]
            : [...others, { ...canonical, id: "foreign.vector", feature: "async.native.delay" as const }];
      expect(() => deriveNativeVectorResourcePlan({ ...input, providers })).toThrow(
        "native vector resources: noncanonical selected vector provider",
      );
    });
  for (const gvn of ["off", "on"] as const)
    for (const replay of [false, true])
      it(`retains the complete population and located physical gaps, GVN=${gvn} replay=${replay}`, () => {
        const { program, plan } = prepare(gvn, replay);
        expect(plan.layouts).toEqual(["f64", "externref"]);
        expect(plan.demands).toEqual(collectVectorCallableDemands(program.ir.functions));
        expect(plan.demands.map((owner) => owner.unitId)).toEqual(program.ir.functions.map((fn) => fn.unitId));
        expect(plan.demands).toHaveLength(16);
        expect(plan.demands.some((owner) => owner.uses.length === 0)).toBe(true);
        expect(plan.demands.flatMap((owner) => owner.uses)).toHaveLength(1);
        expect(plan.exceptionRequired).toBe(true);
        expect(Object.isFrozen(plan)).toBe(true);
        expect(Object.isFrozen(plan.demands)).toBe(true);
        const refusal = planPhysicalSetup(program, options, program.runtime[0]!);
        expect(refusal.kind).toBe("unsupported");
        if (refusal.kind === "planned") throw new Error("whole-family physical execution unexpectedly admitted");
        expect(refusal.detail).toContain("scheduler/promise runtime materialization");
        expect(refusal.location.sourceId).toBeDefined();
        expect(program.allocations.size).toBeGreaterThan(0);
      });
});

describe("real reserved provider execution, separately from full-family acceptance", () => {
  for (const shared of [false, true])
    for (const offset of [false, true])
      it(`grows, preserves identities/nulls, and repeats stores; shared=${shared}, kernel import offset=${offset}`, () => {
        const { api, helper, tx, externalTag } = execute(shared, offset);
        const vec = api.make(0),
          first = { first: true },
          second = { second: true };
        expect(api.capacity(vec)).toBe(0);
        api.store(vec, 0, first);
        expect(api.capacity(vec)).toBe(4);
        expect(api.length(vec)).toBe(1);
        expect(api.get(vec, 0)).toBe(first);
        api.store(vec, 7, second);
        expect(api.capacity(vec)).toBe(8);
        expect(api.length(vec)).toBe(8);
        expect(api.get(vec, 0)).toBe(first);
        expect(api.get(vec, 7)).toBe(second);
        expect(api.get(vec, 3)).toBeNull();
        api.store(vec, 0, null);
        api.store(vec, 7, first);
        expect(api.get(vec, 0)).toBeNull();
        expect(api.get(vec, 7)).toBe(first);
        expect(api.length(vec)).toBe(8);
        expect(api.capacity(vec)).toBe(8);
        api.store(vec, 8, second);
        expect(api.capacity(vec)).toBe(16);
        expect(api.length(vec)).toBe(9);
        const other = api.make(10);
        api.store(other, 2, second);
        expect(api.length(other)).toBe(3);
        expect(api.capacity(other)).toBe(10);
        expect(api.get(other, 2)).toBe(second);
        expect(tx.physicalIndex(helper.function)).toBe(5 + Number(offset));
        expect(helper.function.handle).not.toBe(tx.physicalIndex(helper.function));
        if (shared) expect(api.exception).toBe(externalTag);
        let thrown: unknown;
        try {
          api.store(null, 0, first);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(WebAssembly.Exception);
        expect((thrown as WebAssembly.Exception).is(api.exception)).toBe(true);
        expect((thrown as WebAssembly.Exception).getArg(api.exception, 0)).toBeNull();
      });
});

describe("exact reservation descriptors, provenance and lifecycle", () => {
  it("shares one base and keeps nullable/non-null views without allocating lookup", () => {
    const { types, tx } = reserve();
    expect(types.layouts).toHaveLength(2);
    for (const row of types.layouts) {
      expect(row.carrier.object).toMatchObject({ superTypeIdx: types.base!.typeIndex });
      expect(Object.hasOwn(row.layout, "valueType")).toBe(false);
      for (const nullable of [false, true]) {
        const logical = { kind: "vec", elementType: { kind: "val", val: { kind: row.element } }, nullable } as const;
        const physical = nativeVectorPhysicalType(types, logical)!;
        expect(physical).toEqual({ kind: nullable ? "ref_null" : "ref", typeIdx: row.carrier.typeIndex });
        expect(resolveNativeVector(types, physical)).toBe(row.layout);
      }
    }
    expect(resolveNativeVectorForElement(types, { kind: "i32" })).toBeUndefined();
    expect(
      nativeVectorPhysicalSignature(types, {
        params: [{ kind: "vec", elementType: { kind: "val", val: { kind: "i32" } }, nullable: true }],
        results: [],
      }),
    ).toBeUndefined();
    expect(tx.state).toBe("reserving");
  });
  for (const mutation of [
    "element",
    "array-mutability",
    "field-mutability",
    "field-type",
    "supertype",
    "base",
  ] as const)
    it(`rejects exact ${mutation} descriptor corruption before building`, () => {
      const state = reserve(),
        row = state.types.layouts.find((row) => row.element === "externref")!;
      if (
        row.array.object.kind !== "array" ||
        row.carrier.object.kind !== "struct" ||
        state.types.base!.object.kind !== "struct"
      )
        throw new Error("missing descriptors");
      if (mutation === "element") row.array.object.element = { kind: "f64" };
      if (mutation === "array-mutability") row.array.object.mutable = false;
      if (mutation === "field-mutability") row.carrier.object.fields[1]!.mutable = false;
      if (mutation === "field-type") row.carrier.object.fields[1]!.type = { kind: "externref" };
      if (mutation === "supertype") row.carrier.object.superTypeIdx = row.array.typeIndex;
      if (mutation === "base") state.types.base!.object.fields[0]!.type = { kind: "f64" };
      expect(() => resolveNativeVectorForElement(state.types, { kind: "externref" })).toThrow(
        /native vector resources: .*descriptor mismatch/,
      );
    });
  it("rejects substituted type/helper wrapper objects", () => {
    const { types, helper, tx } = reserve();
    expect(() => resolveNativeVectorForElement({ ...types }, { kind: "externref" })).toThrow(
      "foreign vector type reservations",
    );
    tx.freezeReservations();
    expect(() => fillNativeVectorHelper(tx, { ...helper })).toThrow("foreign vector helper reservation");
  });
  it("rejects foreign transactions", () => {
    const left = reserve(),
      right = reserve();
    expect(() => reserveNativeVectorHelper(right.tx, prepared().plan, left.types, right.tag)).toThrow(
      "foreign vector type reservations",
    );
    right.tx.freezeReservations();
    expect(() => fillNativeVectorHelper(right.tx, left.helper)).toThrow("foreign vector helper reservation");
  });
  it("rejects duplicate reservation", () => {
    const { tx, types, tag } = reserve();
    expect(() => reserveNativeVectorHelper(tx, prepared().plan, types, tag)).toThrow(/duplicate/);
  });
  it("rejects duplicate fill", () => {
    const { tx, helper } = reserve();
    tx.freezeReservations();
    fillNativeVectorHelper(tx, helper);
    expect(() => fillNativeVectorHelper(tx, helper)).toThrow("duplicate function fill");
  });
  it("rejects missing fills and late allocation", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const tag = tx.reserveTag(
      "exception",
      { params: [{ kind: "externref" }], results: [] },
      { kind: "defined", name: "__exn" },
    );
    const types = reserveNativeVectorTypes(tx, prepared().plan);
    const helper = reserveNativeVectorHelper(tx, prepared().plan, types, tag)!;
    tx.freezeReservations();
    expect(() => tx.seal()).toThrow(`missing function fill ${helper.function.key}`);
    const late = reserve();
    late.tx.freezeReservations();
    expect(() => reserveNativeVectorTypes(late.tx, prepared().plan)).toThrow(/requires reserving/);
  });
  it("rejects post-fill mutation", () => {
    const { tx, helper } = reserve();
    tx.freezeReservations();
    fillNativeVectorHelper(tx, helper);
    helper.function.object.body.push({ op: "nop" });
    expect(() => tx.seal()).toThrow("altered completed function");
  });
  for (const kind of ["missing", "wrong-signature", "wrong-linkage", "foreign", "substituted"] as const)
    it(`rejects ${kind} exception resource`, () => {
      const tx = new PhysicalModuleReservations(createEmptyModule());
      const signature = {
        params: [{ kind: kind === "wrong-signature" ? "i32" : "externref" } as ValType],
        results: [],
      };
      const tag =
        kind === "missing"
          ? undefined
          : tx.reserveTag(
              "exception",
              signature,
              kind === "wrong-linkage"
                ? { kind: "import", module: "foreign", name: "__exn" }
                : { kind: "defined", name: "__exn" },
            );
      const types = reserveNativeVectorTypes(tx, prepared().plan);
      if (kind === "missing" || kind === "wrong-signature" || kind === "wrong-linkage") {
        expect(() => reserveNativeVectorHelper(tx, prepared().plan, types, tag)).toThrow(/exception tag/);
      } else {
        const foreign = new PhysicalModuleReservations(createEmptyModule());
        const foreignTag = foreign.reserveTag(
          "exception",
          { params: [{ kind: "externref" }], results: [] },
          { kind: "defined", name: "__exn" },
        );
        const token = kind === "foreign" ? foreignTag : { ...tag! };
        const helper = reserveNativeVectorHelper(tx, prepared().plan, types, token)!;
        tx.freezeReservations();
        expect(() => fillNativeVectorHelper(tx, helper)).toThrow(/foreign|substitut|owned/);
      }
    });
  it("rejects substituted exact helper token even when its descriptor is copied", () => {
    const { tx, helper, module } = reserve();
    module.functions[module.functions.indexOf(helper.function.object)] = { ...helper.function.object };
    expect(() => tx.freezeReservations()).toThrow(/substitut|population|order/);
  });
  it("does not admit a second provider or fabricated canonical declaration", () => {
    const { program } = prepared();
    const projection = program.runtime[0]!;
    const row = projection.prepared.manifest.providers.find(
      (provider) => provider.feature === "js.vector.elem-set.externref",
    )!;
    expect(row).toBeDefined();
    const duplicate = {
      ...projection,
      prepared: {
        ...projection.prepared,
        manifest: {
          ...projection.prepared.manifest,
          providers: [...projection.prepared.manifest.providers, row],
        },
      },
    };
    const forged = { ...program, runtime: [duplicate] };
    expect(() => planNativeVectorResources(forged, options, duplicate)).toThrow();
    const changed = {
      ...program,
      abi: {
        entries: program.abi.entries.map((entry) =>
          entry.plan.id === prepared().plan.helper!.bindingId && entry.contract.kind === "callable"
            ? { ...entry, contract: { ...entry.contract, results: [{ kind: "val", val: { kind: "i32" } }] } }
            : entry,
        ),
      },
    };
    expect(() => planNativeVectorResources(changed as typeof program, options, projection)).toThrow();
  });
});
