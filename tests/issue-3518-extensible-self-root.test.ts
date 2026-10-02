// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import type { StructTypeDef, TypeDef } from "../src/wasm/model/module-records.js";
import {
  PhysicalModuleReservations,
  type SelfReferentialStructDefinition,
  type TypeReservation,
} from "../src/wasm/physical/module-reservations.js";
import {
  compareNativeResourceDeclarationShape,
  executeNativeResourceRecipe,
  executeNativeResourceRecipeWithSignatures,
  preflightNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "../src/backend/wasmgc/resources/native-resource-declarations.js";
import type {
  NativeDeclaredType,
  NativeResourceRecipe,
  NativeStringValueDeclaration,
} from "../src/runtime/wasmgc/values/native-resource-declaration-types.js";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
function fixture() {
  const module = createEmptyModule();
  return { module, tx: new PhysicalModuleReservations(module) };
}
function definition(): SelfReferentialStructDefinition {
  return {
    name: "Root",
    fields: [
      { name: "next", type: { kind: "ref_null", self: true }, mutable: true },
      { name: "count", type: { kind: "i32" }, mutable: true },
    ],
  };
}
function prefix(tx: PhysicalModuleReservations): void {
  tx.reserveType("prefix", {
    kind: "rec",
    types: [
      { kind: "struct", name: "Prefix0", fields: [] },
      { kind: "sub", superType: null, final: false, type: { kind: "struct", name: "Prefix1", fields: [] } },
    ],
  });
}
function noAllocation(f: ReturnType<typeof fixture>, action: () => unknown, diagnostic?: string | RegExp): void {
  const before = structuredClone(f.module);
  const arrays = [f.module.types, f.module.functions, f.module.globals, f.module.funcOrdinalToPosition];
  expect(action).toThrow(diagnostic);
  expect(f.module).toStrictEqual(before);
  expect(
    [f.module.types, f.module.functions, f.module.globals, f.module.funcOrdinalToPosition].every(
      (v, i) => v === arrays[i],
    ),
  ).toBe(true);
}
function rootShape(): Extract<NativeDeclaredType, { kind: "struct" }> {
  return {
    kind: "struct",
    name: "Root",
    fields: [
      { name: "next", type: { kind: "ref_null", typeKey: "root" }, mutable: true },
      { name: "count", type: { kind: "i32" }, mutable: true },
    ],
    parent: { kind: "root" },
    final: false,
  };
}
function recipe(extra: readonly NativeStringValueDeclaration[] = []): NativeResourceRecipe {
  const declarations: NativeStringValueDeclaration[] = [
    { key: "root", role: ["root"], space: "type", shape: rootShape() },
    ...extra,
  ];
  return {
    declarations,
    reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
  };
}
function child(root: TypeReservation, name = "Child"): StructTypeDef {
  if (root.object.kind !== "struct") throw Error("fixture root is not a struct");
  return {
    kind: "struct",
    name,
    superTypeIdx: root.typeIndex,
    final: true,
    fields: [...structuredClone(root.object.fields), { name: "privateValue", type: { kind: "i64" }, mutable: false }],
  };
}

for (const shifted of [false, true]) {
  for (const symbolic of [false, true]) {
    it(`emits an extensible recursive root and executes its private-field child (shifted=${shifted}, symbolic=${symbolic})`, () => {
      const f = fixture();
      if (shifted) prefix(f.tx);
      const plan = recipe();
      const root = symbolic
        ? requireNativeDeclaredReservation(executeNativeResourceRecipe(f.tx, plan), "root", "type")
        : f.tx.reserveExtensibleSelfReferentialStructType("root", definition());
      expect(root.typeIndex).toBe(shifted ? 2 : 0);
      expect(root.object).toStrictEqual({
        kind: "struct",
        name: "Root",
        superTypeIdx: -1,
        final: false,
        fields: [
          { name: "next", type: { kind: "ref_null", typeIdx: root.typeIndex }, mutable: true },
          { name: "count", type: { kind: "i32" }, mutable: true },
        ],
      });
      const derived = f.tx.reserveType("child", child(root));
      const make = f.tx.reserveFunction("make", "make", {
        params: [{ kind: "i64" }],
        results: [{ kind: "externref" }],
      });
      const read = f.tx.reserveFunction("read", "read", {
        params: [{ kind: "externref" }],
        results: [{ kind: "i64" }],
      });
      const link = f.tx.reserveFunction("link", "link", {
        params: [{ kind: "externref" }, { kind: "externref" }],
        results: [{ kind: "i64" }],
      });
      const count = f.tx.reserveFunction("count", "count", {
        params: [{ kind: "externref" }, { kind: "i32" }],
        results: [{ kind: "i32" }],
      });
      const distinct = f.tx.reserveFunction("distinct", "distinct", {
        params: [{ kind: "externref" }, { kind: "externref" }],
        results: [{ kind: "i32" }],
      });
      f.tx.freezeReservations();
      const cast = (index: number, typeIdx: number): Instr[] => [
        { op: "local.get", index },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx },
      ];
      f.tx.fillFunction(make, {
        locals: [],
        body: [
          { op: "ref.null", typeIdx: root.typeIndex },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 0 },
          { op: "struct.new", typeIdx: derived.typeIndex },
          { op: "extern.convert_any" },
        ],
      });
      f.tx.fillFunction(read, {
        locals: [],
        body: [...cast(0, derived.typeIndex), { op: "struct.get", typeIdx: derived.typeIndex, fieldIdx: 2 }],
      });
      f.tx.fillFunction(link, {
        locals: [],
        body: [
          ...cast(0, root.typeIndex),
          ...cast(1, root.typeIndex),
          { op: "struct.set", typeIdx: root.typeIndex, fieldIdx: 0 },
          ...cast(0, root.typeIndex),
          { op: "struct.get", typeIdx: root.typeIndex, fieldIdx: 0 },
          { op: "ref.as_non_null" },
          { op: "ref.cast", typeIdx: derived.typeIndex },
          { op: "struct.get", typeIdx: derived.typeIndex, fieldIdx: 2 },
        ],
      });
      f.tx.fillFunction(count, {
        locals: [],
        body: [
          ...cast(0, root.typeIndex),
          { op: "local.get", index: 1 },
          { op: "struct.set", typeIdx: root.typeIndex, fieldIdx: 1 },
          ...cast(0, derived.typeIndex),
          { op: "struct.get", typeIdx: derived.typeIndex, fieldIdx: 1 },
        ],
      });
      f.tx.fillFunction(distinct, {
        locals: [],
        body: [...cast(0, root.typeIndex), ...cast(1, root.typeIndex), { op: "ref.eq" }, { op: "i32.eqz" }],
      });
      for (const token of [make, read, link, count, distinct])
        f.tx.defineExport("export:" + token.key, token.key, token);
      f.tx.seal();
      compareNativeResourceDeclarationShape(
        f.tx,
        plan.declarations[0]!,
        { key: "root", space: "type", definition: root.object },
        new Map([["root", root]]),
      );
      const bytes = emitBinary(f.module);
      expect(WebAssembly.validate(bytes as BufferSource)).toBe(true);
      const wasm = new WebAssembly.Module(bytes as BufferSource);
      expect(WebAssembly.Module.imports(wasm)).toEqual([]);
      const api = new WebAssembly.Instance(wasm).exports as Record<string, (...args: any[]) => any>;
      const first = api.make!(11n),
        second = api.make!(23n);
      expect(api.distinct!(first, second)).toBe(1);
      expect(api.read!(first)).toBe(11n);
      expect(api.link!(first, second)).toBe(23n);
      expect(api.count!(first, 17)).toBe(17);
      expect(api.read!(first)).toBe(11n);
      expect(api.read!(second)).toBe(23n);
    });
  }
  it.each(["covariant-mutable-reference", "changed-mutability", "changed-value-type"] as const)(
    `actual Wasm rejects invalid inherited field %s (shifted=${shifted})`,
    (change) => {
      const f = fixture();
      if (shifted) prefix(f.tx);
      const root = f.tx.reserveExtensibleSelfReferentialStructType("root", definition());
      const invalid = child(root);
      if (change === "covariant-mutable-reference")
        invalid.fields[0]!.type = { kind: "ref_null", typeIdx: root.typeIndex + 1 };
      if (change === "changed-mutability") invalid.fields[0]!.mutable = false;
      if (change === "changed-value-type") invalid.fields[1]!.type = { kind: "i64" };
      f.tx.reserveType("child", invalid);
      f.tx.freezeReservations();
      f.tx.seal();
      const bytes = emitBinary(f.module);
      expect(WebAssembly.validate(bytes as BufferSource)).toBe(false);
      expect(() => new WebAssembly.Module(bytes as BufferSource)).toThrow(WebAssembly.CompileError);
    },
  );
}

