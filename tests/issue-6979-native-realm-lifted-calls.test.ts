// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  liftedIds,
  liftedOwnerFixture,
  fillLiftedOwnerFixture,
  liftedComponentRuntime,
} from "./helpers/native-realm-lifted-calls.js";
import {
  reserveNativeRealmLiftedCalls,
  requireNativeRealmLiftedCalls,
  fillNativeRealmLiftedCalls,
  requireCompletedNativeRealmLiftedCalls,
  requireCompletedNativeObjectRealm,
  requireCompletedNativeRealmBaseAlgorithms,
} from "../src/backend/wasmgc/resources/native-object-realm.js";
import { requireCompletedNativeObjectIsAlgorithm } from "../src/backend/wasmgc/resources/native-object-is.js";

afterEach(async () => await setImmediate());
for (const [displaced, decoded] of [
  [false, false],
  [true, false],
  [true, true],
] as const)
  describe(`owned lifted component displaced=${displaced} decoded=${decoded}`, () => {
    let r: ReturnType<typeof liftedComponentRuntime>;
    beforeAll(() => {
      r = liftedComponentRuntime(displaced, decoded);
      console.info(
        "lifted-call component witness",
        JSON.stringify({
          displaced,
          decoded,
          bytes: r.bytes.length,
          sha256: createHash("sha256").update(r.bytes).digest("hex"),
          imports: WebAssembly.Module.imports(r.module),
          wholeRealmCompleted: false,
        }),
      );
    }, 120000);
    const caught = (run: () => unknown, message: unknown) => {
      let error: unknown;
      try {
        run();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(WebAssembly.Exception);
      const exception = error as WebAssembly.Exception;
      expect(exception.is(r.ex.exception)).toBe(true);
      const value = exception.getArg(r.ex.exception, 0);
      expect(r.ex.errorTag(value)).toBe(-11);
      expect(Object.is(r.ex.errorMessage(value), message)).toBe(true);
    };
    it("executes the genuine canonical algorithms through guarded and stored lifted Call entries with zero imports", () => {
      r.ex.initialize();
      expect(WebAssembly.Module.imports(r.module)).toEqual([]);
      expect(r.entries.map((entry) => entry.id)).toEqual(liftedIds);
      const argv = r.vector([]),
        fp = r.ex["0:singleton"].value;
      for (const receiver of [null, undefined, 7, { receiver: true }]) {
        expect(Object.is(r.ex["0:call"](fp, receiver, argv), r.ex.undefinedValue())).toBe(true);
        expect(Object.is(r.ex["0:storedCall"](fp, receiver, argv), r.ex.undefinedValue())).toBe(true);
      }
      const native = r.ex["2:singleton"].value;
      const a = r.ex.boxNumber(NaN),
        b = r.ex.boxNumber(NaN);
      expect(r.ex.unboxBoolean(r.ex["2:storedCall"](native, fp, r.vector([a, b])))).toBe(1);
      expect(r.ex.unboxBoolean(r.ex["2:call"](native, null, r.vector([r.ex.boxNumber(0), r.ex.boxNumber(-0)])))).toBe(
        0,
      );
      expect(r.ex.unboxBoolean(r.ex["2:call"](native, null, r.vector([])))).toBe(1);
      const large = r.vector([a, b, ...Array.from({ length: 100 }, (_, index) => r.ex.boxNumber(index))]);
      expect(r.ex.unboxBoolean(r.ex["2:call"](native, null, large))).toBe(1);
    });
    it("propagates the exact public tag and canonical restricted-property TypeError payload", () => {
      r.ex.initialize();
      caught(() => r.ex["1:storedCall"](r.ex["1:singleton"].value, null, r.vector([])), r.ex.restricted());
    });
    it.each([0, 1, 2])(
      "refuses clone, wrong metadata, foreign realm, wrong signature and cross-entry self for entry %s",
      (index) => {
        r.ex.initialize();
        const argv = r.vector([]),
          method = r.ex[index + ":call"];
        for (const fields of [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ]) {
          const clone = r.ex[index + ":clone"](...fields);
          caught(() => method(clone, null, argv), r.ex.incompatible());
        }
        caught(() => method(r.ex[((index + 1) % 3) + ":singleton"].value, null, argv), r.ex.incompatible());
      },
    );
    it("does not treat a replaced extern singleton or stale realm as native receiver authority", () => {
      r.ex.initialize();
      const old = r.ex["0:singleton"].value,
        argv = r.vector([]);
      r.ex["0:singleton"].value = { forged: true };
      caught(() => r.ex["0:call"](old, null, argv), r.ex.incompatible());
      r.ex.initialize();
      caught(() => r.ex["0:call"](old, null, argv), r.ex.incompatible());
      expect(Object.is(r.ex["0:call"](r.ex["0:singleton"].value, null, argv), r.ex.undefinedValue())).toBe(true);
    });
  });

describe("genuine owned catalog lifted Call producer", () => {
  it("borrows only the actual three reserved slots, without allocating another algorithm or widening completion", () => {
    const f = liftedOwnerFixture();
    expect(f.lifted.entries.map((entry) => entry.request.intrinsic.id)).toEqual(liftedIds);
    expect(f.lifted.completionScope).toBe("owned-catalog-lifted-calls");
    for (const entry of f.lifted.entries) expect(f.declarations.entries.includes(entry)).toBe(true);
    expect(requireNativeRealmLiftedCalls(f.tx, f.lifted, f.declarations)).toBe(f.lifted);
    expect(() => reserveNativeRealmLiftedCalls(f.tx, f.declarations)).toThrow(/already/);
    expect(() => requireNativeRealmLiftedCalls(f.tx, { ...f.lifted }, f.declarations)).toThrow(/copied/);
    const other = liftedOwnerFixture(true);
    expect(() => requireNativeRealmLiftedCalls(other.tx, f.lifted, f.declarations)).toThrow(/foreign/);
    expect(() => requireNativeRealmLiftedCalls(f.tx, f.lifted, other.declarations)).toThrow(/different expected/);
    expect(() => requireCompletedNativeRealmLiftedCalls(f.tx, f.lifted)).toThrow(/missing canonical/);
  });
  it("fills genuine owned entries after canonical dependencies, never the remaining catalog/source/population", () => {
    const f = liftedOwnerFixture(true, true);
    f.tx.freezeReservations();
    expect(() => fillNativeRealmLiftedCalls(f.tx, f.lifted)).toThrow(/missing canonical|missing|incomplete/);
    expect(f.lifted.entries.every((entry) => entry.lifted.object.body.length === 0)).toBe(true);
    fillLiftedOwnerFixture(f);
    fillNativeRealmLiftedCalls(f.tx, f.lifted);
    expect(requireCompletedNativeRealmLiftedCalls(f.tx, f.lifted)).toBe(f.lifted);
    expect(
      f.declarations.entries
        .filter((entry) => !f.lifted.entries.includes(entry))
        .every((entry) => entry.algorithm.object.body.length === 0 && entry.lifted.object.body.length === 0),
    ).toBe(true);
    expect(() => requireCompletedNativeObjectRealm(f.tx, f.declarations)).toThrow(/remain incomplete/);
    expect(() => fillNativeRealmLiftedCalls(f.tx, f.lifted)).toThrow(/duplicate/);
  });
  it.each(liftedIds)("independently rejects an intercepted canonical algorithm fill for %s", (id) => {
    const f = liftedOwnerFixture();
    const target = f.lifted.entries.find((entry) => entry.request.intrinsic.id === id)!.algorithm;
    const fill = f.tx.fillFunction.bind(f.tx);
    f.tx.fillFunction = (token, definition) =>
      fill(token, token === target ? { locals: [], body: [{ op: "ref.null.extern" }] } : definition);
    fillLiftedOwnerFixture(f);
    expect(() => f.tx.assertCompletedReservation(target)).not.toThrow();
    const check =
      id === "%Object.is%"
        ? () => requireCompletedNativeObjectIsAlgorithm(f.tx, f.objectIs)
        : () => requireCompletedNativeRealmBaseAlgorithms(f.tx, f.base);
    expect(check).toThrow(/noncanonical function definition/);
    expect(() => requireCompletedNativeRealmLiftedCalls(f.tx, f.lifted)).toThrow();
    expect(f.lifted.entries.every((entry) => entry.lifted.object.body.length === 0)).toBe(true);
  });
  it.each(liftedIds)("rejects a substituted lifted body even when its allocator receipt says complete: %s", (id) => {
    const f = liftedOwnerFixture();
    fillLiftedOwnerFixture(f);
    const target = f.lifted.entries.find((entry) => entry.request.intrinsic.id === id)!.lifted;
    const fill = f.tx.fillFunction.bind(f.tx);
    f.tx.fillFunction = (token, definition) =>
      fill(token, token === target ? { locals: [], body: [{ op: "ref.null.extern" }] } : definition);
    fillNativeRealmLiftedCalls(f.tx, f.lifted);
    expect(() => f.tx.assertCompletedReservation(target)).not.toThrow();
    expect(() => requireCompletedNativeRealmLiftedCalls(f.tx, f.lifted)).toThrow(/noncanonical function definition/);
  });
  it("does not certify a caller-filled final slot or permit retry after a partial fill failure", () => {
    const f = liftedOwnerFixture();
    fillLiftedOwnerFixture(f);
    const last = f.lifted.entries.at(-1)!.lifted;
    f.tx.fillFunction(last, { locals: [], body: [{ op: "ref.null.extern" }] });
    expect(() => fillNativeRealmLiftedCalls(f.tx, f.lifted)).toThrow(/duplicate/);
    expect(f.tx.state).toBe("failed");
    expect(() => requireCompletedNativeRealmLiftedCalls(f.tx, f.lifted)).toThrow(/in failed/);
    expect(() => fillNativeRealmLiftedCalls(f.tx, f.lifted)).toThrow(/in failed/);
    expect(() => requireCompletedNativeObjectRealm(f.tx, f.declarations)).toThrow(/in failed/);
  });
});
