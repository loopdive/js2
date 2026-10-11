// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import {
  bindNativePrototypeSeederResources,
  buildNativePrototypeSeedDescriptorTail,
  buildNativePrototypeSeedDescriptorTails,
  requireNativePrototypeSeederBindings,
  type NativePrototypeSeedDescriptor,
} from "../src/backend/wasmgc/resources/native-prototype-seeder-bindings.js";
import { nativeObjectDescriptorReservationInventory } from "../src/backend/wasmgc/resources/native-object-descriptors.js";
import {
  assertNativePrototypeRequirementsCurrent,
  deriveNativePrototypeRequirements,
} from "../src/ir/program/native-prototype-requirements.js";
import { deriveNativeObjectAccessRequirements } from "../src/ir/program/native-object-access-requirements.js";
import { completeDescriptorFixture, descriptorFixture } from "./helpers/native-descriptor-fixture.js";
import {
  seederBindingFixture,
  seederDescriptorModule,
  seederDescriptorRuntime,
} from "./helpers/native-prototype-seeder-fixture.js";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

const method = { kind: "method", member: "valueOf" } as const;
const requireBinding = (f: ReturnType<typeof seederBindingFixture>) =>
  requireNativePrototypeSeederBindings(f.descriptors.tx, f.binding, f.requirements, f.dependencies);
const tail = (f: ReturnType<typeof seederBindingFixture>, descriptor: NativePrototypeSeedDescriptor = method) =>
  buildNativePrototypeSeedDescriptorTail(f.descriptors.tx, f.binding, f.requirements, f.dependencies, descriptor);
const tails = (f: ReturnType<typeof seederBindingFixture>, descriptors: readonly NativePrototypeSeedDescriptor[]) =>
  buildNativePrototypeSeedDescriptorTails(f.descriptors.tx, f.binding, f.requirements, f.dependencies, descriptors);

// Only read-only controls share these two fully built graphs. They do not
// mutate them; each tail call still authenticates current completion afresh.
const readOnlyPair = new Map<number, ReturnType<typeof seederBindingFixture>>();
function completedReadOnly(index: number) {
  let f = readOnlyPair.get(index);
  if (!f) {
    f = seederBindingFixture();
    completeDescriptorFixture(f.descriptors);
    Object.freeze(f.dependencies);
    readOnlyPair.set(index, Object.freeze(f));
  }
  return f;
}

