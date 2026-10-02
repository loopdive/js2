// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
} from "../src/backend/wasmgc/resources/native-bigint.js";
import {
  declareNativeBigIntNumberResources,
  reserveNativeBigIntNumberResources,
  requireNativeBigIntNumberReservations,
  fillNativeBigIntNumberResources,
  requireCompletedNativeBigIntNumber,
  nativeBigIntNumberReservationInventory,
} from "../src/backend/wasmgc/resources/native-bigint-number.js";
import { buildBigIntToNumberDefinition } from "../src/runtime/wasmgc/values/bigint-to-number-body.js";
import {
  bigintOperandValues,
  reserveBigIntOperands,
  fillBigIntOperands,
} from "./helpers/native-bigint-carrier-fixture.js";

function prerequisites(offset = false, mutableBigintPlan = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const prefix = offset ? tx.reserveFunction("prefix", "prefix", { params: [], results: [] }) : undefined;
  if (offset) tx.reserveType("prefix:type", { kind: "struct", name: "Prefix", fields: [] });
  const declared = declareNativeBigIntResources("bigint");
  const bigintPlan = mutableBigintPlan ? structuredClone(declared) : declared;
  const bigint = reserveNativeBigIntResources(tx, "bigint", bigintPlan);
  const dependencies = { bigint, bigintPlan };
  return { module, tx, prefix, dependencies, bigint, bigintPlan };
}
function fixture(offset = false, mutablePlan = false, mutableBigintPlan = false) {
  const f = prerequisites(offset, mutableBigintPlan);
  const declared = declareNativeBigIntNumberResources("conversion");
  const plan = mutablePlan ? structuredClone(declared) : declared;
  const pack = reserveNativeBigIntNumberResources(f.tx, "conversion", plan, f.dependencies);
  return { ...f, plan, pack };
}
type Fixture = ReturnType<typeof fixture>;
function current(f: Fixture) {
  return requireNativeBigIntNumberReservations(f.tx, f.pack, f.plan, f.dependencies);
}
function completed(f: Fixture) {
  return requireCompletedNativeBigIntNumber(f.tx, f.pack, f.plan, f.dependencies);
}
function fillDependencies(f: Fixture) {
  if (f.prefix) f.tx.fillFunction(f.prefix, { locals: [], body: [] });
  fillNativeBigIntResources(f.tx, f.bigint);
}
function complete(f = fixture()) {
  f.tx.freezeReservations();
  fillDependencies(f);
  fillNativeBigIntNumberResources(f.tx, f.pack);
  completed(f);
  return f;
}

/** Check every append population and its existing object identities, without a lossy clone. */
function populations(f: ReturnType<typeof prerequisites>) {
  return Object.fromEntries(
    Object.entries(f.module)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, [...(value as unknown[])]]),
  );
}
function unchangedPopulations(f: ReturnType<typeof prerequisites>, before: ReturnType<typeof populations>) {
  const after = populations(f);
  expect(Object.keys(after)).toEqual(Object.keys(before));
  for (const [key, entries] of Object.entries(before)) {
    expect(after[key]).toHaveLength(entries.length);
    expect(after[key]!.every((entry, index) => Object.is(entry, entries[index]))).toBe(true);
  }
}

