// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { indexPhysicalTypes } from "../src/wasm/physical/type-layout.js";
import { reserveNativeStringLiteralTypes } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { deriveNativeValueResourcePlan } from "../src/ir/program/native-value-resources.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import {
  planNativeStringValuePhysical,
  reserveNativeStringValueResources,
  fillNativeStringValueResources,
  nativeStringValueReservationInventory,
  requireCompletedNativeStringValues,
  emitPreparedNativeStringLiteral,
} from "../src/backend/wasmgc/program/native-string-values.js";

const policy = {
  target: "standalone",
  backend: "wasmgc",
  stringConst: { storage: "native" },
  numberBoundary: { box: "unsupported", unbox: "native" },
} as const;
function prepared(value = " 42 ", numeric = true, replay = false) {
  const source = prepareIrProgramSources({
    ...sourceInput({
      "./entry.ts": numeric
        ? `function parse(s: string): number { return +s; } export function run(): number { return parse(${JSON.stringify(value)}); }`
        : `export function run(): string { return ${JSON.stringify(value)}; }`,
    }),
    policy,
    nativeStringValueProjection: "standalone-native",
  });
  if (source.kind !== "prepared") throw new Error(source.detail);
  const original = requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(source), { ...typedOptions, policy, runtimePolicies: [policy] }),
  );
  const program = replay ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
  const demands = collectNativeStringValueDemands(program, program.runtime[0]!);
  return { program, demands };
}
function setup(value = " 42 ", numeric = true, utf8Storage = false, replay = false) {
  const { program, demands } = prepared(value, numeric, replay);
  const outcome = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage });
  if (outcome.kind !== "planned") throw new Error("expected planned source: " + outcome.kind);
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const types = reserveNativeStringLiteralTypes(tx, outcome.plan.key, utf8Storage);
  const input = {
    demands,
    plan: outcome.plan,
    ...(numeric
      ? {
          valueRequirements: deriveNativeValueResourcePlan(program, program.runtime[0]!, "native-string"),
        }
      : {}),
  };
  const pack = reserveNativeStringValueResources(tx, input, types);
  return { module, tx, pack, input, types };
}
function literalArgs(s: ReturnType<typeof setup>) {
  const demand = s.input.demands.literals[s.input.plan.literalUses[0]!.demandIndex]!;
  if (demand.kind !== "string.const") throw new Error("expected string demand");
  const occurrence = s.input.demands.occurrences[demand.occurrence]!;
  const owner = s.input.demands.buffers[occurrence.bufferIndex]!.ownerUnitId;
  const i = demand.instruction;
  return [owner, i.value, i.alloc, i.storage, i.materializer] as const;
}
describe("real producer joins, not program-consumer acceptance", () => {
  it.each(["global-header", "function-type", "interned-signature"] as const)(
    "reauthenticates actual pre-freeze module contents after %s mutation",
    (mutation) => {
      const s = setup();
      const rows = nativeStringValueReservationInventory(s.tx, s.pack);
      expect(rows.length).toBeGreaterThan(0);
      const before = structuredClone(s.module);
      expect(nativeStringValueReservationInventory(s.tx, s.pack)).toBe(rows);
      expect(s.module).toStrictEqual(before);
      expect(s.tx.state).toBe("reserving");
      if (mutation === "global-header") {
        const row = rows.find((row) => row.space === "global");
        if (!row || row.space !== "global") throw new Error("expected actual global");
        row.reservation.object.mutable = !row.reservation.object.mutable;
      } else if (mutation === "function-type") {
        s.pack.number!.scanner.toNumber.object.typeIdx = s.pack.strings.layout.anyStrTypeIdx;
      } else {
        const scanner = s.pack.number!.scanner.toNumber.object;
        const definition = indexPhysicalTypes(s.module.types).entries[scanner.typeIdx]!.definition;
        if (definition.kind !== "func") throw new Error("expected actual scanner signature");
        definition.results[0] = { kind: "i32" };
      }
      expect(() => nativeStringValueReservationInventory(s.tx, s.pack)).toThrow(/altered/);
    },
  );
  for (const utf8 of [false, true])
    for (const replay of [false, true])
      it(`executes the selected chain with exact resources, utf8=${utf8}, decoded=${replay}`, () => {
        const s = setup(" 42 ", true, utf8, replay);
        expect(s.input.plan.mode).toBe("number-boundary");
        expect(s.pack.number).toBeDefined();
        const rows = nativeStringValueReservationInventory(s.tx, s.pack);
        expect(new Set(rows.map((row) => row.reservation)).size).toBe(rows.length);
        expect(rows.map((row) => ({ key: row.key, space: row.space }))).toEqual(
          s.input.plan.declarations.map((row) => ({ key: row.key, space: row.space })),
        );
        const probe = s.tx.reserveFunction("probe", "probe", { params: [], results: [{ kind: "f64" }] });
        s.tx.freezeReservations();
        expect(() => requireCompletedNativeStringValues(s.tx, s.pack)).toThrow(/incomplete/);
        fillNativeStringValueResources(s.tx, s.pack);
        const body = emitPreparedNativeStringLiteral(s.tx, s.pack, ...literalArgs(s));
        s.tx.fillFunction(probe, {
          locals: [],
          body: [
            ...body,
            { op: "extern.convert_any" },
            { op: "call", funcIdx: s.tx.physicalIndex(s.pack.number!.values.functions.unboxNumber) },
          ],
        });
        s.tx.defineExport("export:probe", "probe", probe);
        s.tx.seal();
        expect(requireCompletedNativeStringValues(s.tx, s.pack)).toBe(s.pack);
        const compiled = new WebAssembly.Module(emitBinary(s.module) as BufferSource);
        expect(WebAssembly.Module.imports(compiled)).toEqual([]);
        for (let instance = 0; instance < 2; instance++) {
          const run = new WebAssembly.Instance(compiled, {}).exports.probe as () => number;
          expect([run(), run()]).toEqual([42, 42]);
        }
      });
  it("retains every internal oversized chunk and rejects unplanned emitter tuples", () => {
    const s = setup("x".repeat(20001), false);
    const rows = nativeStringValueReservationInventory(s.tx, s.pack);
    expect(rows.filter((row) => row.space === "global")).toHaveLength(2);
    expect(rows.filter((row) => row.space === "function")).toHaveLength(1);
    expect(s.pack.number).toBeUndefined();
    s.tx.freezeReservations();
    fillNativeStringValueResources(s.tx, s.pack);
    expect(emitPreparedNativeStringLiteral(s.tx, s.pack, ...literalArgs(s))[0]!.op).toBe("call");
    const args = literalArgs(s);
    expect(() => emitPreparedNativeStringLiteral(s.tx, s.pack, args[0], "not planned")).toThrow(/closed projection/);
    const internal = rows.find((row) => row.space === "global")!;
    if (internal.space !== "global") throw new Error("expected global");
    internal.reservation.object.init = [];
    expect(() => requireCompletedNativeStringValues(s.tx, s.pack)).toThrow(/altered/);
  });
  it("rejects copied/foreign packs after a genuine fill", () => {
    const s = setup("hello", false);
    s.tx.freezeReservations();
    fillNativeStringValueResources(s.tx, s.pack);
    expect(requireCompletedNativeStringValues(s.tx, s.pack)).toBe(s.pack);
    expect(() => nativeStringValueReservationInventory(s.tx, { ...s.pack })).toThrow(/copied/);
    expect(() =>
      nativeStringValueReservationInventory(new PhysicalModuleReservations(createEmptyModule()), s.pack),
    ).toThrow(/foreign/);
  });
  it("rejects a mismatched plan before consuming types", () => {
    const { demands } = prepared("hello", false);
    const outcome = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage: false });
    if (outcome.kind !== "planned") throw new Error("expected plan");
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const types = reserveNativeStringLiteralTypes(tx, outcome.plan.key, false);
    const before = structuredClone(module);
    expect(() =>
      reserveNativeStringValueResources(tx, { demands, plan: { ...outcome.plan, literalUses: [] } }, types),
    ).toThrow(/mismatch/);
    expect(module).toStrictEqual(before);
    expect(reserveNativeStringValueResources(tx, { demands, plan: outcome.plan }, types).strings.types).toBe(
      types.types,
    );
  });
  it.each(["missing", "extra", "reordered", "shape", "step-order"] as const)(
    "rejects %s declarations before consuming types",
    (mutation) => {
      const { demands } = prepared("hello", false);
      const outcome = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage: false });
      if (outcome.kind !== "planned") throw new Error("expected plan");
      const plan = structuredClone(outcome.plan);
      const declarations = [...plan.declarations];
      const steps = [...plan.reservationSteps];
      if (mutation === "missing") declarations.pop();
      if (mutation === "extra") declarations.push(declarations[0]!);
      if (mutation === "reordered") declarations.reverse();
      if (mutation === "shape") {
        const index = declarations.findIndex((row) => row.space === "global");
        const row = declarations[index]!;
        if (row.space !== "global") throw new Error("expected global declaration");
        declarations[index] = { ...row, mutable: !row.mutable };
      }
      if (mutation === "step-order") steps.reverse();
      const module = createEmptyModule();
      const tx = new PhysicalModuleReservations(module);
      const types = reserveNativeStringLiteralTypes(tx, plan.key, false);
      const before = structuredClone(module);
      expect(() =>
        reserveNativeStringValueResources(
          tx,
          { demands, plan: { ...plan, declarations, reservationSteps: steps } },
          types,
        ),
      ).toThrow(/mismatch/);
      expect(module).toStrictEqual(before);
      expect(reserveNativeStringValueResources(tx, { demands, plan: outcome.plan }, types).strings.types).toBe(
        types.types,
      );
    },
  );
});
