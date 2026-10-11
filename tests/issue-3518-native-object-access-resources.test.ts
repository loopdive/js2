// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import type { Instr } from "../src/wasm/model/instructions.js";
import {
  nativeObjectLookupReservationInventory,
  reserveNativeObjectLookupResources,
  requireNativeObjectLookupReservations,
  fillNativeObjectLookupResources,
  requireCompletedNativeObjectLookup,
} from "../src/backend/wasmgc/resources/native-object-access.js";
import { declareNativeObjectAccessResources } from "../src/backend/wasmgc/resources/native-object-access-declarations.js";
import {
  buildOrdinaryObjectGetDefinition,
  ORDINARY_OBJECT_READ_ENCODING,
  ORDINARY_OBJECT_READ_STATUS,
} from "../src/runtime/wasmgc/values/ordinary-object-access-bodies.js";
import {
  objectLookupFixture,
  completeObjectLookupFixture,
  fillObjectLookupDependencies,
  objectLookupRuntime,
  type ObjectLookupFixture,
} from "./helpers/native-object-access-fixture.js";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
function noAllocation(f: ObjectLookupFixture, run: () => unknown): void {
  const before = structuredClone(f.module),
    arrays = [f.module.types, f.module.functions, f.module.globals];
  expect(run).toThrow();
  expect(f.module).toStrictEqual(before);
  expect([f.module.types, f.module.functions, f.module.globals].every((v, i) => Object.is(v, arrays[i]))).toBe(true);
}
describe("issued ordinary key/lookup subgraph", () => {
  it("declares six joined functions and completes only its actual five-slot lookup owner", () => {
    const f = objectLookupFixture(true, true),
      inventory = nativeObjectLookupReservationInventory(f.tx, f.pack);
    const aggregate = declareNativeObjectAccessResources("reads", {
      object: "objects:object",
      propEntry: "objects:entry",
      nativeString: "strings:flat",
    });
    expect(aggregate.declarations.map((row) => row.role)).toEqual(
      ["hash", "keyEquals", "findOwn", "lookup", "has", "get"].map((role) => ["ordinary-object-access", role]),
    );
    expect(inventory.functions).toHaveLength(5);
    expect(inventory.plan.declarations).toHaveLength(5);
    expect(Object.is(requireNativeObjectLookupReservations(f.tx, f.pack, f.dependencies), f.pack)).toBe(true);
    expect(f.module.exports).toEqual([]);
    completeObjectLookupFixture(f);
    expect(Object.is(requireCompletedNativeObjectLookup(f.tx, f.pack, f.dependencies), f.pack)).toBe(true);
    expect(f.module.exports).toEqual([]);
    expect(
      nativeObjectLookupReservationInventory(f.tx, f.pack).functions.every((token, i) =>
        Object.is(token, inventory.functions[i]),
      ),
    ).toBe(true);
  });
  it.each(["layouts", "layoutPlan", "strings", "flatten", "equality", "symbols"] as const)(
    "rejects copied dependency %s before allocation",
    (role) => {
      const f = objectLookupFixture();
      const dependencies = { ...f.dependencies, [role]: { ...f.dependencies[role] } };
      noAllocation(f, () => reserveNativeObjectLookupResources(f.tx, "next", dependencies, f.plan));
    },
  );
  it.each(["layouts", "strings", "flatten", "equality", "symbols"] as const)(
    "rejects foreign-ledger %s before allocation",
    (role) => {
      const f = objectLookupFixture(),
        other = objectLookupFixture();
      const dependencies = { ...f.dependencies, [role]: other.dependencies[role] };
      noAllocation(f, () => reserveNativeObjectLookupResources(f.tx, "next", dependencies, f.plan));
    },
  );
  it("rejects a changed declaration signature before any reservation", () => {
    const f = objectLookupFixture(),
      plan = structuredClone(f.plan);
    const row = plan.declarations[0]!;
    if (row.space !== "function") throw Error("missing positive function declaration");
    (row.signature.results as { kind: string }[])[0] = { kind: "f64" };
    noAllocation(f, () => reserveNativeObjectLookupResources(f.tx, "reads", f.dependencies, plan));
  });
  it("preflights the last owned key before appending the first function", () => {
    const f = objectLookupFixture();
    const plan = declareNativeObjectAccessResources("next", {
      object: "objects:object",
      propEntry: "objects:entry",
      nativeString: "strings:flat",
    });
    f.tx.reserveFunction("next:has", "collision", { params: [], results: [] });
    const lookupPlan = {
      declarations: plan.declarations.slice(0, 5),
      reservationSteps: plan.reservationSteps.slice(0, 5),
    };
    noAllocation(f, () => reserveNativeObjectLookupResources(f.tx, "next", f.dependencies, lookupPlan));
  });
  it("rejects a copied owner and a substituted expected dependency object", () => {
    const f = objectLookupFixture();
    expect(Object.is(requireNativeObjectLookupReservations(f.tx, f.pack, f.dependencies), f.pack)).toBe(true);
    expect(() => requireNativeObjectLookupReservations(f.tx, { ...f.pack }, f.dependencies)).toThrow(
      "foreign or copied",
    );
    expect(() => requireNativeObjectLookupReservations(f.tx, f.pack, { ...f.dependencies })).toThrow(
      "foreign expected",
    );
  });
  it("detects changed retained dependency identities", () => {
    const f = objectLookupFixture(),
      other = objectLookupFixture();
    expect(Object.is(requireNativeObjectLookupReservations(f.tx, f.pack, f.dependencies), f.pack)).toBe(true);
    f.dependencies.symbols = other.symbols;
    expect(() => requireNativeObjectLookupReservations(f.tx, f.pack, f.dependencies)).toThrow("substituted dependency");
  });
  it("refuses incomplete dependencies and externally filled lookup functions", () => {
    const f = objectLookupFixture();
    f.tx.freezeReservations();
    expect(() => fillNativeObjectLookupResources(f.tx, f.pack)).toThrow();
    fillObjectLookupDependencies(f);
    f.tx.fillFunction(f.pack.hash, { locals: [], body: [{ op: "i32.const", value: 0 }] });
    expect(() => requireCompletedNativeObjectLookup(f.tx, f.pack, f.dependencies)).toThrow("missing canonical fill");
    expect(() => fillNativeObjectLookupResources(f.tx, f.pack)).toThrow("duplicate function fill");
    expect(f.tx.state).toBe("failed");
    expect(() => requireCompletedNativeObjectLookup(f.tx, f.pack, f.dependencies)).toThrow(
      "physical index requested in failed",
    );
  });
  it("rejects duplicate canonical fill and changed completed content", () => {
    const f = objectLookupFixture();
    completeObjectLookupFixture(f);
    expect(() => fillNativeObjectLookupResources(f.tx, f.pack)).toThrow("duplicate canonical fill");
    f.pack.has.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeObjectLookup(f.tx, f.pack, f.dependencies)).toThrow();
  });
});

