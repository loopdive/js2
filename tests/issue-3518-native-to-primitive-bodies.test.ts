// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Instr } from "../src/wasm/model/instructions.js";
import * as recipe from "../src/runtime/wasmgc/values/to-primitive-bodies.js";
import { copyToPrimitiveLiteral } from "../src/runtime/wasmgc/values/to-primitive-method-bodies.js";
import { compile } from "../src/index.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const fixtureText = read("tests/fixtures/issue-3518-native-to-primitive-donor.json");
const fixtureHash = "2da520f20060b198ea9c19b7d7d6ef2b49ae0a784c89b3878ce17e66eb2a9b53";
interface Donor {
  path: string;
  gitBlob: string;
  sourceSha256: string;
  scope: string;
  start: number;
  end: number;
  scopeSha256: string;
  text: string;
}
function authenticate(text: string): Donor[] {
  if (sha(text) !== fixtureHash) throw new Error("ToPrimitive donor digest mismatch");
  const f = JSON.parse(text) as { schemaVersion: number; base: string; rows: Donor[] };
  if (f.schemaVersion !== 1 || f.base !== "0ef8e0ea4c23829a4eba37dca6dd6822aa95265e" || f.rows.length !== 3)
    throw new Error("ToPrimitive donor provenance mismatch");
  for (const row of f.rows)
    if (sha(row.text) !== row.scopeSha256 || row.end - row.start !== row.text.length)
      throw new Error("ToPrimitive donor scope mismatch");
  return f.rows;
}
const donors = authenticate(fixtureText);
// The measured extraction remains separate from the forward semantic repair.
// These snapshots do not replace the Git-authenticated donor authority above.
const extractionText = read("tests/fixtures/issue-3518-to-primitive-extraction-baseline.json");
if (sha(extractionText) !== "b9f0e37bc857e1be0e0e5c57c243614ff142de60265de55c6b507242f451be34")
  throw new Error("changed measured extraction baseline");
const extraction = JSON.parse(extractionText) as {
  originalDonorFixtureSha256: string;
  records: { path: string; sha256: string; text: string }[];
};
if (extraction.originalDonorFixtureSha256 !== fixtureHash || extraction.records.length !== 7)
  throw new Error("foreign measured extraction provenance");
const extractionSources = new Map(
  extraction.records.map((row) => {
    if (sha(row.text) !== row.sha256) throw new Error("changed measured extraction source");
    return [row.path, row.text] as const;
  }),
);
const sources = donors.map((d) => extractionSources.get(d.path)!);
const measuredModules = new Map<string, Record<string, unknown>>();
function measuredModule(name: string): Record<string, unknown> {
  const prior = measuredModules.get(name);
  if (prior) return prior;
  const source = extractionSources.get(`src/runtime/wasmgc/values/${name}.ts`);
  if (!source) throw new Error("unrecorded measured module");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Record<string, unknown> = {};
  runInNewContext(output, {
    exports,
    structuredClone,
    require(specifier: string) {
      const match = /^\.\/(to-primitive-(?:method|wrapper)-bodies)\.js$/.exec(specifier);
      if (!match) throw new Error("foreign measured module dependency");
      return measuredModule(match[1]!);
    },
  });
  measuredModules.set(name, exports);
  return exports;
}
const buildToPrimitiveBody = measuredModule("to-primitive-bodies")
  .buildToPrimitiveBody as typeof recipe.buildToPrimitiveBody;
