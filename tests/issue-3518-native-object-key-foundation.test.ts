// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as bodies from "../src/runtime/wasmgc/values/object-key-bodies.js";
import { verifyObjectRuntimeComposition } from "./helpers/object-get-key-composition.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import * as binaryEmitter from "../src/emit/binary.js";
import { mintDefinedFunc, commitDefinedFuncOrdinal, appendDefinedFunc } from "../src/wasm/physical/function-handles.js";
import { internFunctionType } from "../src/wasm/physical/function-types.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";

const BASE = "750fb7e7365692b315179dc909b57fa1407d4527";
const SOURCE_SHA = "692133e0345a24e3c45071ed031036b96dc3f6e7702dc358e2f99651820eed9e";
const RECEIPT_SHA = "71eb1eb834898794fc81c8d9906df63abcbcf418f75d407ded39688ddc39b19c";
const receiptText = readFileSync(new URL("./fixtures/issue-3518-object-key-donors.json", import.meta.url), "utf8");
const names = [
  "propertyKeyPrefix",
  "coercion",
  "hash",
  "equality",
  "classification",
  "match",
  "find",
  "propertyKeyLateArm",
];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
interface Receipt {
  schemaVersion: number;
  base: string;
  path: string;
  sourceSha256: string;
  spans: { name: string; start: number; end: number; sha256: string; text: string }[];
}
function authenticate(text: string): Receipt {
  if (sha(text) !== RECEIPT_SHA) throw Error("donor receipt digest mismatch");
  const result = JSON.parse(text) as Receipt;
  if (
    result.schemaVersion !== 1 ||
    result.base !== BASE ||
    result.sourceSha256 !== SOURCE_SHA ||
    result.path !== "src/codegen/object-runtime.ts" ||
    JSON.stringify(result.spans.map((r) => r.name)) !== JSON.stringify(names)
  )
    throw Error("donor provenance mismatch");
  for (const row of result.spans)
    if (sha(row.text) !== row.sha256 || row.end - row.start !== row.text.length) throw Error("donor span mismatch");
  return result;
}
const receipt = authenticate(receiptText);
function donor(name: string, bindings: Record<string, unknown>): Instr[] {
  const row = receipt.spans.find((r) => r.name === name);
  if (!row) throw Error("missing authenticated donor");
  const source =
    name === "propertyKeyLateArm" ? `${row.text}\nresult = nonSymbolToStringArm;` : `result = (${row.text});`;
  const context = vm.createContext({ ...bindings });
  vm.runInContext(
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    context,
  );
  return context.result as Instr[];
}
function resources(symbols: boolean, cached: boolean, nativeFirst: boolean) {
  return {
    anyStrTypeIdx: 10,
    nativeStrTypeIdx: 11,
    nativeStrRef: { kind: "ref", typeIdx: 11 } as ValType,
    strDataTypeIdx: 12,
    hashedStrTypeIdx: cached ? 13 : -1,
    symbolTypeIdx: symbols ? 14 : -1,
    symbolKeysEnabled: symbols,
    nativeFirst,
    strFlattenIdx: 20,
    strEqualsIdx: 21,
    objectTypeIdx: 30,
    propMapTypeIdx: 31,
    propEntryTypeIdx: 32,
    keyEqualsIdx: 22,
    objHashIdx: 23,
    tombstoneFlag: 0x80,
  };
}
function bindings(r: ReturnType<typeof resources>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...r,
    FNV_OFFSET: 0x811c9dc5 | 0,
    FNV_PRIME: 0x01000193,
    FLAG_TOMBSTONE: r.tombstoneFlag,
    ctx: {
      hashedStrTypeIdx: r.hashedStrTypeIdx,
      targetProfile: { semanticProviders: r.nativeFirst ? "native-first" : "compatibility" },
    },
  };
  result.emitClassifyKey = (
    keyParamIdx: number,
    searchAnyLocal: number,
    isSymLocal: number,
    symIdLocal: number,
    fkeyLocal: number,
  ) => donor("classification", { ...result, keyParamIdx, searchAnyLocal, isSymLocal, symIdLocal, fkeyLocal });
  result.emitKeyMatch = (entryLocal: number, isSymLocal: number, symIdLocal: number, fkeyLocal: number) =>
    donor("match", { ...result, entryLocal, isSymLocal, symIdLocal, fkeyLocal });
  return result;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

