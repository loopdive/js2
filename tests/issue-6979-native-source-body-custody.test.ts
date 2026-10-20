// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
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
  nativeRealmSourceClosureCallableBindings,
  nativeSourceClosureResolver,
  fillPreparedPrimaryUnit,
  requireCompletedNativeSourceClosures,
  completeNativeRealmSourceClosureBodyCustody,
  requireNativeRealmSourceClosureBodyCustody,
} from "../src/ir/program-native-invocation.js";
import { deriveNativeRealmRequirements } from "../src/ir/program/native-realm-requirements.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { createEmptyModule } from "../src/ir/types.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});

function fixture(displaced: boolean, decoded: boolean) {
  const f = publicRealmFoundation(displaced, decoded),
    c = publicRealmClosures(f),
    s = publicRealmSourceSlots(f, c);
  f.tx.freezeReservations();
  bindNativeSourceClosureUnits(f.tx, c.source!, s.slots);
  const callables = nativeRealmSourceClosureCallableBindings(f.tx, c.source!, f.realm);
  fillRealmLayoutFixture(f);
  const resolver: IrLowerResolver = {
    ...nativeSourceClosureResolver(f.tx, c.source!),
    resolveFunc(ref) {
      const slot = ref.binding.kind === "unit" && s.slots.get(ref.binding.unitId);
      if (!slot) throw Error("unexpected source callable");
      return slot.handle;
    },
    resolveGlobal() {
      throw Error("unexpected source global");
    },
    resolveType() {
      throw Error("unexpected source type");
    },
    internFuncType(signature) {
      return f.tx.internFunctionType(signature.params, signature.results);
    },
  };
  const lower = (index: number) => {
    const row = callables.entries[index]!;
    fillPreparedPrimaryUnit(f.tx, row.source, row.slot, s.signatures.get(row.unitId)!, resolver, "wasmgc", c.source);
  };
  return { f, c, s, callables, lower };
}

