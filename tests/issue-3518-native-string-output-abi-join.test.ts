// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import type { PreparedIrProgram, PreparedIrAbiEntry } from "../src/ir/program/prepared-contracts.js";
import { asValueId, type IrInstr } from "../src/ir/core/nodes.js";
import { irIntrinsicFuncRef, irCallableBindingKey } from "../src/ir/core/callable-bindings.js";
import { IR_ASYNC_STRING_CONCAT_5_FN } from "../src/ir/core/async-callables.js";
import { irStringConcatManySymbol } from "../src/ir/core/string-callables.js";
import { STRING_CONCAT_MANY_RUNTIME_PROVIDERS } from "../src/ir/runtime/manifest.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { deriveNativeStringOutputRequirements } from "../src/ir/program/native-string-output-requirements.js";
import {
  preparedIrRuntimeAbiAnchor,
  preparedIrRuntimeCallableBindingId,
} from "../src/ir/program/runtime-abi-identity.js";
import { preparedIrCallableSignature } from "../src/ir/program/abi-signatures.js";
import { ProgramAbiMap } from "../src/ir/program/abi.js";
import { planNativeStringOutputResources } from "../src/backend/wasmgc/program/native-string-output.js";
import { nativeStringOutputAbiBindings } from "../src/backend/wasmgc/program/native-string-output-abi.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringOutputResources,
  fillNativeStringOutputResources,
  nativeStringOutputReservationInventory,
  requireCompletedNativeStringOutput,
} from "../src/backend/wasmgc/resources/native-string-output.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";

const string = { kind: "string" } as const;
const params = Array.from({ length: 5 }, () => string),
  results = [string];