describe("fixed key-body donor preservation", () => {
  for (const symbols of [false, true])
    for (const cached of [false, true])
      for (const nativeFirst of [false, true])
        it(`preserves every key/find instruction: symbols=${symbols}, cached=${cached}, nativeFirst=${nativeFirst}`, () => {
          const r = resources(symbols, cached, nativeFirst),
            b = bindings(r);
          expect(bodies.buildObjectHashBody(r)).toEqual(donor("hash", b));
          if (symbols) expect(bodies.buildObjectKeyEqualsBody(r)).toEqual(donor("equality", b));
          expect(bodies.buildObjectKeyClassification(r, 1, 8, 9, 10, 7)).toEqual(
            donor("classification", {
              ...b,
              keyParamIdx: 1,
              searchAnyLocal: 8,
              isSymLocal: 9,
              symIdLocal: 10,
              fkeyLocal: 7,
            }),
          );
          expect(bodies.buildObjectKeyMatch(r, 6, 9, 10, 7)).toEqual(
            donor("match", { ...b, entryLocal: 6, isSymLocal: 9, symIdLocal: 10, fkeyLocal: 7 }),
          );
          expect(bodies.buildObjectFindBody(r)).toEqual(donor("find", b));
        });
  it.each([-1, 17])("preserves numeric key admission with boxed-number type %s", (boxNumTypeIdx) => {
    const r = { anyStrTypeIdx: 10, boxNumTypeIdx, unboxNumberIdx: 20, numToStringIdx: 21 };
    expect(bodies.buildObjectPropertyKeyPrefix(r)).toEqual(donor("propertyKeyPrefix", r));
  });
  it.each([false, true])("preserves the late ToPrimitive arm with Symbol support %s", (symbolKeysEnabled) => {
    const hint = (): Instr[] => [{ op: "global.get", index: 37 }, { op: "extern.convert_any" }];
    const r = { externToStringIdx: 27, toPrimitiveIdx: 28, symbolKeysEnabled, symbolTypeIdx: 14 };
    const stringExtern = vi.fn((text: string) => {
      expect(text).toBe("string");
      return hint();
    });
    const original = donor("propertyKeyLateArm", { ...r, stringExtern });
    expect(stringExtern).toHaveBeenCalledTimes(1);
    expect(bodies.buildObjectPropertyKeyLateArm({ ...r, stringHintInstrs: hint() })).toEqual(original);
  });
  it("retains exact body identity when key coercion is absent", () => {
    const body: Instr[] = [{ op: "local.get", index: 4 }];
    expect(donor("coercion", { body, keyParamIdx: 1, toPropertyKeyIdx: undefined })).toBe(body);
    expect(bodies.prependObjectKeyCoercion(undefined, 1, body)).toBe(body);
    expect(bodies.prependObjectKeyCoercion(24, 1, body)).toEqual(
      donor("coercion", { body, keyParamIdx: 1, toPropertyKeyIdx: 24 }),
    );
    expect(bodies.prependObjectKeyCoercion(24, 1, body)[3]).toBe(body[0]);
  });
  it.each(["body", "base", "population"])(
    "rejects changed %s after authenticating the positive receipt",
    (mutation) => {
      expect(authenticate(receiptText).spans).toHaveLength(8);
      const copy = JSON.parse(receiptText) as Receipt;
      if (mutation === "body") copy.spans[2]!.text = copy.spans[2]!.text.replace("i32.xor", "i32.or");
      else if (mutation === "base") copy.base = "0".repeat(40);
      else copy.spans.pop();
      expect(() => authenticate(JSON.stringify(copy))).toThrow("donor receipt digest mismatch");
    },
  );
  it("has no runtime imports or shared emitted instructions across independent builds", () => {
    const source = readFileSync(new URL("../src/runtime/wasmgc/values/object-key-bodies.ts", import.meta.url), "utf8");
    const file = ts.createSourceFile("leaf.ts", source, ts.ScriptTarget.Latest, true);
    const imports = file.statements.filter(ts.isImportDeclaration);
    expect(imports).toHaveLength(1);
    expect(imports.every((row) => row.importClause?.isTypeOnly)).toBe(true);
    expect(
      ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
        .outputText,
    ).not.toMatch(/\bimport\b/);
    const instructions = (value: unknown, found = new Set<object>()): Set<object> => {
      if (value && typeof value === "object") {
        if ("op" in value) {
          expect(found.has(value)).toBe(false);
          found.add(value);
        }
        for (const child of Object.values(value)) instructions(child, found);
      }
      return found;
    };
    const r = resources(true, true, true);
    const first = instructions(bodies.buildObjectFindBody(r));
    const second = instructions(bodies.buildObjectFindBody(r));
    expect(first.size).toBeGreaterThan(60);
    expect([...second].some((row) => first.has(row))).toBe(false);
  });
});