describe("authentic prototype seeder descriptor bindings", () => {
  it("binds real source provenance without allocating or claiming missing builtin providers", () => {
    const d = descriptorFixture(),
      requirements = deriveNativePrototypeRequirements(d.access),
      dependencies = { descriptors: d.pack, descriptorDependencies: d.dependencies },
      before = structuredClone(d.module);
    const binding = bindNativePrototypeSeederResources(d.tx, requirements, dependencies);
    expect(Object.is(requireNativePrototypeSeederBindings(d.tx, binding, requirements, dependencies), binding)).toBe(
      true,
    );
    expect(binding.requirements).toBe(requirements);
    expect(binding.gaps).toBe(requirements.gaps);
    expect(binding.gaps.some((gap) => gap.detail.includes("executable provider closure"))).toBe(true);
    expect(binding.completionScope).toBe("descriptor-bindings");
    expect(d.module).toStrictEqual(before);
  });

  it("distinguishes reservation authentication from real descriptor completion", () => {
    const f = seederBindingFixture();
    requireBinding(f);
    const before = structuredClone(f.descriptors.module);
    expect(() => tail(f)).toThrow("missing canonical fill");
    expect(f.descriptors.module).toStrictEqual(before);
    completeDescriptorFixture(f.descriptors);
    const inventory = nativeObjectDescriptorReservationInventory(
      f.descriptors.tx,
      f.descriptors.pack,
      f.descriptors.dependencies,
    );
    expect(tail(f)).toEqual([
      { op: "f64.const", value: 189 },
      { op: "call", funcIdx: inventory.functions[0]!.handle },
      { op: "drop" },
    ]);
    expect(inventory.functions[0]).not.toBe(f.descriptors.pack.defineData);
    expect(inventory.functions[1]).not.toBe(f.descriptors.pack.defineAccessor);
    expect(f.binding.gaps).toBe(f.requirements.gaps);
  });

  it.each(["binding", "requirements", "dependencies", "descriptors", "descriptorDependencies"] as const)(
    "rejects copied %s after an authentic positive",
    (role) => {
      const f = seederBindingFixture();
      requireBinding(f);
      const before = structuredClone(f.descriptors.module);
      if (role === "binding" || role === "requirements" || role === "dependencies") {
        expect(() =>
          requireNativePrototypeSeederBindings(
            f.descriptors.tx,
            role === "binding" ? { ...f.binding } : f.binding,
            role === "requirements" ? { ...f.requirements } : f.requirements,
            role === "dependencies" ? { ...f.dependencies } : f.dependencies,
          ),
        ).toThrow();
      } else {
        expect(() =>
          bindNativePrototypeSeederResources(f.descriptors.tx, f.requirements, {
            ...f.dependencies,
            [role]: { ...f.dependencies[role] },
          }),
        ).toThrow();
      }
      expect(f.descriptors.module).toStrictEqual(before);
    },
  );

  it("rejects an independently issued access census over the same source", () => {
    const f = seederBindingFixture();
    requireBinding(f);
    const access = deriveNativeObjectAccessRequirements(f.descriptors.program, f.descriptors.projection);
    const requirements = deriveNativePrototypeRequirements(access);
    expect(() => bindNativePrototypeSeederResources(f.descriptors.tx, requirements, f.dependencies)).toThrow(
      "different access requirement identity",
    );
  });

  it("rejects a foreign ledger and a foreign descriptor owner without mutation", () => {
    const f = seederBindingFixture(),
      other = seederBindingFixture();
    requireBinding(f);
    requireBinding(other);
    const before = structuredClone(f.descriptors.module);
    expect(() =>
      requireNativePrototypeSeederBindings(other.descriptors.tx, f.binding, f.requirements, f.dependencies),
    ).toThrow("foreign or copied binding");
    expect(() => bindNativePrototypeSeederResources(f.descriptors.tx, other.requirements, other.dependencies)).toThrow(
      "foreign or copied owner",
    );
    expect(f.descriptors.module).toStrictEqual(before);
  });

  it.each(["descriptors", "descriptorDependencies"] as const)("rejects substituted retained %s", (role) => {
    const f = seederBindingFixture();
    requireBinding(f);
    Object.assign(f.dependencies, { [role]: { ...f.dependencies[role] } });
    expect(() => requireBinding(f)).toThrow("substituted dependency identity");
  });

  it("rejects stale prototype issuer currentness after a genuine cloned-source positive", () => {
    const d = descriptorFixture();
    const program = structuredClone(d.program),
      projection = program.runtime[0]!,
      access = deriveNativeObjectAccessRequirements(program, projection),
      requirements = deriveNativePrototypeRequirements(access);
    expect(() => assertNativePrototypeRequirementsCurrent(requirements)).not.toThrow();
    const use = access.uses.find((row) => row.feature === "js.object.create-default")!;
    const instruction = access.demands.occurrences[use.occurrence]!.instruction;
    if (instruction.kind !== "call") throw Error("missing genuine source creation");
    Object.assign(instruction, { args: [99999] });
    expect(() => assertNativePrototypeRequirementsCurrent(requirements)).toThrow(
      "borrowed source changed after selection",
    );
  });

  it.each([0, 1])("materializes completed read-only descriptor owner %s for foreign-token controls", (index) => {
    const f = completedReadOnly(index);
    const inventory = nativeObjectDescriptorReservationInventory(
      f.descriptors.tx,
      f.descriptors.pack,
      f.descriptors.dependencies,
    );
    const actual = tails(f, [method, { kind: "getter" }]);
    expect(actual.map((body) => body[1])).toEqual(
      inventory.functions.slice(0, 2).map((token) => ({ op: "call", funcIdx: token.handle })),
    );
    expect(Object.isFrozen(inventory.functions)).toBe(true);
  });

  it.each([
    [0, method],
    [1, { kind: "getter" }],
  ] as const)("refuses foreign-ledger descriptor token %s with the same physical signature", (index, descriptor) => {
    const f = completedReadOnly(0),
      other = completedReadOnly(1),
      before = structuredClone(f.descriptors.module),
      otherBefore = structuredClone(other.descriptors.module);
    const inventory = nativeObjectDescriptorReservationInventory(
        f.descriptors.tx,
        f.descriptors.pack,
        f.descriptors.dependencies,
      ),
      foreign = nativeObjectDescriptorReservationInventory(
        other.descriptors.tx,
        other.descriptors.pack,
        other.descriptors.dependencies,
      );
    expect(inventory.plan.declarations[index]).toEqual(foreign.plan.declarations[index]);
    expect(Object.is(inventory.functions[index], foreign.functions[index])).toBe(false);
    expect(tail(f, descriptor)[1]).toEqual({ op: "call", funcIdx: inventory.functions[index]!.handle });
    expect(tail(other, descriptor)[1]).toEqual({ op: "call", funcIdx: foreign.functions[index]!.handle });
    expect(Reflect.set(inventory.functions, index, foreign.functions[index])).toBe(false);
    expect(() =>
      buildNativePrototypeSeedDescriptorTail(
        f.descriptors.tx,
        f.binding,
        f.requirements,
        other.dependencies,
        descriptor,
      ),
    ).toThrow("foreign expected requirements or dependencies");
    expect(tail(f, descriptor)[1]).toEqual({ op: "call", funcIdx: inventory.functions[index]!.handle });
    expect(f.descriptors.module).toStrictEqual(before);
    expect(other.descriptors.module).toStrictEqual(otherBefore);
  });

  it("refuses a late binding and cannot mutate an issued binding", () => {
    const f = seederBindingFixture();
    requireBinding(f);
    expect(() => Object.assign(f.binding, { gaps: [] })).toThrow();
    f.descriptors.tx.freezeReservations();
    expect(() => bindNativePrototypeSeederResources(f.descriptors.tx, f.requirements, f.dependencies)).toThrow(
      "invalid binding phase",
    );
  });

  it.each([0, 1])("rejects altered completed internal descriptor body %s", (index) => {
    const f = seederBindingFixture();
    completeDescriptorFixture(f.descriptors);
    tail(f);
    const inventory = nativeObjectDescriptorReservationInventory(
      f.descriptors.tx,
      f.descriptors.pack,
      f.descriptors.dependencies,
    );
    inventory.functions[index]!.object.body.push({ op: "nop" });
    expect(() => tail(f)).toThrow("altered completed function");
  });

  it("does not allow a same-signature outside fill to impersonate canonical descriptor completion", () => {
    const f = seederBindingFixture(),
      inventory = nativeObjectDescriptorReservationInventory(
        f.descriptors.tx,
        f.descriptors.pack,
        f.descriptors.dependencies,
      );
    requireBinding(f);
    f.descriptors.tx.freezeReservations();
    f.descriptors.tx.fillFunction(inventory.functions[0]!, { locals: [], body: [{ op: "local.get", index: 0 }] });
    expect(() => tail(f)).toThrow("missing canonical fill");
  });

  it.each([
    [{ kind: "constructor" }, 189, 0],
    [{ kind: "string-data" }, 189, 0],
    [{ kind: "number-data" }, 184, 0],
    [{ kind: "symbol-tag" }, 188, 0],
    [{ kind: "method", member: "@@3" }, 188, 0],
    [{ kind: "method", member: "@@03" }, 189, 0],
    [{ kind: "getter" }, 52, 1],
    [{ kind: "accessor-pair" }, 52, 1],
  ] as const)("preserves the actual descriptor family %j", (descriptor, flags, index) => {
    const f = seederBindingFixture(true);
    completeDescriptorFixture(f.descriptors);
    const inventory = nativeObjectDescriptorReservationInventory(
      f.descriptors.tx,
      f.descriptors.pack,
      f.descriptors.dependencies,
    );
    expect(tail(f, descriptor)).toEqual([
      { op: "f64.const", value: flags },
      { op: "call", funcIdx: inventory.functions[index]!.handle },
      { op: "drop" },
    ]);
  });

  it("rejects unknown descriptor families and missing member spelling", () => {
    const f = seederBindingFixture();
    completeDescriptorFixture(f.descriptors);
    expect(() => tail(f, { kind: "unknown" } as unknown as NativePrototypeSeedDescriptor)).toThrow(
      "unknown descriptor family",
    );
    expect(() => tail(f, { kind: "method", member: "" })).toThrow("missing method spelling");
  });
});

