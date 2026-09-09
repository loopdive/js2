// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { planNativeValueResources } from "../src/ir/program-physical-plan.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { indexPhysicalTypes } from "../src/wasm/physical/type-layout.js";
import {
  declareNativeStringLiteralTypes,
  declareNativeStringLiteralResources,
  reserveNativeStringLiteralTypes,
  reserveNativeStringLiteralResources,
  nativeStringLiteralReservationInventory,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  declareNativeStringFlattenResources,
  reserveNativeStringFlattenResources,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  declareNativeStringNumberResources,
  reserveNativeStringNumberResources,
} from "../src/backend/wasmgc/resources/native-string-number.js";
import {
  declareNativeValueResources,
  reserveNativeValueResources,
} from "../src/backend/wasmgc/resources/native-values.js";
import {
  executeNativeResourceRecipe,
  instantiateNativeDeclaredType,
  instantiateNativeDeclaredValType,
  compareNativeResourceDeclarationShape,
} from "../src/backend/wasmgc/resources/native-resource-declarations.js";
import type {
  NativeResourceRecipe,
  NativeStringValueDeclaration,
} from "../src/runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  createStringDataType,
  createAnyStringType,
  createNativeStringType,
  createConsStringType,
  createHashedStringType,
  createUtf8StringDataType,
  createUtf8StringType,
} from "../src/runtime/wasmgc/values/string-layouts.js";

function fixture() {
  const module = createEmptyModule();
  return { module, tx: new PhysicalModuleReservations(module) };
}

