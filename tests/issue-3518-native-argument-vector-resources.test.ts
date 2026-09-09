// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { createEmptyModule, type Instr } from "../src/ir/types.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { addFuncType, getOrRegisterVecBaseType } from "../src/codegen/registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  createVectorBaseType,
  createVectorBackingArrayType,
  createVectorCarrierType,
} from "../src/runtime/wasmgc/values/vector-grow-store.js";
import * as bodies from "../src/runtime/wasmgc/values/argument-vector-bodies.js";
import {
  declareNativeArgumentVectorResources,
  nativeArgumentVectorReservationInventory,
  reserveNativeArgumentVectorResources,
  fillNativeArgumentVectorResources,
} from "../src/backend/wasmgc/resources/native-argument-vectors.js";

const base = "a6cc59a2cdfad5141d75faadf1530a9de63bebd7";
const fixtureDigest = "6c1406df64d99bef6f62ce43d3d98f60a517093244979fb226626043c38851ab";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
interface Span {
  role: string;
  start: number;
  end: number;
  text: string;
  sha256: string;
}
interface Fixture {
  schemaVersion: number;
  base: string;
  sources: { path: string; sourceSha256: string; spans: Span[] }[];
}
function authenticate(text: string): Fixture {
  if (sha256(text) !== fixtureDigest) throw new Error("argument-vector fixture digest mismatch");
  const fixture = JSON.parse(text) as Fixture;
  if (fixture.schemaVersion !== 1 || fixture.base !== base || fixture.sources.length !== 2) {
    throw new Error("argument-vector fixture provenance mismatch");
  }
  const roles = ["layout", "helpers", "register", "early"];
  const spans = fixture.sources.flatMap((source) => {
    if (!/^[a-f0-9]{64}$/.test(source.sourceSha256)) throw new Error("missing full-source receipt");
    return source.spans;
  });
  if (spans.length !== roles.length) throw new Error("incomplete donor population");
  spans.forEach((span, index) => {
    if (
      span.role !== roles[index] ||
      span.end - span.start !== span.text.length ||
      span.start < 0 ||
      !span.text.length ||
      sha256(span.text) !== span.sha256
    ) {
      throw new Error("argument-vector donor span mismatch");
    }
  });
  return fixture;
}
// Committed independent donor data. No git, fetch, live fallback, or skip at collection.
const fixtureText = readFileSync(
  new URL("./fixtures/issue-3518-native-argument-vector-donors.json", import.meta.url),
  "utf8",
);
const fixture = authenticate(fixtureText);
const donor = (role: string) => {
  const span = fixture.sources.flatMap((source) => source.spans).find((row) => row.role === role);
  if (!span) throw new Error(`missing donor ${role}`);
  return span.text;
};
function between(source: string, first: string, last: string): string {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start + first.length);
  if (start < 0 || end < start) throw new Error(`missing live donor boundary: ${first}`);
  return source.slice(start, end);
}
const liveObject = readFileSync(new URL("../src/codegen/object-runtime.ts", import.meta.url), "utf8");
const liveLinear = readFileSync(new URL("../src/codegen/linear-type-reservations.ts", import.meta.url), "utf8");
const liveLayout = between(liveObject, "  // $ObjVec backing array:", "  // (#1100/#1355)");
const liveHelpers = between(liveObject, "  // Canonical ObjVec bodies,", "  // ── __hasOwnProperty");
const liveRegister = between(liveObject, "  const registerNative = (", "\n  // (#3468");
const liveEarly = between(liveLinear, "export function reserveObjVecArrType(", "\n/**");

const canonicalObjectImport = `import {
  createArgumentVectorArrayType,
  createArgumentVectorType,
  buildArgumentVectorNewBody,
  buildArgumentVectorPushLocals,
  buildArgumentVectorPushBody,
} from "../runtime/wasmgc/values/argument-vector-bodies.js";
`;
const canonicalLinearImport = `import { createArgumentVectorArrayType } from "../runtime/wasmgc/values/argument-vector-bodies.js";
`;
function replaceExactlyOnce(source: string, expected: string, replacement: string): string {
  const start = source.indexOf(expected);
  if (!expected || start < 0 || source.indexOf(expected, start + expected.length) !== -1) {
    throw new Error("missing or ambiguous approved extraction/import span");
  }
  return source.slice(0, start) + replacement + source.slice(start + expected.length);
}