function parse(source: string) {
  const sf = ts.createSourceFile("donor.ts", source, ts.ScriptTarget.Latest, true);
  if (sf.parseDiagnostics.length) throw new Error("invalid donor source");
  return sf;
}
function functionText(source: string, name: string) {
  const sf = parse(source);
  const found = sf.statements.filter(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  if (found.length !== 1) throw new Error(`nonunique function ${name}`);
  const n = found[0]!;
  return { start: n.getStart(sf), end: n.end, text: source.slice(n.getStart(sf), n.end) };
}
function blockSpan(source: string) {
  const sf = parse(source),
    found: ts.Block[] = [];
  function visit(n: ts.Node) {
    if (
      ts.isBlock(n) &&
      n.statements.some(
        (s) =>
          ts.isExpressionStatement(s) &&
          ts.isCallExpression(s.expression) &&
          ts.isIdentifier(s.expression.expression) &&
          s.expression.expression.text === "registerNative" &&
          ts.isStringLiteral(s.expression.arguments[0]!) &&
          s.expression.arguments[0].text === "__to_primitive",
      )
    )
      found.push(n);
    ts.forEachChild(n, visit);
  }
  visit(sf);
  if (found.length !== 1) throw new Error("nonunique ToPrimitive block");
  const block = found[0]!;
  const variable = (name: string) =>
    block.statements.find(
      (s) =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name),
    );
  const first = variable("primitiveTypePredicates"),
    last = variable("body");
  if (!first || !last) throw new Error("missing ToPrimitive body boundary");
  const registration = block.statements.find(
    (s) =>
      ts.isExpressionStatement(s) &&
      ts.isCallExpression(s.expression) &&
      ts.isIdentifier(s.expression.expression) &&
      s.expression.expression.text === "registerNative" &&
      ts.isStringLiteral(s.expression.arguments[0]!) &&
      s.expression.arguments[0].text === "__to_primitive",
  )!;
  return {
    start: block.getStart(sf),
    end: registration.end,
    first: source.lastIndexOf("\n", first.getStart(sf)) + 1,
    last: last.end,
  };
}
function replaceOnce(source: string, old: string, next: string) {
  if (source.split(old).length !== 2) throw new Error("nonunique approved replacement");
  return source.replace(old, next);
}
const oldWrapperImport = `import {
  buildOwnToPrimitiveOverridePresent,
  buildWrapperSlotShortCircuit,
  type ToPrimitiveSlotDeps,
} from "./to-primitive-wrapper-slot.js";`;
const newWrapperImport = `import { captureOwnToPrimitiveOverrideKeys, captureWrapperPrimitiveKey } from "./to-primitive-wrapper-slot.js";`;
const methodTypeImport = `import type {
  ToPrimitiveCoreBindings,
  ToPrimitiveMethodLiterals,
  ToPrimitiveSymbolBindings,
} from "../runtime/wasmgc/values/to-primitive-method-bodies.js";\n`;
const wrapperAdapter = `import type { Instr } from "../wasm/model/instructions.js";
export function captureWrapperPrimitiveKey(wrapperPrimitiveKey: string, stringExtern: (value: string) => Instr[]): readonly Instr[] {
  return stringExtern(wrapperPrimitiveKey);
}
export function captureOwnToPrimitiveOverrideKeys(stringExtern: (value: string) => Instr[]) {
  return { valueOf: stringExtern("valueOf"), toString: stringExtern("toString") };
}`;
const printer = ts.createPrinter({ removeComments: true });
function reconstruct(index: number, source: string): string {
  const donor = donors[index]!;
  if (index === 0) {
    const s = blockSpan(source);
    source = source.slice(0, s.first) + donor.text + source.slice(s.last);
    source = replaceOnce(source, "  captureArgumentsToPrimitiveBindings,", "  buildArgumentsToPrimitiveArm,");
    source = replaceOnce(source, newWrapperImport, oldWrapperImport);
    source = replaceOnce(
      source,
      'import { buildToPrimitiveBody } from "../runtime/wasmgc/values/to-primitive-bodies.js";\n',
      "",
    );
    source = replaceOnce(source, methodTypeImport, "");
  } else if (index === 1) {
    if (printer.printFile(parse(source)) !== printer.printFile(parse(wrapperAdapter)))
      throw new Error("changed wrapper capture adapter");
    source = donor.text;
  } else {
    const span = functionText(source, "captureArgumentsToPrimitiveBindings");
    source = source.slice(0, span.start) + donor.text + source.slice(span.end);
    source = replaceOnce(
      source,
      'import type { ToPrimitiveArgumentsBindings } from "../runtime/wasmgc/values/to-primitive-method-bodies.js";\n',
      "",
    );
  }
  if (sha(source) !== donor.sourceSha256) throw new Error("retained source mismatch");
  return source;
}
const currentSpan = blockSpan(sources[0]!);
const currentBlock = sources[0]!.slice(currentSpan.start, currentSpan.end) + "\n}";
const originalObject = reconstruct(0, sources[0]!);
const oldSpan = blockSpan(originalObject);
const originalBlock = originalObject.slice(oldSpan.start, oldSpan.end) + "\n}";

