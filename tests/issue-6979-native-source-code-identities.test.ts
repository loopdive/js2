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
  nativeRealmSourceClosureCallableBindings,
  nativeSourceClosureResolver,
  fillPreparedPrimaryUnit,
  fillNativeRealmSourceCodeIdentities,
  requireCompletedNativeRealmSourceCodeIdentities,
  requireNativeRealmSourceCodeIdentities,
  reserveNativeRealmSourceCodeIdentities,
  beginNativeSourceClosureEmission,
} from "../src/ir/program-native-invocation.js";
import {
  requireNativeSourceCodeIdentityReservations,
  reserveNativeSourceCodeIdentityResources,
} from "../src/backend/wasmgc/resources/native-source-code-identities.js";
import { buildNativeSourceCodeIdentityOperand } from "../src/runtime/wasmgc/values/source-code-identity-bodies.js";
import { deriveNativeRealmRequirements } from "../src/ir/program/native-realm-requirements.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { nativeStringTypeKeys } from "../src/runtime/contracts/native-string-resource-keys.js";
import { nativeStringTypeKeys as compatibilityStringKeys } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { ASYNC_CALLBACK_EXCEPTION_POLICY as runtimePolicy } from "../src/runtime/contracts/async-provider-schema.js";
import { ASYNC_CALLBACK_EXCEPTION_POLICY as compatibilityPolicy } from "../src/ir/async-runtime-providers.js";

