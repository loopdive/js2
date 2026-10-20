// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  publicRealmFoundation,
  publicRealmClosures,
  publicRealmSourceSlots,
  publicRealmSourceRuntime,
} from "./helpers/native-object-realm.js";
import { fillRealmLayoutFixture } from "./helpers/native-realm-object-layouts.js";
import {
  bindNativeSourceClosureUnits,
  fillPreparedPrimaryUnit,
  completeNativeRealmSourceClosureBodyCustody,
  completeNativeRealmSourceAllocationBodyCustody,
  requireNativeRealmSourceAllocationBodyCustody,
} from "../src/ir/program-native-invocation.js";
import { deriveNativeRealmRequirements } from "../src/ir/program/native-realm-requirements.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import type { PhysicalFunctionSignature } from "../src/wasm/physical/module-reservations.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import type { ValType } from "../src/wasm/model/instructions.js";
import { walkInstructions } from "../src/wasm/model/instruction-walk.js";
import { createEmptyModule } from "../src/ir/types.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});

function fixture(displaced: boolean, decoded: boolean, option?: "omit-factory" | "wrong-abi") {
  const f = publicRealmFoundation(displaced, decoded),
    c = publicRealmClosures(f, true, true);
  const reserve = f.tx.reserveFunction.bind(f.tx);
  const interception =
    option === "wrong-abi"
      ? vi
          .spyOn(f.tx, "reserveFunction")
          .mockImplementation((key, name, signature) =>
            reserve(key, name, name === "makeCaptured" ? { ...signature, params: [{ kind: "i32" }] } : signature),
          )
      : undefined;
  const s = publicRealmSourceSlots(f, c);
  interception?.mockRestore();
  const originalSlots = new Map(s.slots);
  if (option === "omit-factory") originalSlots.delete(s.factories[0]!.fn.unitId);
  f.tx.freezeReservations();
  bindNativeSourceClosureUnits(f.tx, c.source!, originalSlots);
  fillRealmLayoutFixture(f);
  const unexpected = vi.fn(() => {
    throw Error("caller tried to replace genuine source resolution");
  });
  const resolver: IrLowerResolver = {
    resolveFunc: unexpected,
    resolveGlobal: unexpected,
    resolveType: unexpected,
    resolveClosure: unexpected,
    resolveClosureRoot: unexpected,
    resolveClosureSubtype: unexpected,
    resolveRefCell: unexpected,
    internFuncType(signature) {
      return f.tx.internFunctionType(signature.params, signature.results);
    },
  };
  const lower = (id: (typeof s.factories)[number]["fn"]["unitId"]) =>
    fillPreparedPrimaryUnit(
      f.tx,
      f.projection.prepared.functions.find((row) => row.unitId === id)!,
      s.slots.get(id)!,
      s.signatures.get(id)!,
      resolver,
      "wasmgc",
      c.source,
    );
  const lifted = () => {
    for (const row of c.source!.requirements.units) lower(row.unitId);
  };
  const factories = () => {
    for (const row of s.factories) lower(row.fn.unitId);
  };
  const complete = () => completeNativeRealmSourceAllocationBodyCustody(f.tx, c.source!, f.realm);
  return { f, c, s, lower, lifted, factories, complete, resolver, unexpected };
}

