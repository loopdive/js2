// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { deriveNativeValueResourcePlan } from "../src/ir/program/native-value-resources.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import {
  reserveNativeStringLiteralResources,
  requireNativeStringLiteral,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
} from "../src/backend/wasmgc/resources/native-string-number.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
} from "../src/backend/wasmgc/resources/native-values.js";
import {
  reserveNativeBooleanResources,
  fillNativeBooleanResources,
  reserveNativeBooleanBoxResources,
  fillNativeBooleanBoxResources,
} from "../src/backend/wasmgc/resources/native-booleans.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
} from "../src/backend/wasmgc/resources/native-bigint.js";
import {
  reserveNativeSymbolCarrierResources,
  fillNativeSymbolCarrierResources,
} from "../src/backend/wasmgc/resources/native-symbol-carrier.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../src/backend/wasmgc/resources/native-object-layouts.js";
import { reserveNativeClosureResources } from "../src/backend/wasmgc/resources/native-closures.js";
import { buildBuiltinClosureValueInstrs } from "../src/runtime/wasmgc/values/closure-layouts.js";
import {
  declareNativeNumberPrimitiveClassifierResources,
  reserveNativeNumberPrimitiveClassifierResources,
  requireNativeNumberPrimitiveClassifierReservations,
  fillNativeNumberPrimitiveClassifierResources,
  requireCompletedNativeNumberPrimitiveClassifier,
  nativeNumberPrimitiveClassifierReservationInventory,
} from "../src/backend/wasmgc/resources/native-number-primitive-classifier.js";
import {
  bigintOperandValues,
  reserveBigIntOperands,
  fillBigIntOperands,
} from "./helpers/native-bigint-carrier-fixture.js";

const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" },
  f64: ValType = { kind: "f64" };
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

function prepare() {
  const policy = { backend: "wasmgc", target: "standalone" } as const;
  const source = prepareIrProgramSources({
    ...sourceInput({ "./entry.ts": "export function main(value: number): number { return value; }" }),
    policy,
  });
  if (source.kind !== "prepared") throw Error(source.detail);
  return requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(source), {
      ...typedOptions,
      policy,
      runtimePolicies: [policy],
    }),
  );
}
let cachedProgram: ReturnType<typeof prepare>;
beforeAll(() => {
  cachedProgram = prepare();
});

function prerequisites(offset = false, program = cachedProgram, mutableBigintPlan = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const prefix = offset ? tx.reserveFunction("prefix:function", "prefix", { params: [], results: [] }) : undefined;
  if (offset) tx.reserveType("prefix:type", { kind: "struct", name: "Prefix", fields: [] });
  const valuePlan = deriveNativeValueResourcePlan(program, program.runtime[0]!, "native-string");
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: offset,
    literals: [
      { value: "", encoding: "wtf16" },
      { value: "42", encoding: "wtf16" },
      { value: "utf8", encoding: "utf8-guaranteed" },
    ],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "flatten", strings);
  const scanner = reserveNativeStringNumberResources(tx, valuePlan, flatten);
  const valueDependencies = { strings: { kind: "native-string" as const, stringPack: strings, scanner } };
  const values = reserveNativeValueResources(tx, valuePlan, valueDependencies);
  const booleans = reserveNativeBooleanResources(tx, "booleans", values, valuePlan, valueDependencies);
  const declared = declareNativeBigIntResources("bigints");
  const bigintPlan = mutableBigintPlan ? structuredClone(declared) : declared;
  const bigints = reserveNativeBigIntResources(tx, "bigints", bigintPlan);
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const dependencies = { values, valuePlan, valueDependencies, booleans, bigints, bigintPlan, strings, symbols };
  return { module, tx, prefix, program, flatten, scanner, ...dependencies, dependencies };
}
function fixture(offset = false, mutablePlan = false, program = cachedProgram, mutableBigintPlan = false) {
  const f = prerequisites(offset, program, mutableBigintPlan);
  const declared = declareNativeNumberPrimitiveClassifierResources("classify");
  const plan = mutablePlan ? structuredClone(declared) : declared;
  const pack = reserveNativeNumberPrimitiveClassifierResources(f.tx, "classify", plan, f.dependencies);
  return { ...f, plan, pack };
}
type Fixture = ReturnType<typeof fixture>;
const current = (f: Fixture) =>
  requireNativeNumberPrimitiveClassifierReservations(f.tx, f.pack, f.plan, f.dependencies);
