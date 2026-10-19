// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { objectIsFixture, fillObjectIsDependencies } from "./helpers/native-object-is-fixture.js";
import { fillNativeObjectIsAlgorithm } from "../src/backend/wasmgc/resources/native-object-is.js";
import {
  reserveNativeObjectRealmException,
  reserveNativeRealmBaseAlgorithms,
  requireNativeRealmBaseAlgorithms,
  fillNativeRealmBaseAlgorithms,
  requireCompletedNativeRealmBaseAlgorithms,
  reserveNativeObjectRealmDeclarations,
  fillNativeObjectRealmDeclarations,
  requireCompletedNativeObjectRealm,
  nativeObjectRealmDeclarationInventory,
} from "../src/backend/wasmgc/resources/native-object-realm.js";
import {
  declareNativeRealmObjectLayouts,
  reserveNativeRealmObjectLayouts,
  fillNativeRealmObjectLayouts,
} from "../src/backend/wasmgc/resources/native-realm-object-layouts.js";
import { fillDescriptorDependencies } from "./helpers/native-descriptor-fixture.js";
import { fillNativeObjectDescriptorResources } from "../src/backend/wasmgc/resources/native-object-descriptors.js";
import { fillNativeInvocationSubstrateResources } from "../src/backend/wasmgc/resources/native-invocation-substrate.js";
import { fillNativeBooleanBoxResources } from "../src/backend/wasmgc/resources/native-booleans.js";
import { beginNativeSourceClosureEmission } from "../src/ir/program-native-invocation.js";
import {
  nativeStringLiteralReservationInventory,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import { emitBinary } from "../src/emit/binary.js";
import type { ValType, Instr } from "../src/wasm/model/instructions.js";

function fixture(displaced = false, decoded = false) {
  const f = objectIsFixture(displaced, decoded);
  const exception = reserveNativeObjectRealmException(f.tx, f.realm, { required: true, shared: false });
  const dependencies = {
    requests: f.requests,
    substrate: f.substrate,
    exception,
    values: f.values,
    valuePlan: f.valuePlan,
    valueDependencies: f.valueDependencies,
    errors: f.errors,
    errorRequirements: f.errorRequirements,
    errorDependencies: f.errorDependencies,
  };
  const base = reserveNativeRealmBaseAlgorithms(f.tx, dependencies);
  return { ...f, publicException: exception, baseDependencies: dependencies, base };
}
const population = (f: ReturnType<typeof fixture>) => [
  f.module.types.length,
  f.module.functions.length,
  f.module.globals.length,
];
function runtime(displaced = false, decoded = false) {
  const f = fixture(displaced, decoded),
    { tx } = f;
  const ext: ValType = { kind: "externref" };
  const observer = (name: string, params: ValType[], results: ValType[]) =>
    tx.reserveFunction("base:observer:" + name, name, { params, results });
  const undefinedValue = observer("undefinedValue", [], [ext]);
  const errorTag = observer("errorTag", [ext], [{ kind: "i32" }]);
  const errorName = observer("errorName", [ext], [ext]);
  const errorMessage = observer("errorMessage", [ext], [ext]);
  const message = observer("message", [], [ext]);
  const name = observer("name", [], [ext]);
  fillObjectIsDependencies(f);
  fillNativeObjectIsAlgorithm(tx, f.objectIs);
  fillNativeRealmBaseAlgorithms(tx, f.base);
  requireCompletedNativeRealmBaseAlgorithms(tx, f.base);
  tx.fillFunction(undefinedValue, { locals: [], body: builtinUndefined() });
  function builtinUndefined(): Instr[] {
    return [{ op: "global.get", index: tx.physicalIndex(f.values.globals.undefined) }, { op: "extern.convert_any" }];
  }
  for (const [token, field] of [
    [errorTag, 0],
    [errorMessage, 1],
    [errorName, 2],
  ] as const)
    tx.fillFunction(token, {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: f.errors.type.typeIndex },
        { op: "struct.get", typeIdx: f.errors.type.typeIndex, fieldIdx: field },
      ],
    });
  for (const [token, text] of [
    [message, "TypeError: restricted function property"],
    [name, "TypeError"],
  ] as const) {
    const value = requireNativeStringLiteral(tx, f.strings, text);
    tx.fillFunction(token, {
      locals: [],
      body: [
        value.kind === "global"
          ? { op: "global.get", index: tx.physicalIndex(value.global) }
          : { op: "call", funcIdx: value.function.handle },
        { op: "extern.convert_any" },
      ],
    });
  }
  for (const [key, token] of Object.entries({
    functionPrototype: f.base.algorithms["%Function.prototype%"],
    throwTypeError: f.base.algorithms["%ThrowTypeError%"],
    newVector: f.substrate.arguments.newVector,
    push: f.substrate.arguments.push,
    undefinedValue,
    errorTag,
    errorMessage,
    errorName,
    message,
    name,
    exception: f.publicException.tag,
  }))
    tx.defineExport("base:export:" + key, key, token);
  tx.seal();
  const bytes = emitBinary(f.module),
    module = new WebAssembly.Module(bytes as BufferSource);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length) throw Error("base algorithms require host providers");
  const ex = new WebAssembly.Instance(module).exports as Record<string, any>;
  const vector = (values: readonly unknown[]) => {
    const v = ex.newVector();
    values.forEach((value) => ex.push(v, value));
    return v;
  };
  return { f, ex, imports, bytes, vector };
}