type TraceOptions = {
  array?: boolean;
  vec?: boolean;
  arrayDriver?: boolean;
  classDriver?: boolean;
  brand?: boolean;
  symbol?: boolean;
  box?: boolean;
  normalization?: boolean;
  primitiveTypes?: boolean;
  mutation?: boolean;
  nested?: boolean;
};
function runTrace(original: boolean, options: TraceOptions = {}, blockOverride?: string, wrapperOverride?: string) {
  const trace: unknown[][] = [],
    registrations: unknown[][] = [];
  const handles = new Map([
    ["__extern_get", 0x40000010],
    ["__extern_has", 0x40000011],
    ["__typeof_number", 0x40000020],
    ["__typeof_string", 0x40000021],
    ["__typeof_boolean", 0x40000022],
    ["__typeof_undefined", 0x40000023],
    ["__typeof_bigint", 0x40000024],
    ["__typeof_function", 0x40000025],
    ["__new_TypeError", 0x40000030],
    ["__nullish_to_null", 0x40000031],
    ["__box_symbol", 0x40000040],
    ["__args_is_branded", 0x40000041],
  ]);
  if (options.brand === false) handles.delete("__args_is_branded");
  if (options.box === false) handles.delete("__box_symbol");
  if (options.normalization === false) handles.delete("__nullish_to_null");
  const ctx = {
    funcMap: {
      get(name: string) {
        const result = handles.get(name);
        trace.push(["get", name, result]);
        return result;
      },
    },
    nativeBoxNumberTypeIdx: options.primitiveTypes === false ? -1 : 111,
    nativeBoxBooleanTypeIdx: options.primitiveTypes === false ? -1 : 112,
    anyStrTypeIdx: options.primitiveTypes === false ? -1 : 113,
    errorStructTypeIdx: options.primitiveTypes === false ? -1 : 114,
  };
  let count = 0;
  const sharedNested: Instr[] = [
    { op: "block", blockType: { kind: "empty" }, body: [{ op: "call", funcIdx: 0x40000700 }] },
  ];
  const operand = (kind: string, text: string): Instr[] => {
    trace.push([kind, text, ++count]);
    if (options.mutation) {
      // Each real acquisition can shift later-needed handles and fields. Already
      // captured numeric operands must keep their original value.
      for (const [name, value] of handles) handles.set(name, value + 7);
      ctx.nativeBoxNumberTypeIdx += 3;
      ctx.nativeBoxBooleanTypeIdx += 3;
      ctx.anyStrTypeIdx += 3;
      ctx.errorStructTypeIdx += 3;
    }
    return options.nested ? sharedNested : [{ op: "global.get", index: 1000 + count }];
  };
  const obtain = (name: string, value: number | undefined) => (actual: typeof ctx) => {
    if (actual !== ctx) throw new Error("foreign context");
    trace.push([name, value]);
    return value;
  };
  const environment = {
    ctx,
    symbolKeysEnabled: options.symbol !== false,
    symbolTypeIdx: 105,
    anyStrTypeIdx: 104,
    objectTypeIdx: 100,
    propEntryTypeIdx: 101,
    strFlattenIdx: 0x40000001,
    strEqualsIdx: 0x40000002,
    objectTerminalAllowsImplicitProtoIdx: 0x40000003,
    objFindIdx: 0x40000004,
    FLAG_INTERNAL: 16,
    objVecNewIdx: 0x40000005,
    objVecPushIdx: 0x40000006,
    WRAPPER_PRIMITIVE_KEY: "[[PrimitiveValue]]",
    addUnionImportsViaRegistry: obtain("union", undefined),
    reserveAccessorGetDriver: obtain("accessor", 0x40000050),
    reserveArgumentsLengthBrand: obtain("arguments", options.array === false ? undefined : 0x40000051),
    getOrRegisterVecBaseType: obtain("vec", options.vec === false ? -1 : 102),
    reserveArrayToPrimitiveString: obtain("array", options.arrayDriver === false ? -1 : 0x40000052),
    reserveClassToPrimitive: obtain("class", options.classDriver === false ? -1 : 0x40000053),
    addStringConstantGlobal: (actual: typeof ctx, value: string) => {
      expect(actual === ctx).toBe(true);
      trace.push(["intern", value]);
    },
    emitWasiErrorConstructor: (actual: typeof ctx, name: string, arity: number) => {
      expect(actual === ctx).toBe(true);
      trace.push(["error", name, arity]);
    },
    ensureExnTag: obtain("tag", 2),
    nativeStringLiteralInstrs: (actual: typeof ctx, text: string) => {
      expect(actual === ctx).toBe(true);
      return operand("native", text);
    },
    stringConstantExternrefInstrs: (actual: typeof ctx, text: string) => {
      expect(actual === ctx).toBe(true);
      return operand("extern", text);
    },
    reserveApplyClosure: (actual: typeof ctx) => {
      expect(actual === ctx).toBe(true);
      trace.push(["apply", 0x40000054]);
      if (options.mutation) for (const [name, value] of handles) handles.set(name, value + 100);
      return 0x40000054;
    },
    buildToPrimitiveBody,
    registerNative: (...args: unknown[]) => registrations.push(args),
  };
  const wrapperSource = wrapperOverride ?? (original ? donors[1]!.text : sources[1]!);
  const wrapper = (
    original
      ? ["buildWrapperSlotShortCircuit", "buildOwnToPrimitiveOverridePresent"]
      : ["captureWrapperPrimitiveKey", "captureOwnToPrimitiveOverrideKeys"]
  )
    .map((name) => functionText(wrapperSource, name).text)
    .join("\n");
  const args = original ? donors[2]!.text : functionText(sources[2]!, "captureArgumentsToPrimitiveBindings").text;
  const brand = functionText(sources[2]!, "buildArgumentsIsBrandedCall").text;
  const script = `${wrapper}\n${args}\n${brand}\nconst IS_BRANDED_NAME = "__args_is_branded";\n${blockOverride ?? (original ? originalBlock : currentBlock)}`;
  const js = ts.transpileModule(script.replace(/\bexport\s+/g, ""), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  new Function(...Object.keys(environment), js)(...Object.values(environment));
  expect(registrations).toHaveLength(1);
  return { trace, registrations, body: registrations[0]![4] as Instr[], sharedNested };
}
function allNodes(value: unknown): object[] {
  if (value === null || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(allNodes)];
}
function assertSameTrace(options: TraceOptions = {}, override?: string) {
  const old = runTrace(true, options),
    current = runTrace(false, options, override);
  expect(current.trace).toEqual(old.trace);
  expect(current.registrations).toEqual(old.registrations);
  return current;
}
afterEach(async () => {
  await setImmediate();
});

describe("C1 historical measured ToPrimitive extraction against signed donor", () => {
  it.each([0, 1, 2])("restores the exact committed whole source for donor %i", (index) => {
    const d = donors[index]!;
    expect(authenticate(fixtureText)[index]).toEqual(d);
    expect(sha(reconstruct(index, sources[index]!))).toBe(d.sourceSha256);
  });
  it("rejects changed fixture bytes without replacing historical authority", () => {
    authenticate(fixtureText);
    expect(() => authenticate(fixtureText.replace("typeofNumberIdx", "typeofWrongIdx"))).toThrow("digest mismatch");
    expect(() => authenticate(fixtureText.replace("0ef8e0ea", "0ef8e0eb"))).toThrow("digest mismatch");
  });
  it.each([
    [0, "const L_ARGS = 6;", "const L_ARGS = 7;"],
    [0, newWrapperImport, newWrapperImport.replace("captureWrapperPrimitiveKey", "wrongWrapperPrimitiveKey")],
    [0, "ToPrimitiveCoreBindings,", "ToPrimitiveCoreBindings as OtherCore,"],
    [1, 'stringExtern("valueOf")', 'stringExtern("toString")'],
    [2, 'const ABSENT_NAME = "__args_len_absent";', 'const ABSENT_NAME = "__wrong_absent";'],
  ] as const)("rejects retained source or adapter import corruption %i %s", (index, old, changed) => {
    reconstruct(index, sources[index]!);
    expect(() => reconstruct(index, replaceOnce(sources[index]!, old, changed))).toThrow();
  });
  it.each([
    ["all branches", {}],
    ["no arrays", { array: false }],
    ["no vec type", { vec: false }],
    ["no array driver", { arrayDriver: false }],
    ["no class driver", { classDriver: false }],
    ["no arguments brand", { brand: false }],
    ["Symbol disabled", { symbol: false }],
    ["no Symbol boxer", { box: false }],
    ["no nullish normalizer", { normalization: false }],
    ["no boxed input types", { primitiveTypes: false }],
    ["minimum historical branch set", { array: false, symbol: false, normalization: false, primitiveTypes: false }],
    ["acquisitions mutate later handles and types", { mutation: true }],
    ["mutations without arguments brand", { mutation: true, brand: false }],
    ["mutations without Symbol boxer", { mutation: true, box: false }],
    ["mutations without arrays", { mutation: true, array: false }],
    ["same nested literal response at every occurrence", { nested: true }],
  ] satisfies [string, TraceOptions][])(
    "preserves full body, registration and acquisition trace: %s",
    (_name, options) => {
      assertSameTrace(options);
    },
  );
  it.each([
    [
      "earlier Symbol lookup",
      'const boxSymbolIdx = ctx.funcMap.get("__box_symbol");',
      "const boxSymbolIdx = earlyBox;",
      "const inputTypes = {",
      'const earlyBox = ctx.funcMap.get("__box_symbol"); const inputTypes = {',
    ],
    ["wrong captured method handle", "callMethod0Idx,", "callMethod0Idx: externGetIdx,", "", ""],
    ["wrong input type", "boolean: ctx.nativeBoxBooleanTypeIdx,", "boolean: ctx.nativeBoxNumberTypeIdx,", "", ""],
    [
      "reversed ordinary method order",
      '[captureMethod("toString", true), captureMethod("valueOf", false)]',
      '[captureMethod("valueOf", false), captureMethod("toString", true)]',
      "",
      "",
    ],
    [
      "dropped class branch",
      "classToPrimIdx,\n            arguments:",
      "classToPrimIdx: -1,\n            arguments:",
      "",
      "",
    ],
  ] as const)("positive-first donor equality rejects %s", (_name, old, changed, before, after) => {
    assertSameTrace({ mutation: true });
    let mutant = replaceOnce(currentBlock, old, changed);
    if (before) mutant = replaceOnce(mutant, before, after);
    const original = runTrace(true, { mutation: true }),
      actual = runTrace(false, { mutation: true }, mutant);
    expect({ trace: actual.trace, body: actual.body }).not.toEqual({ trace: original.trace, body: original.body });
  });
  it("clones a reused nested operand graph at every emitted occurrence", () => {
    const result = assertSameTrace({ nested: true });
    const nodes = allNodes(result.body);
    expect(new Set(nodes).size).toBe(nodes.length);
    for (const node of allNodes(result.sharedNested))
      expect(nodes.some((actual) => Object.is(actual, node))).toBe(false);
    const literals = nodes.filter((n): n is Extract<Instr, { op: "block" }> => "op" in n && n.op === "block");
    expect(literals.length).toBeGreaterThan(10);
    const before = structuredClone(literals[1]);
    (literals[0]!.body[0] as Extract<Instr, { op: "call" }>).funcIdx++;
    expect(literals[1]).toEqual(before);
    expect(result.sharedNested[0]).toEqual(before);
  });
  it("positive-first control exposes a shallow nested-literal copy", () => {
    const nested: Instr[] = [
      { op: "block", blockType: { kind: "empty" }, body: [{ op: "call", funcIdx: 0x40000001 }] },
    ];
    const first = copyToPrimitiveLiteral(nested),
      second = copyToPrimitiveLiteral(nested);
    expect(first).toEqual(second);
    expect(allNodes(first).some((a) => allNodes(second).some((b) => Object.is(a, b)))).toBe(false);
    const shallowA = nested.map((i) => ({ ...i })),
      shallowB = nested.map((i) => ({ ...i }));
    expect(allNodes(shallowA).some((a) => allNodes(shallowB).some((b) => Object.is(a, b)))).toBe(true);
  });
  it("keeps every pure runtime dependency below codegen and accepts no callback authority", () => {
    for (const file of ["to-primitive-bodies", "to-primitive-method-bodies", "to-primitive-wrapper-bodies"]) {
      const sf = parse(read(`src/runtime/wasmgc/values/${file}.ts`));
      for (const n of sf.statements.filter(ts.isImportDeclaration)) {
        expect(n.attributes).toBeUndefined();
        expect((n.moduleSpecifier as ts.StringLiteral).text).toMatch(
          /^(?:\.\.\/\.\.\/\.\.\/wasm\/model\/instructions|\.\/to-primitive-(?:method|wrapper)-bodies)\.js$/,
        );
      }
      const callbacks: ts.Node[] = [];
      function visit(n: ts.Node) {
        if (ts.isFunctionTypeNode(n)) callbacks.push(n);
        ts.forEachChild(n, visit);
      }
      visit(sf);
      expect(callbacks).toHaveLength(0);
    }
  });
});

/** Real compiler route: these modules invoke the relocated body through the
 * unchanged legacy reservation/finalization path. This is not C1/C2 ownership. */
type Completion =
  | { kind: "return"; value: number }
  | { kind: "throw"; name: string }
  | { kind: "unclassified-wasm-throw"; name: string; message: string };
function nativeExports(source: string): Record<string, (seed?: number) => number> {
  const exports = {};
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(js, { exports });
  return exports;
}
function nativeCompletion(source: string, seed: number): Completion {
  try {
    return { kind: "return", value: nativeExports(source).run!(seed) };
  } catch (error) {
    return { kind: "throw", name: String((error as { name?: unknown })?.name) };
  }
}
// A transparent observation wrapper leaves each exact case source intact. It
// classifies the one uncaught error family in these cases inside Wasm, where
// the actual native Error carrier is available. Unknown throws/traps stay loud.
const completionObserver = `
let __c1_observed_value = 0;
export function __c1_observe(seed: number): number {
  try { __c1_observed_value = run(seed); return 1; }
  catch (error) { if (error instanceof TypeError) return 2; throw error; }
}
export function __c1_value(): number { return __c1_observed_value; }
`;
function observedCompletion(exports: Record<string, (seed?: number) => number>, seed: number): Completion {
  try {
    const kind = exports.__c1_observe!(seed);
    if (kind === 1) return { kind: "return", value: exports.__c1_value!() };
    if (kind === 2) return { kind: "throw", name: "TypeError" };
    throw new Error(`unknown completion kind ${kind}`);
  } catch (error) {
    return {
      kind: "unclassified-wasm-throw",
      name: String((error as Error)?.name),
      message: String((error as Error)?.message),
    };
  }
}
async function execute(source: string) {
  const wrapped = source + completionObserver;
  const native = nativeCompletion(source, 7);
  expect(observedCompletion(nativeExports(wrapped), 7)).toEqual(native);
  const result = await compile(wrapped, { target: "standalone", fileName: "to-primitive-connected.ts", emitWat: true });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  const actual = observedCompletion(instance.exports as Record<string, (seed?: number) => number>, 7);
  console.info("ToPrimitive completion", JSON.stringify({ sourceSha256: sha(source), native, actual }));
  expect(actual, JSON.stringify({ sourceSha256: sha(source), native, actual })).toEqual(native);
}
// The original manual expectations are archived in the local review receipt.
// Every current expected completion comes from the exact native Node fixture.
const connected: [string, string][] = [
  [
    "inherited Symbol getter, original receiver, string hint and real hash/find",
    `
    export function run(seed: number): number {
      const proto: any = {}; let calls=0; let hints=0; let receivers=0;
      const key: any = Object.create(proto); key.prefix = "key";
      Object.defineProperty(proto, Symbol.toPrimitive, {get:function():any {
        calls++; if(this===key) receivers++;
        return function(h:any):any { if(this===key) receivers++; if(h==="string") hints++; return this.prefix+seed; };
      }});
      const bag:any={}; bag[key]=31; const found=bag[key];
      return found===31 && calls===2 && hints===2 && receivers===4 ? 1:0;
    }`,
  ],
  [
    "Symbol result keeps identity through real property-key lookup",
    `
    export function run(seed:number):number {
      const symbol:any=Symbol("key"); const key:any={}; let calls=0;
      key[Symbol.toPrimitive]=function(h:any):any { calls++; return symbol; };
      const bag:any={};bag[key]=seed; return bag[symbol]===seed && calls===1 ? 1:0;
    }`,
  ],
  [
    "default and string hints remain distinct and methods receive the input",
    `
    export function run(seed:number):number {
      const x:any={n:seed};let defaults=0;let strings=0;let receivers=0;
      x[Symbol.toPrimitive]=function(h:any):any { if(this===x)receivers++; if(h==="default")defaults++;if(h==="string")strings++;return h==="string"?"K":this.n;};
      const n=x+1;const text=String(x);return n===seed+1 && text==="K" && defaults===1 && strings===1 && receivers===2 ? 1:0;
    }`,
  ],
  [
    "inherited getter exception precedes all fallback calls",
    `
    export function run(seed:number):number {
      const abrupt:any={value:seed};const proto:any={};let gets=0;let fallback=0;
      Object.defineProperty(proto,Symbol.toPrimitive,{get:function():any {gets++;throw abrupt;}});
      proto.toString=function():any{fallback++;return "bad";};const key:any=Object.create(proto);
      try {const bag:any={};bag[key]=1;return 0;} catch(e:any){return e===abrupt && gets===1 && fallback===0 ? 1:0;}
    }`,
  ],
  [
    "noncallable Symbol method throws before ordinary fallback",
    `
    export function run(seed:number):number {const x:any={};let fallback=0;x[Symbol.toPrimitive]=seed;x.valueOf=function():any{fallback++;return 1;};try{return +x;}catch(e:any){return e instanceof TypeError && fallback===0 ? 1:0;}}
  `,
  ],
  [
    "nonprimitive Symbol result throws exactly after one call",
    `
    export function run(seed:number):number {const x:any={};let calls=0;let fallback=0;x[Symbol.toPrimitive]=function():any{calls++;return {n:seed};};x.valueOf=function():any{fallback++;return 1;};try{return +x;}catch(e:any){return e instanceof TypeError && calls===1 && fallback===0 ? 1:0;}}
  `,
  ],
  [
    "undefined is a primitive method result, not absence",
    `
    export function run(seed:number):number {const x:any={};let first=0;let second=0;x.valueOf=function():any{first++;return undefined;};x.toString=function():any{second++;return "wrong";};const v=x+seed;return v!==v && first===1 && second===0 ? 1:0;}
  `,
  ],
  [
    "null is a primitive method result",
    `
    export function run(seed:number):number {const x:any={};let calls=0;x.valueOf=function():any{calls++;return null;};x.toString=function():any{return "wrong";};return x*seed===0 && calls===1 ? 1:0;}
  `,
  ],
  [
    "wrapper own overrides and two object-returning own methods",
    `
    export function run(seed:number):number {const a:any=new Number(seed);let calls=0;a.valueOf=function():any{calls++;return seed+1;};const first=a*2;const b:any=new Number(seed);b.valueOf=function():any{return {};};b.toString=function():any{return {};};return first===(seed+1)*2 && b*2===seed*2 && calls===1 ? 1:0;}
  `,
  ],
  [
    "array and nominal class conversion retain their distinct drivers",
    `
    class Value {n:number;constructor(n:number){this.n=n;}valueOf():number{return this.n+1;}}
    function reduce(x:any):number{return x*2;}
    export function run(seed:number):number {const a:any=[seed];return reduce(a)===seed*2 && reduce(new Value(seed))===(seed+1)*2 ? 1:0;}
  `,
  ],
  [
    "null and undefined inputs remain primitive identities",
    `
    function reduce(x:any):number{return x*2;}
    export function run(seed:number):number {const nullResult=reduce(null);const undefResult=reduce(undefined);return nullResult===0 && undefResult!==undefResult && seed===7 ? 1:0;}
  `,
  ],
  [
    "ordinary method getter order follows the requested hint",
    `
    export function run(seed:number):number {const x:any={};let log="";Object.defineProperty(x,"valueOf",{get:function():any{log=log+"v";return function():any{return seed;};}});Object.defineProperty(x,"toString",{get:function():any{log=log+"s";return function():any{return "K";};}});const number=x*2;const text=String(x);return number===seed*2 && text==="K" && log==="vs" ? 1:0;}
  `,
  ],
];
describe("C1 ToPrimitive connected legacy emitted-Wasm behavior", () => {
  it.each(connected)("%s", async (_name, source) => {
    await execute(source);
  });
});

it("the actual emitted ToPrimitive body executes: positive first, then a test-only poison prefix", async () => {
  const source = `function reduce(value:any):number {return value*2;} export function run(seed:number):number {const object:any={};object.valueOf=function():number{return seed;};return reduce(object);}`;
  const native = nativeCompletion(source, 7);
  expect(native).toEqual({ kind: "return", value: 14 });
  const control = await compile(source, { target: "standalone", fileName: "to-primitive-live-control.ts" });
  expect(control.success, JSON.stringify(control.errors)).toBe(true);
  const live = new WebAssembly.Instance(new WebAssembly.Module(control.binary), {});
  expect((live.exports.run as (seed: number) => number)(7)).toBe(14);
  const original = recipe.buildToPrimitiveBody;
  const spy = vi
    .spyOn(recipe, "buildToPrimitiveBody")
    .mockImplementation((bindings) => [{ op: "unreachable" }, ...original(bindings)]);
  try {
    const poisoned = await compile(source, { target: "standalone", fileName: "to-primitive-live-control.ts" });
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(poisoned.success, JSON.stringify(poisoned.errors)).toBe(true);
    expect(WebAssembly.validate(poisoned.binary)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(poisoned.binary), {});
    expect(() => (instance.exports.run as (seed: number) => number)(7)).toThrow(/unreachable/);
  } finally {
    spy.mockRestore();
  }
});
