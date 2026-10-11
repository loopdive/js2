// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import * as bodies from "../src/runtime/wasmgc/values/symbol-carrier-bodies.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  declareNativeSymbolCarrierResources,
  reserveNativeSymbolCarrierResources,
  fillNativeSymbolCarrierResources,
  requireNativeSymbolCarrierReservations,
  requireCompletedNativeSymbolCarrier,
  nativeSymbolCarrierReservationInventory,
} from "../src/backend/wasmgc/resources/native-symbol-carrier.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const read = readBeforeResumeMain;
const fixtureText = read("tests/fixtures/issue-3518-native-symbol-carrier-donor.json");
const FIXTURE_SHA = "aa7beec33888dd1ddc7bf8fdb9ac515ed9ba7a5ae0e8e3489215ab9572b5bca1";
const SOURCE_SHA = "5685b9fc944573b6f01026bb0295170a4788facee478a3463af0e2408c95bce6";
const adapter = read("src/codegen/symbol-native.ts");
interface Receipt {
  schemaVersion: number;
  base: string;
  path: string;
  gitBlob: string;
  sourceSha256: string;
  functionName: string;
  start: number;
  end: number;
  text: string;
  sha256: string;
}
function authenticate(text: string): Receipt {
  if (sha(text) !== FIXTURE_SHA) throw Error("symbol donor digest mismatch");
  const r = JSON.parse(text) as Receipt;
  if (
    r.schemaVersion !== 1 ||
    r.base !== "17ac5ad7d3fd5d959a4ffbea0f526d9f18d1c901" ||
    r.path !== "src/codegen/symbol-native.ts" ||
    r.sourceSha256 !== SOURCE_SHA ||
    r.functionName !== "ensureSymbolCarrier" ||
    r.text.length !== r.end - r.start ||
    sha(r.text) !== r.sha256
  )
    throw Error("symbol donor provenance mismatch");
  return r;
}
const receipt = authenticate(fixtureText);
const parse = (text: string) => ts.createSourceFile("symbol.ts", text, ts.ScriptTarget.Latest, true);
function fn(text: string) {
  const sf = parse(text);
  const node = sf.statements.find(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "ensureSymbolCarrier",
  );
  if (!node?.body) throw Error("missing carrier donor");
  return { sf, node };
}
function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    result.push(n);
    n.forEachChild(visit);
  };
  visit(node);
  return result;
}
function moved(text: string) {
  const { sf, node } = fn(text),
    nodes = descendants(node);
  const push = nodes.find(
    (n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText(sf) === "ctx.mod.types.push",
  );
  const body = nodes.find(
    (n): n is ts.PropertyAssignment => ts.isPropertyAssignment(n) && n.name.getText(sf) === "body",
  );
  if (!push || push.arguments.length !== 1 || !body) throw Error("missing carrier construction");
  return { sf, node, shape: push.arguments[0]!, body: body.initializer };
}
function reconstruct(text: string) {
  const original = moved(receipt.text),
    current = moved(text);
  const tokens = (n: ts.Node) => n.getText(current.sf).replace(/\s/g, "");
  expect(tokens(current.shape)).toBe("createSymbolCarrierType(anyStrTypeIdx)");
  expect(tokens(current.body)).toBe(
    "buildSymbolBoxBody({symIdx,anyStrTypeIdx,internArrTypeIdx,internGlobalIdx},{table:TBL,existing:EXISTING,grow:GROW},)",
  );
  let result = text;
  for (const key of ["body", "shape"] as const) {
    const n = current[key];
    result = result.slice(0, n.getStart(current.sf)) + original[key].getText(original.sf) + result.slice(n.end);
  }
  const imports = current.sf.statements.filter(
    (n): n is ts.ImportDeclaration =>
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      n.moduleSpecifier.text === "../runtime/wasmgc/values/symbol-carrier-bodies.js",
  );
  expect(imports).toHaveLength(1);
  const added = imports[0]!;
  expect(added.getText(current.sf).replace(/\s/g, "")).toBe(
    'import{createSymbolCarrierType,buildSymbolBoxBody}from"../runtime/wasmgc/values/symbol-carrier-bodies.js";',
  );
  result = result.slice(0, added.getStart(current.sf)) + result.slice(added.end + 1);
  if (sha(result) !== SOURCE_SHA) throw Error("unadmitted symbol source delta");
  return result;
}
interface TraceOptions {
  typeOffset?: number;
  globalOffset?: number;
  existingType?: boolean;
  existingBox?: boolean;
}
function trace(text: string, options: TraceOptions = {}, override: Partial<typeof bodies> = {}) {
  const events: unknown[] = [],
    types: unknown[] = Array.from({ length: options.typeOffset ?? 0 }, () => ({ kind: "struct", fields: [] }));
  const functions: unknown[] = [],
    globals: unknown[] = [];
  const map = new Map<string, number>();
  if (options.existingBox) map.set("__box_symbol", 0x40000012);
  const ctx = {
    symbolTypeIdx: options.existingType ? 3 : -1,
    anyStrTypeIdx: 2,
    numImportGlobals: options.globalOffset ?? 0,
    mod: { types, globals },
    funcMap: {
      get(name: string) {
        events.push(["get", name]);
        return map.get(name);
      },
      set(name: string, value: number) {
        events.push(["set", name, value]);
        map.set(name, value);
      },
    },
  };
  const sandbox = vm.createContext({
    exports: {},
    ...bodies,
    ...override,
    ensureNativeStringHelpers(actual: unknown) {
      expect(actual).toBe(ctx);
      events.push(["strings", types.length]);
    },
    getOrRegisterArrayType(actual: unknown, name: string, element: unknown) {
      expect(actual).toBe(ctx);
      events.push(["array", name, element, types.length]);
      const at = types.length;
      types.push({ kind: "array", name: `__arr_${name}`, element, mutable: true });
      return at;
    },
    addFuncType(actual: unknown, params: unknown, results: unknown) {
      expect(actual).toBe(ctx);
      events.push(["signature", params, results]);
      types.push({ kind: "func", params, results });
      return types.length - 1;
    },
    mintDefinedFunc(actual: unknown) {
      expect(actual).toBe(ctx);
      events.push(["mint"]);
      return 0x40000005;
    },
    pushDefinedFunc(actual: unknown, handle: number, definition: unknown) {
      expect(actual).toBe(ctx);
      events.push(["publish", handle]);
      functions.push(definition);
    },
  });
  vm.runInContext(
    ts.transpileModule(fn(text).node.getText(fn(text).sf), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    sandbox,
  );
  const api = sandbox.exports as { ensureSymbolCarrier(ctx: unknown): number };
  const first = api.ensureSymbolCarrier(ctx),
    second = api.ensureSymbolCarrier(ctx);
  return JSON.parse(JSON.stringify({ events, types, globals, functions, first, second }));
}

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
});
describe("fixed Symbol carrier donor and real adapter", () => {
  it("reconstructs the exact committed complete source and original carrier scope", () => {
    const original = reconstruct(adapter);
    expect(original.slice(receipt.start, receipt.end)).toBe(receipt.text);
    expect(sha(original)).toBe(SOURCE_SHA);
  });
  it.each([
    {},
    { typeOffset: 7, globalOffset: 3 },
    { existingType: true },
    { existingBox: true },
    { existingType: true, existingBox: true },
  ])("preserves complete allocation/publication and idempotent trace %j", (options) => {
    expect(trace(adapter, options)).toEqual(trace(receipt.text, options));
  });
  it("rejects retained description/bridge source corruption after a genuine inverse", () => {
    reconstruct(adapter);
    expect(() =>
      reconstruct(
        adapter.replace("export function ensureNativeSymbolBoundaryBridge", "export function changedBoundaryBridge"),
      ),
    ).toThrow("unadmitted symbol source delta");
  });
  it.each(['with { type: "json" }', 'assert { type: "json" }'])(
    "rejects added import semantics %s before inversion",
    (attributes) => {
      reconstruct(adapter);
      expect(() =>
        reconstruct(
          adapter.replace(
            'from "../runtime/wasmgc/values/symbol-carrier-bodies.js";',
            `from "../runtime/wasmgc/values/symbol-carrier-bodies.js" ${attributes};`,
          ),
        ),
      ).toThrow();
    },
  );
  it("rejects changed donor bytes without reseeding", () => {
    authenticate(fixtureText);
    expect(() => authenticate(fixtureText.replace("17ac5ad7", "00000000"))).toThrow("digest");
  });
  it("detects a missing growth copy against the actual donor definition", () => {
    const original = trace(receipt.text);
    expect(trace(adapter)).toEqual(original);
    const mutate = (xs: Instr[]): Instr[] =>
      xs
        .filter((i) => i.op !== "array.copy")
        .map((i) => {
          const copy = { ...i };
          for (const key of ["body", "then", "else"] as const)
            if (key in copy && Array.isArray(copy[key]))
              (copy as Record<string, unknown>)[key] = mutate(copy[key] as Instr[]);
          return copy;
        });
    expect(trace(adapter, {}, { buildSymbolBoxBody: (d, l) => mutate(bodies.buildSymbolBoxBody(d, l)) })).not.toEqual(
      original,
    );
  });
  it("keeps runtime builder imports in canonical runtime/Wasm layers", () => {
    const sf = parse(read("src/runtime/wasmgc/values/symbol-carrier-bodies.ts"));
    const imports = sf.statements
      .filter(ts.isImportDeclaration)
      .map((n) => (n.moduleSpecifier as ts.StringLiteral).text);
    expect(imports).toEqual([
      "../../../wasm/model/instructions.js",
      "../../../wasm/model/module-records.js",
      "./vector-grow-store.js",
    ]);
  });
});