describe("emitted lookup owner and Get body with controlled invocation", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)("preserves null/undefined shadowing and explicit-null misses (offset=%s UTF8=%s)", (offset, utf8) => {
    const { runtime: r } = objectLookupRuntime(undefined, offset, utf8),
      key = r.key(1),
      ancestor = r.make(null, 128),
      child = r.make(ancestor, 0),
      marker = {};
    r.putAt(ancestor, key, marker, 7, null, r.hash(key) & 7);
    expect(r.has(child, key)).toBe(1);
    expect(Object.is(r.get(child, key, child)[1], marker)).toBe(true);
    r.putAt(child, key, null, 7, null, r.hash(key) & 7);
    expect(r.get(child, key, child)).toEqual([1, null]);
    const undefinedValue = r.undefinedValue();
    r.putAt(child, key, undefinedValue, 7, null, r.hash(key) & 7);
    expect(r.has(child, key)).toBe(1);
    const result = r.get(child, key, child);
    expect(result[0]).toBe(1);
    expect(Object.is(result[1], undefinedValue)).toBe(true);
    const missing = r.get(child, r.key(2), child);
    expect(missing[0]).toBe(0);
    expect(Object.is(missing[1], undefinedValue)).toBe(true);
  });
  it("preserves the unresolved implicit terminal instead of declaring absence", () => {
    const { runtime: r } = objectLookupRuntime(),
      parent = r.make(null, 0),
      child = r.make(parent, 128),
      key = r.key(2);
    expect(r.has(child, key)).toBe(2);
    expect(r.get(child, key, child)[0]).toBe(2);
    r.setFlags(parent, 128);
    expect(r.has(child, key)).toBe(0);
    r.setProto(child, r.make(null, 0));
    expect(r.has(child, key)).toBe(2);
  });
  it("compares native string content across flat, slice and rope keys", () => {
    const { runtime: r } = objectLookupRuntime(),
      object = r.make(null, 128),
      key = r.key(3),
      marker = {};
    r.putAt(object, key, marker, 7, null, r.hash(key) & 7);
    for (const probe of [r.flatAB(), r.sliceAB(), r.ropeAB()]) {
      expect(r.hash(probe)).toBe(r.hash(key));
      expect(r.has(object, probe)).toBe(1);
      expect(Object.is(r.get(object, probe, object)[1], marker)).toBe(true);
    }
  });
  it("keeps Symbol identity distinct from same-looking string and other Symbol IDs", () => {
    const { runtime: r } = objectLookupRuntime(),
      object = r.make(null, 128),
      symbol = r.symbol(0),
      value = {};
    r.putAt(object, symbol, value, 7, null, r.hash(symbol) & 7);
    expect(Object.is(r.symbol(0), symbol)).toBe(true);
    expect(r.has(object, r.symbol(0))).toBe(1);
    expect(r.has(object, r.symbol(8))).toBe(0);
    expect(r.has(object, r.key(5))).toBe(0);
  });
  it("continues through tombstones and colliding live keys", () => {
    const { runtime: r } = objectLookupRuntime(),
      object = r.make(null, 128),
      first = r.symbol(1),
      dead = r.symbol(9),
      last = r.symbol(17),
      marker = {};
    expect(r.hash(first) & 7).toBe(r.hash(dead) & 7);
    expect(r.hash(first) & 7).toBe(r.hash(last) & 7);
    r.putAt(object, first, {}, 7, null, 1);
    r.putAt(object, dead, {}, 128, null, 2);
    r.putAt(object, last, marker, 7, null, 3);
    expect(r.has(object, dead)).toBe(0);
    expect(r.has(object, last)).toBe(1);
    expect(Object.is(r.get(object, last, object)[1], marker)).toBe(true);
  });
  it("does not invoke getters for Has or an accessor with no getter", () => {
    let calls = 0;
    const { runtime: r } = objectLookupRuntime(() => {
        calls++;
        return null;
      }),
      object = r.make(null, 128),
      key = r.key(1);
    r.putAt(object, key, null, 8, null, r.hash(key) & 7);
    expect(r.has(object, key)).toBe(1);
    const result = r.get(object, key, object);
    expect(result[0]).toBe(1);
    expect(Object.is(result[1], r.undefinedValue())).toBe(true);
    expect(calls).toBe(0);
  });
  it("invokes the found getter exactly once with original Reflect receiver", () => {
    const seen: unknown[][] = [],
      receiver = {},
      getter = {},
      result = {};
    const { runtime: r } = objectLookupRuntime((actualReceiver, actualGetter) => {
      seen.push([actualReceiver, actualGetter]);
      return result;
    });
    const parent = r.make(null, 128),
      child = r.make(parent, 0),
      key = r.key(1);
    r.putAt(parent, key, null, 8, getter, r.hash(key) & 7);
    expect(r.has(child, key)).toBe(1);
    expect(seen).toHaveLength(0);
    const actual = r.get(child, key, receiver);
    expect(actual[0]).toBe(1);
    expect(Object.is(actual[1], result)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(Object.is(seen[0]![0], receiver)).toBe(true);
    expect(Object.is(seen[0]![1], getter)).toBe(true);
  });
  it("keeps outer presence across nested misses and preserves thrown getter identity", () => {
    let nestedStatus = -1,
      calls = 0;
    const getter = {},
      thrown = {},
      r = objectLookupRuntime((receiver, actualGetter) => {
        calls++;
        expect(Object.is(actualGetter, getter)).toBe(true);
        nestedStatus = r.get(receiver as object, r.key(2), receiver)[0];
        throw thrown;
      }).runtime;
    const object = r.make(null, 128),
      key = r.key(1);
    r.putAt(object, key, null, 8, getter, r.hash(key) & 7);
    let actual: unknown;
    try {
      r.get(object, key, object);
    } catch (error) {
      actual = error;
    }
    expect(Object.is(actual, thrown)).toBe(true);
    expect(calls).toBe(1);
    expect(nestedStatus).toBe(0);
    expect(r.has(object, key)).toBe(1);
  });
  it("does not turn an actual null or undefined getter result into a miss", () => {
    let returned: unknown = null;
    const { runtime: r } = objectLookupRuntime(() => returned),
      object = r.make(null, 128),
      key = r.key(1);
    r.putAt(object, key, null, 8, {}, r.hash(key) & 7);
    expect(r.get(object, key, object)).toEqual([1, null]);
    returned = r.undefinedValue();
    const result = r.get(object, key, object);
    expect(result[0]).toBe(1);
    expect(Object.is(result[1], returned)).toBe(true);
  });
  it("allocates fresh instruction graphs for repeated pure recipe construction", () => {
    const binding = { propEntryTypeIdx: 5, lookupIdx: 6, getterDispatchIdx: 7, undefinedGlobalIdx: 8 };
    const first = buildOrdinaryObjectGetDefinition(binding),
      second = buildOrdinaryObjectGetDefinition(binding);
    expect(first).toEqual(second);
    const objects = new Set<object>();
    const collect = (value: unknown, reject: boolean): void => {
      if (!value || typeof value !== "object") return;
      if (reject) expect(objects.has(value)).toBe(false);
      else objects.add(value);
      Object.values(value).forEach((child) => collect(child, reject));
    };
    collect(first, false);
    collect(second, true);
  });
  it("detects an executable wrong-receiver mutant after its genuine positive", () => {
    const observed: unknown[] = [],
      receiver = {};
    const control = (mutate?: (body: Instr[]) => Instr[]) => {
      const r = objectLookupRuntime(
        (value) => {
          observed.push(value);
          return null;
        },
        false,
        false,
        mutate,
      ).runtime;
      const object = r.make(null, 128),
        key = r.key(1);
      r.putAt(object, key, null, 8, {}, r.hash(key) & 7);
      expect(r.get(object, key, receiver)[0]).toBe(1);
    };
    control();
    expect(Object.is(observed[0], receiver)).toBe(true);
    const wrongReceiver = (body: Instr[]): Instr[] =>
      body.map((instruction): Instr => {
        if (instruction.op === "local.get" && instruction.index === 2) return { op: "ref.null.extern" };
        if (instruction.op === "if")
          return {
            ...instruction,
            then: wrongReceiver(instruction.then),
            ...(instruction.else ? { else: wrongReceiver(instruction.else) } : {}),
          };
        return { ...instruction };
      });
    control(wrongReceiver);
    expect(observed).toHaveLength(2);
    expect(Object.is(observed[1], receiver)).toBe(false);
    expect(observed[1]).toBeNull();
  });
  it("detects an executable value-slot corruption after the actual data positive", () => {
    const marker = {};
    const run = (mutate?: (body: Instr[]) => Instr[]) => {
      const r = objectLookupRuntime(undefined, false, false, mutate).runtime;
      const object = r.make(null, 128),
        key = r.key(1);
      r.putAt(object, key, marker, 7, null, r.hash(key) & 7);
      return r.get(object, key, object);
    };
    expect(Object.is(run()[1], marker)).toBe(true);
    const corrupt = run((body) =>
      body.map((instruction) =>
        instruction.op === "struct.get" && instruction.fieldIdx === 1 ? { ...instruction, fieldIdx: 4 } : instruction,
      ),
    );
    expect(corrupt[0]).toBe(1);
    expect(corrupt[1]).toBeNull();
    expect(Object.is(corrupt[1], marker)).toBe(false);
  });
});