it.each(["params", "results", "fields", "roles"] as const)(
  "rejects late sparse %s without consuming keys or hidden ordinals",
  (part) => {
    const declarations: NativeStringValueDeclaration[] = [
      { key: "first", role: ["first"], space: "type", shape: { kind: "struct", name: "first", fields: [] } },
      {
        key: "late-type",
        role: ["late-type"],
        space: "type",
        shape: { kind: "struct", name: "late", fields: [{ name: "value", type: { kind: "i32" }, mutable: false }] },
      },
      {
        key: "late-function",
        role: ["late-function"],
        space: "function",
        name: "late",
        signature: { params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
      },
    ];
    const good: NativeResourceRecipe = {
      declarations,
      reservationSteps: declarations.map((row) => ({ phase: "resources", kind: "reserve", resourceKey: row.key })),
    };
    expect(executeNativeResourceRecipe(fixture().tx, good).size).toBe(3);
    const bad = structuredClone(good);
    if (part === "roles") Object.assign(bad.declarations[2]!, { role: new Array(1) });
    else if (part === "fields") {
      const row = bad.declarations[1]!;
      if (row.space !== "type") throw new Error("expected type");
      Object.assign(row.shape, { fields: new Array(1) });
    } else {
      const row = bad.declarations[2]!;
      if (row.space !== "function") throw new Error("expected function");
      Object.assign(row.signature, { [part]: new Array(1) });
    }
    const target = fixture(),
      twin = fixture();
    const before = structuredClone(target.module);
    const arrays = [
      target.module.types,
      target.module.functions,
      target.module.globals,
      target.module.funcOrdinalToPosition,
    ];
    expect(() => executeNativeResourceRecipe(target.tx, bad)).toThrow(/sparse/);
    expect(target.module).toStrictEqual(before);
    [target.module.types, target.module.functions, target.module.globals, target.module.funcOrdinalToPosition].forEach(
      (array, i) => expect(array === arrays[i]).toBe(true),
    );
    const probe = (tx: PhysicalModuleReservations) => {
      const records = executeNativeResourceRecipe(tx, good);
      return [...records.values()].map((token) =>
        token.kind === "type"
          ? { key: token.key, index: token.typeIndex }
          : token.kind === "function"
            ? { key: token.key, handle: token.handle, signature: token.object.typeIdx }
            : { key: token.key },
      );
    };
    expect(probe(target.tx)).toStrictEqual(probe(twin.tx));
    expect(target.module).toStrictEqual(twin.module);
  },
);

it("preserves canonical scalar brands and ref_extern, rejecting unsupported scalar spellings", () => {
  const { tx } = fixture();
  for (const value of [
    { kind: "i32", boolean: true },
    { kind: "i64", bigint: true },
    { kind: "f64", undefSentinel: true },
    { kind: "ref_extern" },
  ] as const) {
    expect(instantiateNativeDeclaredValType(tx, value, new Map())).toStrictEqual(value);
  }
  const good: NativeResourceRecipe = {
    declarations: [
      { key: "g", role: ["test"], space: "global", name: "g", mutable: false, valueType: { kind: "ref_extern" } },
    ],
    reservationSteps: [{ phase: "resources", kind: "reserve", resourceKey: "g" }],
  };
  executeNativeResourceRecipe(tx, good);
  for (const kind of ["i31ref", "structref", "arrayref", "nullref"]) {
    const bad = structuredClone(good);
    const row = bad.declarations[0]!;
    if (row.space !== "global") throw new Error("expected global");
    Object.assign(row.valueType, { kind });
    const target = fixture();
    const before = structuredClone(target.module);
    expect(() => executeNativeResourceRecipe(target.tx, bad)).toThrow(/unsupported/);
    expect(target.module).toStrictEqual(before);
  }
});

it("actual issued-plan scanner/value producers match their complete recipes", () => {
  const { packet } = sourcePacket({ "./entry.ts": "export function main(): number { return 42; }" });
  const program = requireProgram(prepareTypedIrProgram(packet, typedOptions));
  const plan = planNativeValueResources(
    program,
    { backend: "wasmgc", target: "standalone" },
    program.runtime[0]!,
    "native-string",
  );
  const { tx, module } = fixture();
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "s",
    utf8Storage: false,
    literals: [{ value: "", encoding: "wtf16" }],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "flat", strings);
  const scanner = reserveNativeStringNumberResources(tx, plan, flatten);
  const values = reserveNativeValueResources(tx, plan, {
    strings: { kind: "native-string", stringPack: strings, scanner },
  });
  const tokens = [
    scanner.toNumber,
    scanner.powerArray,
    scanner.powerGlobal,
    values.types.anyValue,
    values.globals.undefined,
    values.types.boxedNumber,
    values.types.boxedBoolean,
    values.functions.boxNumber,
    values.functions.unboxNumber,
    values.functions.isNumber,
  ];
  const declarations = [
    ...declareNativeStringNumberResources(plan.anchor).declarations,
    ...declareNativeValueResources(plan.anchor).declarations,
  ];
  expect(tokens.map((token) => token.key)).toStrictEqual(declarations.map((row) => row.key));
  const types = new Map(tokens.filter((token) => token.kind === "type").map((token) => [token.key, token]));
  declarations.forEach((row, i) => {
    const token = tokens[i]!;
    if (token.kind === "type")
      compareNativeResourceDeclarationShape(
        tx,
        row,
        { key: token.key, space: "type", definition: token.object },
        types,
      );
    else if (token.kind === "global") {
      const { name, type, mutable } = token.object;
      compareNativeResourceDeclarationShape(
        tx,
        row,
        { key: token.key, space: "global", header: { name, type, mutable } },
        types,
      );
    } else {
      const signature = indexPhysicalTypes(module.types).entries[token.object.typeIdx]?.definition;
      if (!signature || signature.kind !== "func") throw new Error("expected actual function signature");
      compareNativeResourceDeclarationShape(
        tx,
        row,
        {
          key: token.key,
          space: "function",
          name: token.object.name,
          signature: { params: signature.params, results: signature.results },
        },
        types,
      );
    }
  });
  const row = structuredClone(declarations[0]!);
  if (row.space !== "function") throw new Error("expected scanner");
  Object.assign(row.signature, { results: [{ kind: "i32" }] });
  const signature = indexPhysicalTypes(module.types).entries[scanner.toNumber.object.typeIdx]!.definition;
  if (signature.kind !== "func") throw new Error("expected actual scanner signature");
  expect(() =>
    compareNativeResourceDeclarationShape(
      tx,
      row,
      {
        key: scanner.toNumber.key,
        space: "function",
        name: scanner.toNumber.object.name,
        signature: { params: signature.params, results: signature.results },
      },
      types,
    ),
  ).toThrow(/mismatch/);
});

