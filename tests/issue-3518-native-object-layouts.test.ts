// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import {
  PhysicalModuleReservations,
  type SelfReferentialStructDefinition,
} from "../src/wasm/physical/module-reservations.js";
import {
  compareNativeResourceDeclarationShape,
  executeNativeResourceRecipe,
  executeNativeResourceRecipeWithSignatures,
  preflightNativeResourceRecipe,
} from "../src/backend/wasmgc/resources/native-resource-declarations.js";
import type {
  NativeResourceRecipe,
  NativeStringValueDeclaration,
} from "../src/runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
  requireNativeObjectLayouts,
  nativeObjectLayoutReservationInventory,
} from "../src/backend/wasmgc/resources/native-object-layouts.js";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
function fixture() {
  const module = createEmptyModule();
  return { module, tx: new PhysicalModuleReservations(module) };
}
function prefix(tx: PhysicalModuleReservations) {
  tx.reserveType("existing:rec", {
    kind: "rec",
    types: [
      { kind: "struct", name: "prefix0", fields: [{ name: "a", type: { kind: "i64" }, mutable: false }] },
      { kind: "struct", name: "prefix1", fields: [{ name: "b", type: { kind: "f64" }, mutable: false }] },
    ],
  });
}
function recursiveDefinition(): SelfReferentialStructDefinition {
  return {
    name: "node",
    fields: [
      { name: "next", type: { kind: "ref_null", self: true }, mutable: true },
      { name: "value", type: { kind: "i32" }, mutable: true },
    ],
  };
}
function noAllocation(module: ReturnType<typeof createEmptyModule>, action: () => unknown, error?: string | RegExp) {
  const before = structuredClone(module),
    arrays = [module.types, module.functions, module.globals, module.funcOrdinalToPosition];
  expect(action).toThrow(error);
  expect(module).toStrictEqual(before);
  expect(
    [module.types, module.functions, module.globals, module.funcOrdinalToPosition].every((v, i) => v === arrays[i]),
  ).toBe(true);
}
function recipe(declarations: NativeStringValueDeclaration[]): NativeResourceRecipe {
  return {
    declarations,
    reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
  };
}
function simpleRecipe(): NativeResourceRecipe {
  return recipe([
    { key: "prefix", role: ["prefix"], space: "type", shape: { kind: "struct", name: "prefix", fields: [] } },
  ]);
}
function objectFixture(withPrefix = false) {
  const f = fixture();
  if (withPrefix) prefix(f.tx);
  const requirements = { key: "object" },
    plan = declareNativeObjectLayouts(requirements);
  const pack = reserveNativeObjectLayouts(f.tx, requirements, plan);
  return { ...f, requirements, plan, pack };
}

