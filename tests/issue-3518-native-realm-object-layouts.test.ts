// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { emitBinary } from "../src/emit/binary.js";
import {
  declareNativeRealmObjectLayouts,
  reserveNativeRealmObjectLayouts,
  requireNativeRealmObjectLayouts,
  fillNativeRealmObjectLayouts,
  requireCompletedNativeRealmObjectLayouts,
  nativeRealmObjectLayoutReservationInventory,
} from "../src/backend/wasmgc/resources/native-realm-object-layouts.js";
import {
  requireNativeSourceClosureTypes,
  reserveNativeSourceClosureTypes,
} from "../src/backend/wasmgc/resources/native-source-closures.js";
import {
  realmLayoutFoundation,
  realmLayoutFixture,
  realmLayoutRuntime,
  realmSourceRuntime,
  realmSourceFixture,
  i32,
} from "./helpers/native-realm-object-layouts.js";

afterEach(async () => {
  await setImmediate();
});

for (const displaced of [false, true])
  describe("authentic realm carrier state, displaced=" + displaced, () => {
    let r: ReturnType<typeof realmLayoutRuntime>;
    beforeAll(() => {
      r = realmLayoutRuntime(displaced);
    });
    it("executes real zero-import initializer code without a population/readiness grant", () => {
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.f.pack.completionScope).toBe("realm-carrier-state-only");
      const inventory = nativeRealmObjectLayoutReservationInventory(r.f.tx, r.f.pack);
      expect(inventory.types).toHaveLength(4);
      expect(inventory.globals).toHaveLength(2);
      expect(inventory.functions).toHaveLength(1);
      expect(() => r.instance().state!()).toThrow(WebAssembly.RuntimeError);
      const partial = r.instance();
      partial.initialize!(null);
      expect(() => partial.state!()).toThrow(WebAssembly.RuntimeError);
    });
    it("retains exact mutable prototype and immutable realm allocation identity in fresh independent states", () => {
      const a = r.instance(),
        b = r.instance(),
        prototype = { control: "prototype operand" };
      a.initialize!(prototype);
      b.initialize!(prototype);
      const first = a.state!(),
        second = a.state!(),
        foreign = b.state!();
      expect(Object.is(first, second)).toBe(false);
      expect(Object.is(a.prototype!(first), prototype)).toBe(true);
      expect(Object.is(a.realm!(first), a.realm!(second))).toBe(true);
      expect(Object.is(a.realm!(first), b.realm!(foreign))).toBe(false);
      for (const value of [null, undefined, 17, "prototype operand"]) {
        a.setPrototype!(first, value);
        expect(Object.is(a.prototype!(first), value)).toBe(true);
        expect(Object.is(a.prototype!(second), prototype)).toBe(true);
      }
    });
    it("retains the six-field storage prefix and places state only on concrete ordinary carriers", () => {
      const { objects, pack } = r.f;
      for (const type of [objects.object, pack.types.objectPrototype, pack.types.ordinary, pack.types.state])
        expect(type.object.kind).toBe("struct");
      if (
        objects.object.object.kind !== "struct" ||
        pack.types.objectPrototype.object.kind !== "struct" ||
        pack.types.ordinary.object.kind !== "struct" ||
        pack.types.state.object.kind !== "struct"
      )
        throw new Error("missing real structs");
      expect(objects.object.object.fields).toHaveLength(6);
      expect(pack.types.objectPrototype.object).toMatchObject({ superTypeIdx: objects.object.typeIndex, final: true });
      expect(pack.types.objectPrototype.object.fields).toEqual(objects.object.object.fields);
      expect(pack.types.ordinary.object.fields.slice(0, 6)).toEqual(objects.object.object.fields);
      expect(pack.types.ordinary.object.fields[6]).toEqual({
        name: "[[ObjectState]]",
        mutable: false,
        type: { kind: "ref", typeIdx: pack.types.state.typeIndex },
      });
      expect(pack.types.state.object.fields[1]!.mutable).toBe(false);
    });
  });