it("retains the exact 712 source target and independent Node oracle without claiming native integration", () => {
  const source = readFileSync(
    new URL("./fixtures/issue-3518-native-object-access-712.ts.txt", import.meta.url),
    "utf8",
  );
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "c0550b99175c0eb61afa7d5d110a287f3fe90e9fc8e581c6d58a19fe0a971ba9",
  );
  const context = createContext({});
  runInContext(source.replace("export function", "function") + "\nthis.actual = run();", context);
  expect(context.actual).toBe(712);
  expect(ORDINARY_OBJECT_READ_ENCODING).toEqual({ accessor: 8, tombstone: 128, nullPrototype: 128 });
  expect(ORDINARY_OBJECT_READ_STATUS).toEqual({ absent: 0, present: 1, needsImplicitPrototype: 2 });
});

it("matches the live canonical legacy field flags without changing or replacing the old compiler", () => {
  const source = readFileSync(new URL("../src/codegen/object-runtime.ts", import.meta.url), "utf8");
  for (const [name, value] of [
    ["FLAG_ACCESSOR", 8],
    ["FLAG_TOMBSTONE", 128],
    ["OBJ_FLAG_NULL_PROTO", 128],
  ] as const) {
    const rows = [...source.matchAll(new RegExp("\\bconst " + name + " = (0x[0-9a-f]+);", "g"))];
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]![1])).toBe(value);
  }
});