it.each([false, true])(
  "resolves a real self reference at the ledger's flattened coordinate (prefix=%s)",
  (withPrefix) => {
    const { module, tx } = fixture();
    if (withPrefix) prefix(tx);
    const type = tx.reserveSelfReferentialStructType("node", recursiveDefinition());
    expect(type.typeIndex).toBe(withPrefix ? 2 : 0);
    expect(type.object).toStrictEqual({
      kind: "struct",
      name: "node",
      fields: [
        { name: "next", type: { kind: "ref_null", typeIdx: type.typeIndex }, mutable: true },
        { name: "value", type: { kind: "i32" }, mutable: true },
      ],
    });
    const fn = tx.reserveFunction("test", "test", { params: [], results: [{ kind: "i32" }] });
    tx.freezeReservations();
    tx.fillFunction(fn, {
      locals: [],
      body: [
        { op: "ref.null", typeIdx: type.typeIndex },
        { op: "i32.const", value: 23 },
        { op: "struct.new", typeIdx: type.typeIndex },
        { op: "i32.const", value: 7 },
        { op: "struct.new", typeIdx: type.typeIndex },
        { op: "struct.get", typeIdx: type.typeIndex, fieldIdx: 0 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: type.typeIndex, fieldIdx: 1 },
      ],
    });
    tx.defineExport("export", "test", fn);
    tx.seal();
    const bytes = emitBinary(module);
    expect(WebAssembly.validate(bytes)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
    expect((instance.exports.test as () => number)()).toBe(23);
  },
);

it.each([
  "self-false",
  "wrong-kind",
  "numeric-self",
  "forward",
  "missing-ref",
  "parent",
  "field-getter",
  "sparse",
  "empty",
  "callback",
])("rejects malformed self descriptor %s before any append", (variant) => {
  const positive = fixture();
  positive.tx.reserveSelfReferentialStructType("node", recursiveDefinition());
  const bad = recursiveDefinition() as any;
  const getter = vi.fn(() => "node");
  if (variant === "self-false") bad.fields[0].type.self = false;
  if (variant === "wrong-kind") bad.fields[0].type.kind = "i32";
  if (variant === "numeric-self") bad.fields[0].type.typeIdx = 0;
  if (variant === "forward") bad.fields[1].type = { kind: "ref_null", typeIdx: 0 };
  if (variant === "missing-ref") bad.fields[1].type = { kind: "ref_null" };
  if (variant === "parent") bad.parent = "self";
  if (variant === "field-getter") Object.defineProperty(bad, "name", { get: getter });
  if (variant === "sparse") Reflect.deleteProperty(bad.fields, 1);
  if (variant === "empty") bad.fields = [];
  const f = fixture();
  noAllocation(f.module, () =>
    f.tx.reserveSelfReferentialStructType("node", variant === "callback" ? ((() => bad) as never) : bad),
  );
  expect(getter).not.toHaveBeenCalled();
});

it("refuses a duplicate self-type key without appending a second type", () => {
  const f = fixture();
  f.tx.reserveSelfReferentialStructType("node", recursiveDefinition());
  noAllocation(
    f.module,
    () => f.tx.reserveSelfReferentialStructType("node", recursiveDefinition()),
    "duplicate self-type key",
  );
});

it.each(["frozen", "sealed"])("refuses the self-type entrypoint after reservations are %s", (phase) => {
  const f = fixture();
  f.tx.reserveSelfReferentialStructType("node", recursiveDefinition());
  f.tx.freezeReservations();
  if (phase === "sealed") f.tx.seal();
  noAllocation(f.module, () => f.tx.reserveSelfReferentialStructType("late", recursiveDefinition()));
});

it.each(["intern", "reserve"])("refuses a swallowed reentrant %s attempt from a descriptor trap", (route) => {
  const positive = fixture();
  positive.tx.reserveSelfReferentialStructType("node", recursiveDefinition());
  const f = fixture();
  let attempted = false;
  const trapped = new Proxy(recursiveDefinition(), {
    getOwnPropertyDescriptor(target, key) {
      if (!attempted) {
        attempted = true;
        try {
          if (route === "intern") f.tx.internFunctionType([], []);
          else f.tx.reserveType("intruder", { kind: "struct", name: "intruder", fields: [] });
        } catch {
          /* Caller deliberately swallows the rejection; the outer operation must still fail. */
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  noAllocation(f.module, () => f.tx.reserveSelfReferentialStructType("node", trapped), /failed|reentrant/);
  expect(attempted).toBe(true);
  expect(f.tx.state).toBe("failed");
});

it("uses data descriptors rather than a Proxy get result for a self definition", () => {
  const f = fixture(),
    get = vi.fn(() => {
      throw Error("unchecked read");
    });
  const definition = recursiveDefinition();
  const type = f.tx.reserveSelfReferentialStructType(
    "node",
    new Proxy({ ...definition, fields: new Proxy(definition.fields, { get }) }, { get }),
  );
  expect(type.object.name).toBe("node");
  expect(get).not.toHaveBeenCalled();
});

it.each(["array", "global", "signature"] as const)(
  "rejects a late missing %s reference key in both recipe populations",
  (kind) => {
    for (const withSelf of [false, true]) {
      const start = withSelf ? structuredClone(declareNativeObjectLayouts({ key: "object" })) : simpleRecipe();
      const prior = start.declarations[0]!.key;
      const late: NativeStringValueDeclaration =
        kind === "array"
          ? {
              key: "late",
              role: ["late"],
              space: "type",
              shape: { kind: "array", name: "late", mutable: true, element: { kind: "ref_null", typeKey: prior } },
            }
          : kind === "global"
            ? {
                key: "late",
                role: ["late"],
                space: "global",
                name: "late",
                mutable: false,
                valueType: { kind: "ref_null", typeKey: prior },
              }
            : {
                key: "late",
                role: ["late"],
                space: "function",
                name: "late",
                signature: { params: [{ kind: "ref_null", typeKey: prior }], results: [] },
              };
      const good = recipe([...start.declarations, late]);
      expect(executeNativeResourceRecipe(fixture().tx, good).size).toBe(good.declarations.length);
      const bad = structuredClone(good),
        row: any = bad.declarations.at(-1);
      Reflect.deleteProperty(
        kind === "array" ? row.shape.element : kind === "global" ? row.valueType : row.signature.params[0],
        "typeKey",
      );
      const f = fixture();
      noAllocation(f.module, () => executeNativeResourceRecipe(f.tx, bad), "missing/forward symbolic type key");
    }
  },
);

it.each(["self-parent", "foreign-forward", "missing-field-key", "branded-field", "non-data", "sparse", "self-array"])(
  "preflights late invalid object recipe %s before its valid prefix",
  (variant) => {
    const good = declareNativeObjectLayouts({ key: "object" });
    expect(executeNativeResourceRecipe(fixture().tx, good).size).toBe(3);
    const bad: any = structuredClone(good),
      shape = bad.declarations[2].shape;
    const getter = vi.fn(() => shape.fields);
    if (variant === "self-parent") shape.parent = { kind: "resource", typeKey: bad.types.object };
    if (variant === "foreign-forward") shape.fields[0].type.typeKey = "future";
    if (variant === "missing-field-key") Reflect.deleteProperty(shape.fields[0].type, "typeKey");
    if (variant === "branded-field") shape.fields[2].type.boolean = true;
    if (variant === "non-data") Object.defineProperty(shape, "fields", { get: getter });
    if (variant === "sparse") Reflect.deleteProperty(shape.fields, 5);
    if (variant === "self-array")
      bad.declarations[2].shape = {
        kind: "array",
        name: "bad",
        mutable: true,
        element: { kind: "ref_null", typeKey: bad.types.object },
      };
    const f = fixture();
    noAllocation(f.module, () => executeNativeResourceRecipe(f.tx, bad));
    expect(getter).not.toHaveBeenCalled();
  },
);

it("refuses a late resource-key collision without allocating its valid prefix", () => {
  const plan = declareNativeObjectLayouts({ key: "object" });
  expect(executeNativeResourceRecipe(fixture().tx, plan).size).toBe(3);
  const f = fixture();
  f.tx.reserveType(plan.types.object, { kind: "struct", name: "occupied", fields: [] });
  noAllocation(f.module, () => executeNativeResourceRecipe(f.tx, plan), "duplicate planned resource key");
});

it.each(["", "duplicate", "existing"])("batch key check %s changes no module population", (kind) => {
  const f = fixture();
  f.tx.assertReservationKeysAvailable(["a", "b"]);
  expect(f.module.types).toHaveLength(0);
  if (kind === "existing") f.tx.reserveType("b", { kind: "struct", name: "b", fields: [] });
  noAllocation(f.module, () =>
    f.tx.assertReservationKeysAvailable(kind === "duplicate" ? ["a", "a"] : ["a", kind === "" ? "" : "b"]),
  );
});

it("keeps signature observation names outside the ledger resource-key namespace", () => {
  const f = fixture();
  f.tx.reserveType("observed", { kind: "struct", name: "existing", fields: [] });
  const base = simpleRecipe();
  const plan: NativeResourceRecipe = {
    ...base,
    reservationSteps: [
      ...base.reservationSteps,
      {
        kind: "intern-signature",
        phase: "resources",
        key: "observed",
        signature: { params: [], results: [] },
      },
    ],
  };
  const result = executeNativeResourceRecipeWithSignatures(f.tx, plan);
  expect(result.reservations.size).toBe(1);
  expect(result.signatures.get("observed")).toBe(2);
});

it("executes exactly the recipe descriptor snapshot despite different get trap values", () => {
  const plan = declareNativeObjectLayouts({ key: "object" }),
    get = vi.fn(() => {
      throw Error("unchecked recipe read");
    });
  const proxied = new Proxy(structuredClone(plan), { get });
  const f = fixture(),
    records = executeNativeResourceRecipe(f.tx, proxied);
  expect(records.size).toBe(3);
  expect(f.module.types[2]!.name).toBe("$Object");
  expect(get).not.toHaveBeenCalled();
  const snapshot = preflightNativeResourceRecipe(proxied);
  expect(snapshot).toEqual(plan);
  expect(snapshot === proxied).toBe(false);
  expect(get).not.toHaveBeenCalled();
});

it.each(["copy", "foreign", "missing"])(
  "authenticates prerequisite tokens before prefix allocation (%s)",
  (variant) => {
    const f = fixture(),
      external = f.tx.reserveType("external", { kind: "struct", name: "external", fields: [] });
    const plan = recipe([
      ...simpleRecipe().declarations,
      {
        key: "late",
        role: ["late"],
        space: "type",
        shape: {
          kind: "array",
          name: "late",
          mutable: true,
          element: { kind: "ref_null", typeKey: "external" },
        },
      },
    ]);
    const good = fixture(),
      goodExternal = good.tx.reserveType("external", { kind: "struct", name: "external", fields: [] });
    expect(executeNativeResourceRecipe(good.tx, plan, new Map([["external", goodExternal]])).size).toBe(2);
    const wrong =
      variant === "copy"
        ? { ...external }
        : fixture().tx.reserveType("external", { kind: "struct", name: "external", fields: [] });
    noAllocation(f.module, () =>
      executeNativeResourceRecipe(f.tx, plan, new Map(variant === "missing" ? [] : [["external", wrong]])),
    );
  },
);

it.each([false, true])("matches fixed historical Object layout declarations (prefix=%s)", (withPrefix) => {
  // Exact layout span from 9dd54aff748b62b7417e7b0d4b0bf95e172bb4b3; no candidate-derived receipt.
  const source = readFileSync(new URL("../src/codegen/object-runtime.ts", import.meta.url), "utf8");
  const start = source.indexOf("  const propEntryTypeIdx = ctx.mod.types.length;");
  const text = source.slice(start, source.indexOf("  // $ObjVec backing array:", start));
  expect(createHash("sha256").update(text).digest("hex")).toBe(
    "e4d546ab2007a44fe45d5bcda8453e190aaaa89296d427c7de20df045ec8f547",
  );
  const f = fixture();
  if (withPrefix) f.tx.reserveType("ordinary-prefix", { kind: "func", params: [], results: [] });
  const before = structuredClone(f.module.types),
    ctx = { mod: { types: structuredClone(before) } };
  const js = ts.transpile(text, { target: ts.ScriptTarget.ES2022 });
  Function("ctx", js)(ctx);
  const requirements = { key: "object" },
    plan = declareNativeObjectLayouts(requirements);
  const pack = reserveNativeObjectLayouts(f.tx, requirements, plan);
  expect(f.module.types).toStrictEqual(ctx.mod.types);
  expect(nativeObjectLayoutReservationInventory(f.tx, pack, plan)).toEqual([pack.propEntry, pack.propMap, pack.object]);
});

it.each(["copied-pack", "foreign-ledger", "copied-plan", "mutated-plan", "mutated-requirements", "mutated-layout"])(
  "refuses changed layout owner evidence (%s)",
  (variant) => {
    const f = fixture(),
      requirements = { key: "object" },
      plan = structuredClone(declareNativeObjectLayouts(requirements));
    const pack = reserveNativeObjectLayouts(f.tx, requirements, plan);
    expect(requireNativeObjectLayouts(f.tx, pack, plan)).toBe(pack);
    if (variant === "mutated-plan") (plan.declarations[2] as any).shape.fields[0].mutable = false;
    if (variant === "mutated-requirements") requirements.key = "different";
    if (variant === "mutated-layout") (pack.object.object as any).fields[0].mutable = false;
    expect(() =>
      requireNativeObjectLayouts(
        variant === "foreign-ledger" ? fixture().tx : f.tx,
        variant === "copied-pack" ? { ...pack } : pack,
        variant === "copied-plan" ? structuredClone(plan) : plan,
      ),
    ).toThrow();
  },
);

it("the owner compares, executes and looks up tokens from one retained plan snapshot", () => {
  const f = fixture(),
    requirements = { key: "object" },
    raw = structuredClone(declareNativeObjectLayouts(requirements));
  const get = vi.fn(() => {
      throw Error("unchecked owner plan read");
    }),
    plan = new Proxy(raw, { get });
  const pack = reserveNativeObjectLayouts(f.tx, requirements, plan);
  expect(requireNativeObjectLayouts(f.tx, pack, plan)).toBe(pack);
  expect(get).not.toHaveBeenCalled();
  (raw.types as any).object = "substituted";
  expect(() => requireNativeObjectLayouts(f.tx, pack, plan)).toThrow("changed retained declaration plan");
  expect(pack.object.key).toBe("object:object");
});

it.each(["copied-definition", "copied-token", "foreign-token", "missing-token"])(
  "self shape comparison uses the actual issued token (%s)",
  (variant) => {
    const f = objectFixture(),
      declaration = f.plan.declarations[2]!;
    const types = new Map([f.pack.propEntry, f.pack.propMap, f.pack.object].map((t) => [t.key, t]));
    const actual = { key: f.pack.object.key, space: "type" as const, definition: f.pack.object.object };
    expect(() => compareNativeResourceDeclarationShape(f.tx, declaration, actual, types)).not.toThrow();
    if (variant === "copied-definition") actual.definition = structuredClone(actual.definition);
    if (variant === "copied-token") types.set(f.pack.object.key, { ...f.pack.object });
    if (variant === "foreign-token") {
      const foreign = objectFixture().pack.object;
      types.set(f.pack.object.key, foreign);
      actual.definition = foreign.object;
    }
    if (variant === "missing-token") types.delete(f.pack.object.key);
    expect(() => compareNativeResourceDeclarationShape(f.tx, declaration, actual, types)).toThrow();
  },
);

function emittedObjectFixture(withPrefix: boolean) {
  const f = objectFixture(withPrefix),
    { tx, module, pack } = f;
  const object = pack.object.typeIndex,
    entry = pack.propEntry.typeIndex,
    map = pack.propMap.typeIndex;
  const obj = (count: number): Instr[] => [
    { op: "i32.const", value: 2 },
    { op: "array.new_default", typeIdx: map },
    { op: "i32.const", value: count },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: object },
  ];
  const walk = tx.reserveFunction("walk", "walk", { params: [], results: [{ kind: "i32" }] });
  const mutate = tx.reserveFunction("mutate", "mutate", { params: [], results: [{ kind: "i32" }] });
  const value = tx.reserveFunction("value", "value", {
    params: [{ kind: "externref" }],
    results: [{ kind: "externref" }],
  });
  tx.freezeReservations();
  tx.fillFunction(walk, {
    locals: [
      { name: "cursor", type: { kind: "ref_null", typeIdx: object } },
      { name: "sum", type: { kind: "i32" } },
    ],
    body: [
      { op: "ref.null", typeIdx: object },
      ...obj(7),
      ...obj(11),
      { op: "local.set", index: 0 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 0 },
              { op: "ref.is_null" },
              { op: "if", blockType: { kind: "empty" }, then: [{ op: "br", depth: 2 }] },
              { op: "local.get", index: 1 },
              { op: "local.get", index: 0 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: object, fieldIdx: 2 },
              { op: "i32.add" },
              { op: "local.set", index: 1 },
              { op: "local.get", index: 0 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: object, fieldIdx: 0 },
              { op: "local.set", index: 0 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "i32.const", value: 100 },
      { op: "i32.mul" },
      { op: "local.get", index: 1 },
      { op: "i32.add" },
    ],
  });
  tx.fillFunction(mutate, {
    locals: [{ name: "o", type: { kind: "ref_null", typeIdx: object } }],
    body: [
      { op: "ref.null", typeIdx: object },
      ...obj(1),
      { op: "local.set", index: 0 },
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "i32.const", value: 23 },
      { op: "struct.set", typeIdx: object, fieldIdx: 2 },
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "i32.const", value: 45 },
      { op: "struct.set", typeIdx: object, fieldIdx: 4 },
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: object, fieldIdx: 2 },
      { op: "i32.const", value: 100 },
      { op: "i32.mul" },
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: object, fieldIdx: 4 },
      { op: "i32.add" },
    ],
  });
  tx.fillFunction(value, {
    locals: [{ name: "e", type: { kind: "ref_null", typeIdx: entry } }],
    body: [
      { op: "ref.null.eq" },
      { op: "ref.null.eq" },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 31 },
      { op: "ref.null.eq" },
      { op: "ref.null.eq" },
      { op: "struct.new", typeIdx: entry },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 1 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "struct.set", typeIdx: entry, fieldIdx: 1 },
      { op: "local.get", index: 1 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: entry, fieldIdx: 1 },
      { op: "extern.convert_any" },
    ],
  });
  for (const fn of [walk, mutate, value]) tx.defineExport("export:" + fn.key, fn.key, fn);
  expect(requireNativeObjectLayouts(tx, pack, f.plan)).toBe(pack);
  tx.seal();
  expect(requireNativeObjectLayouts(tx, pack, f.plan)).toBe(pack);
  const bytes = emitBinary(module);
  expect(WebAssembly.validate(bytes)).toBe(true);
  return { ...f, exports: new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports };
}

it.each([false, true])(
  "executes linked Object traversal, null termination and real mutable fields (rec prefix=%s)",
  (withPrefix) => {
    const f = emittedObjectFixture(withPrefix);
    expect(f.pack.object.typeIndex).toBe(withPrefix ? 4 : 2);
    expect((f.exports.walk as () => number)()).toBe(118);
    expect((f.exports.mutate as () => number)()).toBe(2345);
    const value = f.exports.value as (value: unknown) => unknown,
      identity = { identity: 17 };
    expect(value(identity)).toBe(identity);
    expect(value(null)).toBeNull();
    expect(value(undefined)).toBeUndefined();
  },
);
