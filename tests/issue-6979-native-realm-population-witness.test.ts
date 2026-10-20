// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import { populationOperandWitness } from "./helpers/native-realm-population-witness.js";
import { NATIVE_REALM_CATALOG } from "../src/runtime/contracts/native-realm-catalog.js";

afterEach(async () => await setImmediate());
for (const [displaced, decoded] of [
  [false, false],
  [true, false],
  [true, true],
] as const)
  describe(`pure catalog builder operand witness displaced=${displaced} decoded=${decoded}`, () => {
    let witness: ReturnType<typeof populationOperandWitness>;
    beforeAll(() => {
      witness = populationOperandWitness(displaced, decoded);
      console.info(
        "catalog population operand witness",
        JSON.stringify({
          displaced,
          decoded,
          bytes: witness.bytes.length,
          sha256: createHash("sha256").update(witness.bytes).digest("hex"),
          imports: WebAssembly.Module.imports(witness.module),
          intrinsics: 45,
          builtinAlgorithmExecution: false,
          productionPublicRealmCompleted: false,
        }),
      );
    }, 120000);
    const catalog = NATIVE_REALM_CATALOG.intrinsics;
    const idIndex = (id: string) => {
      const index = catalog.findIndex((row) => row.id === id);
      if (index < 0) throw Error("catalog id absent " + id);
      return index;
    };
    it("seeds all 45 identities, exact descriptors, symbol keys, constructor cycles and accessor aliases", () => {
      const { ex, intrinsic, text } = witness.instantiate();
      expect(WebAssembly.Module.imports(witness.module)).toEqual([]);
      expect(ex.state.value).toBe(0);
      expect(ex.identity.value).toBe(null);
      for (let i = 0; i < 45; i++) expect(intrinsic(i)).toBe(null);
      ex.initialize();
      expect(ex.state.value).toBe(2);
      expect(new Set(catalog.map((_, i) => intrinsic(i))).size).toBe(45);
      for (const [i, row] of catalog.entries()) {
        expect(intrinsic(i), row.id).not.toBe(null);
        expect(ex.prototype(i), row.id).toBe(row.prototype === null ? null : intrinsic(idIndex(row.prototype)));
        expect(ex.count(i), row.id).toBe(row.properties.length);
        expect(ex.objectFlags(i) & 1, row.id).toBe(row.extensible ? 0 : 1);
        if (row.callable) {
          expect(ex.arity(i), row.id).toBe(row.callable.length);
          expect(ex.realm(i), row.id).toBe(ex.identity.value);
          expect(ex.initialName(i), row.id).toBe(text(row.callable.initialName));
        }
        for (const p of row.properties) {
          const key = p.key.kind === "string" ? text(p.key.value) : ex.symbol(2);
          const attributes =
            (p.enumerable ? 2 : 0) | (p.configurable ? 4 : 0) | (p.kind === "accessor" ? 8 : p.writable ? 1 : 0);
          expect(ex.flags(i, key), row.id + ":" + p.key.value).toBe(attributes);
          if (p.kind === "accessor") {
            expect(ex.getter(i, key), row.id).toBe(intrinsic(idIndex(p.get)));
            expect(ex.setter(i, key), row.id).toBe(intrinsic(idIndex(p.set)));
          } else if (p.value.kind === "number") {
            expect(ex.unboxNumber(ex.value(i, key)), row.id).toBe(p.value.value);
          } else {
            expect(ex.value(i, key), row.id).toBe(
              p.value.kind === "string" ? text(p.value.value) : intrinsic(idIndex(p.value.id)),
            );
          }
        }
      }
      const saved = catalog.map((_, i) => intrinsic(i));
      ex.initialize();
      expect(catalog.map((_, i) => intrinsic(i))).toEqual(saved);
    });
    it("allocates independent identities and property bags per zero-import instance", () => {
      const a = witness.instantiate(),
        b = witness.instantiate();
      a.ex.initialize();
      expect(b.ex.identity.value).toBe(null);
      expect(b.ex.state.value).toBe(0);
      b.ex.initialize();
      expect(Object.is(a.ex.identity.value, b.ex.identity.value)).toBe(false);
      for (let i = 0; i < 45; i++) {
        expect(Object.is(a.intrinsic(i), b.intrinsic(i))).toBe(false);
        expect(Object.is(a.ex.bag(i), b.ex.bag(i))).toBe(false);
      }
      expect(Object.is(a.ex.symbol(2), b.ex.symbol(2))).toBe(false);
    });
    it.each([1, 2, 3, 4])("does not publish any singleton on interrupted/reentrant population mode=%s", (mode) => {
      const { ex, intrinsic } = witness.instantiate();
      ex.mode.value = mode;
      ex.after.value = 9;
      let failure: unknown;
      try {
        ex.initialize();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(mode === 3 ? WebAssembly.RuntimeError : WebAssembly.Exception);
      if (mode !== 3) expect((failure as WebAssembly.Exception).is(ex.exception)).toBe(true);
      expect(ex.state.value).toBe(mode === 3 ? 1 : -1);
      expect(ex.identity.value).toBe(null);
      for (let i = 0; i < 45; i++) expect(intrinsic(i)).toBe(null);
      ex.mode.value = 0;
      expect(() => ex.initialize()).toThrow(WebAssembly.Exception);
      expect(ex.state.value).toBe(-1);
      expect(ex.identity.value).toBe(null);
      for (let i = 0; i < 45; i++) expect(intrinsic(i)).toBe(null);
    });
  });