describe("realm carrier issuer boundaries", () => {
  it("rejects final storage roots before allocation", () => {
    const f = realmLayoutFoundation(false, false),
      before = structuredClone(f.module);
    expect(() => reserveNativeRealmObjectLayouts(f.tx, "realm-layout", f.dependencies, f.plan)).toThrow(
      /explicit extensible root/,
    );
    expect(f.module).toEqual(before);
  });
  it("rejects copied and foreign owners while the original remains current", () => {
    const f = realmLayoutFixture(),
      other = realmLayoutFixture();
    expect(requireNativeRealmObjectLayouts(f.tx, f.pack)).toBe(f.pack);
    expect(() => requireNativeRealmObjectLayouts(f.tx, { ...f.pack })).toThrow(/foreign or copied/);
    expect(() => requireNativeRealmObjectLayouts(other.tx, f.pack)).toThrow(/foreign or copied/);
    expect(() => requireNativeRealmObjectLayouts(f.tx, f.pack, other.dependencies)).toThrow(/foreign expected/);
  });
  it.each([null, false, 0, ""])("rejects malformed explicit expected dependencies %s", (value) => {
    const f = realmLayoutFixture();
    expect(() => requireNativeRealmObjectLayouts(f.tx, f.pack, value as never)).toThrow(/plain data/);
    expect(requireNativeRealmObjectLayouts(f.tx, f.pack, f.dependencies)).toBe(f.pack);
  });
  it.each(["accessor", "hidden", "inherited", "extra"])(
    "refuses %s dependency roles without callbacks or allocation",
    (kind) => {
      const f = realmLayoutFoundation(),
        before = structuredClone(f.module);
      let reads = 0;
      const input = kind === "inherited" ? Object.create(f.dependencies) : { ...f.dependencies };
      if (kind === "accessor")
        Object.defineProperty(input, "objects", {
          get() {
            reads++;
            return f.objects;
          },
          enumerable: true,
        });
      if (kind === "hidden") Object.defineProperty(input, "objects", { value: f.objects, enumerable: false });
      if (kind === "extra") input.extra = f.objects;
      expect(() => reserveNativeRealmObjectLayouts(f.tx, "realm-layout", input, f.plan)).toThrow(/dependenc/);
      expect(reads).toBe(0);
      expect(f.module).toEqual(before);
    },
  );
  it("rejects a nonstring key without coercion or allocation", () => {
    const f = realmLayoutFoundation(),
      before = structuredClone(f.module);
    let reads = 0;
    expect(() =>
      declareNativeRealmObjectLayouts(
        {
          toString() {
            reads++;
            return "realm-layout";
          },
        } as never,
        f.objects.object.key,
        f.objects.propMap.key,
      ),
    ).toThrow(/invalid declaration key/);
    expect(reads).toBe(0);
    expect(f.module).toEqual(before);
  });
  it("preflights the last initializer key before reserving any owner resource", () => {
    const f = realmLayoutFoundation(),
      last = f.plan.declarations.at(-1)!;
    f.tx.reserveGlobal(last.key, "collision", i32, false);
    const before = structuredClone(f.module);
    expect(() => reserveNativeRealmObjectLayouts(f.tx, "realm-layout", f.dependencies, f.plan)).toThrow(
      /already reserved|duplicate/,
    );
    expect(f.module).toEqual(before);
  });
  it("rejects mutated retained plans and dependency substitution", () => {
    const f = realmLayoutFixture();
    (f.plan.declarations[0]!.role as string[]).push("changed");
    expect(() => requireNativeRealmObjectLayouts(f.tx, f.pack)).toThrow(/changed retained declaration/);
    const second = realmLayoutFixture(),
      third = realmLayoutFixture();
    second.dependencies.objectPlan = third.objectPlan;
    expect(() => requireNativeRealmObjectLayouts(second.tx, second.pack)).toThrow(/changed dependency identity/);
  });
  it("requires canonical fill and refuses duplicate or externally filled initializers", () => {
    const f = realmLayoutFixture();
    f.tx.freezeReservations();
    expect(() => requireCompletedNativeRealmObjectLayouts(f.tx, f.pack)).toThrow(/missing canonical/);
    fillNativeRealmObjectLayouts(f.tx, f.pack);
    expect(requireCompletedNativeRealmObjectLayouts(f.tx, f.pack)).toBe(f.pack);
    expect(() => fillNativeRealmObjectLayouts(f.tx, f.pack)).toThrow(/duplicate/);
    const second = realmLayoutFixture();
    second.tx.freezeReservations();
    second.tx.fillFunction(second.pack.sourceInitializer, { locals: [], body: [{ op: "unreachable" }] });
    expect(() => fillNativeRealmObjectLayouts(second.tx, second.pack)).toThrow(/already filled|completed|duplicate/);
    expect(() => requireCompletedNativeRealmObjectLayouts(second.tx, second.pack)).toThrow();
  });
  it.each(["body", "locals"])("refuses ledger-completed valid-Wasm wrong initializer %s", (kind) => {
    const f = realmLayoutFixture(),
      original = f.tx.fillFunction.bind(f.tx);
    f.tx.fillFunction = (token, definition) =>
      original(
        token,
        token !== f.pack.sourceInitializer
          ? definition
          : kind === "locals"
            ? { ...definition, locals: [{ name: "wrong", type: i32 }] }
            : {
                locals: [],
                body: [
                  { op: "ref.null.extern" },
                  { op: "struct.new", typeIdx: f.pack.types.identity.typeIndex },
                  { op: "struct.new", typeIdx: f.pack.types.state.typeIndex },
                ],
              },
      );
    f.tx.freezeReservations();
    fillNativeRealmObjectLayouts(f.tx, f.pack);
    expect(() => new WebAssembly.Module(emitBinary(f.module) as BufferSource)).not.toThrow();
    expect(() => requireCompletedNativeRealmObjectLayouts(f.tx, f.pack)).toThrow(/noncanonical anchor or initializer/);
  });
  it("refuses post-fill body mutation", () => {
    const f = realmLayoutFixture();
    f.tx.freezeReservations();
    fillNativeRealmObjectLayouts(f.tx, f.pack);
    f.pack.sourceInitializer.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeRealmObjectLayouts(f.tx, f.pack)).toThrow(
      "physical module reservations: altered completed function realm-layout:sourceInitializer",
    );
  });
});