describe("fresh authentication for descriptor batches", () => {
  it("accepts copied construction data and returns independent instruction arrays", () => {
    const f = completedReadOnly(0),
      descriptor = { ...method };
    const first = tails(f, [descriptor, { kind: "getter" }, { ...descriptor }]);
    expect(first[0]).toEqual(first[2]);
    expect(first[0]).not.toBe(first[2]);
    expect(first[0]![0]).not.toBe(first[2]![0]);
    Object.assign(first[0]![0]!, { value: 0 });
    const next = tails(f, [{ ...descriptor }]);
    expect(next[0]![0]).toEqual({ op: "f64.const", value: 189 });
    expect(first[2]![0]).toEqual(next[0]![0]);
  });

  it.each(["kind", "member", "entry"] as const)("rejects an accessor at %s without invoking it", (role) => {
    const f = seederBindingFixture(),
      before = structuredClone(f.descriptors.module);
    requireBinding(f);
    let calls = 0;
    const descriptor: NativePrototypeSeedDescriptor = { ...method },
      descriptors = [descriptor];
    Object.defineProperty(role === "entry" ? descriptors : descriptor, role === "entry" ? "0" : role, {
      get() {
        calls++;
        Object.assign(f.dependencies, { descriptors: { ...f.dependencies.descriptors } });
        return role === "entry" ? descriptor : role === "kind" ? "method" : "valueOf";
      },
      configurable: true,
    });
    expect(() => tails(f, descriptors)).toThrow(
      role === "entry" ? "non-data descriptor batch entry" : "non-data descriptor field",
    );
    expect(calls).toBe(0);
    expect(f.descriptors.module).toStrictEqual(before);
    requireBinding(f);
  });

  it.each([
    ["empty", []],
    ["sparse", Array<NativePrototypeSeedDescriptor>(1)],
    ["extra field", [{ ...method, extra: 1 }]],
    ["inherited kind", [Object.create(method)]],
  ] as const)("rejects unsafe %s construction data after an authentic positive", (_label, descriptors) => {
    const f = seederBindingFixture();
    requireBinding(f);
    const before = structuredClone(f.descriptors.module);
    expect(() => tails(f, descriptors)).toThrow("native prototype seeder bindings:");
    expect(f.descriptors.module).toStrictEqual(before);
    requireBinding(f);
  });

  it.each(["kind", "member", "value"] as const)("requires own descriptor data despite inherited %s", (role) => {
    const f = seederBindingFixture();
    requireBinding(f);
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, role);
    let descriptor: NativePrototypeSeedDescriptor;
    let calls = 0;
    if (role === "kind") descriptor = {} as NativePrototypeSeedDescriptor;
    else if (role === "member") descriptor = { kind: "method" } as NativePrototypeSeedDescriptor;
    else {
      descriptor = Object.defineProperty({}, "kind", {
        get() {
          calls++;
          return "constructor";
        },
      });
    }
    let error: unknown;
    try {
      Object.defineProperty(Object.prototype, role, {
        configurable: true,
        value: role === "value" ? "constructor" : { value: role === "kind" ? "constructor" : "valueOf" },
      });
      tails(f, [descriptor]);
    } catch (caught) {
      error = caught;
    } finally {
      Reflect.deleteProperty(Object.prototype, role);
      if (previous) Object.defineProperty(Object.prototype, role, previous);
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      role === "kind"
        ? "unknown descriptor family"
        : role === "member"
          ? "missing method spelling"
          : "non-data descriptor field",
    );
    expect(calls).toBe(0);
    requireBinding(f);
  });

  it("authenticates after reflective descriptor selection mutates a completed body", () => {
    const f = seederBindingFixture();
    completeDescriptorFixture(f.descriptors);
    tails(f, [method, { kind: "getter" }]);
    const inventory = nativeObjectDescriptorReservationInventory(
      f.descriptors.tx,
      f.descriptors.pack,
      f.descriptors.dependencies,
    );
    let mutations = 0;
    const descriptor = new Proxy(
      { ...method },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "kind") {
            inventory.functions[1]!.object.body.push({ op: "nop" });
            mutations++;
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(() => tails(f, [method, descriptor])).toThrow("altered completed function");
    expect(mutations).toBe(1);
  });

  it("rechecks retained dependencies on the next batch after a completed positive", () => {
    const f = seederBindingFixture();
    completeDescriptorFixture(f.descriptors);
    tails(f, [method, { kind: "getter" }]);
    Object.assign(f.dependencies, { descriptorDependencies: { ...f.dependencies.descriptorDependencies } });
    expect(() => tails(f, [method])).toThrow("substituted dependency identity");
  });
});