describe("strict direct extensible-root reservation", () => {
  it("retains the original final-only descriptor and refuses children atomically", () => {
    const f = fixture(),
      root = f.tx.reserveSelfReferentialStructType("root", definition());
    expect(Object.hasOwn(root.object, "superTypeIdx")).toBe(false);
    expect(Object.hasOwn(root.object, "final")).toBe(false);
    noAllocation(f, () => f.tx.reserveType("child", child(root)), "cannot extend final parent type");
  });
  it.each(["plain", "rec", "sub"] as const)("keeps final-parent refusal for %s records", (form) => {
    const f = fixture();
    const shape: StructTypeDef = { kind: "struct", name: "Final", fields: [] };
    const parent: TypeDef =
      form === "plain"
        ? shape
        : form === "rec"
          ? { kind: "rec", types: [shape] }
          : { kind: "sub", superType: null, final: true, type: shape };
    const root = f.tx.reserveType("parent", parent);
    noAllocation(
      f,
      () => f.tx.reserveType("child", { kind: "struct", name: "Child", superTypeIdx: root.typeIndex, fields: [] }),
      "cannot extend final parent type",
    );
  });
  const malformed = [
    "parent",
    "superTypeIdx",
    "final",
    "self-false",
    "wrong-self-kind",
    "numeric-self",
    "forward",
    "missing-ref",
    "negative-ref",
    "fractional-ref",
    "scalar-coordinate",
    "unknown-field",
    "unknown-type-field",
    "unknown-descriptor-field",
    "field-getter",
    "name-getter",
    "sparse",
    "array-extra",
    "empty",
    "callback",
  ] as const;
  it.each(malformed)("rejects malformed extensible descriptor %s without allocating", (variant) => {
    const good = fixture();
    good.tx.reserveExtensibleSelfReferentialStructType("root", definition());
    const f = fixture(),
      bad = definition() as any,
      getter = vi.fn(() => "wrong");
    if (variant === "parent") bad.parent = { kind: "root" };
    if (variant === "superTypeIdx") bad.superTypeIdx = -1;
    if (variant === "final") bad.final = false;
    if (variant === "self-false") bad.fields[0].type.self = false;
    if (variant === "wrong-self-kind") bad.fields[0].type.kind = "i32";
    if (variant === "numeric-self") bad.fields[0].type.typeIdx = 0;
    if (variant === "forward") bad.fields[1].type = { kind: "ref_null", typeIdx: 0 };
    if (variant === "missing-ref") bad.fields[1].type = { kind: "ref_null" };
    if (variant === "negative-ref") bad.fields[1].type = { kind: "ref_null", typeIdx: -1 };
    if (variant === "fractional-ref") bad.fields[1].type = { kind: "ref_null", typeIdx: 0.5 };
    if (variant === "scalar-coordinate") bad.fields[1].type.typeIdx = 0;
    if (variant === "unknown-field") bad.fields[0].extra = true;
    if (variant === "unknown-type-field") bad.fields[0].type.extra = true;
    if (variant === "unknown-descriptor-field") bad.extra = true;
    if (variant === "field-getter") Object.defineProperty(bad.fields, "0", { get: getter });
    if (variant === "name-getter") Object.defineProperty(bad, "name", { get: getter });
    if (variant === "sparse") Reflect.deleteProperty(bad.fields, 1);
    if (variant === "array-extra") bad.fields.extra = true;
    if (variant === "empty") bad.fields = [];
    noAllocation(f, () =>
      f.tx.reserveExtensibleSelfReferentialStructType("root", variant === "callback" ? ((() => bad) as never) : bad),
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["parent", "superTypeIdx", "final"])("original final-only entrypoint still rejects explicit %s", (key) => {
    const f = fixture();
    noAllocation(f, () =>
      f.tx.reserveSelfReferentialStructType("root", { ...definition(), [key]: key === "final" ? false : -1 }),
    );
  });
  it("resolves genuine prior reference coordinates alongside the ledger-issued self field", () => {
    const f = fixture();
    prefix(f.tx);
    const input = definition() as any;
    input.fields.push({ name: "prior", type: { kind: "ref_null", typeIdx: 1 }, mutable: false });
    const root = f.tx.reserveExtensibleSelfReferentialStructType("root", input);
    expect((root.object as StructTypeDef).fields[0]!.type).toEqual({ kind: "ref_null", typeIdx: 2 });
    expect((root.object as StructTypeDef).fields[2]!.type).toEqual({ kind: "ref_null", typeIdx: 1 });
    f.tx.freezeReservations();
    f.tx.seal();
    expect(WebAssembly.validate(emitBinary(f.module) as BufferSource)).toBe(true);
  });
  it.each(["empty", "duplicate"])("rejects %s resource keys before append", (kind) => {
    const f = fixture();
    f.tx.reserveExtensibleSelfReferentialStructType("root", definition());
    noAllocation(
      f,
      () => f.tx.reserveExtensibleSelfReferentialStructType(kind === "empty" ? "" : "root", definition()),
      "duplicate self-type key",
    );
  });
  it.each(["frozen", "sealed"])("rejects the new entrypoint after %s", (phase) => {
    const f = fixture();
    f.tx.reserveExtensibleSelfReferentialStructType("root", definition());
    f.tx.freezeReservations();
    if (phase === "sealed") f.tx.seal();
    noAllocation(f, () => f.tx.reserveExtensibleSelfReferentialStructType("late", definition()), /requires reserving/);
  });
  it.each(["intern", "reserve", "extensible-self", "final-self"] as const)(
    "rejects swallowed reentrant %s from a descriptor trap",
    (route) => {
      const f = fixture();
      let attempted = false;
      const input = new Proxy(definition(), {
        getOwnPropertyDescriptor(target, key) {
          if (!attempted) {
            attempted = true;
            try {
              if (route === "intern") f.tx.internFunctionType([], []);
              else if (route === "reserve")
                f.tx.reserveType("intruder", { kind: "struct", name: "Intruder", fields: [] });
              else if (route === "extensible-self")
                f.tx.reserveExtensibleSelfReferentialStructType("intruder", definition());
              else f.tx.reserveSelfReferentialStructType("intruder", definition());
            } catch {
              /* The outer operation must refuse even when the trap swallows this. */
            }
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      noAllocation(f, () => f.tx.reserveExtensibleSelfReferentialStructType("root", input), /failed|reentrant/);
      expect(attempted).toBe(true);
      expect(f.tx.state).toBe("failed");
    },
  );
  it("reads only own data descriptors and detaches caller-owned input fields", () => {
    const f = fixture(),
      input = definition(),
      get = vi.fn(() => {
        throw Error("unchecked access");
      });
    const root = f.tx.reserveExtensibleSelfReferentialStructType(
      "root",
      new Proxy({ ...input, fields: new Proxy(input.fields, { get }) }, { get }),
    );
    const saved = structuredClone(root.object);
    (input.fields[0]!.type as any).self = false;
    (input.fields as any[]).push({});
    expect(root.object).toStrictEqual(saved);
    expect(get).not.toHaveBeenCalled();
    f.tx.freezeReservations();
    f.tx.seal();
  });
  it.each(["finality", "self-coordinate", "mutability"] as const)("refuses live root mutation of %s", (change) => {
    const f = fixture(),
      root = f.tx.reserveExtensibleSelfReferentialStructType("root", definition());
    f.tx.assertTypeReservation(root);
    const actual = root.object as StructTypeDef;
    if (change === "finality") actual.final = true;
    if (change === "self-coordinate") (actual.fields[0]!.type as { typeIdx: number }).typeIdx = 1;
    if (change === "mutability") actual.fields[0]!.mutable = false;
    expect(() => f.tx.assertTypeReservation(root)).toThrow(/changed|mutated|replaced|altered/);
  });
});

describe("exact symbolic self-root form", () => {
  it.each([false, true])(
    "accepts copied construction data and named signature execution (signatures=%s)",
    (signatures) => {
      const f = fixture(),
        plan = recipe();
      const copy = structuredClone(plan);
      const records = signatures
        ? executeNativeResourceRecipeWithSignatures(f.tx, copy).reservations
        : executeNativeResourceRecipe(f.tx, copy);
      const root = requireNativeDeclaredReservation(records, "root", "type");
      compareNativeResourceDeclarationShape(
        f.tx,
        plan.declarations[0]!,
        { key: "root", space: "type", definition: root.object },
        new Map([["root", root]]),
      );
      expect(copy).toStrictEqual(plan);
      expect(root.object).toMatchObject({ superTypeIdx: -1, final: false });
    },
  );
  it("resolves prior prerequisites and child inheritance without granting arbitrary self parents", () => {
    const f = fixture(),
      prior = f.tx.reserveType("prior", { kind: "struct", name: "Prior", fields: [] });
    const plan = recipe([
      {
        key: "child",
        role: ["child"],
        space: "type",
        shape: {
          kind: "struct",
          name: "Child",
          parent: { kind: "resource", typeKey: "root" },
          final: true,
          fields: [
            ...rootShape().fields,
            { name: "prior", type: { kind: "ref_null", typeKey: "prior" }, mutable: false },
          ],
        },
      },
    ]);
    const records = executeNativeResourceRecipe(f.tx, plan, new Map([["prior", prior]]));
    const root = requireNativeDeclaredReservation(records, "root", "type"),
      derived = requireNativeDeclaredReservation(records, "child", "type");
    expect(root.typeIndex).toBe(1);
    expect(derived.typeIndex).toBe(2);
    const types = new Map([
      ["prior", prior],
      ["root", root],
      ["child", derived],
    ]);
    for (const [index, token] of [root, derived].entries())
      compareNativeResourceDeclarationShape(
        f.tx,
        plan.declarations[index]!,
        { key: token.key, space: "type", definition: token.object },
        types,
      );
    f.tx.freezeReservations();
    f.tx.seal();
    expect(WebAssembly.validate(emitBinary(f.module) as BufferSource)).toBe(true);
  });
  it.each([
    "missing-parent",
    "missing-final",
    "true-final",
    "undefined-final",
    "resource-self-parent",
    "prior-parent",
    "extra-root-field",
    "extra-shape-field",
    "extra-field",
    "extra-type-field",
    "extra-array-field",
    "future-field",
    "sparse-field",
    "parent-getter",
    "final-getter",
  ] as const)(
    "rejects invalid symbolic %s before the first append and leaves valid replay coordinates intact",
    (variant) => {
      const f = fixture(),
        valid = recipe(),
        invalid = structuredClone(valid),
        root = (invalid.declarations[0] as any).shape;
      const getter = vi.fn(() => ({ kind: "root" }));
      if (variant === "missing-parent") Reflect.deleteProperty(root, "parent");
      if (variant === "missing-final") Reflect.deleteProperty(root, "final");
      if (variant === "true-final") root.final = true;
      if (variant === "undefined-final") root.final = undefined;
      if (variant === "resource-self-parent") root.parent = { kind: "resource", typeKey: "root" };
      if (variant === "prior-parent") root.parent = { kind: "resource", typeKey: "prefix" };
      if (variant === "extra-root-field") root.parent.extra = true;
      if (variant === "extra-shape-field") root.extra = true;
      if (variant === "extra-field") root.fields[0].extra = true;
      if (variant === "extra-type-field") root.fields[0].type.extra = true;
      if (variant === "extra-array-field") root.fields.extra = true;
      if (variant === "future-field") root.fields[1].type = { kind: "ref_null", typeKey: "future" };
      if (variant === "sparse-field") Reflect.deleteProperty(root.fields, 1);
      if (variant === "parent-getter") Object.defineProperty(root, "parent", { get: getter });
      if (variant === "final-getter") Object.defineProperty(root, "final", { get: getter });
      const first: NativeStringValueDeclaration = {
        key: "prefix",
        role: ["prefix"],
        space: "type",
        shape: { kind: "struct", name: "Prefix", fields: [] },
      };
      const withPrefix: NativeResourceRecipe = {
        declarations: [first, ...invalid.declarations],
        reservationSteps: [{ phase: "resources", kind: "reserve", resourceKey: "prefix" }, ...invalid.reservationSteps],
      };
      noAllocation(f, () => executeNativeResourceRecipe(f.tx, withPrefix));
      expect(getter).not.toHaveBeenCalled();
      expect(f.tx.state).toBe("reserving");
      const actual = executeNativeResourceRecipe(f.tx, valid),
        twin = executeNativeResourceRecipe(fixture().tx, valid);
      expect(requireNativeDeclaredReservation(actual, "root", "type").typeIndex).toBe(
        requireNativeDeclaredReservation(twin, "root", "type").typeIndex,
      );
    },
  );
  it.each(["array", "global", "signature", "parent"] as const)(
    "does not grant future %s references outside a self field",
    (kind) => {
      const f = fixture();
      const future: NativeStringValueDeclaration = {
        key: "future",
        role: ["future"],
        space: "type",
        shape: { kind: "struct", name: "Future", fields: [] },
      };
      const row: NativeStringValueDeclaration =
        kind === "array"
          ? {
              key: "bad",
              role: ["bad"],
              space: "type",
              shape: { kind: "array", name: "Bad", element: { kind: "ref_null", typeKey: "future" }, mutable: true },
            }
          : kind === "global"
            ? {
                key: "bad",
                role: ["bad"],
                space: "global",
                name: "Bad",
                valueType: { kind: "ref_null", typeKey: "future" },
                mutable: false,
              }
            : kind === "signature"
              ? {
                  key: "bad",
                  role: ["bad"],
                  space: "function",
                  name: "Bad",
                  signature: { params: [{ kind: "ref_null", typeKey: "future" }], results: [] },
                }
              : {
                  key: "bad",
                  role: ["bad"],
                  space: "type",
                  shape: {
                    kind: "struct",
                    name: "Bad",
                    fields: [],
                    parent: { kind: "resource", typeKey: "future" },
                    final: false,
                  },
                };
      noAllocation(f, () => executeNativeResourceRecipe(f.tx, recipe([row, future])), /forward|parent/);
      expect(f.tx.state).toBe("reserving");
    },
  );
  it.each(["copied", "foreign", "substituted-key"] as const)(
    "refuses %s prerequisite tokens before allocation",
    (kind) => {
      const f = fixture(),
        real = f.tx.reserveType("prior", { kind: "struct", name: "Prior", fields: [] });
      const plan = recipe(),
        keys = new Map([["prior", real]]);
      expect(() => preflightNativeResourceRecipe(plan, [...keys.keys()])).not.toThrow();
      f.tx.assertTypeReservation(real);
      if (kind === "copied") keys.set("prior", { ...real });
      if (kind === "foreign")
        keys.set("prior", fixture().tx.reserveType("prior", { kind: "struct", name: "Prior", fields: [] }));
      if (kind === "substituted-key") {
        keys.delete("prior");
        keys.set("other", real);
      }
      noAllocation(f, () => executeNativeResourceRecipe(f.tx, plan, keys), /foreign|unissued|substituted|owned/);
    },
  );
  it.each([
    "copied-token",
    "foreign-token",
    "copied-definition",
    "wrong-self-index",
    "wrong-finality",
    "extra-parent-field",
  ] as const)("comparison authenticates actual self root against %s", (kind) => {
    const f = fixture(),
      plan = recipe(),
      records = executeNativeResourceRecipe(f.tx, plan),
      root = requireNativeDeclaredReservation(records, "root", "type");
    const types = new Map([["root", root]]),
      observed = { key: "root", space: "type" as const, definition: root.object };
    compareNativeResourceDeclarationShape(f.tx, plan.declarations[0]!, observed, types);
    const changed = structuredClone(plan.declarations[0]!) as Extract<NativeStringValueDeclaration, { space: "type" }>;
    if (kind === "copied-token") types.set("root", { ...root });
    if (kind === "foreign-token")
      types.set(
        "root",
        requireNativeDeclaredReservation(executeNativeResourceRecipe(fixture().tx, plan), "root", "type"),
      );
    if (kind === "copied-definition") observed.definition = structuredClone(root.object);
    if (kind === "wrong-self-index")
      (observed.definition as StructTypeDef).fields[0]!.type = { kind: "ref_null", typeIdx: 1 };
    if (kind === "wrong-finality") (changed.shape as any).final = true;
    if (kind === "extra-parent-field") (changed.shape as any).parent.extra = true;
    expect(() => compareNativeResourceDeclarationShape(f.tx, changed, observed, types)).toThrow();
  });
});