const cases = [
  {
    name: "numeric and string key coercion",
    expected: 2345,
    body: `
    const o: any = {}; const a = -0; const b = -1.5;
    o[a] = 2; o[b] = 3; o[true as any] = 4; o[null as any] = 5;
    return o["0"] * 1000 + o["-1.5"] * 100 + o["true"] * 10 + o["null"];
  `,
  },
  {
    name: "distinct Symbol identities and a same-description string",
    expected: 5711,
    body: `
    const a = Symbol("same"); const b = Symbol("same"); const o: any = {};
    o[a] = 3; o[b] = 7; o["same"] = 11; delete o[a];
    if (a in o) return -1; o[a] = 5;
    return o[a] * 1000 + o[b] * 100 + o["same"];
  `,
  },
  {
    name: "collision probing past tombstones and reinsertion",
    expected: 792,
    body: `
    const keys = ["a", "A", "!"]; const o: any = {};
    for (let i = 0; i < keys.length; i++) o[keys[i]] = i + 1;
    delete o[keys[0]]; if (keys[0] in o) return -1;
    const after = o[keys[1]]; o[keys[0]] = 7; o[keys[2]] = 9;
    return o[keys[0]] * 100 + o[keys[2]] * 10 + after;
  `,
  },
  {
    name: "effectful object key preserves a returned Symbol",
    expected: 113,
    body: `
    const s = Symbol("key"); const state = { calls: 0 }; const o: any = {};
    const key: any = { toString() { state.calls++; return s; } };
    o[key] = 13; return state.calls * 100 + o[s];
  `,
  },
];
const builderNames = [
  "buildObjectPropertyKeyPrefix",
  "prependObjectKeyCoercion",
  "buildObjectHashBody",
  "buildObjectKeyEqualsBody",
  "buildObjectKeyClassification",
  "buildObjectKeyMatch",
  "buildObjectFindBody",
  "buildObjectPropertyKeyLateArm",
] as const;