describe("real native descriptor execution through seeder tails", () => {
  const runtimes = new Map<
    boolean,
    { bytes: readonly number[]; runtime: ReturnType<typeof seederDescriptorRuntime> }
  >();
  const actual = (offset: boolean) => {
    let r = runtimes.get(offset);
    if (!r) {
      const bytes = Object.freeze(Array.from(seederDescriptorModule(offset)));
      r = { bytes, runtime: seederDescriptorRuntime(offset, Uint8Array.from(bytes)) };
      runtimes.set(offset, r);
    }
    return r.runtime;
  };
  it.each([false, true])("executes all data-family tails with no host providers, offset=%s", (offset) => {
    const r = actual(offset),
      value = r.boxNumber(7);
    for (const [name, flags] of [
      ["method", 5],
      ["constructorData", 5],
      ["stringData", 5],
      ["numberData", 0],
      ["symbolTag", 4],
      ["readonlyMethod", 4],
    ] as const) {
      const object = r.create();
      expect(r[name](object, r.key(), value)).toBeUndefined();
      const entry = r.entry(object, r.key());
      expect(entry[0]).toBe(flags);
      expect(Object.is(entry[2], value)).toBe(true);
    }
  });
  it("retains installation order and stable passed value identity", () => {
    const r = actual(false),
      object = r.create(),
      value = r.closure();
    r.constructorData(object, r.key(), value);
    r.method(object, r.other(), value);
    const first = r.entry(object, r.key()),
      second = r.entry(object, r.other());
    expect(first[1]).toBeLessThan(second[1]);
    expect(Object.is(first[2], value)).toBe(true);
    expect(Object.is(second[2], value)).toBe(true);
  });
  it("preserves actual getter/setter identities and the absent-setter slot", () => {
    const r = actual(true),
      object = r.create(),
      get = r.closure(),
      set = r.closure();
    r.accessor(object, r.key(), get, set);
    r.getter(object, r.other(), get);
    const pair = r.entry(object, r.key()),
      single = r.entry(object, r.other());
    expect(pair[0]).toBe(12);
    expect(single[0]).toBe(12);
    expect(Object.is(pair[3], get)).toBe(true);
    expect(Object.is(pair[4], set)).toBe(true);
    expect(Object.is(single[3], get)).toBe(true);
    expect(single[4]).toBeNull();
  });
  it("keeps canonical undefined distinct from null data operands", () => {
    const r = actual(false),
      object = r.create(),
      undefinedValue = r.undefinedValue();
    r.method(object, r.key(), undefinedValue);
    r.method(object, r.other(), null);
    expect(Object.is(r.entry(object, r.key())[2], undefinedValue)).toBe(true);
    expect(r.entry(object, r.other())[2]).toBeNull();
  });
  it("executes both accessor-family tails with no host providers at zero offset", () => {
    const r = actual(false),
      object = r.create(),
      get = r.closure(),
      set = r.closure();
    r.accessor(object, r.key(), get, set);
    r.getter(object, r.other(), get);
    const pair = r.entry(object, r.key()),
      single = r.entry(object, r.other());
    expect(pair[0]).toBe(12);
    expect(single[0]).toBe(12);
    expect(Object.is(pair[3], get)).toBe(true);
    expect(Object.is(pair[4], set)).toBe(true);
    expect(Object.is(single[3], get)).toBe(true);
    expect(single[4]).toBeNull();
  });
  it("requires the real return-target drop for a void seeder caller", () => {
    actual(false);
    const bytes = runtimes.get(false)!.bytes;
    expect(Object.isFrozen(bytes)).toBe(true);
    expect(WebAssembly.validate(Uint8Array.from(bytes))).toBe(true);
    expect(WebAssembly.validate(seederDescriptorModule(false, true))).toBe(false);
  });
});