const completed = (f: Fixture) => requireCompletedNativeNumberPrimitiveClassifier(f.tx, f.pack, f.plan, f.dependencies);
const dependencyKinds = ["strings", "flatten", "scanner", "values", "booleans", "bigints", "symbols"] as const;
type DependencyKind = (typeof dependencyKinds)[number];
function fillDependency(f: Fixture, kind: DependencyKind) {
  switch (kind) {
    case "strings":
      fillNativeStringLiteralResources(f.tx, f.strings);
      break;
    case "flatten":
      fillNativeStringFlattenResources(f.tx, f.flatten);
      break;
    case "scanner":
      fillNativeStringNumberResources(f.tx, f.scanner);
      break;
    case "values":
      fillNativeValueResources(f.tx, f.values, f.valueDependencies);
      break;
    case "booleans":
      fillNativeBooleanResources(f.tx, f.booleans);
      break;
    case "bigints":
      fillNativeBigIntResources(f.tx, f.bigints);
      break;
    case "symbols":
      fillNativeSymbolCarrierResources(f.tx, f.symbols);
      break;
  }
}
function fillDependencies(f: Fixture) {
  if (f.prefix) f.tx.fillFunction(f.prefix, { locals: [], body: [] });
  dependencyKinds.forEach((kind) => fillDependency(f, kind));
}
function complete(f = fixture()) {
  f.tx.freezeReservations();
  fillDependencies(f);
  fillNativeNumberPrimitiveClassifierResources(f.tx, f.pack);
  completed(f);
  return f;
}

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