for (const [displaced, decoded] of [
  [false, false],
  [true, true],
] as const) {
  describe(`actual allocation-owner custody displaced=${displaced}, decoded=${decoded}`, () => {
    let runtime: ReturnType<typeof publicRealmSourceRuntime>;
    let mutable: { runtime: typeof runtime; sourceHookCalls: number };
    beforeAll(() => {
      runtime = publicRealmSourceRuntime(displaced, decoded, true);
      // Compile both real programs within the existing 120s preparation hook;
      // the mutable-capture case retains its ordinary 35s assertion deadline.
      const hostile = vi.fn(() => {
        throw Error("caller substituted the mutable capture owner");
      });
      const sourceText = `export function makeCaptured(seed: number): (value: number) => number {
        let current = seed;
        return function update(value: number): number { current += value; return current; };
      }
      export function makeEmpty(): (value: number) => number {
        return function empty(value: number): number { return value + 7; };
      }`;
      const prepared = publicRealmSourceRuntime(displaced, decoded, true, sourceText, {
        resolveClosure: hostile,
        resolveClosureRoot: hostile,
        resolveClosureSubtype: hostile,
        resolveRefCell: hostile,
        resolveBoxed: hostile,
        resolveFunc: hostile,
      });
      // Capture before afterEach restores mocks in preceding cases.
      mutable = { runtime: prepared, sourceHookCalls: hostile.mock.calls.length };
    }, 120000);
    it("executes genuinely lowered factories and retains a distinct full allocation-body scope", () => {
      const r = runtime,
        source = r.c.source!,
        custody = r.allocationBodies;
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(source.requirements.allocations.length).toBeGreaterThanOrEqual(2);
      expect(new Set(source.requirements.allocations.map((row) => row.ownerUnitId)).size).toBe(2);
      expect(custody.completionScope).toBe("realm-source-allocation-body-custody");
      expect(custody.bodies).toBe(completeNativeRealmSourceClosureBodyCustody(r.f.tx, source, r.f.realm));
      expect(requireNativeRealmSourceAllocationBodyCustody(r.f.tx, custody, source, r.f.realm)).toBe(custody);
      for (const api of [r.instance(), r.instance()]) {
        api.initialize!({ genuineSourcePrototype: true });
        const a = api.makeCaptured!(13),
          b = api.makeCaptured!(-20);
        expect(Object.is(a, b)).toBe(false);
        expect(api.callCode!(a, 7)).toBe(20);
        expect(api.callCode!(b, -3)).toBe(-23);
        expect(api.callCode!(a, 2)).toBe(15);
        expect(api.callCode!(api.makeEmpty!(), 4)).toBe(11);
      }
      expect(() => requireNativeRealmSourceAllocationBodyCustody(r.f.tx, { ...custody }, source, r.f.realm)).toThrow(
        "copied or substituted allocation-body custody",
      );
      expect(() => requireNativeRealmSourceAllocationBodyCustody(r.f.tx, custody, { ...source }, r.f.realm)).toThrow(
        "copied source association",
      );
      expect(() =>
        requireNativeRealmSourceAllocationBodyCustody(
          new PhysicalModuleReservations(createEmptyModule()),
          custody,
          source,
          r.f.realm,
        ),
      ).toThrow("foreign or copied source association");
      const realm = deriveNativeRealmRequirements(r.f.program, r.f.projection, source.requirements)!;
      expect(() => requireNativeRealmSourceAllocationBodyCustody(r.f.tx, custody, source, realm)).toThrow(
        "substituted realm callable association",
      );
    });

    it("uses genuine mutable capture allocation/read/write despite hostile ref-cell hooks", () => {
      const r = mutable.runtime;
      expect(r.c.source!.requirements.refCells.length).toBeGreaterThan(0);
      expect(r.c.source!.requirements.refCellAllocations.length).toBeGreaterThan(0);
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(requireNativeRealmSourceAllocationBodyCustody(r.f.tx, r.allocationBodies, r.c.source!, r.f.realm)).toBe(
        r.allocationBodies,
      );
      expect(mutable.sourceHookCalls).toBe(0);
      const a = r.instance(),
        b = r.instance();
      a.initialize!({ instance: "a" });
      b.initialize!({ instance: "b" });
      const first = a.makeCaptured!(10),
        second = a.makeCaptured!(100),
        other = b.makeCaptured!(10);
      expect(a.callCode!(first, 5)).toBe(15);
      expect(a.callCode!(first, -2)).toBe(13);
      expect(a.callCode!(second, 5)).toBe(105);
      expect(b.callCode!(other, 1)).toBe(11);
      expect(a.callCode!(first, 0)).toBe(13);
    });

    it("does not upgrade lifted-only completion or raw factory receipts", () => {
      const r = fixture(displaced, decoded);
      r.lifted();
      expect(completeNativeRealmSourceClosureBodyCustody(r.f.tx, r.c.source!, r.f.realm).completionScope).toBe(
        "realm-source-body-custody",
      );
      expect(r.complete).toThrow("allocation owner canonical lowering is incomplete");
      for (const row of r.s.factories) {
        r.f.tx.fillFunction(row.slot, { locals: [], body: [{ op: "ref.null", type: { kind: "externref" } }] });
        r.f.tx.assertCompletedReservation(row.slot);
      }
      expect(r.f.tx.state).toBe("filling");
      expect(r.complete).toThrow("allocation owner canonical lowering is incomplete");
    });

    it("cannot retroactively bind an omitted factory", () => {
      const r = fixture(displaced, decoded, "omit-factory");
      r.lifted();
      expect(r.complete).toThrow("allocation owner lacks native canonical body/frame custody");
      expect(() => r.lower(r.s.factories[0]!.fn.unitId)).toThrow("unbound source allocation owner");
      expect(() => bindNativeSourceClosureUnits(r.f.tx, r.c.source!, r.s.slots)).toThrow(
        "one frozen binding operation",
      );
    });

    it("uses genuine source hooks and target handles despite hostile caller overrides", () => {
      const r = fixture(displaced, decoded);
      r.lifted();
      r.factories();
      expect(r.complete().completionScope).toBe("realm-source-allocation-body-custody");
      expect(r.unexpected).not.toHaveBeenCalled();
      const requirements = r.c.source!.requirements;
      const sites = requirements.allocations.filter((row) => {
        const occurrence = requirements.demands.occurrences[row.occurrence]!;
        return requirements.demands.buffers[occurrence.bufferIndex]!.view === "projection";
      });
      // The census retains BOTH original and projected occurrences. Emission
      // lowers the projected bodies once, not both representations twice.
      expect(requirements.allocations).toHaveLength(4);
      expect(sites).toHaveLength(2);
      for (const row of r.s.factories) {
        const targets: number[] = [];
        walkInstructions(row.slot.object.body, (instr) => {
          if (instr.op === "ref.func") targets.push(instr.funcIdx);
        });
        const owned = sites.filter((site) => site.ownerUnitId === row.fn.unitId);
        expect(owned).toHaveLength(1);
        expect(targets).toEqual(owned.map((site) => r.s.slots.get(site.liftedUnitId)!.handle));
      }
    });

    for (const component of ["body", "locals"] as const)
      for (const inPlace of [false, true])
        it(`refuses receipt-valid factory ${inPlace ? "in-place" : "replacement"} ${component}`, () => {
          const r = fixture(displaced, decoded),
            target = r.s.factories[0]!.slot,
            fill = r.f.tx.fillFunction.bind(r.f.tx);
          r.lifted();
          const spy = vi.spyOn(r.f.tx, "fillFunction").mockImplementation((slot, definition) => {
            if (slot === target) {
              const replacement = inPlace ? definition : structuredClone(definition);
              if (component === "body")
                replacement.body.splice(0, replacement.body.length, { op: "ref.null", type: { kind: "externref" } });
              else replacement.locals.push({ name: "not-from-ir", type: { kind: "f64" } });
              fill(slot, replacement);
            } else fill(slot, definition);
          });
          r.factories();
          spy.mockRestore();
          for (const row of r.s.factories) r.f.tx.assertCompletedReservation(row.slot);
          expect(r.f.tx.state).toBe("filling");
          expect(r.complete).toThrow("noncanonical function definition");
        });

    for (const afterLedger of [false, true])
      it(`keeps an interrupted factory fill terminal ${afterLedger ? "after" : "before"} ledger acceptance`, () => {
        const r = fixture(displaced, decoded),
          row = r.s.factories[0]!,
          fill = r.f.tx.fillFunction.bind(r.f.tx);
        r.lifted();
        const spy = vi.spyOn(r.f.tx, "fillFunction").mockImplementation((slot, definition) => {
          if (slot === row.slot) {
            if (afterLedger) fill(slot, definition);
            throw Error("interrupted actual factory");
          }
          fill(slot, definition);
        });
        expect(() => r.lower(row.fn.unitId)).toThrow("interrupted actual factory");
        spy.mockRestore();
        if (afterLedger) r.f.tx.assertCompletedReservation(row.slot);
        expect(() => r.lower(row.fn.unitId)).toThrow("repeats completion");
        r.lower(r.s.factories[1]!.fn.unitId);
        expect(r.complete).toThrow("allocation owner canonical lowering is incomplete");
      });

    it("refuses a copied factory function or substituted slot", () => {
      const r = fixture(displaced, decoded),
        row = r.s.factories[0]!;
      expect(() =>
        fillPreparedPrimaryUnit(
          r.f.tx,
          structuredClone(row.fn),
          row.slot,
          r.s.signatures.get(row.fn.unitId)!,
          r.resolver,
          "wasmgc",
          r.c.source,
        ),
      ).toThrow("changed function/slot");
      expect(() =>
        fillPreparedPrimaryUnit(
          r.f.tx,
          row.fn,
          r.s.factories[1]!.slot,
          r.s.signatures.get(row.fn.unitId)!,
          r.resolver,
          "wasmgc",
          r.c.source,
        ),
      ).toThrow("changed function/slot");
    });

    it("rejects the actual factory ABI even when the caller signature matches lowered IR", () => {
      const r = fixture(displaced, decoded, "wrong-abi");
      r.lifted();
      expect(() => r.lower(r.s.factories[0]!.fn.unitId)).toThrow("noncanonical function signature");
      expect(r.f.tx.state).toBe("failed");
      expect(r.complete).toThrow();
    });

    it("rechecks genuine factory bodies after capability issuance", () => {
      const r = fixture(displaced, decoded);
      r.lifted();
      r.factories();
      const custody = r.complete();
      r.s.factories[0]!.slot.object.body = [{ op: "ref.null", type: { kind: "externref" } }];
      expect(() => requireNativeRealmSourceAllocationBodyCustody(r.f.tx, custody, r.c.source!, r.f.realm)).toThrow();
    });
  });
}