const SOURCE = `export function makeCaptured(seed: number): (value: number) => number {
  const plus = function positive(value: number): number { return seed + value; };
  const minus = function negative(value: number): number { return seed - value; };
  return seed < 0 ? minus : plus;
}
export function makeEmpty(): (value: number) => number {
  return function empty(value: number): number { return value + 7; };
}`;
afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});
function fixture(displaced: boolean, decoded: boolean) {
  const f = publicRealmFoundation(displaced, decoded, false, false, SOURCE),
    c = publicRealmClosures(f, true, true),
    s = publicRealmSourceSlots(f, c),
    codes = c.carriers!.codeIdentities!;
  f.tx.freezeReservations();
  bindNativeSourceClosureUnits(f.tx, c.source!, s.slots);
  const callables = nativeRealmSourceClosureCallableBindings(f.tx, c.source!, f.realm);
  fillRealmLayoutFixture(f);
  const resolver: IrLowerResolver = {
    ...nativeSourceClosureResolver(f.tx, c.source!),
    resolveFunc(ref) {
      const slot = ref.binding.kind === "unit" && s.slots.get(ref.binding.unitId);
      if (!slot) throw Error("unexpected callable in source identity fixture");
      return slot.handle;
    },
    resolveType() {
      throw Error("unexpected source type");
    },
    resolveGlobal() {
      throw Error("unexpected source global");
    },
    internFuncType(signature) {
      return f.tx.internFunctionType(signature.params, signature.results);
    },
  };
  const lower = () => {
    for (const row of callables.entries)
      fillPreparedPrimaryUnit(f.tx, row.source, row.slot, s.signatures.get(row.unitId)!, resolver, "wasmgc", c.source);
  };
  const fill = () => fillNativeRealmSourceCodeIdentities(f.tx, c.source!, f.realm);
  const complete = () => requireCompletedNativeRealmSourceCodeIdentities(f.tx, c.source!, f.realm);
  return { f, c, s, codes, callables, lower, fill, complete };
}
for (const [displaced, decoded] of [
  [false, false],
  [true, true],
] as const) {
  describe(`actual source code identities displaced=${displaced}, decoded=${decoded}`, () => {
    let runtime: ReturnType<typeof publicRealmSourceRuntime>;
    beforeAll(() => {
      runtime = publicRealmSourceRuntime(displaced, decoded, true, SOURCE);
    }, 120000);
    const globalCode = (api: ReturnType<typeof runtime.instance>, index: number) =>
      (api["code" + index] as unknown as WebAssembly.Global).value;
    it("has distinct original unit identities despite shared signature and capture shape", () => {
      expect(WebAssembly.Module.imports(runtime.wasm)).toEqual([]);
      expect(runtime.callables.entries).toHaveLength(3);
      const captured = runtime.callables.entries.filter(
        (row) => row.source.closureSubtype!.captureFieldTypes.length === 1,
      );
      expect(captured).toHaveLength(2);
      expect(captured[0]!.shape.type).toBe(captured[1]!.shape.type);
      expect(captured[0]!.slot.object.typeIdx).toBe(captured[1]!.slot.object.typeIdx);
      const api = runtime.instance();
      for (let a = 0; a < 3; a++)
        for (let b = a + 1; b < 3; b++) expect(Object.is(globalCode(api, a), globalCode(api, b))).toBe(false);
      const completion = requireCompletedNativeRealmSourceCodeIdentities(
        runtime.f.tx,
        runtime.c.source!,
        runtime.f.realm,
      );
      expect(completion.completionScope).toBe("realm-source-code-identities");
      expect(requireNativeRealmSourceCodeIdentities(runtime.f.tx, completion, runtime.c.source!, runtime.f.realm)).toBe(
        completion,
      );
      expect(() =>
        requireNativeRealmSourceCodeIdentities(runtime.f.tx, { ...completion }, runtime.c.source!, runtime.f.realm),
      ).toThrow("copied or substituted completed code identities");
    });
    it("actual IR allocations carry their exact box and call its real target with independent captures", () => {
      const api = runtime.instance();
      expect(api.matchCode!({})).toBe(-2);
      api.initialize!({ actualSourcePrototype: true });
      const positive = api.makeCaptured!(13),
        negative = api.makeCaptured!(-100),
        empty = api.makeEmpty!();
      const code = (callee: unknown) => api.sourceCode!(callee);
      expect(Object.is(code(positive), code(negative))).toBe(false);
      expect(Object.is(code(api.makeCaptured!(31)), code(positive))).toBe(true);
      for (const [callee, seed] of [
        [positive, 13],
        [negative, -100],
      ] as const)
        for (const value of [-5, 0, 17]) {
          const expected = seed < 0 ? seed - value : seed + value;
          expect(api.call!(callee, value)).toBe(expected);
          expect(api.callCode!(callee, value)).toBe(expected);
          const matched = api.matchCode!(callee);
          expect(matched).toBeGreaterThan(0);
          expect(matched).toBeLessThanOrEqual(3);
          expect(Object.is(code(callee), globalCode(api, matched - 1))).toBe(true);
        }
      expect(api.callCode!(empty, 2)).toBe(9);
      expect(Object.is(positive, api.makeCaptured!(13))).toBe(false);
    });
    it("rejects foreign instances, unknown JS values and stale realm generations without host hooks", () => {
      const a = runtime.instance(),
        b = runtime.instance();
      a.initialize!({ instance: "a" });
      b.initialize!({ instance: "b" });
      const captured = a.makeCaptured!(10),
        foreign = b.makeCaptured!(20);
      expect(a.matchCode!(foreign)).toBe(0);
      expect(b.matchCode!(captured)).toBe(0);
      for (let i = 0; i < 3; i++) expect(Object.is(globalCode(a, i), globalCode(b, i))).toBe(false);
      const hostile = new Proxy(
        {},
        {
          get() {
            throw Error("host hook must not run");
          },
        },
      );
      for (const value of [hostile, null, undefined, 4, "foreign string", () => 1, globalCode(a, 0)])
        expect(a.matchCode!(value)).toBe(0);
      const priorCode = a.sourceCode!(captured);
      a.initialize!({ newGeneration: true });
      expect(a.matchCode!(captured)).toBe(0);
      expect(Object.is(a.sourceCode!(a.makeCaptured!(30)), priorCode)).toBe(true);
      expect(a.callCode!(a.makeCaptured!(30), 7)).toBe(37);
    });
  });
  describe(`source code identity ownership displaced=${displaced}, decoded=${decoded}`, () => {
    it("requires complete actual bodies, fills once and authenticates original declarations", () => {
      const r = fixture(displaced, decoded);
      expect(r.codes.entries).toHaveLength(3);
      expect(() => r.fill()).toThrow("canonical lowering is incomplete");
      r.lower();
      r.fill();
      const completed = r.complete();
      expect(completed.declarations).toBe(r.codes);
      expect(r.complete()).toBe(completed);
      expect(() => r.fill()).toThrow("duplicate or terminal");
      expect(() => requireNativeSourceCodeIdentityReservations(r.f.tx, { ...r.codes })).toThrow(
        "foreign or copied code declarations",
      );
      const other = deriveNativeRealmRequirements(r.f.program, r.f.projection, r.f.realm.source)!;
      expect(() => requireCompletedNativeRealmSourceCodeIdentities(r.f.tx, r.c.source!, other)).toThrow(
        "missing original source code declarations",
      );
    });
    for (const inPlace of [false, true])
      it(`refuses a receipt-valid ${inPlace ? "in-place" : "replacement"} same-ABI target substitution`, () => {
        const r = fixture(displaced, decoded);
        r.lower();
        const original = r.f.tx.fillGlobal.bind(r.f.tx),
          target = r.codes.entries[0]!.identity;
        expect(r.callables.entries[0]!.slot.object.typeIdx).toBe(r.callables.entries[1]!.slot.object.typeIdx);
        expect(r.callables.entries[0]!.shape.type).toBe(r.callables.entries[1]!.shape.type);
        const spy = vi.spyOn(r.f.tx, "fillGlobal").mockImplementation((token, init) => {
          const changed = inPlace ? init : structuredClone(init);
          if (token === target) changed[0] = { op: "ref.func", funcIdx: r.callables.entries[1]!.slot.handle };
          original(token, changed);
        });
        r.fill();
        spy.mockRestore();
        for (const row of r.codes.entries) r.f.tx.assertCompletedReservation(row.identity);
        r.f.tx.assertCompletedReservation(r.codes.match);
        expect(r.f.tx.state).toBe("filling");
        expect(r.complete).toThrow("noncanonical global initializer");
      });
    it("refuses a receipt-valid matcher that accepts every candidate", () => {
      const r = fixture(displaced, decoded);
      r.lower();
      const original = r.f.tx.fillFunction.bind(r.f.tx);
      const spy = vi
        .spyOn(r.f.tx, "fillFunction")
        .mockImplementation((token, definition) =>
          original(token, token === r.codes.match ? { locals: [], body: [{ op: "i32.const", value: 1 }] } : definition),
        );
      r.fill();
      spy.mockRestore();
      r.f.tx.assertCompletedReservation(r.codes.match);
      expect(r.complete).toThrow("noncanonical function definition");
    });
    for (const afterLedger of [false, true])
      it(`keeps a partial fill interrupted ${afterLedger ? "after" : "before"} ledger acceptance terminal`, () => {
        const r = fixture(displaced, decoded);
        r.lower();
        const original = r.f.tx.fillGlobal.bind(r.f.tx),
          target = r.codes.entries[1]!.identity;
        const spy = vi.spyOn(r.f.tx, "fillGlobal").mockImplementation((token, init) => {
          if (token === target) {
            if (afterLedger) original(token, init);
            throw Error("actual code fill interruption");
          }
          original(token, init);
        });
        expect(r.fill).toThrow("actual code fill interruption");
        spy.mockRestore();
        r.f.tx.assertCompletedReservation(r.codes.entries[0]!.identity);
        if (afterLedger) r.f.tx.assertCompletedReservation(target);
        expect(r.fill).toThrow("duplicate or terminal");
        expect(r.complete).toThrow("incomplete or terminal");
      });
    it("refuses receipt-valid forged source bodies before granting code identities", () => {
      const r = fixture(displaced, decoded),
        original = r.f.tx.fillFunction.bind(r.f.tx),
        target = r.callables.entries[0]!.slot;
      const spy = vi
        .spyOn(r.f.tx, "fillFunction")
        .mockImplementation((token, definition) =>
          original(token, token === target ? { locals: [], body: [{ op: "f64.const", value: 9 }] } : definition),
        );
      r.lower();
      spy.mockRestore();
      for (const row of r.callables.entries) r.f.tx.assertCompletedReservation(row.slot);
      expect(r.fill).toThrow("noncanonical function definition");
    });
  });
}