describe("issued canonical BigInt-to-number owner", () => {
  it("declares one real externref-to-f64 slot and preserves its limited scope", () => {
    const f = fixture(true),
      inventory = nativeBigIntNumberReservationInventory(f.tx, f.pack, f.plan, f.dependencies);
    expect(f.pack.completionScope).toBe("canonical-bigint-number");
    expect(Object.isFrozen(f.pack)).toBe(true);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.functions)).toBe(true);
    expect(inventory.plan.declarations).toHaveLength(1);
    expect(inventory.plan.declarations[0]).toMatchObject({
      key: "conversion:number",
      role: ["bigint", "number"],
      space: "function",
      signature: { params: [{ kind: "externref" }], results: [{ kind: "f64" }] },
    });
    expect(Object.is(inventory.functions[0], f.pack.number)).toBe(true);
    expect(Object.is(inventory.bigint, f.bigint)).toBe(true);
    expect(f.bigint.type.typeIndex).toBeGreaterThan(0);
    expect(Object.is(current(f), f.pack)).toBe(true);
    expect(f.module.exports).toEqual([]);
    complete(f);
    expect(f.tx.physicalIndex(f.pack.number)).toBeGreaterThan(0);
    expect(Object.is(completed(f), f.pack)).toBe(true);
    const again = nativeBigIntNumberReservationInventory(f.tx, f.pack, f.plan, f.dependencies);
    expect(Object.is(again.functions, inventory.functions)).toBe(true);
  });

  it.each(["owner", "ledger", "plan", "dependencies"] as const)(
    "rejects copied/foreign %s after a positive",
    (role) => {
      const f = fixture();
      current(f);
      expect(() =>
        requireNativeBigIntNumberReservations(
          role === "ledger" ? prerequisites().tx : f.tx,
          role === "owner" ? { ...f.pack } : f.pack,
          role === "plan" ? structuredClone(f.plan) : f.plan,
          role === "dependencies" ? { ...f.dependencies } : f.dependencies,
        ),
      ).toThrow(
        role === "plan"
          ? "declaration plan"
          : role === "dependencies"
            ? "dependency identity"
            : "foreign or copied owner",
      );
      expect(Object.is(current(f), f.pack)).toBe(true);
    },
  );

  it.each(["pack", "plan", "ledger"] as const)("rejects invalid BigInt prerequisite %s before allocation", (role) => {
    const f = prerequisites(),
      plan = declareNativeBigIntNumberResources("conversion");
    const other = role === "ledger" ? prerequisites() : f;
    const bad = {
      bigint: role === "pack" ? { ...f.bigint } : other.bigint,
      bigintPlan: role === "plan" ? structuredClone(f.bigintPlan) : other.bigintPlan,
    };
    const before = populations(f);
    expect(() => reserveNativeBigIntNumberResources(f.tx, "conversion", plan, bad)).toThrow();
    unchangedPopulations(f, before);
    const pack = reserveNativeBigIntNumberResources(f.tx, "conversion", plan, f.dependencies);
    expect(Object.is(requireNativeBigIntNumberReservations(f.tx, pack, plan, f.dependencies), pack)).toBe(true);
  });

  it("rejects another genuine dependency root on the same ledger", () => {
    const f = fixture();
    current(f);
    const otherPlan = declareNativeBigIntResources("other");
    const other = reserveNativeBigIntResources(f.tx, "other", otherPlan);
    f.dependencies.bigint = other;
    f.dependencies.bigintPlan = otherPlan;
    expect(() => current(f)).toThrow("substituted dependency identity");
  });

  it("rejects replacement of the borrowed dependency plan with an equal copy", () => {
    const f = fixture();
    current(f);
    f.dependencies.bigintPlan = structuredClone(f.bigintPlan);
    expect(() => current(f)).toThrow("substituted dependency identity");
  });

  it.each(["conversion", "bigint"] as const)("rejects changed borrowed %s recipe after a positive", (role) => {
    const f = fixture(false, true, true);
    current(f);
    const plan = role === "conversion" ? f.plan : f.bigintPlan;
    Object.defineProperty(plan.declarations[0]!, "key", { value: "changed" });
    expect(() => current(f)).toThrow("changed declaration plan");
  });

  it("rejects a mismatched conversion declaration without consuming any slot or key", () => {
    const f = prerequisites(),
      plan = declareNativeBigIntNumberResources("conversion"),
      bad = structuredClone(plan);
    Object.defineProperty(bad.declarations[0]!, "name", { value: "lookalike" });
    const before = populations(f);
    expect(() => reserveNativeBigIntNumberResources(f.tx, "conversion", bad, f.dependencies)).toThrow(
      "substituted declaration plan",
    );
    unchangedPopulations(f, before);
    expect(reserveNativeBigIntNumberResources(f.tx, "conversion", plan, f.dependencies).number.key).toBe(
      "conversion:number",
    );
  });

  it("preflights a key collision before appending a type or function", () => {
    const f = prerequisites();
    f.tx.reserveFunction("conversion:number", "collision", { params: [], results: [] });
    const before = populations(f);
    expect(() =>
      reserveNativeBigIntNumberResources(
        f.tx,
        "conversion",
        declareNativeBigIntNumberResources("conversion"),
        f.dependencies,
      ),
    ).toThrow("duplicate planned resource key");
    unchangedPopulations(f, before);
  });

  it("preflights an altered prerequisite layout before allocation", () => {
    const f = prerequisites(),
      layout = f.bigint.limbs.object;
    if (layout.kind !== "array") throw Error("missing actual limb array");
    layout.mutable = false;
    const before = populations(f);
    expect(() =>
      reserveNativeBigIntNumberResources(
        f.tx,
        "conversion",
        declareNativeBigIntNumberResources("conversion"),
        f.dependencies,
      ),
    ).toThrow("altered carrier layout");
    unchangedPopulations(f, before);
  });

  it("refuses reservation after freeze without allocating", () => {
    const f = prerequisites();
    f.tx.freezeReservations();
    const before = populations(f);
    expect(() =>
      reserveNativeBigIntNumberResources(
        f.tx,
        "conversion",
        declareNativeBigIntNumberResources("conversion"),
        f.dependencies,
      ),
    ).toThrow("invalid reservation phase");
    unchangedPopulations(f, before);
  });

  it("requires completed real BigInt dependencies before its own canonical fill", () => {
    const f = fixture();
    current(f);
    f.tx.freezeReservations();
    expect(() => fillNativeBigIntNumberResources(f.tx, f.pack)).toThrow("missing canonical fill");
    expect(f.pack.number.object.body).toEqual([]);
    fillDependencies(f);
    fillNativeBigIntNumberResources(f.tx, f.pack);
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  it("does not report an unfilled owner as completed", () => {
    const f = fixture();
    f.tx.freezeReservations();
    fillDependencies(f);
    expect(() => completed(f)).toThrow("missing canonical fill");
    fillNativeBigIntNumberResources(f.tx, f.pack);
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  it("does not grant canonical completion for an externally filled identical body", () => {
    const f = fixture();
    f.tx.freezeReservations();
    fillDependencies(f);
    f.tx.fillFunction(
      f.pack.number,
      buildBigIntToNumberDefinition({
        narrow: f.bigint.type.typeIndex,
        limbs: f.bigint.limbs.typeIndex,
        wide: f.bigint.wide.typeIndex,
      }),
    );
    expect(f.pack.number.object.body.length).toBeGreaterThan(0);
    expect(() => completed(f)).toThrow("missing canonical fill");
    expect(() => fillNativeBigIntNumberResources(f.tx, f.pack)).toThrow("duplicate function fill");
  });

  it("rejects duplicate canonical fill and retains the original completed body", () => {
    const f = complete(),
      body = f.pack.number.object.body;
    expect(() => fillNativeBigIntNumberResources(f.tx, f.pack)).toThrow("duplicate canonical fill");
    expect(Object.is(f.pack.number.object.body, body)).toBe(true);
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  it.each(["conversion", "dependency"] as const)("refuses a changed completed %s body", (role) => {
    const f = complete();
    completed(f);
    (role === "conversion" ? f.pack.number : f.bigint.equal).object.body.push({ op: "nop" });
    expect(() => completed(f)).toThrow("altered completed function");
  });

  it("refuses a same-signature replacement allocator object", () => {
    const f = complete();
    completed(f);
    const index = f.module.functions.indexOf(f.pack.number.object);
    f.module.functions[index] = { ...f.pack.number.object };
    expect(() => completed(f)).toThrow("substituted or reordered functions");
  });

  it("refuses a changed conversion signature at its original slot", () => {
    const f = complete();
    completed(f);
    f.pack.number.object.typeIdx = f.bigint.box.object.typeIdx;
    expect(() => completed(f)).toThrow("altered function descriptor");
  });

  it("refuses a changed wide carrier field after completion", () => {
    const f = complete();
    completed(f);
    const wide = f.bigint.wide.object;
    if (wide.kind !== "struct") throw Error("missing actual wide carrier");
    wide.fields[1]!.mutable = true;
    expect(() => completed(f)).toThrow("altered carrier layout");
  });

  it("cannot substitute another issued conversion token into the frozen pack", () => {
    const f = fixture(),
      other = fixture();
    current(f);
    current(other);
    expect(Reflect.set(f.pack, "number", other.pack.number)).toBe(false);
    expect(Object.is(current(f), f.pack)).toBe(true);
    expect(() =>
      requireNativeBigIntNumberReservations(f.tx, { ...f.pack, number: other.pack.number }, f.plan, f.dependencies),
    ).toThrow("foreign or copied owner");
    expect(Object.is(current(other), other.pack)).toBe(true);
  });

  it("rejects a foreign fill transaction", () => {
    const f = fixture(),
      other = fixture();
    expect(() => fillNativeBigIntNumberResources(other.tx, f.pack)).toThrow("foreign or copied owner");
    expect(f.pack.number.object.body).toEqual([]);
  });
});

describe.each([false, true])("issued BigInt-number execution, offset=%s", (offset) => {
  let result: { number(value: unknown): number } & Record<keyof typeof bigintOperandValues, () => object>;
  beforeAll(() => {
    const f = fixture(offset),
      operands = reserveBigIntOperands(f.tx);
    f.tx.freezeReservations();
    fillDependencies(f);
    fillNativeBigIntNumberResources(f.tx, f.pack);
    fillBigIntOperands(f.tx, f.bigint, operands);
    completed(f);
    for (const [name, token] of Object.entries({ number: f.pack.number, ...operands }))
      f.tx.defineExport("export:" + name, name, token);
    expect(f.tx.seal().completedFunctions).toBe(5 + Number(offset) + Object.keys(operands).length);
    const bytes = emitBinary(f.module);
    expect(WebAssembly.validate(bytes as BufferSource)).toBe(true);
    const module = new WebAssembly.Module(bytes as BufferSource);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    result = new WebAssembly.Instance(module).exports as unknown as typeof result;
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });
  it.each(Object.entries(bigintOperandValues))(
    "converts actual %s through the completed issued function",
    (name, value) => {
      expect(result.number(result[name as keyof typeof bigintOperandValues]())).toBe(Number(value));
    },
  );
});

describe("BigInt number own-data authentication", () => {
  it.each(["accessor", "inherited", "hidden", "symbol", "extra", "undefined", "null"] as const)(
    "rejects %s dependencies atomically and permits valid retry",
    (shape) => {
      const f = prerequisites();
      const plan = declareNativeBigIntNumberResources("conversion");
      let reads = 0;
      const bad = { ...f.dependencies };
      if (shape === "accessor")
        Object.defineProperty(bad, "bigint", {
          get: () => {
            reads++;
            return f.bigint;
          },
        });
      if (shape === "inherited") {
        Object.setPrototypeOf(bad, { bigint: f.bigint });
        Reflect.deleteProperty(bad, "bigint");
      }
      if (shape === "hidden") Object.defineProperty(bad, "bigint", { enumerable: false });
      if (shape === "symbol") Object.defineProperty(bad, Symbol("extra"), { value: true });
      if (shape === "extra") Object.assign(bad, { extra: true });
      if (shape === "undefined" || shape === "null")
        Object.assign(bad, { bigint: shape === "null" ? null : undefined });
      const before = populations(f);
      expect(() => reserveNativeBigIntNumberResources(f.tx, "conversion", plan, bad)).toThrow();
      expect(reads).toBe(0);
      unchangedPopulations(f, before);
      const pack = reserveNativeBigIntNumberResources(f.tx, "conversion", plan, f.dependencies);
      expect(requireNativeBigIntNumberReservations(f.tx, pack, plan, f.dependencies)).toBe(pack);
    },
  );
  it("refuses nested recipe accessors before running a producer or consuming keys", () => {
    const f = prerequisites(false, true);
    const declaration = f.bigintPlan.declarations.find((row) => row.space === "function");
    expect(declaration).toBeDefined();
    expect(declaration!.space).toBe("function");
    if (!declaration || declaration.space !== "function") throw Error("missing actual BigInt function declaration");
    const original = Object.getOwnPropertyDescriptor(declaration, "signature");
    expect(original).toBeDefined();
    expect(original!.enumerable).toBe(true);
    expect(Object.hasOwn(original!, "value")).toBe(true);
    expect(original!.value).toBe(declaration.signature);
    if (!original || !original.enumerable || !Object.hasOwn(original, "value"))
      throw Error("missing actual enumerable signature data descriptor");
    let reads = 0;
    Object.defineProperty(declaration, "signature", {
      get: () => {
        reads++;
        return original.value;
      },
      configurable: true,
    });
    const before = populations(f);
    expect(() =>
      reserveNativeBigIntNumberResources(
        f.tx,
        "conversion",
        declareNativeBigIntNumberResources("conversion"),
        f.dependencies,
      ),
    ).toThrow();
    expect(reads).toBe(0);
    unchangedPopulations(f, before);
    Object.defineProperty(declaration, "signature", original);
    expect(
      reserveNativeBigIntNumberResources(
        f.tx,
        "conversion",
        declareNativeBigIntNumberResources("conversion"),
        f.dependencies,
      ),
    ).toBeDefined();
  });
  it("rejects warmed dependency getters without evaluating them", () => {
    const f = complete();
    let reads = 0;
    Object.defineProperty(f.dependencies, "bigint", {
      get: () => {
        reads++;
        return f.bigint;
      },
    });
    expect(() => completed(f)).toThrow();
    expect(reads).toBe(0);
  });
  it.each(["locals", "body"] as const)("independently rejects changed full %s after warm completion", (role) => {
    const f = complete();
    expect(completed(f)).toBe(f.pack);
    if (role === "locals") f.pack.number.object.locals.push({ name: "unused", type: { kind: "i32" } });
    else f.pack.number.object.body = [{ op: "f64.const", value: 0 }];
    expect(() => completed(f)).toThrow();
  });
});

/** Reflection-only observations while a live definition is deliberately malformed. */
function definitionAccessorControl(f: Fixture, target: object, key: PropertyKey, action: () => unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  expect(descriptor).toBeDefined();
  expect(Object.hasOwn(descriptor!, "value")).toBe(true);
  expect(descriptor!.enumerable).toBe(true);
  expect(descriptor!.configurable).toBe(true);
  const before = populations(f),
    state = f.tx.state;
  const tokens = (["number"] as const).map((role) => f.pack[role]);
  const objects = tokens.map((token) => token.object);
  const arrays = objects.map((object) => ({ locals: object.locals, body: object.body }));
  let reads = 0;
  // Mutate twice with an authentic retry between them: no successful-capture cache.
  for (let repeat = 0; repeat < 2; repeat++) {
    try {
      Object.defineProperty(target, key, {
        enumerable: descriptor!.enumerable,
        configurable: descriptor!.configurable,
        get() {
          reads++;
          return descriptor!.value;
        },
      });
      const mutant = Object.getOwnPropertyDescriptor(target, key)!;
      expect(Object.hasOwn(mutant, "value")).toBe(false);
      expect(typeof mutant.get).toBe("function");
      expect(() => action()).toThrow();
      expect(reads).toBe(0);
      expect(f.tx.state).toBe(state);
      unchangedPopulations(f, before);
      tokens.forEach((token, index) => {
        expect(token.object).toBe(objects[index]);
        for (const part of ["locals", "body"] as const) {
          const field = Object.getOwnPropertyDescriptor(objects[index]!, part)!;
          if (objects[index] !== target || part !== key) expect(field.value).toBe(arrays[index]![part]);
        }
      });
    } finally {
      Object.defineProperty(target, key, descriptor!);
    }
    expect(Object.getOwnPropertyDescriptor(target, key)).toEqual(descriptor);
    expect(Object.getOwnPropertyDescriptor(target, key)!.value).toBe(descriptor!.value);
    expect(reads).toBe(0);
    expect(() => action()).not.toThrow();
    unchangedPopulations(f, before);
  }
}

function definitionAction(f: Fixture, route: "require" | "inventory" | "completion") {
  return route === "require"
    ? () => current(f)
    : route === "inventory"
      ? () => nativeBigIntNumberReservationInventory(f.tx, f.pack, f.plan, f.dependencies)
      : () => completed(f);
}

function filledDefinitionFixture(warm: boolean) {
  const f = fixture();
  f.tx.freezeReservations();
  fillDependencies(f);
  fillNativeBigIntNumberResources(f.tx, f.pack);
  expect(current(f)).toBe(f.pack);
  if (warm) expect(completed(f)).toBe(f.pack);
  return f;
}

describe("BigInt number descriptor-first live definitions", () => {
  it.each(["number"] as const)("baseline original-array getter control for %s on every public audit route", (role) => {
    for (const warm of [false, true]) {
      for (const route of ["require", "inventory", "completion"] as const) {
        for (const part of ["locals", "body"] as const) {
          const f = filledDefinitionFixture(warm);
          definitionAccessorControl(f, f.pack[role].object, part, definitionAction(f, route));
        }
      }
    }
  });

  it.each(["number"] as const)(
    "refuses unfilled %s array getters before dependency completion and permits fill retry",
    (role) => {
      for (const part of ["locals", "body"] as const) {
        const f = fixture();
        f.tx.freezeReservations();
        expect(current(f)).toBe(f.pack);
        const target = f.pack[role].object;
        const descriptor = Object.getOwnPropertyDescriptor(target, part)!;
        expect(Array.isArray(descriptor.value)).toBe(true);
        expect(descriptor.value).toHaveLength(0);
        const before = populations(f),
          state = f.tx.state;
        let reads = 0;
        try {
          Object.defineProperty(target, part, {
            enumerable: true,
            configurable: true,
            get() {
              reads++;
              return descriptor.value;
            },
          });
          expect(Object.hasOwn(Object.getOwnPropertyDescriptor(target, part)!, "value")).toBe(false);
          expect(() => fillNativeBigIntNumberResources(f.tx, f.pack)).toThrow();
          expect(reads).toBe(0);
          expect(f.tx.state).toBe(state);
          unchangedPopulations(f, before);
        } finally {
          Object.defineProperty(target, part, descriptor);
        }
        expect(Object.getOwnPropertyDescriptor(target, part)).toEqual(descriptor);
        expect(Object.getOwnPropertyDescriptor(target, part)!.value).toBe(descriptor.value);
        expect(reads).toBe(0);
        fillDependencies(f);
        fillNativeBigIntNumberResources(f.tx, f.pack);
        expect(completed(f)).toBe(f.pack);
        unchangedPopulations(f, before);
      }
    },
  );

  it.each(["number"] as const)("refuses deep original-returning %s getters before any audit route", (role) => {
    for (const route of ["require", "inventory", "completion"] as const) {
      for (const location of ["array-index", "instruction-op", "block-type", "local-type"] as const) {
        const f = filledDefinitionFixture(true);
        const object = f.pack[role].object;
        let target: object = object.body,
          key: PropertyKey = "0";
        if (location === "instruction-op") {
          target = object.body[0]!;
          key = "op";
        }
        if (location === "block-type") {
          const block = object.body.find((instruction) => "blockType" in instruction);
          expect(block).toBeDefined();
          if (!block || !("blockType" in block)) throw Error("missing real canonical block");
          expect(typeof block.blockType).toBe("object");
          target = block.blockType;
          key = "kind";
        }
        if (location === "local-type") {
          expect(object.locals.length).toBeGreaterThan(0);
          target = object.locals[0]!;
          key = "type";
        }
        definitionAccessorControl(f, target, key, definitionAction(f, route));
      }
    }
  });

  it.each(["hidden", "inherited", "sparse", "extra-array", "symbol", "cycle"] as const)(
    "refuses %s live data and permits exact restoration",
    (shape) => {
      const f = filledDefinitionFixture(true),
        object = f.pack.number.object;
      const body = object.body,
        instruction = body[0]!;
      const target = shape === "sparse" || shape === "extra-array" ? body : instruction;
      const key: PropertyKey =
        shape === "symbol"
          ? Symbol("extra")
          : shape === "sparse"
            ? "0"
            : shape === "extra-array" || shape === "cycle"
              ? "extra"
              : "op";
      const descriptor = Object.getOwnPropertyDescriptor(target, key),
        proto = Object.getPrototypeOf(target);
      const originalFields = Reflect.ownKeys(target).map((fieldKey) => ({
        key: fieldKey,
        descriptor: Object.getOwnPropertyDescriptor(target, fieldKey)!,
      }));
      if (shape === "inherited") {
        expect(originalFields.map((field) => field.key)).toEqual(["op", "index"]);
        expect(originalFields.every((field) => field.descriptor.configurable)).toBe(true);
      }
      if (shape === "hidden" || shape === "inherited" || shape === "sparse") {
        expect(descriptor).toBeDefined();
        expect(Object.hasOwn(descriptor!, "value")).toBe(true);
      }
      const before = populations(f),
        state = f.tx.state;
      try {
        if (shape === "hidden") Object.defineProperty(target, key, { ...descriptor!, enumerable: false });
        else if (shape === "inherited") {
          Reflect.deleteProperty(target, key);
          Object.setPrototypeOf(target, { op: descriptor!.value });
        } else if (shape === "sparse") Reflect.deleteProperty(target, key);
        else
          Object.defineProperty(target, key, {
            value: shape === "cycle" ? target : 1,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        expect(() => completed(f)).toThrow();
        expect(f.tx.state).toBe(state);
        unchangedPopulations(f, before);
      } finally {
        Object.setPrototypeOf(target, proto);
        if (shape === "inherited") {
          // Re-inserting only op would move it after index; restore the complete original order.
          for (const fieldKey of Reflect.ownKeys(target)) expect(Reflect.deleteProperty(target, fieldKey)).toBe(true);
          for (const field of originalFields) Object.defineProperty(target, field.key, field.descriptor);
        } else if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
      }
      expect(Object.getOwnPropertyDescriptor(target, key)).toEqual(descriptor);
      expect(Object.getPrototypeOf(target)).toBe(proto);
      expect(Reflect.ownKeys(target)).toEqual(originalFields.map((field) => field.key));
      for (const field of originalFields) {
        const restored = Object.getOwnPropertyDescriptor(target, field.key)!;
        expect(restored).toEqual(field.descriptor);
        expect(restored.value).toBe(field.descriptor.value);
      }
      expect(completed(f)).toBe(f.pack);
    },
  );

  it.each(["locals", "body", "field-attributes", "deep-attributes"] as const)(
    "retains successful-fill %s identity or attributes after warm completion",
    (part) => {
      const f = filledDefinitionFixture(true),
        object = f.pack.number.object;
      const target = part === "deep-attributes" ? object.body[0]! : object;
      const key = part === "locals" || part === "body" ? part : part === "deep-attributes" ? "op" : "body";
      const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
      expect(Object.hasOwn(descriptor, "value")).toBe(true);
      expect(descriptor.writable).toBe(true);
      const before = populations(f),
        state = f.tx.state;
      try {
        Object.defineProperty(
          target,
          key,
          part === "locals" || part === "body"
            ? { ...descriptor, value: structuredClone(descriptor.value) }
            : { ...descriptor, writable: false },
        );
        expect(() => completed(f)).toThrow();
        expect(f.tx.state).toBe(state);
        unchangedPopulations(f, before);
      } finally {
        Object.defineProperty(target, key, descriptor);
      }
      expect(Object.getOwnPropertyDescriptor(target, key)).toEqual(descriptor);
      expect(Object.getOwnPropertyDescriptor(target, key)!.value).toBe(descriptor.value);
      expect(completed(f)).toBe(f.pack);
    },
  );
});