for (const [displaced, decoded] of [
  [false, false],
  [true, true],
] as const)
  describe(`actual prepared source-body custody displaced=${displaced}, decoded=${decoded}`, () => {
    it("executes independent captures and issues only full authentic source-unit custody", () => {
      const r = publicRealmSourceRuntime(displaced, decoded),
        source = r.c.source!,
        { tx, realm } = r.f;
      expect(tx.state).toBe("sealed");
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.callables.entries).toHaveLength(2);
      const custody = completeNativeRealmSourceClosureBodyCustody(tx, source, realm);
      expect(custody.completionScope).toBe("realm-source-body-custody");
      expect(custody.source).toBe(source);
      expect(custody.callables).toBe(r.callables);
      expect(completeNativeRealmSourceClosureBodyCustody(tx, source, realm)).toBe(custody);
      expect(requireNativeRealmSourceClosureBodyCustody(tx, custody, source, realm)).toBe(custody);
      for (const instance of [r.instance(), r.instance()]) {
        instance.initialize!({ sourcePrototype: true });
        for (const seed of [-100, -0, 0, 13, 1000]) {
          const a = instance.makeCaptured!(seed),
            b = instance.makeCaptured!(seed + 50);
          expect(Object.is(a, b)).toBe(false);
          expect(instance.call!(a, 7)).toBe(seed + 7);
          expect(instance.call!(b, -2)).toBe(seed + 48);
          expect(instance.call!(a, -9)).toBe(seed - 9);
        }
        expect(instance.call!(instance.makeEmpty!(), 3)).toBe(10);
      }
      expect(() => requireNativeRealmSourceClosureBodyCustody(tx, { ...custody }, source, realm)).toThrow(
        "foreign, copied or substituted source-body custody",
      );
      expect(() => requireNativeRealmSourceClosureBodyCustody(tx, custody, { ...source }, realm)).toThrow(
        "foreign or copied source association",
      );
      expect(() =>
        requireNativeRealmSourceClosureBodyCustody(
          new PhysicalModuleReservations(createEmptyModule()),
          custody,
          source,
          realm,
        ),
      ).toThrow("foreign or copied source association");
      const otherRealm = deriveNativeRealmRequirements(r.f.program, r.f.projection, realm.source)!;
      expect(() => requireNativeRealmSourceClosureBodyCustody(tx, custody, source, otherRealm)).toThrow(
        "foreign, copied or substituted realm callable association",
      );
    });

    it("refuses no lowering, a raw receipt, and a genuinely lowered but incomplete population", () => {
      const r = fixture(displaced, decoded),
        source = r.c.source!;
      expect(r.callables.entries).toHaveLength(2);
      const complete = () => completeNativeRealmSourceClosureBodyCustody(r.f.tx, source, r.f.realm);
      expect(complete).toThrow("canonical lowering is incomplete");
      r.lower(0);
      expect(() => r.lower(0)).toThrow("repeats completion");
      expect(complete).toThrow("canonical lowering is incomplete");
      const row = r.callables.entries[1]!;
      r.f.tx.fillFunction(row.slot, { locals: [], body: [{ op: "f64.const", value: 9 }] });
      r.f.tx.assertCompletedReservation(row.slot);
      expect(complete).toThrow("canonical lowering is incomplete");
    });

    for (const component of ["body", "locals"] as const)
      for (const inPlace of [false, true])
        it(`refuses receipt-valid ${inPlace ? "in-place" : "replacement"} ${component} substitution`, () => {
          const r = fixture(displaced, decoded),
            target = r.callables.entries[0]!.slot,
            original = r.f.tx.fillFunction.bind(r.f.tx);
          const intercepted = vi.spyOn(r.f.tx, "fillFunction").mockImplementation((slot, definition) => {
            if (slot === target) {
              const replacement = inPlace ? definition : structuredClone(definition);
              if (component === "body")
                replacement.body.splice(0, replacement.body.length, { op: "f64.const", value: 9 });
              else replacement.locals.push({ name: "counterfeit-local", type: { kind: "f64" } });
              original(slot, replacement);
            } else original(slot, definition);
          });
          r.lower(0);
          r.lower(1);
          intercepted.mockRestore();
          // This positive control matters: the allocator accepted exactly the
          // substituted definition. Custody must reject independently of it.
          for (const row of r.callables.entries) r.f.tx.assertCompletedReservation(row.slot);
          expect(r.f.tx.state).toBe("filling");
          expect(() => requireCompletedNativeSourceClosures(r.f.tx, r.c.source!)).toThrow(
            "noncanonical function definition",
          );
          expect(() => completeNativeRealmSourceClosureBodyCustody(r.f.tx, r.c.source!, r.f.realm)).toThrow();
        });

    for (const afterLedger of [false, true])
      it(`keeps an actual fill interrupted ${afterLedger ? "after" : "before"} the ledger terminal`, () => {
        const r = fixture(displaced, decoded),
          original = r.f.tx.fillFunction.bind(r.f.tx),
          target = r.callables.entries[0]!.slot;
        const intercepted = vi.spyOn(r.f.tx, "fillFunction").mockImplementation((slot, definition) => {
          if (slot === target) {
            if (afterLedger) original(slot, definition);
            throw Error("actual source fill interrupted");
          }
          original(slot, definition);
        });
        expect(() => r.lower(0)).toThrow("actual source fill interrupted");
        intercepted.mockRestore();
        if (afterLedger) r.f.tx.assertCompletedReservation(target);
        expect(r.f.tx.state).toBe("filling");
        expect(() => r.lower(0)).toThrow("repeats completion");
        r.lower(1);
        expect(() => completeNativeRealmSourceClosureBodyCustody(r.f.tx, r.c.source!, r.f.realm)).toThrow(
          "canonical lowering is incomplete",
        );
      });

    it("rechecks the body after custody was issued", () => {
      const r = fixture(displaced, decoded);
      r.lower(0);
      r.lower(1);
      const custody = completeNativeRealmSourceClosureBodyCustody(r.f.tx, r.c.source!, r.f.realm);
      r.callables.entries[0]!.slot.object.body = [{ op: "f64.const", value: 9 }];
      expect(() => requireNativeRealmSourceClosureBodyCustody(r.f.tx, custody, r.c.source!, r.f.realm)).toThrow();
    });
  });