describe("source code declaration and allocator data boundaries", () => {
  it("retains exact String-key and callback-policy identities through compatibility exports", () => {
    expect(nativeStringTypeKeys).toBe(compatibilityStringKeys);
    expect(runtimePolicy).toBe(compatibilityPolicy);
    for (const key of ["", "realm:source", "😀\u0000"])
      expect(nativeStringTypeKeys(key)).toEqual({
        data: key + ":data",
        any: key + ":any",
        flat: key + ":flat",
        cons: key + ":cons",
        hashed: key + ":hashed",
        utf8Data: key + ":utf8-data",
        utf8: key + ":utf8",
      });
  });
  it("refuses an original-source subset even though raw physical declarations can be reserved", () => {
    const f = publicRealmFoundation();
    const codes = reserveNativeSourceCodeIdentityResources(
      f.tx,
      {
        key: f.realm.description.key + ":source-code",
        realm: f.realm,
        source: f.realm.source!,
        units: [f.realm.source!.units[0]!.unitId],
      },
      f.pack,
    );
    const before = [f.module.types.length, f.module.functions.length, f.module.globals.length];
    expect(codes.completionScope).toBe("source-code-declarations");
    expect(() =>
      beginNativeSourceClosureEmission(
        f.tx,
        f.realm.source!,
        {
          vectors: f.vectors,
          vectorPlan: f.vectorPlan,
          realmState: f.pack,
          codeIdentities: codes,
          strings: { types: f.stringTypes, key: f.stringTypes.key, utf8Storage: f.stringTypes.utf8Storage },
        },
        f.requests,
      ),
    ).toThrow("code identities omit or substitute original source units");
    expect([f.module.types.length, f.module.functions.length, f.module.globals.length]).toEqual(before);
  });
  it("preflights duplicate declarations without consuming a partial prefix", () => {
    const f = publicRealmFoundation(),
      c = publicRealmClosures(f, true, true);
    const before = [f.module.types.length, f.module.globals.length, f.module.functions.length];
    expect(() => reserveNativeRealmSourceCodeIdentities(f.tx, f.realm, f.pack)).toThrow(
      "duplicate planned resource key",
    );
    expect([f.module.types.length, f.module.globals.length, f.module.functions.length]).toEqual(before);
    expect(c.carriers!.codeIdentities!.completionScope).toBe("source-code-declarations");
  });
  it("never reads an accessor or inherited allocator operand", () => {
    const base = { structTypeIdx: 1, funcTypeIdx: 2, funcFieldIdx: 0, capFieldIdx: (i: number) => i + 3 };
    expect(buildNativeSourceCodeIdentityOperand(base)).toEqual([]);
    const getter = vi.fn(() => {
      throw Error("getter invoked");
    });
    expect(() =>
      buildNativeSourceCodeIdentityOperand(
        Object.defineProperty({ ...base }, "nativeSourceCodeIdentityGlobal", { get: getter, enumerable: true }),
      ),
    ).toThrow("invalid native allocator operand");
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      buildNativeSourceCodeIdentityOperand(Object.assign(Object.create({ nativeSourceCodeIdentityGlobal: 0 }), base)),
    ).toThrow("inherited allocator operand");
    expect(() =>
      buildNativeSourceCodeIdentityOperand({ ...base, nativeSourceCodeIdentityGlobal: 1 } as typeof base),
    ).toThrow("invalid native allocator operand");
  });
});