// Derive ONLY the approved replacement text from the authenticated donor, never
// from the live file being checked. Exact matching prevents inversion from
// concealing edits within an extracted span; the full hash covers retained code.
const donorArrayDescriptor = `{
      kind: "array",
      name: "$ObjVecArr",
      element: { kind: "externref" },
      mutable: true,
    }`;
const donorCarrierAppend = `  ctx.mod.types.push({
    kind: "struct",
    name: "$ObjVec",
    superTypeIdx: objVecBaseTypeIdx,
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      { name: "data", type: { kind: "ref", typeIdx: objVecArrTypeIdx }, mutable: true },
    ],
  });`;
const approvedLayout = replaceExactlyOnce(
  replaceExactlyOnce(donor("layout"), donorArrayDescriptor, "createArgumentVectorArrayType()"),
  donorCarrierAppend,
  "  ctx.mod.types.push(createArgumentVectorType(objVecBaseTypeIdx, objVecArrTypeIdx));",
);
const approvedHelpers = `  // Canonical ObjVec bodies, registered at the historical new-before-push points.
  const argumentVectorLayout = { objVecArrTypeIdx, objVecTypeIdx };
  registerNative("__objvec_new", [], [{ kind: "externref" }], [], buildArgumentVectorNewBody(argumentVectorLayout));
  const objVecNewIdx = ctx.funcMap.get("__objvec_new")!;
  registerNative(
    "__objvec_push",
    [{ kind: "externref" }, { kind: "externref" }],
    [],
    buildArgumentVectorPushLocals(argumentVectorLayout),
    buildArgumentVectorPushBody(argumentVectorLayout),
  );
  const objVecPushIdx = ctx.funcMap.get("__objvec_push")!;
`;
const approvedEarly = replaceExactlyOnce(
  donor("early"),
  `{
    kind: "array",
    name: "$ObjVecArr",
    element: { kind: "externref" },
    mutable: true,
  }`,
  "createArgumentVectorArrayType()",
);

function reconstructLegacySource(source: string, file: "object" | "linear"): string {
  if (file === "object") {
    const withoutImport = replaceExactlyOnce(source, canonicalObjectImport, "");
    const withLayout = replaceExactlyOnce(withoutImport, approvedLayout, donor("layout"));
    return replaceExactlyOnce(withLayout, approvedHelpers, donor("helpers"));
  }
  const withoutImport = replaceExactlyOnce(source, canonicalLinearImport, "");
  return replaceExactlyOnce(withoutImport, approvedEarly, donor("early"));
}
function requireFullLegacyReceipt(source: string, file: "object" | "linear"): void {
  const path = file === "object" ? "src/codegen/object-runtime.ts" : "src/codegen/linear-type-reservations.ts";
  const receipt = fixture.sources.find((entry) => entry.path === path);
  if (!receipt) throw new Error(`missing full-source receipt: ${path}`);
  if (sha256(reconstructLegacySource(source, file)) !== receipt.sourceSha256) {
    throw new Error(`full-source donor receipt mismatch: ${path}`);
  }
}

function evaluate(source: string, dependencies: Record<string, unknown>): Record<string, any> {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, any> = {};
  new Function("exports", ...Object.keys(dependencies), js)(exports, ...Object.values(dependencies));
  return exports;
}
function legacy(original: boolean, early: boolean, baseFirst: boolean) {
  const ctx = {
    mod: createEmptyModule(),
    vecBaseTypeIdx: -1,
    numImportFuncs: 0,
    structMap: new Map(),
    structFields: new Map(),
    typeIdxToStructName: new Map(),
    funcMap: new Map(),
    funcTypeCache: new Map(),
  } as unknown as CodegenContext;
  const deps = { ...bodies, addFuncType, getOrRegisterVecBaseType, mintDefinedFunc, pushDefinedFunc };
  if (baseFirst) getOrRegisterVecBaseType(ctx);
  const earlyFn = evaluate(original ? donor("early") : liveEarly, deps).reserveObjVecArrType;
  if (early) {
    earlyFn(ctx);
    earlyFn(ctx);
  }
  const run = evaluate(
    `export function run(ctx: CodegenContext) {
    const INITIAL_CAP = 8;
    ${original ? donor("layout") : liveLayout}
    ${original ? donor("register") : liveRegister}
    ${original ? donor("helpers") : liveHelpers}
    return { objVecArrTypeIdx, objVecTypeIdx, objVecNewIdx, objVecPushIdx };
  }`,
    deps,
  ).run;
  const result = run(ctx);
  return { ctx, result };
}
function reserve(early = false, explicit = true) {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const vectorBase = tx.reserveType("shared:base", createVectorBaseType());
  const earlyArgumentArray = early ? tx.reserveType("early:argv", bodies.createArgumentVectorArrayType()) : undefined;
  const declaration = declareNativeArgumentVectorResources(
    { key: "argv" },
    { vectorBaseKey: vectorBase.key, ...(earlyArgumentArray ? { earlyArgumentArrayKey: earlyArgumentArray.key } : {}) },
  );
  const pack = reserveNativeArgumentVectorResources(
    tx,
    { key: "argv" },
    { vectorBase, earlyArgumentArray },
    explicit ? declaration : undefined,
  );
  return { module, tx, pack, declaration };
}