describe("issued native Number primitive classifier authority", () => {
  it("declares exactly three primitive predicates and no Number or callable authority", () => {
    const f = fixture(true),
      inventory = nativeNumberPrimitiveClassifierReservationInventory(f.tx, f.pack, f.plan, f.dependencies);
    expect(f.pack.completionScope).toBe("native-number-primitive-classification");
    expect(Object.isFrozen(f.pack)).toBe(true);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.functions)).toBe(true);
    expect(inventory.plan.declarations.map((row) => row.role)).toEqual([
      ["number-primitive-classifier", "is-primitive"],
      ["number-primitive-classifier", "is-symbol"],
      ["number-primitive-classifier", "is-nullish"],
    ]);
    for (const row of inventory.plan.declarations)
      expect(row).toMatchObject({ space: "function", signature: { params: [ext], results: [i32] } });
    expect(
      inventory.functions.every((token, index) =>
        Object.is(token, [f.pack.isPrimitive, f.pack.isSymbol, f.pack.isNullish][index]),
      ),
    ).toBe(true);
    expect(Object.is(current(f), f.pack)).toBe(true);
    expect(f.module.exports).toEqual([]);
    expect(() => completed(f)).toThrow("missing canonical fill");
  });

  it.each(["owner", "ledger", "plan", "dependencies"] as const)(
    "rejects a copied or foreign %s after a positive",
    (role) => {
      const f = fixture();
      current(f);
      expect(() =>
        requireNativeNumberPrimitiveClassifierReservations(
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

  it.each([
    "values",
    "valuePlan",
    "valueDependencies",
    "booleans",
    "bigints",
    "bigintPlan",
    "strings",
    "symbols",
  ] as const)("rejects copied dependency %s before allocation", (role) => {
    const f = prerequisites(),
      plan = declareNativeNumberPrimitiveClassifierResources("classify");
    const bad = { ...f.dependencies, [role]: { ...f.dependencies[role] } };
    const before = populations(f);
    expect(() => reserveNativeNumberPrimitiveClassifierResources(f.tx, "classify", plan, bad)).toThrow();
    unchangedPopulations(f, before);
    const pack = reserveNativeNumberPrimitiveClassifierResources(f.tx, "classify", plan, f.dependencies);
    expect(Object.is(requireNativeNumberPrimitiveClassifierReservations(f.tx, pack, plan, f.dependencies), pack)).toBe(
      true,
    );
  });

  it("rejects an authentic but foreign complete dependency root before allocation", () => {
    const foreign = complete(),
      f = prerequisites(),
      before = populations(f);
    expect(() =>
      reserveNativeNumberPrimitiveClassifierResources(
        f.tx,
        "classify",
        declareNativeNumberPrimitiveClassifierResources("classify"),
        foreign.dependencies,
      ),
    ).toThrow();
    unchangedPopulations(f, before);
    expect(Object.is(completed(foreign), foreign.pack)).toBe(true);
  });

  it("rejects a different authentic Symbol/string root on the same ledger", () => {
    const f = prerequisites();
    const strings = reserveNativeStringLiteralResources(f.tx, {
      key: "other-strings",
      utf8Storage: false,
      literals: [{ value: "" }],
    });
    const symbols = reserveNativeSymbolCarrierResources(f.tx, "other-symbols", strings);
    const before = populations(f);
    expect(() =>
      reserveNativeNumberPrimitiveClassifierResources(
        f.tx,
        "classify",
        declareNativeNumberPrimitiveClassifierResources("classify"),
        { ...f.dependencies, strings, symbols },
      ),
    ).toThrow("value/string producer identities differ");
    unchangedPopulations(f, before);
  });

  it("rejects replacement by a genuine same-ledger BigInt owner after a positive", () => {
    const f = fixture();
    current(f);
    const plan = declareNativeBigIntResources("other");
    f.dependencies.bigints = reserveNativeBigIntResources(f.tx, "other", plan);
    f.dependencies.bigintPlan = plan;
    expect(() => current(f)).toThrow("substituted dependency identity");
  });

  it.each(["classifier", "bigint"] as const)("rejects changed borrowed %s plan after a positive", (role) => {
    const f = fixture(false, true, cachedProgram, true);
    current(f);
    Object.defineProperty((role === "classifier" ? f.plan : f.bigintPlan).declarations[0]!, "key", {
      value: "changed",
    });
    expect(() => current(f)).toThrow("changed declaration plan");
  });

  it("rejects a stale issued value plan after a genuine positive", () => {
    const program = structuredClone(cachedProgram),
      f = fixture(false, false, program);
    current(f);
    Object.defineProperty(program.inventory.sources[0]!, "id", { value: "changed-source" });
    expect(() => current(f)).toThrow("stale selected native value requirements");
  });

  it("preflights the full classifier declaration without consuming slots or keys", () => {
    const f = prerequisites(),
      plan = declareNativeNumberPrimitiveClassifierResources("classify"),
      bad = structuredClone(plan);
    Object.defineProperty(bad.declarations[2]!, "name", { value: "substitute" });
    const before = populations(f);
    expect(() => reserveNativeNumberPrimitiveClassifierResources(f.tx, "classify", bad, f.dependencies)).toThrow(
      "substituted declaration plan",
    );
    unchangedPopulations(f, before);
    expect(
      reserveNativeNumberPrimitiveClassifierResources(f.tx, "classify", plan, f.dependencies).isPrimitive.key,
    ).toBe("classify:is-primitive");
  });

  it("preflights the last key collision before allocating the first slot", () => {
    const f = prerequisites();
    f.tx.reserveFunction("classify:is-nullish", "collision", { params: [ext], results: [i32] });
    const before = populations(f);
    expect(() =>
      reserveNativeNumberPrimitiveClassifierResources(
        f.tx,
        "classify",
        declareNativeNumberPrimitiveClassifierResources("classify"),
        f.dependencies,
      ),
    ).toThrow("duplicate planned resource key");
    unchangedPopulations(f, before);
  });

  it.each(["values", "bigints", "symbols", "strings"] as const)(
    "preflights an altered %s layout without allocating",
    (role) => {
      const f = prerequisites();
      const token =
        role === "values"
          ? f.values.types.anyValue
          : role === "bigints"
            ? f.bigints.wide
            : role === "symbols"
              ? f.symbols.types.symbol
              : f.strings.types[0]!;
      Object.defineProperty(token.object, "name", { value: "changed-layout" });
      const before = populations(f);
      expect(() =>
        reserveNativeNumberPrimitiveClassifierResources(
          f.tx,
          "classify",
          declareNativeNumberPrimitiveClassifierResources("classify"),
          f.dependencies,
        ),
      ).toThrow();
      unchangedPopulations(f, before);
    },
  );

  it("refuses reservation after freeze without allocating", () => {
    const f = prerequisites();
    f.tx.freezeReservations();
    const before = populations(f);
    expect(() =>
      reserveNativeNumberPrimitiveClassifierResources(
        f.tx,
        "classify",
        declareNativeNumberPrimitiveClassifierResources("classify"),
        f.dependencies,
      ),
    ).toThrow("invalid reservation phase");
    unchangedPopulations(f, before);
  });

  it.each(["values", "booleans", "bigints", "symbols"] as const)(
    "requires the completed real %s dependency before canonical fill",
    (missing) => {
      const f = fixture();
      f.tx.freezeReservations();
      for (const kind of dependencyKinds) {
        if (kind === missing || (missing === "values" && kind === "booleans")) continue;
        fillDependency(f, kind);
      }
      expect(() => fillNativeNumberPrimitiveClassifierResources(f.tx, f.pack)).toThrow();
      for (const fn of [f.pack.isPrimitive, f.pack.isSymbol, f.pack.isNullish]) expect(fn.object.body).toEqual([]);
      fillDependency(f, missing);
      if (missing === "values") fillDependency(f, "booleans");
      fillNativeNumberPrimitiveClassifierResources(f.tx, f.pack);
      expect(Object.is(completed(f), f.pack)).toBe(true);
    },
  );

  it("does not grant completion to externally filled predicate slots", () => {
    const f = fixture();
    f.tx.freezeReservations();
    fillDependencies(f);
    for (const fn of [f.pack.isNullish, f.pack.isSymbol, f.pack.isPrimitive])
      f.tx.fillFunction(fn, { locals: [], body: [{ op: "i32.const", value: 0 }] });
    expect(() => completed(f)).toThrow("missing canonical fill");
    expect(() => fillNativeNumberPrimitiveClassifierResources(f.tx, f.pack)).toThrow("duplicate function fill");
    expect(f.tx.state).toBe("failed");
    expect(() => completed(f)).toThrow("physical index requested in failed");
  });

  it("rejects duplicate canonical fill without replacing completed instruction arrays", () => {
    const f = complete(),
      functions = [f.pack.isPrimitive, f.pack.isSymbol, f.pack.isNullish];
    const bodies = functions.map((fn) => fn.object.body);
    expect(() => fillNativeNumberPrimitiveClassifierResources(f.tx, f.pack)).toThrow("duplicate canonical fill");
    expect(functions.every((fn, i) => Object.is(fn.object.body, bodies[i]))).toBe(true);
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  it.each(["primitive", "symbol", "nullish", "number", "boolean", "bigint", "symbol-box", "scanner"] as const)(
    "refuses a changed completed %s body",
    (role) => {
      const f = complete();
      completed(f);
      const token = {
        primitive: f.pack.isPrimitive,
        symbol: f.pack.isSymbol,
        nullish: f.pack.isNullish,
        number: f.values.functions.isNumber,
        boolean: f.booleans.isBoolean,
        bigint: f.bigints.isBigInt,
        "symbol-box": f.symbols.functions.box,
        scanner: f.scanner.toNumber,
      }[role];
      token.object.body.push({ op: "nop" });
      expect(() => completed(f)).toThrow("altered completed function");
    },
  );

  it("refuses a changed completed undefined initializer", () => {
    const f = complete();
    completed(f);
    f.values.globals.undefined.object.init.push({ op: "nop" });
    expect(() => completed(f)).toThrow("altered completed global");
  });

  it("refuses a same-signature substituted function object at its original coordinate", () => {
    const f = complete();
    completed(f);
    f.module.functions[f.module.functions.indexOf(f.pack.isSymbol.object)] = { ...f.pack.isSymbol.object };
    expect(() => completed(f)).toThrow("substituted or reordered functions");
  });

  it("refuses a replaced function signature", () => {
    const f = complete();
    completed(f);
    f.pack.isPrimitive.object.typeIdx = f.values.functions.boxNumber.object.typeIdx;
    expect(() => completed(f)).toThrow("altered function descriptor");
  });

  it("refuses a changed Symbol layout after successful completion", () => {
    const f = complete();
    completed(f);
    Object.defineProperty(f.symbols.types.symbol.object, "name", { value: "changed" });
    expect(() => completed(f)).toThrow();
  });
});

/** Observer factories use issued layouts and genuine producers, never predicate stand-ins. */
function reserveExecution(offset: boolean) {
  const f = fixture(offset),
    { tx } = f;
  const booleanBoxes = reserveNativeBooleanBoxResources(
    tx,
    "boolean-boxes",
    f.values,
    f.valuePlan,
    f.valueDependencies,
    "interned",
  );
  const layoutRequirements = { key: "objects" };
  const objects = reserveNativeObjectLayouts(tx, layoutRequirements, declareNativeObjectLayouts(layoutRequirements));
  const closures = reserveNativeClosureResources(tx, {
    key: "closures",
    startingClosureCounter: 0,
    referenceTypes: [],
    requests: [{ kind: "signature", id: "value", params: [], results: [f64], allocationMode: "ordinary" }],
  });
  const lifted = tx.reserveFunction("observer:lifted", "lifted", {
    params: [{ kind: "ref", typeIdx: closures.root.typeIndex }],
    results: [f64],
  });
  const bigintOperands = reserveBigIntOperands(tx);
  const signatures: Record<string, { params: ValType[]; results: ValType[] }> = {
    undefinedValue: { params: [], results: [ext] },
    flat: { params: [], results: [ext] },
    utf8: { params: [], results: [ext] },
    cons: { params: [], results: [ext] },
    hashed: { params: [], results: [ext] },
    object: { params: [], results: [ext] },
    closure: { params: [], results: [ext] },
    closureValue: { params: [ext], results: [f64] },
    tagged: { params: [i32], results: [ext] },
    i31: { params: [i32], results: [ext] },
  };
  const observers = Object.fromEntries(
    Object.entries(signatures).map(([name, signature]) => [
      name,
      tx.reserveFunction("observer:" + name, name, signature),
    ]),
  );
  return { ...f, booleanBoxes, objects, closures, lifted, bigintOperands, observers };
}
function fillExecution(f: ReturnType<typeof reserveExecution>) {
  const { tx } = f;
  fillNativeNumberPrimitiveClassifierResources(tx, f.pack);
  fillNativeBooleanBoxResources(tx, f.booleanBoxes);
  fillBigIntOperands(tx, f.bigints, f.bigintOperands);
  tx.fillFunction(f.lifted, { locals: [], body: [{ op: "f64.const", value: 7 }] });
  tx.declareFunctionReference(f.lifted);
  const fill = (name: string, body: Instr[]) => tx.fillFunction(f.observers[name]!, { locals: [], body });
  const literal = (value: string, encoding: "wtf16" | "utf8-guaranteed"): Instr[] => {
    const binding = requireNativeStringLiteral(tx, f.strings, value, encoding);
    return [
      binding.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(binding.global) }
        : { op: "call", funcIdx: binding.function.handle },
    ];
  };
  fill("undefinedValue", [
    { op: "global.get", index: tx.physicalIndex(f.values.globals.undefined) },
    { op: "extern.convert_any" },
  ]);
  fill("flat", [...literal("42", "wtf16"), { op: "extern.convert_any" }]);
  fill("utf8", [...literal("utf8", "utf8-guaranteed"), { op: "extern.convert_any" }]);
  fill("cons", [
    { op: "i32.const", value: 4 },
    ...literal("42", "wtf16"),
    ...literal("42", "wtf16"),
    { op: "struct.new", typeIdx: f.strings.layout.consStrTypeIdx },
    { op: "extern.convert_any" },
  ]);
  fill("hashed", [
    { op: "i32.const", value: 2 },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 52 },
    { op: "i32.const", value: 50 },
    { op: "array.new_fixed", typeIdx: f.strings.layout.nativeStrDataTypeIdx, length: 2 },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "ref.null", typeIdx: -18 },
    { op: "ref.null", typeIdx: -18 },
    { op: "ref.null", typeIdx: -18 },
    { op: "struct.new", typeIdx: f.strings.layout.hashedStrTypeIdx },
    { op: "extern.convert_any" },
  ]);
  fill("object", [
    { op: "ref.null", typeIdx: f.objects.object.typeIndex },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: f.objects.propMap.typeIndex },
    ...[0, 0, 0, 0].map((value): Instr => ({ op: "i32.const", value })),
    { op: "struct.new", typeIdx: f.objects.object.typeIndex },
    { op: "extern.convert_any" },
  ]);
  const signature = f.closures.signatures[0]!.binding;
  fill("closure", [
    ...buildBuiltinClosureValueInstrs(signature.type.typeIndex, f.lifted.handle, 0, false),
    { op: "extern.convert_any" },
  ]);
  const closure = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.closures.root.typeIndex },
  ];
  fill("closureValue", [
    ...closure(),
    ...closure(),
    { op: "struct.get", typeIdx: f.closures.root.typeIndex, fieldIdx: 0 },
    { op: "ref.cast", typeIdx: signature.liftedFuncTypeIndex },
    { op: "call_ref", typeIdx: signature.liftedFuncTypeIndex },
  ]);
  fill("tagged", [
    { op: "local.get", index: 0 },
    { op: "i32.const", value: 123 },
    { op: "f64.const", value: 7 },
    { op: "ref.null", typeIdx: -19 },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: f.values.types.anyValue.typeIndex },
    { op: "extern.convert_any" },
  ]);
  fill("i31", [{ op: "local.get", index: 0 }, { op: "ref.i31" }, { op: "extern.convert_any" }]);
  for (const [name, token] of Object.entries({
    ...f.observers,
    ...f.bigintOperands,
    isPrimitive: f.pack.isPrimitive,
    isSymbol: f.pack.isSymbol,
    isNullish: f.pack.isNullish,
    boxNumber: f.values.functions.boxNumber,
    boxBoolean: f.booleanBoxes.boxBoolean,
    boxSymbol: f.symbols.functions.box,
  }))
    tx.defineExport("export:" + name, name, token);
  completed(f);
  tx.seal();
  const bytes = emitBinary(f.module);
  expect(WebAssembly.validate(bytes as BufferSource)).toBe(true);
  const wasm = new WebAssembly.Module(bytes as BufferSource);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  return new WebAssembly.Instance(wasm).exports as unknown as Record<string, (...args: unknown[]) => unknown>;
}