describe("actual physical function signature authentication", () => {
  const pairs: [ValType, ValType][] = [
    [{ kind: "i32", boolean: true }, { kind: "i32" }],
    [{ kind: "i32", symbol: true }, { kind: "i32" }],
    [{ kind: "i32", int32: true }, { kind: "i32" }],
    [{ kind: "i64", bigint: true }, { kind: "i64" }],
    [{ kind: "f64", undefSentinel: true }, { kind: "f64" }],
  ];
  for (const [actual, replaced] of pairs)
    for (const position of ["params", "results"] as const)
      it(`refuses lost ${Object.keys(actual)[1]} brand in ${position}`, () => {
        const tx = new PhysicalModuleReservations(createEmptyModule());
        const signature: PhysicalFunctionSignature = { params: [], results: [], [position]: [actual] };
        const slot = tx.reserveFunction("actual", "actual", signature);
        tx.freezeReservations();
        tx.assertFunctionSignature(slot, signature);
        expect(() => tx.assertFunctionSignature(slot, { ...signature, [position]: [replaced] })).toThrow(
          "noncanonical function signature",
        );
      });
  it("rejects changed nullability, reference coordinate, foreign and copied tokens", () => {
    for (const mutation of ["nullability", "coordinate", "foreign", "copy"] as const) {
      const tx = new PhysicalModuleReservations(createEmptyModule());
      const a = tx.reserveType("a", { kind: "struct", name: "A", fields: [] });
      const b = tx.reserveType("b", { kind: "struct", name: "B", fields: [] });
      const signature = { params: [{ kind: "ref" as const, typeIdx: a.typeIndex }], results: [] };
      const slot = tx.reserveFunction("actual", "actual", signature);
      tx.freezeReservations();
      tx.assertFunctionSignature(slot, signature);
      if (mutation === "foreign") {
        const other = new PhysicalModuleReservations(createEmptyModule());
        other.freezeReservations();
        expect(() => other.assertFunctionSignature(slot, signature)).toThrow();
      } else if (mutation === "copy") expect(() => tx.assertFunctionSignature({ ...slot }, signature)).toThrow();
      else
        expect(() =>
          tx.assertFunctionSignature(slot, {
            params: [
              {
                kind: mutation === "nullability" ? "ref_null" : "ref",
                typeIdx: mutation === "coordinate" ? b.typeIndex : a.typeIndex,
              },
            ],
            results: [],
          }),
        ).toThrow("noncanonical function signature");
    }
  });
});