const canonicalBodySource = () =>
  readFileSync(new URL("../src/runtime/wasmgc/values/argument-vector-bodies.ts", import.meta.url), "utf8");
function requireFactoredArgumentVectorReceipt(source: string): void {
  const parsed = ts.createSourceFile("argument-vector-factories.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = parsed.statements.filter(ts.isFunctionDeclaration);
  const named = (name: string) => {
    const matches = declarations.filter((row) => row.name?.text === name);
    if (matches.length !== 1) throw new Error("missing/duplicate argument-vector factory");
    return matches[0]!.getText(parsed);
  };
  const delegate = named("createArgumentVectorType"),
    shape = named("createArgumentVectorShape");
  const header =
    "export function createArgumentVectorType(objVecBaseTypeIdx: number, objVecArrTypeIdx: number): StructTypeDef {";
  const expected = `${header}
  const { parent, ...shape } = createArgumentVectorShape(
    { kind: "ref" as const, typeIdx: objVecArrTypeIdx },
    objVecBaseTypeIdx,
  );
  return { kind: shape.kind, name: shape.name, superTypeIdx: parent, fields: shape.fields };
}`;
  if (delegate !== expected) throw new Error("changed argument-vector delegate");
  let original = replaceExactlyOnce(
    shape,
    "export function createArgumentVectorShape<D, P>(data: D, parent: P) {",
    header,
  );
  original = replaceExactlyOnce(original, 'kind: "struct" as const,', 'kind: "struct",');
  original = replaceExactlyOnce(original, "    parent,", "    superTypeIdx: objVecBaseTypeIdx,");
  original = replaceExactlyOnce(original, 'type: { kind: "i32" as const }', 'type: { kind: "i32" }');
  original = replaceExactlyOnce(original, "type: data,", 'type: { kind: "ref", typeIdx: objVecArrTypeIdx },');
  const inverse = replaceExactlyOnce(source, delegate + "\n\n" + shape, original);
  // Exact pre-factoring file at a024d9c048; prior extraction donors unchanged.
  if (sha256(inverse) !== "5be0cba6648fd0c6eee5ff66fdca78c318b6f1d28b7c2901b0a171930a3bd166")
    throw new Error("complete argument-vector factory inverse mismatch");
}
type Api = {
  newVector(): unknown;
  push(vector: unknown, element: unknown): void;
  length(vector: unknown): number;
  capacity(vector: unknown): number;
  get(vector: unknown, index: number): unknown;
};
function instantiate() {
  const { module, tx, pack } = reserve();
  const length = tx.reserveFunction("probe:length", "length", {
    params: [{ kind: "externref" }],
    results: [{ kind: "i32" }],
  });
  const capacity = tx.reserveFunction("probe:capacity", "capacity", {
    params: [{ kind: "externref" }],
    results: [{ kind: "i32" }],
  });
  const get = tx.reserveFunction("probe:get", "get", {
    params: [{ kind: "externref" }, { kind: "i32" }],
    results: [{ kind: "externref" }],
  });
  tx.freezeReservations();
  fillNativeArgumentVectorResources(tx, pack);
  const field = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: pack.carrier.typeIndex },
    { op: "struct.get", typeIdx: pack.carrier.typeIndex, fieldIdx },
  ];
  tx.fillFunction(length, { locals: [], body: field(0) });
  tx.fillFunction(capacity, { locals: [], body: [...field(1), { op: "array.len" }] });
  tx.fillFunction(get, {
    locals: [],
    body: [...field(1), { op: "local.get", index: 1 }, { op: "array.get", typeIdx: pack.array.typeIndex }],
  });
  for (const [name, token] of [
    ["newVector", pack.newVector],
    ["push", pack.push],
    ["length", length],
    ["capacity", capacity],
    ["get", get],
  ] as const) {
    tx.defineExport(`export:${name}`, name, token);
  }
  tx.seal();
  const bytes = emitBinary(module);
  expect(WebAssembly.validate(bytes)).toBe(true);
  const api = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as unknown as Api;
  return { api, module, pack };
}