for (const offset of [false, true])
  describe(`real Wasm primitive classification (physical offset=${offset})`, () => {
    let f: ReturnType<typeof reserveExecution>, runtime: ReturnType<typeof fillExecution>;
    beforeAll(() => {
      f = reserveExecution(offset);
      f.tx.freezeReservations();
    });
    describe("completed prerequisite owners", () => {
      beforeAll(() => {
        fillDependencies(f);
      });
      describe("emitted classifiers", () => {
        beforeAll(() => {
          runtime = fillExecution(f);
        });
        function classification(value: unknown) {
          return [runtime.isPrimitive!(value), runtime.isSymbol!(value), runtime.isNullish!(value)];
        }
        it("retains exact completion and offset coordinates after real emission", () => {
          expect(Object.is(completed(f), f.pack)).toBe(true);
          expect(f.tx.physicalIndex(f.pack.isPrimitive)).toBeGreaterThan(0);
          expect(f.values.types.anyValue.typeIndex).toBeGreaterThan(0);
          expect(f.prefix === undefined).toBe(!offset);
        });
        it("classifies null as primitive and nullish", () => {
          expect(classification(null)).toEqual([1, 0, 1]);
        });
        it("classifies the canonical non-null undefined singleton", () => {
          const value = runtime.undefinedValue!();
          expect(Object.is(value, null)).toBe(false);
          expect(classification(value)).toEqual([1, 0, 1]);
        });
        it.each([0, -0, 7, -7, 2 ** 30, 2 ** 53, 1.25, NaN, Infinity, -Infinity])(
          "classifies canonical Number %s",
          (value) => {
            expect(classification(runtime.boxNumber!(value))).toEqual([1, 0, 0]);
          },
        );
        it.each([0, 1])("classifies genuine boxed Boolean %s", (value) => {
          expect(classification(runtime.boxBoolean!(value))).toEqual([1, 0, 0]);
        });
        it.each([-(2 ** 30), 0, 2 ** 30 - 1])("classifies actual i31 Number %s", (value) => {
          expect(classification(runtime.i31!(value))).toEqual([1, 0, 0]);
        });
        it.each(["flat", "utf8", "cons", "hashed"] as const)("classifies canonical %s String carrier", (kind) => {
          expect(classification(runtime[kind]!())).toEqual([1, 0, 0]);
        });
        it.each([1, 17])("classifies actual interned Symbol %s without admitting other primitives as Symbol", (id) => {
          expect(classification(runtime.boxSymbol!(id))).toEqual([1, 1, 0]);
        });
        it.each(Object.keys(bigintOperandValues))("classifies canonical narrow/wide BigInt %s", (name) => {
          expect(classification(runtime[name]!())).toEqual([1, 0, 0]);
        });
        it.each([0, 2, 3, 4, 5, 6, 7, -1])("rejects nonundefined AnyValue tag %s", (tag) => {
          expect(classification(runtime.tagged!(tag))).toEqual([0, 0, 0]);
        });
        it("rejects an actual issued ordinary Object carrier", () => {
          expect(classification(runtime.object!())).toEqual([0, 0, 0]);
        });
        it("rejects a real callable closure without changing its call behavior", () => {
          const closure = runtime.closure!();
          expect(runtime.closureValue!(closure)).toBe(7);
          expect(classification(closure)).toEqual([0, 0, 0]);
          expect(runtime.closureValue!(closure)).toBe(7);
        });
        it.each([
          ["object", () => ({})],
          ["array", () => []],
          ["function", () => function callable() {}],
          ["class", () => class Example {}],
          ["Date", () => new Date(0)],
          ["boxed Number object", () => new Number(7)],
          ["boxed Boolean object", () => new Boolean(true)],
        ] as const)("rejects unknown host %s instead of treating absence of a brand as primitive", (_name, make) => {
          expect(classification(make())).toEqual([0, 0, 0]);
        });
      });
    });
  });