function resources(offset = 0, utf8Storage = false) {
  const mod = createEmptyModule(),
    tx = new PhysicalModuleReservations(mod);
  for (let i = 0; i < offset; i++) tx.reserveType(`padding:${i}`, { kind: "struct", name: `Padding${i}`, fields: [] });
  if (offset) {
    tx.reserveFunctionImport("offset:function", "offset", "noop", { params: [], results: [] });
    tx.reserveGlobalImport("offset:global", "offset", "number", { kind: "i32" }, false);
  }
  const strings = reserveNativeStringLiteralResources(tx, { key: "strings", utf8Storage, literals: [] });
  const padding = offset ? tx.reserveGlobal("padding:global", "padding", { kind: "i32" }, false) : null;
  const pack = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  return { mod, tx, strings, pack, padding };
}
function complete(f: ReturnType<typeof resources>) {
  f.tx.freezeReservations();
  if (f.padding) f.tx.fillGlobal(f.padding, [{ op: "i32.const", value: 41 }]);
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeSymbolCarrierResources(f.tx, f.pack);
  expect(requireCompletedNativeSymbolCarrier(f.tx, f.pack, f.strings)).toBe(f.pack);
  return f;
}
function boxDefinition(f: ReturnType<typeof resources>) {
  return bodies.buildSymbolBoxDefinition({
    symIdx: f.tx.physicalIndex(f.pack.types.symbol),
    anyStrTypeIdx: f.strings.layout.anyStrTypeIdx,
    internArrTypeIdx: f.tx.physicalIndex(f.pack.types.internArray),
    internGlobalIdx: f.tx.physicalIndex(f.pack.globals.internTable),
  });
}
function runtime(offset = 0, utf8 = false, mutate?: (body: Instr[]) => Instr[]) {
  const f = resources(offset, utf8),
    { tx, pack } = f;
  const id = tx.reserveFunction("read:id", "read_id", { params: [{ kind: "externref" }], results: [{ kind: "i32" }] });
  const desc = tx.reserveFunction("read:desc", "read_desc", {
    params: [{ kind: "externref" }],
    results: [{ kind: "i32" }],
  });
  const capacity = tx.reserveFunction("read:capacity", "capacity", { params: [], results: [{ kind: "i32" }] });
  if (mutate) {
    tx.freezeReservations();
    if (f.padding) tx.fillGlobal(f.padding, [{ op: "i32.const", value: 41 }]);
    fillNativeStringLiteralResources(tx, f.strings);
    const definition = boxDefinition(f);
    tx.fillGlobal(pack.globals.internTable, [{ op: "ref.null", typeIdx: pack.types.internArray.typeIndex }]);
    tx.fillFunction(pack.functions.box, { ...definition, body: mutate(definition.body) });
    expect(() => requireCompletedNativeSymbolCarrier(tx, pack, f.strings)).toThrow("missing canonical fill");
  } else complete(f);
  for (const [token, field, tail] of [
    [id, 0, []],
    [desc, 1, [{ op: "ref.is_null" }]],
  ] as const)
    tx.fillFunction(token, {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: pack.types.symbol.typeIndex },
        { op: "struct.get", typeIdx: pack.types.symbol.typeIndex, fieldIdx: field },
        ...tail,
      ],
    });
  tx.fillFunction(capacity, {
    locals: [],
    body: [
      { op: "global.get", index: tx.physicalIndex(pack.globals.internTable) },
      { op: "ref.as_non_null" },
      { op: "array.len" },
    ],
  });
  for (const [name, token] of [
    ["box", pack.functions.box],
    ["id", id],
    ["desc", desc],
    ["capacity", capacity],
  ] as const)
    tx.defineExport(`export:${name}`, name, token);
  tx.seal();
  const bytes = emitBinary(f.mod);
  expect(WebAssembly.validate(bytes)).toBe(true);
  const compiled = new WebAssembly.Module(bytes);
  const instance = () =>
    new WebAssembly.Instance(compiled, { offset: { noop: () => {}, number: 77 } }).exports as {
      box: (id: number) => object;
      id: (value: object) => number;
      desc: (value: object) => number;
      capacity: () => number;
    };
  return { ...f, instance };
}
describe("issued native Symbol carrier resources", () => {
  it("declares and authenticates all four exact current resources before and after fill", () => {
    const f = resources(3, true),
      inventory = nativeSymbolCarrierReservationInventory(f.tx, f.pack);
    expect(inventory.plan).toEqual(declareNativeSymbolCarrierResources("symbols", "strings:any"));
    expect(inventory.strings).toBe(f.strings);
    expect(inventory.resources.map((x) => x.declaration.role)).toEqual([
      "symbol-type",
      "intern-array",
      "intern-table",
      "box",
    ]);
    expect(inventory.resources.map((x) => x.reservation)).toEqual([
      f.pack.types.symbol,
      f.pack.types.internArray,
      f.pack.globals.internTable,
      f.pack.functions.box,
    ]);
    expect(Object.isFrozen(inventory.plan.declarations[1].shape.name)).toBe(true);
    expect(requireNativeSymbolCarrierReservations(f.tx, f.pack, f.strings)).toBe(f.pack);
    expect(f.pack.types.symbol.object).toEqual(bodies.createSymbolCarrierType(f.strings.layout.anyStrTypeIdx));
    expect(f.pack.types.internArray.object).toEqual(bodies.createSymbolInternArrayType(f.pack.types.symbol.typeIndex));
    complete(f);
    expect(nativeSymbolCarrierReservationInventory(f.tx, f.pack)).toBe(inventory);
    expect(f.tx.physicalIndex(f.pack.globals.internTable)).toBe(2);
    expect(f.tx.physicalIndex(f.pack.functions.box)).toBe(1);
    expect(f.mod.exports).toEqual([]);
  });
  it.each([
    [0, false],
    [0, true],
    [4, false],
    [4, true],
  ] as const)("executes intern identity, fields and growth with offset %i UTF8=%s", (offset, utf8) => {
    const { instance } = runtime(offset, utf8),
      r = instance(),
      zero = r.box(0);
    expect(r.capacity()).toBe(1);
    expect(Object.is(r.box(0), zero)).toBe(true);
    expect(r.id(zero)).toBe(0);
    expect(r.desc(zero)).toBe(1);
    const seen = new Map<number, object>([[0, zero]]);
    for (const id of [1, 5, 16, 100, 400]) {
      const value = r.box(id);
      expect(Object.is(value, zero)).toBe(false);
      expect(r.id(value)).toBe(id);
      expect(r.desc(value)).toBe(1);
      expect(r.capacity()).toBeGreaterThan(id);
      expect([...seen.values()].some((previous) => Object.is(previous, value))).toBe(false);
      seen.set(id, value);
      for (const [oldId, oldValue] of seen) expect(Object.is(r.box(oldId), oldValue)).toBe(true);
    }
  });
  it("preserves donor id+1 allocation and repeated doubling from a nonzero first ID", () => {
    const r = runtime().instance(),
      first = r.box(100);
    expect(r.capacity()).toBe(101);
    r.box(102);
    expect(r.capacity()).toBe(202);
    r.box(404);
    expect(r.capacity()).toBe(808);
    expect(Object.is(r.box(100), first)).toBe(true);
  });
  it("executes a valid-Wasm growth-copy mutant which loses previously interned identity", () => {
    const positive = runtime().instance(),
      oldPositive = positive.box(0);
    positive.box(100);
    expect(Object.is(positive.box(0), oldPositive)).toBe(true);
    let copies = 0;
    const removeCopy = (body: Instr[]): Instr[] =>
      body.flatMap((instruction) => {
        if (instruction.op === "array.copy") {
          copies++;
          return Array.from({ length: 5 }, (): Instr => ({ op: "drop" }));
        }
        const copy = { ...instruction };
        for (const key of ["body", "then", "else"] as const)
          if (key in copy && Array.isArray(copy[key]))
            (copy as Record<string, unknown>)[key] = removeCopy(copy[key] as Instr[]);
        return [copy];
      });
    const mutant = runtime(0, false, removeCopy).instance(),
      oldMutant = mutant.box(0);
    expect(copies).toBe(1);
    mutant.box(100);
    expect(mutant.id(oldMutant)).toBe(0);
    expect(Object.is(mutant.box(0), oldMutant)).toBe(false);
  });
  it("keeps tables isolated between fresh instances", () => {
    const { instance } = runtime(2),
      a = instance(),
      b = instance();
    const value = a.box(3);
    expect(Object.is(a.box(3), value)).toBe(true);
    expect(Object.is(b.box(3), value)).toBe(false);
    expect(b.id(b.box(3))).toBe(3);
  });
  it.each(["copy", "foreign", "altered-type", "invalid-key"] as const)(
    "rejects %s string admission before allocating dependents",
    (mode) => {
      const f = resources();
      expect(requireNativeSymbolCarrierReservations(f.tx, f.pack, f.strings)).toBe(f.pack);
      const counts = () => [f.mod.types.length, f.mod.globals.length, f.mod.functions.length];
      const before = counts();
      let strings = f.strings,
        key = "second";
      if (mode === "copy") strings = { ...strings };
      if (mode === "foreign") strings = resources().strings;
      if (mode === "altered-type") strings.types[0]!.object.name = "altered-string-layout";
      if (mode === "invalid-key") key = "";
      expect(() => reserveNativeSymbolCarrierResources(f.tx, key, strings)).toThrow();
      expect(counts()).toEqual(before);
    },
  );
  it("rejects copied Symbol packs, foreign ledgers and substituted real string owners", () => {
    const f = resources(),
      other = reserveNativeStringLiteralResources(f.tx, { key: "other", utf8Storage: false, literals: [] });
    expect(requireNativeSymbolCarrierReservations(f.tx, f.pack, f.strings)).toBe(f.pack);
    expect(() => requireNativeSymbolCarrierReservations(f.tx, { ...f.pack }, f.strings)).toThrow("copied");
    expect(() => requireNativeSymbolCarrierReservations(resources().tx, f.pack, f.strings)).toThrow("foreign");
    expect(() => requireNativeSymbolCarrierReservations(f.tx, f.pack, other)).toThrow("substituted");
  });
  it.each(["global", "function"] as const)(
    "rejects a pre-existing late %s key before allocating any Symbol prefix",
    (kind) => {
      const positive = resources();
      expect(nativeSymbolCarrierReservationInventory(positive.tx, positive.pack).resources).toHaveLength(4);
      const mod = createEmptyModule(),
        tx = new PhysicalModuleReservations(mod),
        strings = reserveNativeStringLiteralResources(tx, { key: "strings", utf8Storage: false, literals: [] });
      if (kind === "global") tx.reserveGlobal("symbols:intern-table", "occupied", { kind: "i32" }, false);
      else tx.reserveFunction("symbols:box", "occupied", { params: [{ kind: "f64" }], results: [{ kind: "f64" }] });
      const before = structuredClone(mod),
        arrays = [mod.types, mod.globals, mod.functions, mod.funcOrdinalToPosition],
        signatures = structuredClone(mod.types.filter((type) => type.kind === "func"));
      expect(() => reserveNativeSymbolCarrierResources(tx, "symbols", strings)).toThrow(/duplicate.*resource key/);
      expect(mod).toStrictEqual(before);
      expect(mod.types.filter((type) => type.kind === "func")).toStrictEqual(signatures);
      [mod.types, mod.globals, mod.functions, mod.funcOrdinalToPosition].forEach((array, index) =>
        expect(array === arrays[index]).toBe(true),
      );
    },
  );
  it("requires actual string completion before any Symbol fill", () => {
    const f = resources();
    f.tx.freezeReservations();
    expect(() => fillNativeSymbolCarrierResources(f.tx, f.pack)).toThrow("incomplete literal");
    expect(f.pack.functions.box.object.body).toEqual([]);
    expect(f.pack.globals.internTable.object.init).toEqual([]);
    fillNativeStringLiteralResources(f.tx, f.strings);
    fillNativeSymbolCarrierResources(f.tx, f.pack);
    expect(requireCompletedNativeSymbolCarrier(f.tx, f.pack, f.strings)).toBe(f.pack);
  });
  it.each(["intern-global", "box-function", "both"] as const)(
    "refuses external %s prefill even with exact canonical content",
    (mode) => {
      const positive = complete(resources());
      expect(requireCompletedNativeSymbolCarrier(positive.tx, positive.pack, positive.strings)).toBe(positive.pack);
      const f = resources();
      f.tx.freezeReservations();
      fillNativeStringLiteralResources(f.tx, f.strings);
      if (mode !== "box-function")
        f.tx.fillGlobal(f.pack.globals.internTable, [{ op: "ref.null", typeIdx: f.pack.types.internArray.typeIndex }]);
      if (mode !== "intern-global") f.tx.fillFunction(f.pack.functions.box, boxDefinition(f));
      expect(() => requireCompletedNativeSymbolCarrier(f.tx, f.pack, f.strings)).toThrow("missing canonical fill");
      expect(() => fillNativeSymbolCarrierResources(f.tx, f.pack)).toThrow("duplicate");
      expect(f.tx.state).toBe("failed");
      expect(() => requireCompletedNativeSymbolCarrier(f.tx, f.pack, f.strings)).toThrow("failed");
    },
  );
  it("rejects premature and repeated lifecycle calls", () => {
    const f = resources();
    expect(() => fillNativeSymbolCarrierResources(f.tx, f.pack)).toThrow("frozen");
    expect(() => requireCompletedNativeSymbolCarrier(f.tx, f.pack, f.strings)).toThrow("missing canonical fill");
    complete(f);
    expect(() => fillNativeSymbolCarrierResources(f.tx, f.pack)).toThrow("duplicate fill");
  });
  it.each([
    "symbol-field",
    "array-element",
    "global-type",
    "global-initializer",
    "function-signature",
    "body",
    "locals",
    "string-layout",
  ] as const)("rejects changed completed %s content", (mode) => {
    const f = complete(resources()),
      { pack } = f;
    expect(requireCompletedNativeSymbolCarrier(f.tx, pack, f.strings)).toBe(pack);
    if (mode === "symbol-field") {
      const x = pack.types.symbol.object;
      if (x.kind !== "struct") throw Error("shape");
      x.fields[0]!.mutable = true;
    }
    if (mode === "array-element") {
      const x = pack.types.internArray.object;
      if (x.kind !== "array") throw Error("shape");
      x.element = { kind: "externref" };
    }
    if (mode === "global-type") pack.globals.internTable.object.mutable = false;
    if (mode === "global-initializer") pack.globals.internTable.object.init = [];
    if (mode === "function-signature") pack.functions.box.object.typeIdx = 0;
    if (mode === "body") pack.functions.box.object.body = [{ op: "ref.null.extern" }];
    if (mode === "locals") pack.functions.box.object.locals = [];
    if (mode === "string-layout") f.strings.types[0]!.object.name = "changed";
    expect(() => requireCompletedNativeSymbolCarrier(f.tx, pack, f.strings)).toThrow();
  });
});
