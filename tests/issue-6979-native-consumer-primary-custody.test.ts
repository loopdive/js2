// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
  acceptedPhysicalSetupPlan,
  emittedSupportFunctionReceipts,
} from "../src/ir/program-consumer.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { irUnitCallableBindingId } from "../src/ir/core/callable-bindings.js";
import { emitBinary } from "../src/emit/binary.js";
import { publicRealmFoundation, publicRealmClosures, publicRealmSourceSlots } from "./helpers/native-object-realm.js";
import { fillRealmLayoutFixture } from "./helpers/native-realm-object-layouts.js";
import {
  bindNativeSourceClosureUnits,
  fillPreparedPrimaryUnit,
  completeNativeRealmSourceClosureBodyCustody,
  completeNativeRealmSourceAllocationBodyCustody,
} from "../src/ir/program-native-invocation.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { createEmptyModule } from "../src/ir/types.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import * as physicalResources from "../src/wasm/physical/program-resources.js";

const SOURCE = `let offset = 3;
function adjust(value: number): number {
  if (value < 0) return 0;
  return value * 3 - 1 + offset;
}
function make(seed: number): (value: number) => number {
  const captured = seed * 2 + 3;
  return function add(value: number): number { return adjust(captured + value); };
}
export function run(seed: number): number { const closure = make(seed); return closure(7); }`;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await setImmediate();
});
function fixture(decoded = false, files: Record<string, string> = { "./entry.ts": SOURCE }) {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  const prepared = requireProgram(prepareWholeIrProgram(sourceInput(files)));
  const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(prepared)) : prepared;
  const accepted = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
  if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
  const plan = acceptedPhysicalSetupPlan(accepted);
  const helper = accepted.runtime.prepared.functions.find((fn) => fn.name === "adjust");
  if (!helper || !plan.sourceClosures?.units.length || !plan.sourceClosures.allocations.length)
    throw Error("missing real helper/source allocation population");
  expect(plan.functions.length).toBeGreaterThanOrEqual(4);
  // Keep a real runtime call: the single-block version was inlined, making
  // substitution of its unused physical slot an ineffective wrong-result probe.
  expect(helper.blocks.length).toBeGreaterThan(1);
  expect(plan.sourceClosures.units.some((row) => row.unitId === helper.unitId)).toBe(false);
  expect(plan.sourceClosures.allocations.some((row) => row.ownerUnitId === helper.unitId)).toBe(false);
  expect(plan.definedGlobals.length).toBeGreaterThan(0);
  return { program, accepted, plan, helper };
}

function execute(f: ReturnType<typeof fixture>) {
  const emitted = emitAcceptedIrProgram(f.accepted);
  expect(emitted.emittedUnitIds).toEqual(f.accepted.runtime.prepared.functions.map((fn) => fn.unitId));
  const wasm = new WebAssembly.Module(emitBinary(emitted.module) as BufferSource);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  for (const instance of [new WebAssembly.Instance(wasm), new WebAssembly.Instance(wasm)]) {
    const run = instance.exports.run as (seed: number) => number;
    expect(typeof run).toBe("function");
    for (const seed of [-2, 0, 1, 37]) expect(run(seed)).toBe((seed * 2 + 3 + 7) * 3 - 1 + 3);
  }
  expect(() => emittedSupportFunctionReceipts(emitted)).not.toThrow();
}