describe("Number classifier descriptor and definition authentication", () => {
  it.each(["accessor", "inherited", "hidden", "symbol", "extra", "undefined", "null"] as const)(
    "rejects %s dependencies with no allocation and a valid retry",
    (shape) => {
      const f = prerequisites();
      const plan = declareNativeNumberPrimitiveClassifierResources("classify");
      let reads = 0;
      const bad = { ...f.dependencies };
      if (shape === "accessor")
        Object.defineProperty(bad, "symbols", {
          get: () => {
            reads++;
            return f.symbols;
          },
        });
      if (shape === "inherited") {
        Object.setPrototypeOf(bad, { symbols: f.symbols });
        Reflect.deleteProperty(bad, "symbols");
      }
      if (shape === "hidden") Object.defineProperty(bad, "symbols", { enumerable: false });
      if (shape === "symbol") Object.defineProperty(bad, Symbol("extra"), { value: true });
      if (shape === "extra") Object.assign(bad, { extra: true });
      if (shape === "undefined" || shape === "null")
        Object.assign(bad, { symbols: shape === "null" ? null : undefined });
      const before = populations(f);
      expect(() => reserveNativeNumberPrimitiveClassifierResources(f.tx, "classify", plan, bad)).toThrow();
      expect(reads).toBe(0);
      unchangedPopulations(f, before);
      const pack = reserveNativeNumberPrimitiveClassifierResources(f.tx, "classify", plan, f.dependencies);
      expect(requireNativeNumberPrimitiveClassifierReservations(f.tx, pack, plan, f.dependencies)).toBe(pack);
    },
  );
  it.each(["strings", "scanner"] as const)("rejects nested %s getter before invoking a producer", (role) => {
    const f = prerequisites();
    let reads = 0;
    const target = role === "strings" ? f.valueDependencies : f.valueDependencies.strings;
    const original = Object.getOwnPropertyDescriptor(target, role)!;
    Object.defineProperty(target, role, {
      get: () => {
        reads++;
        return original.value;
      },
      configurable: true,
    });
    const before = populations(f);
    expect(() =>
      reserveNativeNumberPrimitiveClassifierResources(
        f.tx,
        "classify",
        declareNativeNumberPrimitiveClassifierResources("classify"),
        f.dependencies,
      ),
    ).toThrow();
    expect(reads).toBe(0);
    unchangedPopulations(f, before);
    Object.defineProperty(target, role, original);
    expect(
      reserveNativeNumberPrimitiveClassifierResources(
        f.tx,
        "classify",
        declareNativeNumberPrimitiveClassifierResources("classify"),
        f.dependencies,
      ),
    ).toBeDefined();
  });
  it("rejects an equal replacement of the nested source record after warm completion", () => {
    const f = complete();
    expect(completed(f)).toBe(f.pack);
    f.valueDependencies.strings = { ...f.valueDependencies.strings };
    expect(() => completed(f)).toThrow("substituted dependency identity");
  });
  it.each(["symbols", "strings", "scanner"] as const)("rejects warmed %s getters without running them", (role) => {
    const f = complete();
    let reads = 0;
    const target =
      role === "symbols" ? f.dependencies : role === "strings" ? f.valueDependencies : f.valueDependencies.strings;
    const original = Object.getOwnPropertyDescriptor(target, role)!;
    Object.defineProperty(target, role, {
      get: () => {
        reads++;
        return original.value;
      },
    });
    expect(() => completed(f)).toThrow();
    expect(reads).toBe(0);
  });
  it.each(["isPrimitive", "isSymbol", "isNullish"] as const)(
    "rederives full %s locals and body after warm completion",
    (role) => {
      for (const part of ["locals", "body"] as const) {
        const f = complete();
        expect(completed(f)).toBe(f.pack);
        if (part === "locals") f.pack[role].object.locals.push({ name: "unused", type: { kind: "i32" } });
        else f.pack[role].object.body = [{ op: "i32.const", value: 0 }];
        expect(() => completed(f)).toThrow();
      }
    },
  );
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
  const tokens = (["isPrimitive", "isSymbol", "isNullish"] as const).map((role) => f.pack[role]);
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
      ? () => nativeNumberPrimitiveClassifierReservationInventory(f.tx, f.pack, f.plan, f.dependencies)
      : () => completed(f);
}

function filledDefinitionFixture(warm: boolean) {
  const f = fixture();
  f.tx.freezeReservations();
  fillDependencies(f);
  fillNativeNumberPrimitiveClassifierResources(f.tx, f.pack);
  expect(current(f)).toBe(f.pack);
  if (warm) expect(completed(f)).toBe(f.pack);
  return f;
}

describe("number classifier descriptor-first live definitions", () => {
  it.each(["isPrimitive", "isSymbol", "isNullish"] as const)(
    "baseline original-array getter control for %s on every public audit route",
    (role) => {
      for (const warm of [false, true]) {
        for (const route of ["require", "inventory", "completion"] as const) {
          for (const part of ["locals", "body"] as const) {
            const f = filledDefinitionFixture(warm);
            definitionAccessorControl(f, f.pack[role].object, part, definitionAction(f, route));
          }
        }
      }
    },
  );

  it.each(["isPrimitive", "isSymbol", "isNullish"] as const)(
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
          expect(() => fillNativeNumberPrimitiveClassifierResources(f.tx, f.pack)).toThrow();
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
        fillNativeNumberPrimitiveClassifierResources(f.tx, f.pack);
        expect(completed(f)).toBe(f.pack);
        unchangedPopulations(f, before);
      }
    },
  );

  it.each(["isPrimitive", "isSymbol", "isNullish"] as const)(
    "refuses deep original-returning %s getters before any audit route",
    (role) => {
      for (const route of ["require", "inventory", "completion"] as const) {
        for (const location of ["array-index", "instruction-op"] as const) {
          const f = filledDefinitionFixture(true);
          const object = f.pack[role].object;
          let target: object = object.body,
            key: PropertyKey = "0";
          if (location === "instruction-op") {
            target = object.body[0]!;
            key = "op";
          }

          definitionAccessorControl(f, target, key, definitionAction(f, route));
        }
      }
    },
  );

  it.each(["hidden", "inherited", "sparse", "extra-array", "symbol", "cycle"] as const)(
    "refuses %s live data and permits exact restoration",
    (shape) => {
      const f = filledDefinitionFixture(true),
        object = f.pack.isNullish.object;
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
        object = f.pack.isNullish.object;
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