const references = [
  irIntrinsicFuncRef(IR_ASYNC_STRING_CONCAT_5_FN),
  irIntrinsicFuncRef(irStringConcatManySymbol(5)),
] as const;
const refKey = (reference: (typeof references)[number]) => irCallableBindingKey(reference.binding);
const keys = { key: "join-output", stringKey: "join-strings", flattenKey: "join-flatten" };
let baseProgram: PreparedIrProgram | undefined;
function base() {
  return (baseProgram ??= requireProgram(prepareTypedIrProgram(sourcePacket().packet, typedOptions)));
}
function entry(reference = references[0], ordinal = 0): PreparedIrAbiEntry {
  const program = base(),
    anchor = preparedIrRuntimeAbiAnchor(program.inventory);
  const declarationOrder =
    1 +
    Math.max(
      0,
      ...program.abi.entries
        .filter((row) => row.plan.order.sourceOrder === anchor.order)
        .map((row) => row.plan.order.declarationOrder),
    );
  return {
    plan: {
      id: preparedIrRuntimeCallableBindingId(program.inventory, reference),
      order: { sourceOrder: anchor.order, declarationOrder: declarationOrder + ordinal },
      displayName: reference.name,
      structuralReferenceKey: refKey(reference),
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "intrinsic", signature: preparedIrCallableSignature(params, results) },
    },
    contract: { kind: "callable", ref: reference, params, results },
  };
}
function alias(source: PreparedIrAbiEntry, target: PreparedIrAbiEntry): PreparedIrAbiEntry {
  const { slotSpace: _slotSpace, ...plan } = source.plan;
  return { ...source, plan: { ...plan, slotPolicy: "alias", aliasOf: target.plan.id } } as PreparedIrAbiEntry;
}
// Complete data fixtures exercise the output ABI projection. Full prepared
// consumer acceptance is tested by its separate source-driven suite.
function fixture(order: readonly number[] = [0, 1], extras: readonly PreparedIrAbiEntry[] = []) {
  const program = base(),
    values = Array.from({ length: 5 }, (_, i) => asValueId(100 + i));
  const instructions: IrInstr[] = [
    ...values.map((result, i) => ({ kind: "string.const" as const, value: String(i), result, resultType: string })),
    ...order.map((ref, i) => ({
      kind: "call" as const,
      target: references[ref]!,
      args: values,
      result: asValueId(120 + i),
      resultType: string,
    })),
  ];
  const functions = program.ir.functions.map((fn, i) =>
    i ? fn : { ...fn, blocks: [{ ...fn.blocks[0]!, instrs: instructions }] },
  );
  const providers = STRING_CONCAT_MANY_RUNTIME_PROVIDERS.filter(
    (row) => row.implementation.kind === "runtime-callable-family",
  );
  const projection = {
    ...program.runtime[0]!,
    prepared: {
      ...program.runtime[0]!.prepared,
      functions,
      manifest: {
        ...program.runtime[0]!.prepared.manifest,
        policy: {
          backend: "wasmgc",
          target: "standalone",
          stringConst: { storage: "native" },
          stringConcat: { concat: "native" },
        },
        features: ["js.string.concat.many"],
        providers,
      },
    },
  } as PreparedIrProgram["runtime"][number];
  const data = {
    ...program,
    ir: { ...program.ir, functions },
    runtime: [projection],
    abi: { entries: [...program.abi.entries, ...extras] },
  };
  const demands = collectNativeStringValueDemands(data, projection),
    requirements = deriveNativeStringOutputRequirements(demands, { emptyIdentity: true });
  if ("kind" in requirements) throw Error(requirements.detail);
  const plan = planNativeStringOutputResources(requirements, keys);
  return { program: data, requirements, plan, extras };
}
const bind = (f: ReturnType<typeof fixture>) => nativeStringOutputAbiBindings(f.requirements, f.plan, 100);
function joined(f: ReturnType<typeof fixture>) {
  const bindings = bind(f);
  expect(new Set(bindings.map((row) => row.resourceKey))).toEqual(new Set(["join-output:batch:5"]));
  expect(new Set(bindings.map((row) => row.entry.id)).size).toBe(1);
  expect(bindings.every((row) => row.entry.slotPolicy === "required" && row.entry.slotSpace === "function")).toBe(true);
  return bindings;
}
function execute(f: ReturnType<typeof fixture>, utf8Storage: boolean) {
  const bindings = joined(f),
    module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const pieces = ["A", "é", "😀", "\ud800", "!"],
    expected = pieces.join("");
  const strings = reserveNativeStringLiteralResources(tx, {
    key: keys.stringKey,
    utf8Storage,
    literals: [{ value: "", encoding: "wtf16" }, { value: "undefined" }, ...pieces.map((value) => ({ value }))],
  });
  const flatten = reserveNativeStringFlattenResources(tx, keys.flattenKey, strings);
  const output = reserveNativeStringOutputResources(tx, f.requirements, f.plan, { strings, flatten });
  const inventory = nativeStringOutputReservationInventory(tx, output, f.plan);
  expect(output.batches.map((row) => row.arity)).toEqual([5]);
  const lookup = new Map(
    bindings.map((binding) => {
      const token = inventory.find((row) => row.key === binding.resourceKey);
      if (token?.kind !== "function") throw Error("real function reservation missing");
      return [refKey(binding.reference), token] as const;
    }),
  );
  expect(lookup.get(refKey(references[0]))).toBe(lookup.get(refKey(references[1])));
  const probes = references.map((_, i) =>
    tx.reserveFunction("probe:" + i, "probe_" + i, {
      params: [],
      results: Array.from({ length: expected.length + 1 }, () => ({ kind: "i32" })),
    }),
  );
  // This is the output part of the existing ABI map, not fabricated whole-program
  // completion: source-unit slots are owned by the separate consumer transaction.
  const abi = new ProgramAbiMap(f.program.inventory, f.program.derivedUnits),
    planned = new Set<string>();
  for (const plan of [...f.extras.map((row) => row.plan), ...bindings.map((row) => row.entry)])
    if (!planned.has(plan.id)) {
      abi.plan(plan);
      planned.add(plan.id);
    }
  abi.sealPlan();
  tx.freezeReservations();
  abi.bindFinalIndex(bindings[0]!.entry.id, {
    space: "function",
    index: tx.physicalIndex(output.batches[0]!.function),
  });
  abi.finishBinding();
  for (const extra of f.extras)
    expect(abi.resolveFinalIndex(extra.plan.id)).toEqual(abi.resolveFinalIndex(bindings[0]!.entry.id));
  fillNativeStringLiteralResources(tx, strings);
  fillNativeStringFlattenResources(tx, flatten);
  fillNativeStringOutputResources(tx, output);
  const l = strings.layout;
  probes.forEach((probe, i) => {
    const target = lookup.get(refKey(references[i]!));
    if (!target) throw Error("missing actual resolver reference");
    const body: Instr[] = pieces.flatMap((text) => {
      const binding = requireNativeStringLiteral(tx, strings, text);
      if (binding.kind !== "global") throw Error("bounded literal premise");
      return [{ op: "global.get", index: tx.physicalIndex(binding.global) }];
    });
    body.push(
      { op: "call", funcIdx: target.handle },
      { op: "call", funcIdx: flatten.flatten.handle },
      { op: "local.set", index: 0 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 0 },
    );
    for (let j = 0; j < expected.length; j++)
      body.push(
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 1 },
        { op: "i32.const", value: j },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: l.nativeStrDataTypeIdx },
      );
    tx.fillFunction(probe, {
      locals: [{ name: "flat", type: { kind: "ref_null", typeIdx: l.nativeStrTypeIdx } }],
      body,
    });
    tx.defineExport("probe-export:" + i, probe.object.name, probe);
  });
  expect(requireCompletedNativeStringOutput(tx, output)).toBe(output);
  const census = tx.seal();
  const bytes = Uint8Array.from(emitBinary(module)),
    compiled = new WebAssembly.Module(bytes);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  const observations = [];
  for (let instance = 0; instance < 2; instance++) {
    const exports = new WebAssembly.Instance(compiled).exports;
    for (let repetition = 0; repetition < 2; repetition++)
      for (const probe of probes) {
        const fn = exports[probe.object.name];
        if (typeof fn !== "function") throw Error("missing actual probe export");
        const value = fn();
        expect(value).toEqual([
          expected.length,
          ...Array.from({ length: expected.length }, (_, i) => expected.charCodeAt(i)),
        ]);
        observations.push({ instance, repetition, name: probe.object.name, value });
      }
  }
  const parent = resolve(import.meta.dirname, "..", ".tmp");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "native-output-abi-join-"));
  writeFileSync(resolve(directory, "module.wasm"), bytes);
  writeFileSync(
    resolve(directory, "evidence.json"),
    JSON.stringify(
      {
        scope: "actual output ABI/resource join; not full prepared-program emission",
        node: process.version,
        execArgv: process.execArgv,
        bindings,
        census,
        utf8Storage,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        wat: emitWat(module),
        observations,
      },
      null,
      2,
    ),
  );
}