it.each([false, true])("symbolic and numeric string constructors agree, utf8=%s", (utf8) => {
  const { tx } = fixture();
  const pack = reserveNativeStringLiteralTypes(tx, "s", utf8);
  const l = pack.layout;
  const expected = [
    createStringDataType(),
    createAnyStringType(),
    createNativeStringType(l),
    createConsStringType(l),
    createHashedStringType(l),
  ];
  if (utf8) expected.push(createUtf8StringDataType(), createUtf8StringType(l));
  expect(pack.types.map((token) => token.object)).toStrictEqual(expected);
  const types = new Map(pack.types.map((token) => [token.key, token]));
  declareNativeStringLiteralTypes("s", utf8).declarations.forEach((row, i) => {
    if (row.space !== "type") throw new Error("expected type");
    expect(instantiateNativeDeclaredType(tx, row.shape, types)).toStrictEqual(expected[i]);
  });
});

it.each([false, true])(
  "captures complete private chunks, sharing and separate empty encodings, utf8=%s",
  (utf8Storage) => {
    const { tx } = fixture();
    const value = "x".repeat(20001);
    const requirements = {
      key: "s",
      utf8Storage,
      literals: [
        { value },
        { value },
        { value: "", encoding: "ascii" as const },
        { value: "", encoding: "wtf16" as const },
        { value: "é".repeat(5001), encoding: "utf8-guaranteed" as const },
        { value: "\ud800", encoding: "wtf16" as const },
      ],
    };
    const recipe = declareNativeStringLiteralResources(requirements);
    const pack = reserveNativeStringLiteralResources(tx, requirements);
    const inventory = nativeStringLiteralReservationInventory(tx, pack);
    expect(recipe.requests.map((row) => row.cacheKey)).toStrictEqual(inventory.requests.map((row) => row.cacheKey));
    expect(recipe.globals.map((row) => row.cacheKey)).toStrictEqual(inventory.globals.map((row) => row.cacheKey));
    expect(recipe.functions).toHaveLength(1);
    expect(recipe.functions[0]!.chunkKeys).toStrictEqual([
      `u16:${"x".repeat(10000)}`,
      `u16:${"x".repeat(10000)}`,
      "u16:x",
    ]);
    expect(inventory.functions[0]!.chunkGlobals[0] === inventory.functions[0]!.chunkGlobals[1]).toBe(true);
    expect(inventory.requests[0]!.binding === inventory.requests[1]!.binding).toBe(true);
    expect(inventory.requests[2]!.binding === inventory.requests[3]!.binding).toBe(!utf8Storage);
    const flatten = reserveNativeStringFlattenResources(tx, "flat", pack);
    const flatRecipe = declareNativeStringFlattenResources("flat", "s", utf8Storage);
    expect(flatRecipe.declarations.map((row) => row.key)).toStrictEqual(
      [flatten.worklist, flatten.copyTree, ...(flatten.utf8Decoder ? [flatten.utf8Decoder] : []), flatten.flatten].map(
        (token) => token.key,
      ),
    );
    expect(flatten.worklist.object).toStrictEqual({
      kind: "array",
      name: `__arr_ref_${pack.layout.anyStrTypeIdx}`,
      element: { kind: "ref_null", typeIdx: pack.layout.anyStrTypeIdx },
      mutable: true,
    });
  },
);