for (const displaced of [false, true])
  for (const decoded of [false, true])
    describe(`genuine source state, displaced=${displaced}, decoded=${decoded}`, () => {
      let r: ReturnType<typeof realmSourceRuntime>;
      beforeAll(() => {
        r = realmSourceRuntime(displaced, decoded);
      });
      it("preserves genuine capture and zero-capture source bodies with real allocations and no imports", () => {
        expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
        expect(r.f.requirements.shapes.map((s) => s.captures.length).sort()).toEqual([0, 1]);
        for (const shape of r.f.source.types.shapes) {
          const count = r.f.requirements.shapes.find((s) => s.id === shape.id)!.captures.length;
          expect(shape.type.object.kind).toBe("struct");
          if (shape.type.object.kind !== "struct") throw new Error("missing source carrier");
          expect(shape.type.object.fields).toHaveLength(4 + count);
          expect(shape.type.object.fields.slice(3).every((field) => !field.mutable)).toBe(true);
          expect(shape.lowering.realmStateInitializer).toBe(r.f.pack.sourceInitializer.handle);
        }
        const a = r.instance(),
          b = r.instance(),
          prototype = { control: "initializer operand" };
        expect(() => a.makeCaptured!(4)).toThrow(WebAssembly.RuntimeError);
        a.initialize!(prototype);
        b.initialize!(prototype);
        const first = a.makeCaptured!(13),
          second = a.makeCaptured!(100),
          empty = a.makeEmpty!(),
          foreign = b.makeCaptured!(13);
        expect(a.call!(first, 2)).toBe(15);
        expect(a.call!(second, 2)).toBe(102);
        expect(a.call!(empty, 2)).toBe(9);
        expect(a.call!(first, -2)).toBe(11);
        const firstState = a.state1!(first),
          secondState = a.state1!(second),
          emptyState = a.state0!(empty);
        expect(Object.is(firstState, secondState)).toBe(false);
        for (const state of [firstState, secondState, emptyState]) {
          expect(Object.is(a.prototype!(state), prototype)).toBe(true);
          expect(Object.is(a.realm!(state), a.realm!(firstState))).toBe(true);
        }
        expect(Object.is(a.realm!(firstState), b.realm!(b.state1!(foreign)))).toBe(false);
      });
    });

describe("source state option authority", () => {
  it.each(["undefined", "copy", "accessor", "hidden"])("rejects %s state option before source allocation", (kind) => {
    const f = realmSourceFixture(),
      input = { ...f.carriers };
    let reads = 0;
    if (kind === "undefined") input.realmState = undefined as never;
    if (kind === "copy") input.realmState = { ...f.pack };
    if (kind === "accessor")
      Object.defineProperty(input, "realmState", {
        get() {
          reads++;
          return f.pack;
        },
        enumerable: true,
      });
    if (kind === "hidden") Object.defineProperty(input, "realmState", { value: f.pack, enumerable: false });
    const before = structuredClone(f.module);
    expect(() => reserveNativeSourceClosureTypes(f.tx, f.requirements, input)).toThrow(/realm state|foreign or copied/);
    expect(reads).toBe(0);
    expect(f.module).toEqual(before);
  });
  it("rejects same-ledger genuine state replacement and removal after source issuance", () => {
    const f = realmSourceFixture();
    const other = reserveNativeRealmObjectLayouts(
      f.tx,
      "other-realm",
      f.dependencies,
      declareNativeRealmObjectLayouts("other-realm", f.objects.object.key, f.objects.propMap.key),
    );
    f.carriers.realmState = other;
    expect(() => requireNativeSourceClosureTypes(f.tx, f.source.types, f.requirements)).toThrow(
      /changed realm state carrier identity/,
    );
    f.carriers.realmState = f.pack;
    expect(requireNativeSourceClosureTypes(f.tx, f.source.types, f.requirements)).toBe(f.source.types);
    Reflect.deleteProperty(f.carriers, "realmState");
    expect(() => requireNativeSourceClosureTypes(f.tx, f.source.types, f.requirements)).toThrow(
      /changed realm state carrier identity/,
    );
  });
});