describe("authenticated fixed/generic batch-five ABI join", () => {
  for (const order of [
    [0, 1],
    [1, 0],
  ])
    for (const utf8 of [false, true])
      it("executes both refs order=" + order + " utf8=" + utf8, () => {
        const f = fixture(order);
        expect(joined(f).map((row) => refKey(row.reference))).toEqual(order.map((i) => refKey(references[i]!)));
        execute(f, utf8);
      });
  for (const owner of [0, 1])
    for (const order of [
      [0, 1],
      [1, 0],
    ])
      it("preserves existing owner=" + owner + " order=" + order, () => {
        const required = entry(references[owner]!);
        const f = fixture(order, [required]);
        expect(joined(f).every((row) => row.entry === required.plan)).toBe(true);
        execute(f, false);
        expect(f.program.abi.entries.at(-1)).toBe(required);
      });
  for (const owner of [0, 1])
    it("retains the other declared canonical owner when only its peer occurs: " + owner, () => {
      const required = entry(references[owner]!);
      const f = fixture([1 - owner], [required]);
      const rows = joined(f);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.entry === required.plan)).toBe(true);
      execute(f, false);
    });
  for (const owner of [0, 1])
    for (const order of [
      [0, 1],
      [1, 0],
    ])
      it("preserves declared alias owner=" + owner + " order=" + order, () => {
        const required = entry(references[owner]!, 0),
          peer = alias(entry(references[1 - owner]!, 1), required);
        const f = fixture(order, [required, peer]);
        expect(joined(f).every((row) => row.entry === required.plan)).toBe(true);
        execute(f, true);
        expect(f.program.abi.entries.slice(-2)).toEqual([required, peer]);
      });
  for (const only of [0, 1])
    it("keeps single-reference identity " + only, () => {
      const f = fixture([only]),
        rows = joined(f);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entry.id).toBe(preparedIrRuntimeCallableBindingId(f.program.inventory, references[only]!));
    });
  it("deduplicates repeated uses without losing either resolver reference", () => {
    expect(joined(fixture([1, 0, 1, 0])).map((row) => refKey(row.reference))).toEqual([
      refKey(references[1]),
      refKey(references[0]),
    ]);
  });
  it("keeps two independent required roots a refusal", () => {
    joined(fixture([0, 1], [entry()]));
    expect(() => bind(fixture([0, 1], [entry(references[0], 0), entry(references[1], 1)]))).toThrow(
      "competing existing required owners",
    );
  });
  it("rejects an alias targeting an unrelated same-signature required root", () => {
    const required = entry();
    joined(fixture([0, 1], [required, alias(entry(references[1], 1), required)]));
    const unrelated = entry(irIntrinsicFuncRef("foreign.batch-five"), 2);
    expect(() => bind(fixture([0, 1], [unrelated, alias(entry(references[0], 0), unrelated)]))).toThrow(
      "unrelated required owner",
    );
  });
  for (const change of [
    "signature",
    "structural-ref",
    "contract-ref",
    "promise",
    "slotless",
    "missing-target",
    "alias-cycle",
  ] as const)
    it("rejects existing-owner corruption " + change + " after authentic positive", () => {
      const required = entry(),
        peer = alias(entry(references[1], 1), required);
      joined(fixture([0, 1], [required, peer]));
      const changed = structuredClone(required);
      let extras: PreparedIrAbiEntry[] = [changed, peer];
      if (change === "signature" && changed.contract.kind === "callable")
        (changed.contract.params as unknown[])[0] = { kind: "i32" };
      if (change === "structural-ref") Object.assign(changed.plan, { structuralReferenceKey: "wrong-reference" });
      if (change === "contract-ref" && changed.contract.kind === "callable")
        Object.assign(changed.contract, { ref: irIntrinsicFuncRef("foreign.batch-five") });
      if (change === "promise" && changed.contract.kind === "callable")
        Object.assign(changed.contract, { promise: undefined });
      if (change === "slotless") {
        const { slotSpace: _slotSpace, ...plan } = changed.plan;
        Object.assign(changed, { plan: { ...plan, slotPolicy: "none" } });
      }
      if (change === "missing-target") extras = [peer];
      if (change === "alias-cycle") extras = [alias(changed, peer), peer];
      expect(() => bind(fixture([0, 1], extras))).toThrow();
    });
  it("rejects copied requirements before creating bindings", () => {
    const f = fixture();
    joined(f);
    expect(() => nativeStringOutputAbiBindings({ ...f.requirements }, f.plan, 100)).toThrow();
  });
  it("rejects a contradictory physical batch signature", () => {
    const f = fixture();
    joined(f);
    const plan = structuredClone(f.plan),
      batch = plan.declarations.find((row) => row.role[1] === "batch");
    if (batch?.space !== "function") throw Error("batch premise");
    (batch.signature.params as unknown[])[0] = { kind: "i32" };
    expect(() => nativeStringOutputAbiBindings(f.requirements, plan, 100)).toThrow("carrier realization");
  });
});