it("retains scanner function/type/global order and values explicit intern cache hits", () => {
  const { tx, module } = fixture();
  const scanner = declareNativeStringNumberResources("entry");
  expect(scanner.declarations.map((row) => row.space)).toStrictEqual(["function", "type", "global"]);
  const records = executeNativeResourceRecipe(tx, scanner);
  expect([...records.keys()]).toStrictEqual(scanner.declarations.map((row) => row.key));
  const values = declareNativeValueResources("entry");
  expect(values.reservationSteps.map((step) => step.kind)).toStrictEqual([
    "reserve",
    "reserve",
    "reserve",
    "reserve",
    "intern-signature",
    "intern-signature",
    "intern-signature",
    "reserve",
    "reserve",
    "reserve",
  ]);
  tx.internFunctionType([{ kind: "externref" }], [{ kind: "i32" }]);
  tx.internFunctionType([{ kind: "externref" }], [{ kind: "f64" }]);
  tx.internFunctionType([{ kind: "f64" }], [{ kind: "externref" }]);
  const before = module.types.length;
  const intern = vi.spyOn(tx, "internFunctionType");
  executeNativeResourceRecipe(tx, values);
  expect(intern.mock.calls.slice(0, 3)).toStrictEqual([
    [[{ kind: "externref" }], [{ kind: "i32" }]],
    [[{ kind: "externref" }], [{ kind: "f64" }]],
    [[{ kind: "f64" }], [{ kind: "externref" }]],
  ]);
  expect(module.types.length - before).toBe(3);
  intern.mockRestore();
});

it.each(["missing-step", "extra-step", "forward-ref", "unsupported"] as const)(
  "rejects malformed recipe %s before allocation",
  (mutation) => {
    const good = declareNativeStringLiteralTypes("s", false);
    executeNativeResourceRecipe(fixture().tx, good);
    const draft = structuredClone(good) as {
      declarations: NativeStringValueDeclaration[];
      reservationSteps: NativeResourceRecipe["reservationSteps"][number][];
    };
    if (mutation === "missing-step") draft.reservationSteps.pop();
    if (mutation === "extra-step") draft.reservationSteps.push(draft.reservationSteps[0]!);
    if (mutation === "forward-ref") draft.reservationSteps.reverse();
    if (mutation === "unsupported")
      Object.assign(draft.declarations[0]!, { shape: { kind: "func", params: [], results: [] } });
    const { tx, module } = fixture();
    const before = structuredClone(module);
    expect(() => executeNativeResourceRecipe(tx, draft)).toThrow();
    expect(module).toStrictEqual(before);
    expect(tx.reserveType("probe", { kind: "struct", name: "probe", fields: [] }).typeIndex).toBe(0);
  },
);

it("rejects a same-shaped foreign prerequisite before reserving a dependent resource", () => {
  const a = fixture(),
    b = fixture();
  const own = reserveNativeStringLiteralTypes(a.tx, "s", false);
  const foreign = reserveNativeStringLiteralTypes(b.tx, "s", false);
  const recipe = declareNativeStringFlattenResources("flat", "s", false);
  executeNativeResourceRecipe(a.tx, recipe, new Map(own.types.map((token) => [token.key, token])));
  const c = fixture(),
    before = structuredClone(c.module);
  expect(() =>
    executeNativeResourceRecipe(c.tx, recipe, new Map(foreign.types.map((token) => [token.key, token]))),
  ).toThrow();
  expect(c.module).toStrictEqual(before);
});

it.each(["mutability", "parent", "nullable", "reference"] as const)(
  "detects changed accepted descriptor %s after a genuine comparison",
  (mutation) => {
    const { tx } = fixture();
    const pack = reserveNativeStringLiteralTypes(tx, "s", false);
    const types = new Map(pack.types.map((token) => [token.key, token]));
    const row = declareNativeStringLiteralTypes("s", false).declarations[2]!;
    const actual = { key: pack.types[2]!.key, space: "type" as const, definition: pack.types[2]!.object };
    compareNativeResourceDeclarationShape(tx, row, actual, types);
    const changed = structuredClone(row);
    if (changed.space !== "type" || changed.shape.kind !== "struct") throw new Error("expected struct");
    if (mutation === "mutability") Object.assign(changed.shape.fields[2]!, { mutable: true });
    if (mutation === "parent") Reflect.deleteProperty(changed.shape, "parent");
    if (mutation === "nullable") Object.assign(changed.shape.fields[2]!.type, { kind: "ref_null" });
    if (mutation === "reference") Object.assign(changed.shape.fields[2]!.type, { typeKey: "s:any" });
    expect(() => compareNativeResourceDeclarationShape(tx, changed, actual, types)).toThrow();
  },
);