describe("canonical base catalog algorithms", () => {
  for (const [displaced, decoded] of [
    [false, false],
    [true, false],
    [true, true],
  ])
    it(`executes the actual undefined and TypeError owners without imports (offset=${displaced}, replay=${decoded})`, () => {
      const { f, ex, imports, vector } = runtime(displaced, decoded);
      expect(imports).toEqual([]);
      expect(f.base.completionScope).toBe("base-catalog-algorithms-only");
      let reads = 0;
      const unused = new Proxy(
        {},
        {
          get() {
            reads++;
            throw Error("ignored value inspected");
          },
        },
      );
      for (const args of [[], [null], Array(14).fill(unused)]) {
        const argv = vector(args);
        expect(ex.functionPrototype(unused, argv)).toBe(ex.undefinedValue());
        let thrown: any;
        try {
          ex.throwTypeError(unused, argv);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(WebAssembly.Exception);
        expect(thrown.is(ex.exception)).toBe(true);
        const value = thrown.getArg(ex.exception, 0);
        expect(ex.errorTag(value)).toBe(-11);
        expect(ex.errorName(value)).toBe(ex.name());
        expect(ex.errorMessage(value)).toBe(ex.message());
      }
      expect(reads).toBe(0);
      expect(ex.functionPrototype(null, vector([]))).not.toBeNull();
      expect(() => ex.functionPrototype(null, {})).toThrow(TypeError);
      expect(requireCompletedNativeRealmBaseAlgorithms(f.tx, f.base)).toBe(f.base);
    });

  it("rejects copied owners and foreign expected catalog/exception/transport", () => {
    const f = fixture(),
      g = fixture();
    const require = (pack = f.base, requests = f.requests, exception = f.publicException, substrate = f.substrate) =>
      requireNativeRealmBaseAlgorithms(f.tx, pack, requests, exception, substrate);
    expect(require()).toBe(f.base);
    expect(() => require({ ...f.base })).toThrow(/copied/);
    expect(() => require(g.base)).toThrow(/foreign/);
    expect(() => require(f.base, g.requests)).toThrow(/different/);
    expect(() => require(f.base, f.requests, g.publicException)).toThrow(/different/);
    expect(() => require(f.base, f.requests, f.publicException, g.substrate)).toThrow(/different/);
  });
  for (const role of ["requests", "exception", "substrate", "values", "errors"] as const)
    it(`rejects a substituted ${role} before reserving slots`, () => {
      const f = fixture(),
        g = fixture(),
        before = population(f);
      expect(() =>
        reserveNativeRealmBaseAlgorithms(f.tx, { ...f.baseDependencies, [role]: g.baseDependencies[role] }),
      ).toThrow();
      expect(population(f)).toEqual(before);
    });
  for (const kind of ["hidden", "accessor", "inherited"] as const)
    it(`rejects ${kind} dependencies without invoking getters`, () => {
      const f = fixture(),
        d = { ...f.baseDependencies },
        before = population(f);
      let reads = 0;
      if (kind === "inherited") {
        Reflect.deleteProperty(d, "errors");
        Object.setPrototypeOf(d, { errors: f.errors });
      } else
        Object.defineProperty(
          d,
          "errors",
          kind === "hidden"
            ? { enumerable: false }
            : {
                get() {
                  reads++;
                  throw Error("getter");
                },
              },
        );
      expect(() => reserveNativeRealmBaseAlgorithms(f.tx, d)).toThrow(/data|dependency/);
      expect(reads).toBe(0);
      expect(population(f)).toEqual(before);
    });
  it("rejects duplicate slots before any allocation and detects dependency replacement", () => {
    const f = fixture(),
      before = population(f);
    expect(() => reserveNativeRealmBaseAlgorithms(f.tx, f.baseDependencies)).toThrow(/reserved|duplicate/);
    expect(population(f)).toEqual(before);
    const g = fixture();
    g.baseDependencies.valueDependencies = { ...g.valueDependencies };
    expect(() => requireCompletedNativeRealmBaseAlgorithms(g.tx, g.base)).toThrow(/changed|substituted/);
  });
  it("requires canonical dependency completion, not just allocated signatures", () => {
    const f = fixture();
    f.tx.freezeReservations();
    expect(() => fillNativeRealmBaseAlgorithms(f.tx, f.base)).toThrow(/incomplete|canonical/);
    expect(f.base.algorithms["%Function.prototype%"].object.body).toHaveLength(0);
    expect(f.base.algorithms["%ThrowTypeError%"].object.body).toHaveLength(0);
  });
  it("rejects caller-filled bodies and post-canonical body/header mutation", () => {
    const f = fixture();
    fillObjectIsDependencies(f);
    f.tx.fillFunction(f.base.algorithms["%Function.prototype%"], { locals: [], body: [{ op: "ref.null.extern" }] });
    expect(() => requireCompletedNativeRealmBaseAlgorithms(f.tx, f.base)).toThrow(/canonical/);
    const g = fixture();
    fillObjectIsDependencies(g);
    fillNativeRealmBaseAlgorithms(g.tx, g.base);
    expect(() => fillNativeRealmBaseAlgorithms(g.tx, g.base)).toThrow(/duplicate/);
    g.base.algorithms["%Function.prototype%"].object.body[0] = { op: "ref.null.extern" };
    expect(() => requireCompletedNativeRealmBaseAlgorithms(g.tx, g.base)).toThrow(/changed|altered|completed|mutation/);
    const h = fixture();
    h.base.algorithms["%ThrowTypeError%"].object.name = "changed";
    expect(() => requireCompletedNativeRealmBaseAlgorithms(h.tx, h.base)).toThrow(/header|altered/);
  });
  it("shares both exact catalog slots without completing the remaining realm", () => {
    const f = fixture();
    const layoutDependencies = { objects: f.layouts, objectPlan: f.lookupDependencies.layoutPlan };
    const layoutPlan = declareNativeRealmObjectLayouts("base:realm", f.layouts.object.key, f.layouts.propMap.key);
    const layouts = reserveNativeRealmObjectLayouts(f.tx, "base:realm", layoutDependencies, layoutPlan);
    const strings = nativeStringLiteralReservationInventory(f.tx, f.strings).typePack;
    const source = beginNativeSourceClosureEmission(
      f.tx,
      f.realm.source!,
      {
        vectors: f.vectors,
        vectorPlan: f.vectorPlan,
        strings: { types: strings, key: strings.key, utf8Storage: strings.utf8Storage },
        realmState: layouts,
      },
      f.requests,
    );
    const dependencies = {
      requests: f.requests,
      closures: source.types.closures,
      closurePlan: source.types.closurePlan,
      layouts,
      substrate: f.substrate,
      vectors: f.vectors,
      vectorPlan: f.vectorPlan,
      exception: f.publicException,
      source: source.types,
      objectIs: f.objectIs,
      baseAlgorithms: f.base,
    };
    const before = population(f);
    for (const baseAlgorithms of [null, { ...f.base }])
      expect(() =>
        reserveNativeObjectRealmDeclarations(f.tx, f.realm, { ...dependencies, baseAlgorithms } as never),
      ).toThrow(/issued|copied/);
    expect(population(f)).toEqual(before);
    const declarations = reserveNativeObjectRealmDeclarations(f.tx, f.realm, dependencies);
    const inventory = nativeObjectRealmDeclarationInventory(f.tx, declarations);
    for (const [id, token] of Object.entries(f.base.algorithms)) {
      expect(declarations.entries.find((row) => row.request.intrinsic.id === id)!.algorithm).toBe(token);
      expect(inventory.functions.filter((row) => row === token)).toHaveLength(1);
      expect(f.module.functions.filter((row) => row === token.object)).toHaveLength(1);
    }
    f.tx.freezeReservations();
    fillDescriptorDependencies(f);
    fillNativeObjectDescriptorResources(f.tx, f.pack, f.exception);
    fillNativeRealmObjectLayouts(f.tx, layouts);
    fillNativeObjectRealmDeclarations(f.tx, declarations);
    fillNativeInvocationSubstrateResources(f.tx, f.substrate);
    fillNativeBooleanBoxResources(f.tx, f.booleanBoxes);
    fillNativeObjectIsAlgorithm(f.tx, f.objectIs);
    fillNativeRealmBaseAlgorithms(f.tx, f.base);
    expect(requireCompletedNativeRealmBaseAlgorithms(f.tx, f.base)).toBe(f.base);
    expect(() => requireCompletedNativeObjectRealm(f.tx, declarations)).toThrow(/remain incomplete/);
    expect(
      declarations.entries
        .filter(
          (row) => !["%Function.prototype%", "%ThrowTypeError%", "%Object.is%"].includes(row.request.intrinsic.id),
        )
        .every((row) => row.algorithm.object.body.length === 0),
    ).toBe(true);
  });
});
