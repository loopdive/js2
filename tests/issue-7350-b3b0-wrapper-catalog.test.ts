// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #7350 B3b-0: the wrapper families' catalog data (constructors, prototypes, statics and methods), checked against the
// host engine; (#7561) each member held on its own, and the gate that keeps a constructor's statics out of every realm.
import { describe, expect, it } from "vitest";
import {
  NATIVE_REALM_CATALOG,
  NATIVE_WRAPPER_CONSTRUCTORS,
  modelledRow,
  type NativeRealmIntrinsic,
} from "../src/runtime/contracts/native-realm-catalog.js";
import {
  BUILTIN_REACHABLE_KEYS,
  OBJECT_PROTOTYPE_KEYS,
  realmStringKeys,
} from "../src/ir/program/builtin-prototype-keys.js";

const row = (id: string): NativeRealmIntrinsic => NATIVE_REALM_CATALOG.intrinsics.find((row) => row.id === id)!;
const host = { String, Number, Boolean } as const;
// The global functions themselves (§21.1.2.12-13): rows once `parseFloat` / `parseInt` are.
const DEFERRED_STATICS = new Set(["parseFloat", "parseInt"]);

describe("#7350 B3b-0 wrapper catalog rows", () => {
  for (const name of NATIVE_WRAPPER_CONSTRUCTORS) {
    const ctor = row(`%${name}%`),
      prototype = row(`%${name}.prototype%`),
      hostCtor = host[name] as unknown as Record<string, unknown>,
      hostPrototype = host[name].prototype as unknown as Record<string, unknown>;

    it(`${name}: the constructor's own properties are the host's`, () => {
      expect(ctor.callable).toMatchObject({ initialName: name, length: 1, implementation: "native" });
      expect(ctor.constructible).toBe(true);
      const keys = Object.getOwnPropertyNames(hostCtor).filter((key) => !DEFERRED_STATICS.has(key));
      expect([...realmStringKeys(ctor.id)].sort()).toEqual(keys.sort());
      expect(ctor.properties.find(({ key }) => key.value === "prototype")).toMatchObject({
        kind: "data",
        value: { kind: "intrinsic", id: prototype.id },
        writable: false,
        enumerable: false,
        configurable: false,
      });
    });

    it(`${name}: its prototype is a wrapper of the primitive data, with the host's keys`, () => {
      expect(prototype).toMatchObject({
        prototype: "%Object.prototype%",
        extensible: true,
        heldWith: prototype.id,
        primitiveData: host[name].prototype.valueOf(),
      });
      expect(prototype.callable).toBeUndefined();
      // (#7561) String.prototype's own `length` 0 is a catalog property.
      const keys = Object.getOwnPropertyNames(hostPrototype);
      expect([...realmStringKeys(prototype.id)].sort()).toEqual(keys.sort());
      expect(prototype.properties.find(({ key }) => key.value === "constructor")).toMatchObject({
        value: { kind: "intrinsic", id: ctor.id },
        writable: true,
        configurable: true,
      });
    });

    it(`${name}: every method and static is a function row with the host's name and length`, () => {
      for (const [owner, hostOwner] of [
        [ctor, hostCtor],
        [prototype, hostPrototype],
      ] as const)
        for (const property of owner.properties) {
          if (property.kind !== "data" || property.value.kind !== "intrinsic") continue;
          if (property.key.value === "constructor" || property.key.value === "prototype") continue;
          const method = row(property.value.id),
            hostMethod = hostOwner[property.key.value] as (...args: unknown[]) => unknown;
          expect(method.heldWith).toBe(method.id);
          expect(method.prototype).toBe("%Function.prototype%");
          expect(method.constructible).toBe(false);
          expect(method.callable).toMatchObject({ initialName: hostMethod.name, length: hostMethod.length });
          expect(method.callable!.requires.length).toBeGreaterThan(0);
          expect({ writable: property.writable, configurable: property.configurable }).toEqual({
            writable: true,
            configurable: true,
          });
        }
    });

    it(`${name}: (#7561) only valueOf and toString are native, and a realm models the constructor's identity`, () => {
      const members = [...ctor.properties, ...prototype.properties].flatMap((property) =>
        property.kind === "data" && property.value.kind === "intrinsic" && property.key.value !== "constructor"
          ? [row(property.value.id)]
          : [],
      );
      expect(
        members.filter((member) => member.callable?.implementation === "native").map((member) => member.id),
      ).toEqual([`%${name}.prototype.toString%`, `%${name}.prototype.valueOf%`]);
      expect(modelledRow(prototype)).toBe(prototype);
      expect(modelledRow(ctor).properties.map(({ key }) => key.value)).toEqual(ctor.identityOnly);
    });
  }

  it("Number's value properties are the host's {!w, !e, !c} numbers; a realm models B3a's five", () => {
    const ctor = row("%Number%");
    const constants = ctor.properties.filter(
      (property) => property.kind === "data" && property.value.kind === "number" && property.key.value !== "length",
    );
    expect(constants.map(({ key }) => key.value)).toEqual([
      "MAX_VALUE",
      "MIN_VALUE",
      "NaN",
      "NEGATIVE_INFINITY",
      "POSITIVE_INFINITY",
      "EPSILON",
      "MAX_SAFE_INTEGER",
      "MIN_SAFE_INTEGER",
    ]);
    for (const property of constants) {
      const descriptor = Object.getOwnPropertyDescriptor(Number, property.key.value)!;
      expect(property).toMatchObject({ writable: false, enumerable: false, configurable: false });
      expect(property.kind === "data" && property.value.kind === "number" && property.value.value).toBe(
        descriptor.value,
      );
    }
    expect(ctor.identityOnly).toEqual([
      "length",
      "name",
      "MAX_VALUE",
      "MIN_VALUE",
      "NaN",
      "NEGATIVE_INFINITY",
      "POSITIVE_INFINITY",
      "prototype",
    ]);
    expect(row("%String%").identityOnly).toEqual(["length", "name", "prototype"]);
    expect(row("%Boolean%").identityOnly).toEqual(["length", "name", "prototype"]);
  });

  it("String's Annex B members are legacy, and trimLeft / trimRight are trimStart / trimEnd", () => {
    const prototype = row("%String.prototype%");
    const property = (key: string) => prototype.properties.find((row) => row.key.value === key)!;
    expect(property("trimLeft")).toMatchObject({ value: { id: "%String.prototype.trimStart%" }, legacy: true });
    expect(property("trimRight")).toMatchObject({ value: { id: "%String.prototype.trimEnd%" }, legacy: true });
    expect(row("%String.prototype.substr%")).toMatchObject({ legacy: true, normativeOptional: true });
    expect(property("substr")).toMatchObject({ legacy: true, normativeOptional: true });
    expect(property("trimStart").legacy).toBeUndefined();
  });

  it("(criterion 9, #7561) a primitive's reachable keys are its prototype's and Object.prototype's, as the host's", () => {
    const union = (...sets: Iterable<string>[]) => [...new Set(sets.flatMap((set) => [...set]))].sort();
    const hostKeys = (value: object) => Object.getOwnPropertyNames(value);
    for (const [kind, name] of [
      ["number", "Number"],
      ["boolean", "Boolean"],
      ["string", "String"],
    ] as const)
      expect(union(BUILTIN_REACHABLE_KEYS[kind], OBJECT_PROTOTYPE_KEYS)).toEqual(
        union(hostKeys(host[name].prototype), hostKeys(Object.prototype)),
      );
  });
});
