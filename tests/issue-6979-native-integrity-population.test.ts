// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import { objectExtensibilityRuntimeSteps } from "./helpers/native-object-extensibility.js";
import { NATIVE_REALM_CATALOG } from "../src/runtime/contracts/native-realm-catalog.js";
import { requireCompletedNativeObjectRealm } from "../src/backend/wasmgc/resources/native-object-realm.js";
import { requireCompletedNativeObjectIntegrityAlgorithms } from "../src/backend/wasmgc/resources/native-object-integrity.js";

afterEach(async () => await setImmediate());
for (const [displaced, decoded, mode] of [
  [false, false, "interned"],
  [true, true, "allocating"],
] as const)
  describe(`actual populated integrity displaced=${displaced} decoded=${decoded} mode=${mode}`, () => {
    const preparation = objectExtensibilityRuntimeSteps(
      displaced,
      decoded,
      mode,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    );
    let r: ReturnType<typeof preparation.next>["value"];
    for (let phase = 0; phase < 14; phase++)
      beforeAll(async () => {
        const step = preparation.next();
        expect(step.done, "phase " + phase).toBe(phase === 13);
        if (step.done) r = step.value;
        await setImmediate();
      }, 120000);
    beforeEach(() => {
      r!.api.populationState(0);
      r!.api.initializePopulation();
    });
    const call = (method: number, value: unknown) =>
      r!.api["stored" + (method + 2)](r!.api["singleton" + (method + 2)].value, null, r!.vector([value]));
    const query = (method: number, value: unknown) => r!.api.readBoolean(call(method, value));
    const identity = (id: string) =>
      id === "%Object.prototype%"
        ? r!.api.objectPrototype.value
        : r!.api["intrinsic" + r!.r.realm.declarations.entries.findIndex((entry) => entry.request.intrinsic.id === id)]
            .value;
    const bag = (id: string) =>
      id === "%Object.prototype%"
        ? identity(id)
        : r!.api.intrinsicBag(r!.r.realm.declarations.entries.findIndex((entry) => entry.request.intrinsic.id === id));
    it("runs the actual 45-identity initializer, retains 133 real descriptors, and never certifies a complete realm", () => {
      expect(r!.api.populationReady()).toBe(2);
      expect(r!.api.wholeRealmReady()).toBe(0);
      expect(WebAssembly.Module.imports(r!.wasm)).toEqual([]);
      expect(NATIVE_REALM_CATALOG.intrinsics).toHaveLength(45);
      expect(r!.r.realm.declarations.entries).toHaveLength(44);
      const seen = new Set(NATIVE_REALM_CATALOG.intrinsics.map((row) => identity(row.id)));
      expect(seen.size).toBe(45);
      let properties = 0;
      for (const row of NATIVE_REALM_CATALOG.intrinsics)
        for (const property of row.properties) {
          const entry = r!.api.integrityEntry(bag(row.id), r!.api.populationKey(properties++));
          expect(entry, row.id + JSON.stringify(property.key)).not.toBeNull();
          const expected =
            (property.configurable ? 4 : 0) | (property.kind === "accessor" ? 8 : property.writable ? 1 : 0);
          expect(r!.api.integrityEntryFlags(entry)).toBe(expected);
          if (property.kind === "accessor") {
            expect(r!.api.integrityGetter(entry)).toBe(identity(property.get));
            expect(r!.api.integritySetter(entry)).toBe(identity(property.set));
          } else if (property.value.kind === "intrinsic")
            expect(r!.api.integrityEntryValue(entry)).toBe(identity(property.value.id));
          else if (property.value.kind === "number")
            expect(r!.api.populationNumber(r!.api.integrityEntryValue(entry))).toBe(property.value.value);
          else expect(r!.api.populationTextIs(r!.api.integrityEntryValue(entry), properties - 1)).toBe(1);
        }
      expect(properties).toBe(133);
      expect(r!.observerOnlyTraps).toHaveLength(38);
      expect(
        requireCompletedNativeObjectIntegrityAlgorithms(r!.r.tx, r!.r.integrity!, r!.r.algorithmDependencies),
      ).toBe(r!.r.integrity);
      expect(() => requireCompletedNativeObjectRealm(r!.r.tx, r!.r.realm.declarations)).toThrow(/incomplete/);
      expect(() => r!.r.tx.seal()).toThrow(/missing function fill/);
      console.info("populated integrity component", {
        displaced,
        decoded,
        mode,
        bytes: r!.bytes.length,
        sha256: createHash("sha256").update(r!.bytes).digest("hex"),
        properties,
        identities: seen.size,
        observerOnlyTrapCount: r!.observerOnlyTraps.length,
        wholeRealmCompleted: false,
      });
    });
    it("requires actual readiness even when genuine published bags already exist", () => {
      const value = identity("%Object%");
      expect(r!.api.integrityKernel2(value)).toBe(0);
      for (const state of [0, 1, -1]) {
        r!.api.populationState(state);
        for (const target of [value, identity("%Function.prototype%"), identity("%Object.prototype%")]) {
          expect(r!.api.integrityKernel0(target)).toBe(2);
          expect(() => call(0, target)).toThrow(WebAssembly.RuntimeError);
        }
      }
      r!.api.populationState(2);
      expect(call(0, value)).toBe(value);
      expect(query(2, value)).toBe(1);
    });
    it("freezes all 44 actual callable bags without replacing their singleton identities", () => {
      for (const entry of r!.r.realm.declarations.entries) {
        const id = entry.request.intrinsic.id,
          value = identity(id),
          storage = bag(id);
        const name = r!.api.integrityEntry(storage, r!.api.text());
        const length = r!.api.integrityEntry(storage, r!.api.integrityLengthKey());
        expect(call(0, value)).toBe(value);
        expect(identity(id)).toBe(value);
        expect(bag(id)).toBe(storage);
        expect(query(2, value)).toBe(1);
        expect(query(3, value)).toBe(1);
        expect(r!.api.integrityEntryFlags(name)).toBe(0);
        expect(r!.api.integrityEntryFlags(length)).toBe(0);
      }
      // Freezing a callable is shallow: the actual object prototype is still extensible.
      expect(query(2, identity("%Object.prototype%"))).toBe(0);
    });
    it("seals and freezes Object.prototype and preserves real accessor/callable payload references", () => {
      const value = identity("%Object.prototype%"),
        constructorEntry = r!.api.integrityEntry(value, r!.api.populationKey(0));
      const payload = r!.api.integrityEntryValue(constructorEntry);
      expect(call(1, value)).toBe(value);
      expect(query(3, value)).toBe(1);
      expect(query(2, value)).toBe(0);
      expect(call(0, value)).toBe(value);
      expect(query(2, value)).toBe(1);
      expect(r!.api.integrityEntryValue(constructorEntry)).toBe(payload);
    });
    it("uses the genuine descriptor validator for writes after seal/freeze, with its real TypeError tag", () => {
      const target = identity("%Object%"),
        storage = bag("%Object%");
      const index = NATIVE_REALM_CATALOG.intrinsics
        .flatMap((row) => row.properties)
        .findIndex((p) => p.kind === "data" && p.value.kind === "intrinsic" && p.value.id === "%Object.assign%");
      const key = r!.api.populationKey(index),
        entry = r!.api.integrityEntry(storage, key);
      const replacement = r!.api.boxNumber(7);
      expect(call(1, target)).toBe(target);
      r!.api.defineData(storage, key, replacement, 128);
      expect(r!.api.integrityEntryValue(entry)).toBe(replacement);
      call(0, target);
      r!.api.defineData(storage, key, replacement, 128);
      let caught: WebAssembly.Exception | undefined;
      try {
        r!.api.defineData(storage, key, r!.api.boxNumber(8), 128);
      } catch (error) {
        caught = error as WebAssembly.Exception;
      }
      expect(caught).toBeInstanceOf(WebAssembly.Exception);
      expect(caught!.is(r!.api.exception)).toBe(true);
      expect(r!.api.errorTag(caught!.getArg(r!.api.exception, 0))).toBe(-11);
      expect(r!.api.integrityEntryValue(entry)).toBe(replacement);
    });
    it("keeps missing unrelated algorithms as observer-only traps and source/foreign values unadmitted", () => {
      const index = r!.r.realm.declarations.entries.findIndex(
        (entry) => entry.request.intrinsic.id === "%Object.assign%",
      );
      expect(() => r!.api["intrinsicCall" + index](identity("%Object.assign%"), null, r!.vector([]))).toThrow(
        WebAssembly.RuntimeError,
      );
      expect(r!.api.integrityKernel0(r!.api.source())).toBe(2);
      let hooks = 0;
      const foreign = new Proxy(
        {},
        {
          get() {
            hooks++;
            throw Error("unexpected hook");
          },
        },
      );
      expect(r!.api.integrityKernel0(foreign)).toBe(3);
      expect(() => call(0, foreign)).toThrow(WebAssembly.RuntimeError);
      expect(hooks).toBe(0);
      const primitive = r!.api.boxNumber(4);
      expect(call(0, primitive)).toBe(primitive);
      expect(query(2, primitive)).toBe(1);
    });
  });