describe("genuine accepted-consumer primary dependency custody", () => {
  it("keeps returned definition data separate from private source completion expectations", () => {
    const f = publicRealmFoundation(),
      c = publicRealmClosures(f),
      s = publicRealmSourceSlots(f, c);
    f.tx.freezeReservations();
    bindNativeSourceClosureUnits(f.tx, c.source!, s.slots);
    fillRealmLayoutFixture(f);
    const unexpected = () => {
      throw Error("unexpected non-source dependency");
    };
    const resolver: IrLowerResolver = {
      resolveFunc: unexpected,
      resolveGlobal: unexpected,
      resolveType: unexpected,
      internFuncType(signature) {
        return f.tx.internFunctionType(signature.params, signature.results);
      },
    };
    expect(c.source!.requirements.units).toHaveLength(2);
    for (const row of c.source!.requirements.units) {
      const fn = f.projection.prepared.functions.find((candidate) => candidate.unitId === row.unitId)!;
      const slot = s.slots.get(row.unitId)!;
      const data = fillPreparedPrimaryUnit(f.tx, fn, slot, s.signatures.get(row.unitId)!, resolver, "wasmgc", c.source);
      expect(data.body).not.toBe(slot.object.body);
      data.body.splice(0, data.body.length, { op: "f64.const", value: 999 });
      data.locals.push({ name: "raw-return-data", type: { kind: "f64" } });
    }
    expect(completeNativeRealmSourceClosureBodyCustody(f.tx, c.source!, f.realm).completionScope).toBe(
      "realm-source-body-custody",
    );
    expect(() => completeNativeRealmSourceAllocationBodyCustody(f.tx, c.source!, f.realm)).toThrow(
      "allocation owner canonical lowering is incomplete",
    );
  });

  it("authenticates the actual ABI of explicit imported capability slots too", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const signature = { params: [{ kind: "f64" as const }], results: [{ kind: "f64" as const }] };
    const slot = tx.reserveFunctionImport("test-capability", "test-capability", "transform", signature);
    tx.freezeReservations();
    tx.assertFunctionSignature(slot, signature);
    expect(() => tx.assertFunctionSignature(slot, { params: [{ kind: "i32" }], results: signature.results })).toThrow(
      "noncanonical function signature",
    );
  });

  it("executes the real helper/factory/lifted graph in two zero-import instances", () => {
    execute(fixture());
  });
  it("executes genuine codec-replayed helper dependencies without an AST at emission", () => {
    execute(fixture(true));
  });
  it("executes a decoded imported-alias helper called inside the actual lifted body", () => {
    execute(
      fixture(true, {
        "./dep.ts":
          "var offset = 3; export function adjust(value: number): number { if (value < 0) return 0; return value * 3 - 1 + offset; }",
        "./entry.ts": `import { adjust as transform } from "./dep";
        function make(seed: number): (value: number) => number {
          const captured = seed * 2 + 3;
          return function add(value: number): number { return transform(captured + value); };
        }
        export function run(seed: number): number { const closure = make(seed); return closure(7); }`,
      }),
    );
  });

  it("observes the actual wrong helper result when only the new independent primary audit is removed", () => {
    const f = fixture(),
      original = PhysicalModuleReservations.prototype.fillFunction;
    const audit = vi.spyOn(physicalResources, "assertSynchronousPrimaryDefinitions").mockImplementation(() => {});
    let acceptedReceipt = false;
    vi.spyOn(PhysicalModuleReservations.prototype, "fillFunction").mockImplementation(function (slot, definition) {
      if (slot.key === irUnitCallableBindingId(f.helper.unitId)) {
        original.call(this, slot, { locals: [], body: [{ op: "f64.const", value: 999 }] });
        this.assertCompletedReservation(slot);
        acceptedReceipt = true;
      } else original.call(this, slot, definition);
    });
    const emitted = emitAcceptedIrProgram(f.accepted);
    expect(audit).toHaveBeenCalled();
    expect(acceptedReceipt).toBe(true);
    const wasm = new WebAssembly.Module(emitBinary(emitted.module) as BufferSource);
    expect(WebAssembly.Module.imports(wasm)).toEqual([]);
    const run = new WebAssembly.Instance(wasm).exports.run as (seed: number) => number;
    expect(run(5)).toBe(999);
    expect(run(5)).not.toBe((5 * 2 + 3 + 7) * 3 - 1 + 3);
  });

  for (const inPlace of [false, true])
    it(`refuses receipt-valid ${inPlace ? "in-place" : "replacement"} non-source helper output`, () => {
      const f = fixture(),
        original = PhysicalModuleReservations.prototype.fillFunction;
      let acceptedReceipt = false;
      const spy = vi
        .spyOn(PhysicalModuleReservations.prototype, "fillFunction")
        .mockImplementation(function (slot, definition) {
          if (slot.key === irUnitCallableBindingId(f.helper.unitId)) {
            const replacement = inPlace ? definition : structuredClone(definition);
            replacement.body.splice(0, replacement.body.length, { op: "f64.const", value: 999 });
            original.call(this, slot, replacement);
            this.assertCompletedReservation(slot);
            acceptedReceipt = true;
          } else original.call(this, slot, definition);
        });
      expect(() => emitAcceptedIrProgram(f.accepted)).toThrow("noncanonical function definition");
      spy.mockRestore();
      expect(acceptedReceipt).toBe(true);
    });

  it("refuses a receipt-valid scalar initializer replacement from the real accepted plan", () => {
    const f = fixture(),
      target = f.plan.definedGlobals[0]!,
      original = PhysicalModuleReservations.prototype.fillGlobal;
    expect(target.type.kind).toBe("f64");
    let acceptedReceipt = false;
    const spy = vi
      .spyOn(PhysicalModuleReservations.prototype, "fillGlobal")
      .mockImplementation(function (slot, definition) {
        if (slot.key === target.bindingId) {
          original.call(this, slot, [{ op: "f64.const", value: 999 }]);
          this.assertCompletedReservation(slot);
          acceptedReceipt = true;
        } else original.call(this, slot, definition);
      });
    expect(() => emitAcceptedIrProgram(f.accepted)).toThrow("noncanonical global initializer");
    spy.mockRestore();
    expect(acceptedReceipt).toBe(true);
  });
});