describe("native argument-vector resources", () => {
  it("inverts only the shared factory factoring against the complete unchanged donor", () => {
    requireFactoredArgumentVectorReceipt(canonicalBodySource());
  });
  for (const [before, after] of [
    ["type: data,", 'type: { kind: "externref" },'],
    ["    parent,", "    parent: undefined,"],
    ["export function createArgumentVectorShape<D, P>", "export async function createArgumentVectorShape<D, P>"],
    ['  return {\n    kind: "struct" as const,', '  void 0;\n  return {\n    kind: "struct" as const,'],
  ])
    it(`rejects live argument-vector factory mutation ${before}`, () => {
      const source = canonicalBodySource();
      requireFactoredArgumentVectorReceipt(source);
      expect(() => requireFactoredArgumentVectorReceipt(replaceExactlyOnce(source, before!, after!))).toThrow();
    });
  it.each([false, true])("preserves implicit/explicit recipe bodies and inventory, adopted=%s", (early) => {
    const explicit = reserve(early),
      implicit = reserve(early, false);
    expect(explicit.module).toStrictEqual(implicit.module);
    const rows = nativeArgumentVectorReservationInventory(explicit.tx, explicit.pack, explicit.declaration);
    expect(rows.map((row) => row.key)).toEqual(explicit.declaration.declarations.map((row) => row.key));
    expect(rows).toHaveLength(early ? 3 : 4);
    if (early) expect(rows).not.toContain(explicit.pack.array);
    explicit.tx.freezeReservations();
    implicit.tx.freezeReservations();
    fillNativeArgumentVectorResources(explicit.tx, explicit.pack);
    fillNativeArgumentVectorResources(implicit.tx, implicit.pack);
    expect(explicit.module).toStrictEqual(implicit.module);
    expect(nativeArgumentVectorReservationInventory(explicit.tx, explicit.pack, explicit.declaration)).toEqual(rows);
    expect(() =>
      nativeArgumentVectorReservationInventory(explicit.tx, { ...explicit.pack }, explicit.declaration),
    ).toThrow();
    expect(() =>
      nativeArgumentVectorReservationInventory(explicit.tx, explicit.pack, structuredClone(explicit.declaration)),
    ).toThrow();
  });
  for (const file of ["object", "linear"] as const) {
    const source = file === "object" ? liveObject : liveLinear;
    const canonicalImport = file === "object" ? canonicalObjectImport : canonicalLinearImport;
    it(`reconstructs the complete ${file} legacy file including canonical imports and retained code`, () => {
      requireFullLegacyReceipt(source, file);
    });
    for (const mutation of ["missing", "renamed"] as const) {
      it(`rejects the ${mutation} canonical import in the full ${file} legacy file`, () => {
        requireFullLegacyReceipt(source, file);
        const replacement =
          mutation === "missing"
            ? ""
            : canonicalImport.replace("createArgumentVectorArrayType", "createArgumentVectorArrayTypeRenamed");
        const mutant = replaceExactlyOnce(source, canonicalImport, replacement);
        expect(mutant).not.toBe(source);
        expect(() => requireFullLegacyReceipt(mutant, file)).toThrow(/approved extraction\/import span/);
      });
    }
  }

  it("rejects a retained INITIAL_CAP change despite injected snippet constants", () => {
    requireFullLegacyReceipt(liveObject, "object");
    const mutant = replaceExactlyOnce(liveObject, "export const INITIAL_CAP = 8;", "export const INITIAL_CAP = 4;");
    const reconstructed = reconstructLegacySource(mutant, "object");
    expect(reconstructed).toContain("export const INITIAL_CAP = 4;");
    expect(() => requireFullLegacyReceipt(mutant, "object")).toThrow(/full-source donor receipt mismatch/);
  });

  it("rejects retained object helper registration-order changes", () => {
    requireFullLegacyReceipt(liveObject, "object");
    const original = `    ctx.funcMap.set(name, funcIdx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });`;
    const reordered = `    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
    ctx.funcMap.set(name, funcIdx);`;
    const mutant = replaceExactlyOnce(liveObject, original, reordered);
    const reconstructed = reconstructLegacySource(mutant, "object");
    expect(reconstructed).toContain(reordered);
    expect(() => requireFullLegacyReceipt(mutant, "object")).toThrow(/full-source donor receipt mismatch/);
  });

  it("rejects retained early type-reservation order changes in the linear file", () => {
    requireFullLegacyReceipt(liveLinear, "linear");
    const original = `  getOrRegisterSubviewType(ctx, "i8_byte", { kind: "i8" });
  getOrRegisterSubviewType(ctx, "i16_byte", { kind: "i16" }); // (#2593) Int16/Uint16`;
    const reordered = `  getOrRegisterSubviewType(ctx, "i16_byte", { kind: "i16" }); // (#2593) Int16/Uint16
  getOrRegisterSubviewType(ctx, "i8_byte", { kind: "i8" });`;
    const mutant = replaceExactlyOnce(liveLinear, original, reordered);
    const reconstructed = reconstructLegacySource(mutant, "linear");
    expect(reconstructed).toContain(reordered);
    expect(() => requireFullLegacyReceipt(mutant, "linear")).toThrow(/full-source donor receipt mismatch/);
  });

  it("authenticates the exact-base four-span donor population", () => {
    expect(fixture.sources.map((source) => source.path)).toEqual([
      "src/codegen/object-runtime.ts",
      "src/codegen/linear-type-reservations.ts",
    ]);
    expect(() => authenticate(fixtureText.replace('"schemaVersion": 1', '"schemaVersion": 2'))).toThrow(/digest/);
    expect(() => authenticate(fixtureText.replace("value: INITIAL_CAP", "value: 4"))).toThrow(/digest/);
  });

  for (const early of [false, true]) {
    for (const baseFirst of [false, true]) {
      it(`preserves actual legacy descriptors/locals/bodies/cache/order/bytes/WAT early=${early} baseFirst=${baseFirst}`, () => {
        const old = legacy(true, early, baseFirst);
        const live = legacy(false, early, baseFirst);
        expect(live.result).toEqual(old.result);
        expect(live.ctx.mod).toEqual(old.ctx.mod);
        expect(live.ctx.funcMap).toEqual(old.ctx.funcMap);
        expect(live.ctx.funcTypeCache).toEqual(old.ctx.funcTypeCache);
        expect(live.ctx.reservedObjVecArrTypeIdx).toBe(old.ctx.reservedObjVecArrTypeIdx);
        expect(live.ctx.structMap).toEqual(old.ctx.structMap);
        expect(live.ctx.structFields).toEqual(old.ctx.structFields);
        expect(live.ctx.mod.functions.map((fn) => fn.name)).toEqual(["__objvec_new", "__objvec_push"]);
        expect(live.ctx.mod.functions[1]!.locals).toHaveLength(7);
        expect(emitBinary(live.ctx.mod)).toEqual(emitBinary(old.ctx.mod));
        expect(emitWat(live.ctx.mod)).toBe(emitWat(old.ctx.mod));
      });
    }
    it(`matches resource bodies, type order, bytes and WAT to independent donor early=${early}`, () => {
      const { module, tx, pack } = reserve(early);
      tx.freezeReservations();
      fillNativeArgumentVectorResources(tx, pack);
      tx.seal();
      const original = legacy(true, early, true);
      expect(module.types).toEqual(original.ctx.mod.types);
      expect(module.functions).toEqual(original.ctx.mod.functions);
      expect(emitBinary(module)).toEqual(emitBinary(original.ctx.mod));
      expect(emitWat(module)).toBe(emitWat(original.ctx.mod));
    });
  }

  it("adopts the exact early backing and shares only the canonical vector base", () => {
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    const earlyArgumentArray = tx.reserveType("early", bodies.createArgumentVectorArrayType());
    const vectorBase = tx.reserveType("base", createVectorBaseType());
    const preparedArray = tx.reserveType(
      "prepared:array",
      createVectorBackingArrayType("__arr_externref", { kind: "externref" }),
    );
    const preparedCarrier = tx.reserveType(
      "prepared:carrier",
      createVectorCarrierType({
        name: "__vec_externref",
        baseTypeIndex: vectorBase.typeIndex,
        arrayTypeIndex: preparedArray.typeIndex,
      }),
    );
    const count = module.types.length;
    const pack = reserveNativeArgumentVectorResources(tx, { key: "argv" }, { vectorBase, earlyArgumentArray });
    expect(pack.array).toBe(earlyArgumentArray);
    expect(pack.vectorBase).toBe(vectorBase);
    expect(pack.array).not.toBe(preparedArray);
    expect(pack.carrier).not.toBe(preparedCarrier);
    expect(module.types.slice(count).filter((type) => type.kind === "array")).toHaveLength(0);
    tx.freezeReservations();
    fillNativeArgumentVectorResources(tx, pack);
    tx.seal();
  });

  it("executes actual resource bodies across 8/16/32/64 growth boundaries and preserves references", () => {
    const { api } = instantiate();
    const vector = api.newVector();
    expect(api.length(vector)).toBe(0);
    expect(api.capacity(vector)).toBe(8);
    const values: unknown[] = [null, undefined, "then", 7, { identity: 1 }, false];
    for (let i = 0; i < 65; i++) {
      const value = i < values.length ? values[i] : { index: i };
      values[i] = value;
      api.push(vector, value);
      expect(api.length(vector)).toBe(i + 1);
      expect(api.capacity(vector)).toBe(8 * 2 ** Math.max(0, Math.ceil(Math.log2((i + 1) / 8))));
      for (let j = 0; j <= i; j++) expect(api.get(vector, j)).toBe(values[j]);
    }
    const other = api.newVector();
    expect(api.length(other)).toBe(0);
    // Assert identity without asking the assertion formatter to inspect opaque
    // Wasm GC objects. Distinct allocations must still compare unequal.
    expect(other === vector).toBe(false);
  });

  it("executes the noncarrier return without mutating host values or trapping", () => {
    const { api } = instantiate();
    const object = { length: 9, data: [1] };
    for (const value of [null, undefined, 1, "x", object]) expect(() => api.push(value, "ignored")).not.toThrow();
    expect(object).toEqual({ length: 9, data: [1] });
  });

  it("rejects foreign pack owners and forged copies", () => {
    const a = reserve(),
      b = reserve();
    a.tx.freezeReservations();
    b.tx.freezeReservations();
    expect(() => fillNativeArgumentVectorResources(a.tx, b.pack)).toThrow(/foreign/);
    expect(() => fillNativeArgumentVectorResources(a.tx, { ...a.pack })).toThrow(/forged/);
    fillNativeArgumentVectorResources(a.tx, a.pack);
    expect(() => fillNativeArgumentVectorResources(a.tx, a.pack)).toThrow(/duplicate/);
  });

  for (const dependency of ["vectorBase", "earlyArgumentArray"] as const) {
    for (const provenance of ["foreign", "copied"] as const) {
      it(`rejects same-index ${provenance} ${dependency} during reserve without changing populations`, () => {
        // A genuine same-ledger control must succeed before testing rejection.
        const positive = reserve(true);
        positive.tx.freezeReservations();
        fillNativeArgumentVectorResources(positive.tx, positive.pack);
        positive.tx.seal();

        const module = createEmptyModule(),
          tx = new PhysicalModuleReservations(module);
        const vectorBase = tx.reserveType("base", createVectorBaseType());
        const earlyArgumentArray = tx.reserveType("early", bodies.createArgumentVectorArrayType());
        const local = dependency === "vectorBase" ? vectorBase : earlyArgumentArray;
        const foreign = dependency === "vectorBase" ? positive.pack.vectorBase : positive.pack.array;
        const rejected = provenance === "foreign" ? foreign : { ...local };
        expect(rejected.typeIndex).toBe(local.typeIndex);
        expect(rejected.object).toEqual(local.object);
        expect(rejected).not.toBe(local);
        const before = structuredClone(module);
        const types = module.types,
          functions = module.functions,
          ordinals = module.funcOrdinalToPosition;
        const dependencies = {
          vectorBase: dependency === "vectorBase" ? rejected : vectorBase,
          earlyArgumentArray: dependency === "earlyArgumentArray" ? rejected : earlyArgumentArray,
        };
        expect(() => reserveNativeArgumentVectorResources(tx, { key: "argv" }, dependencies)).toThrow(/foreign|forged/);
        expect(module).toEqual(before);
        expect(module.types).toBe(types);
        expect(module.functions).toBe(functions);
        expect(module.funcOrdinalToPosition).toBe(ordinals);
        expect(module.funcOrdinalToPosition).toEqual([]);
        expect(tx.state).toBe("failed");
      });
    }
  }

  it("rejects incorrect base and early-array descriptors", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const wrong = tx.reserveType("wrong", { kind: "struct", name: "wrong", fields: [] });
    expect(() => reserveNativeArgumentVectorResources(tx, { key: "bad" }, { vectorBase: wrong })).toThrow(/base/);
    const vectorBase = tx.reserveType("base", createVectorBaseType());
    expect(() =>
      reserveNativeArgumentVectorResources(tx, { key: "bad" }, { vectorBase, earlyArgumentArray: wrong }),
    ).toThrow(/backing/);
  });

  it("rejects missing fills at seal", () => {
    const { tx } = reserve();
    tx.freezeReservations();
    expect(() => tx.seal()).toThrow(/missing function fill/);
  });

  it("rejects altered nested layout contents before filling either function", () => {
    const positive = reserve();
    positive.tx.freezeReservations();
    fillNativeArgumentVectorResources(positive.tx, positive.pack);
    positive.tx.seal();
    const { tx, pack } = reserve();
    tx.freezeReservations();
    if (pack.carrier.object.kind !== "struct") throw new Error("expected struct");
    const before = structuredClone([pack.newVector.object, pack.push.object]);
    pack.carrier.object.fields[0] = { ...pack.carrier.object.fields[0]!, mutable: false };
    expect(() => fillNativeArgumentVectorResources(tx, pack)).toThrow(/altered|replaced|identity|stale/);
    expect([pack.newVector.object, pack.push.object]).toEqual(before);
  });

  it("returns fresh mutable instruction and descriptor objects on each build", () => {
    const layout = { objVecArrTypeIdx: 3, objVecTypeIdx: 5 };
    const first = bodies.buildArgumentVectorPushBody(layout);
    const second = bodies.buildArgumentVectorPushBody(layout);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[5]).not.toBe(second[5]);
    expect(bodies.createArgumentVectorArrayType()).not.toBe(bodies.createArgumentVectorArrayType());
  });

  for (const mutation of ["copy", "replace", "store-length", "noncarrier"] as const) {
    it(`independent donor rejects live ${mutation} mutant (evaluation outside expected failure)`, () => {
      const original = legacy(true, false, true).ctx.mod.functions[1]!;
      const layout = { objVecArrTypeIdx: 1, objVecTypeIdx: 2 };
      const positive = bodies.buildArgumentVectorPushBody(layout);
      expect(positive).toEqual(original.body);
      const mutant = bodies.buildArgumentVectorPushBody(layout);
      const grow = mutant.find((instruction) => instruction.op === "if" && instruction.then.length > 1);
      if (!grow || grow.op !== "if") throw new Error("missing grow branch");
      if (mutation === "copy") {
        const block = grow.then.findIndex((instruction) => instruction.op === "block");
        if (block < 0) throw new Error("missing copy loop");
        grow.then.splice(block, 1);
      } else if (mutation === "replace") {
        // Move v.data/arr replacement before the copy: old elements would be lost.
        const replacement = grow.then.splice(-7);
        const block = grow.then.findIndex((instruction) => instruction.op === "block");
        if (block < 0) throw new Error("missing copy loop");
        grow.then.splice(block, 0, ...replacement);
      } else if (mutation === "store-length") {
        const tail = mutant.splice(-11);
        mutant.push(...tail.slice(5), ...tail.slice(0, 5));
      } else {
        const guard = mutant[5];
        if (guard?.op !== "if") throw new Error("missing noncarrier guard");
        guard.then = [];
      }
      // Construction and genuine positive comparison above cannot be swallowed by toThrow.
      expect(() => expect(mutant).toEqual(original.body)).toThrow();
    });
  }
});