describe.each([false, true])("actual legacy production delegation, experimentalIR=%s", (experimentalIR) => {
  it.each(cases)("executes $name against the native oracle", async ({ name, body, expected }) => {
    for (const key of [
      "JS2WASM_IR_GVN",
      "JS2WASM_IR_OWNERSHIP",
      "JS2WASM_IR_ESCAPE",
      "IR_VERIFY_ALLOC",
      "JS2WASM_IR_VERIFY_DOMINANCE_NAIVE",
      "JS2WASM_IR_INLINE",
    ])
      vi.stubEnv(key, "0");
    const source = `export function test(): number { ${body} }`;
    const native = vm.createContext({});
    vm.runInContext(
      ts.transpileModule(source.replace("export ", ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
        .outputText,
      native,
    );
    expect(vm.runInContext("test()", native)).toBe(expected);
    const calls = builderNames.map((name) => vi.spyOn(bodies, name));
    const { compile } = await import("../src/index.js");
    const result = await compile(source, {
      fileName: `object-key-${name}-${experimentalIR}.ts`,
      target: "standalone",
      nativeStrings: true,
      experimentalIR,
      skipSemanticDiagnostics: false,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    for (let i = 0; i < calls.length; i++) expect(calls[i], builderNames[i]).toHaveBeenCalled();
    const hashCall = calls[2]!.mock.calls.at(-1)![0] as bodies.ObjectHashResources;
    expect(hashCall.symbolKeysEnabled).toBe(true);
    expect(hashCall.hashedStrTypeIdx).toBeGreaterThanOrEqual(0);
    const compiled = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(compiled)).toEqual([]);
    const instance = new WebAssembly.Instance(compiled, {});
    expect((instance.exports.test as () => number)()).toBe(expected);
  });
});

it("executes hash-cache write-back and its cached fast path on real reserved string resources", () => {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "keys",
    utf8Storage: false,
    literals: [{ value: "" }, { value: "ab" }],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "flatten", strings),
    l = strings.layout;
  const hash = tx.reserveFunction("hash", "hash", { params: [{ kind: "externref" }], results: [{ kind: "i32" }] });
  const probe = tx.reserveFunction("probe", "probe", {
    params: [],
    results: [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
  });
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, strings);
  fillNativeStringFlattenResources(tx, flatten);
  const literal = requireNativeStringLiteral(tx, strings, "ab", "wtf16");
  if (literal.kind !== "global") throw Error("missing issued literal");
  const r: bodies.ObjectHashResources = {
    anyStrTypeIdx: l.anyStrTypeIdx,
    nativeStrTypeIdx: l.nativeStrTypeIdx,
    nativeStrRef: { kind: "ref", typeIdx: l.nativeStrTypeIdx },
    strDataTypeIdx: l.nativeStrDataTypeIdx,
    hashedStrTypeIdx: l.hashedStrTypeIdx,
    symbolTypeIdx: -1,
    symbolKeysEnabled: false,
    nativeFirst: true,
    strFlattenIdx: flatten.flatten.handle,
  };
  tx.fillFunction(hash, {
    locals: [
      { name: "str", type: r.nativeStrRef },
      { name: "data", type: { kind: "ref", typeIdx: r.strDataTypeIdx } },
      ...["len", "off", "i", "h"].map((name) => ({ name, type: { kind: "i32" as const } })),
      { name: "keyAny", type: { kind: "anyref" } },
      { name: "keyStr", type: { kind: "ref", typeIdx: r.anyStrTypeIdx } },
    ],
    body: bodies.buildObjectHashBody(r),
  });
  const load = (): Instr[] => [{ op: "local.get", index: 0 }, { op: "ref.as_non_null" }];
  tx.fillFunction(probe, {
    locals: [{ name: "key", type: { kind: "ref_null", typeIdx: l.hashedStrTypeIdx } }],
    body: [
      { op: "i32.const", value: 2 },
      { op: "i32.const", value: 0 },
      { op: "global.get", index: tx.physicalIndex(literal.global) },
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "ref.null", typeIdx: -18 },
      { op: "ref.null", typeIdx: -18 },
      { op: "ref.null", typeIdx: -18 },
      { op: "struct.new", typeIdx: l.hashedStrTypeIdx },
      { op: "local.set", index: 0 },
      ...load(),
      { op: "struct.get", typeIdx: l.hashedStrTypeIdx, fieldIdx: 3 },
      ...load(),
      { op: "extern.convert_any" },
      { op: "call", funcIdx: hash.handle },
      ...load(),
      { op: "struct.get", typeIdx: l.hashedStrTypeIdx, fieldIdx: 3 },
      ...load(),
      { op: "i32.const", value: -2147483525 },
      { op: "struct.set", typeIdx: l.hashedStrTypeIdx, fieldIdx: 3 },
      ...load(),
      { op: "extern.convert_any" },
      { op: "call", funcIdx: hash.handle },
    ],
  });
  tx.defineExport("probe-export", "probe", probe);
  tx.seal();
  const compiled = new WebAssembly.Module(Uint8Array.from(binaryEmitter.emitBinary(module)));
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  const instance = new WebAssembly.Instance(compiled, {});
  let expected = 0x811c9dc5 | 0;
  for (const unit of [97, 98]) expected = Math.imul(expected ^ unit, 0x01000193);
  expected &= 0x7fffffff;
  expect((instance.exports.probe as () => number[])()).toEqual([0, expected, expected | -0x80000000, 123]);
});

it("observes actual hash collisions and lookup crossing a deleted production table slot", async () => {
  const emission = vi.spyOn(binaryEmitter, "emitBinary");
  const { compile } = await import("../src/index.js");
  const source = `
    export function key(n: number): string { return n === 0 ? "a" : n === 1 ? "A" : "!"; }
    export function make(): any {
      const o: any = {}; o[key(0)] = 1; o[key(1)] = 2; o[key(2)] = 3;
      delete o[key(0)]; return o;
    }
    export function read(o: any, k: any): number { return o[k] as number; }
  `;
  const result = await compile(source, {
    fileName: "actual-table-probe.ts",
    target: "standalone",
    nativeStrings: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = emission.mock.calls.at(-1)?.[0];
  if (!module) throw Error("missing actual compiler emission");
  emission.mockRestore();
  // The original artifact runs first. Diagnostic exports below only expose its
  // real bodies/table; no hash, equality, layout or provider is substituted.
  const original = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {});
  const api = original.exports as { key(n: number): unknown; make(): unknown; read(o: unknown, k: unknown): unknown };
  expect(api.read(api.make(), api.key(1))).toBe(2);
  const originalFunctions = structuredClone(module.functions);
  const functionIndex = (name: string) => {
    const matches = module.functions.flatMap((fn, i) => (fn.name === name ? [i] : []));
    expect(matches, name).toHaveLength(1);
    return module.imports.filter((row) => row.desc.kind === "func").length + matches[0]!;
  };
  const structIndex = (name: string) => {
    const index = module.types.findIndex((row) => row.kind === "struct" && row.name === name);
    expect(index, name).toBeGreaterThanOrEqual(0);
    return index;
  };
  const object = structIndex("$Object"),
    entry = structIndex("$PropEntry");
  const map = module.types.findIndex((row) => row.kind === "array" && row.name === "$PropMap");
  expect(map).toBeGreaterThanOrEqual(0);
  const hash = functionIndex("__obj_hash"),
    find = functionIndex("__obj_find");
  const E: ValType = { kind: "externref" },
    I: ValType = { kind: "i32" };
  const objectFromParam = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: object },
  ];
  const table = (): Instr[] => [...objectFromParam(), { op: "struct.get", typeIdx: object, fieldIdx: 1 }];
  const start = (): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: hash },
    ...table(),
    { op: "array.len" },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "i32.and" },
  ];
  const addDiagnostic = (name: string, results: ValType[], body: Instr[]) => {
    const handle = mintDefinedFunc(module);
    const typeIdx = internFunctionType(module.types, new Map(), [E, E], results);
    commitDefinedFuncOrdinal(module, handle);
    appendDefinedFunc(module, { name, typeIdx, locals: [], body, exported: true });
    module.exports.push({ name, desc: { kind: "func", index: handle } });
  };
  addDiagnostic(
    "observe",
    [I, I],
    [
      ...table(),
      { op: "array.len" },
      ...table(),
      ...start(),
      { op: "array.get", typeIdx: map },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: entry, fieldIdx: 2 },
    ],
  );
  addDiagnostic(
    "found",
    [I],
    [
      ...objectFromParam(),
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: find },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
    ],
  );
  addDiagnostic(
    "eraseFirstSlot",
    [],
    [...table(), ...start(), { op: "ref.null", typeIdx: entry }, { op: "array.set", typeIdx: map }],
  );
  module.exports.push({ name: "actualHash", desc: { kind: "func", index: hash } });
  expect(module.functions.slice(0, -3)).toEqual(originalFunctions);
  const diagnostic = new WebAssembly.Module(binaryEmitter.emitBinary(module));
  expect(WebAssembly.Module.imports(diagnostic)).toEqual([]);
  const run = new WebAssembly.Instance(diagnostic, {}).exports as typeof api & {
    actualHash(k: unknown): number;
    observe(o: unknown, k: unknown): number[];
    found(o: unknown, k: unknown): number;
    eraseFirstSlot(o: unknown, k: unknown): void;
  };
  const keys = [0, 1, 2].map((n) => run.key(n)),
    o = run.make();
  const [capacity, flags] = run.observe(o, keys[1]);
  expect(capacity).toBe(8);
  expect(flags & 0x80).toBe(0x80);
  const slots = keys.map((key) => run.actualHash(key) & (capacity! - 1));
  expect(new Set(slots).size).toBe(1);
  expect(run.found(o, keys[0])).toBe(0);
  expect(run.found(o, keys[1])).toBe(1);
  expect(run.read(o, keys[1])).toBe(2);
  // Replacing the measured first tombstone by an empty slot terminates the
  // actual lookup before the still-present next entry: this proves traversal.
  run.eraseFirstSlot(o, keys[1]);
  expect(run.found(o, keys[1])).toBe(0);
});

it("reconstructs every original key donor from the authenticated signed getter/key composition", () => {
  const current = readBeforeResumeMain("src/codegen/object-runtime.ts");
  const restored = verifyObjectRuntimeComposition(current);
  expect(sha(restored.original)).toBe(SOURCE_SHA);
  expect(authenticate(receiptText).spans).toHaveLength(8);
  for (const span of receipt.spans) {
    const original = restored.original.slice(span.start, span.end);
    expect(original, span.name).toBe(span.text);
    expect(sha(original), span.name).toBe(span.sha256);
  }
});
