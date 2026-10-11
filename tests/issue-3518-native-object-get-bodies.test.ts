// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import { createHash } from "node:crypto";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createEmptyModule, type Instr, type LocalDef, type ValType } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import * as arms from "../src/runtime/wasmgc/values/object-get-arms.js";
import { buildObjectGetBody, type ObjectGetBindings } from "../src/runtime/wasmgc/values/object-get-bodies.js";
import {
  authenticateObjectRuntimeComposition,
  invertObjectRuntimePeer,
  objectRuntimeCompositionText,
  verifyHistoricalObjectRuntimeComposition,
  verifyObjectRuntimeComposition,
} from "./helpers/object-get-key-composition.js";
import {
  authenticatedProtoIndexReadSource,
  invertConversionSource,
  protoIndexStorePath,
} from "./helpers/conversion-source-composition.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const read = readBeforeResumeMain;
const fixtureText = read("tests/fixtures/issue-3518-native-object-get-donor.json");
const fixtureHash = "ba22b31f3a4b283f044beaf13b07bb8f4fc36e39e40a003f3df17fd4cde8e065";
interface Donor {
  file: string;
  name: string;
  text: string;
  sha256: string;
  scopeSha256: string;
  gitBlob: string;
}
function authenticate(text: string) {
  if (sha(text) !== fixtureHash) throw new Error("object get donor digest mismatch");
  const parsed = JSON.parse(text) as { base: string; records: Donor[] };
  if (parsed.base !== "750fb7e7365692b315179dc909b57fa1407d4527" || parsed.records.length !== 8)
    throw new Error("object get donor provenance mismatch");
  for (const record of parsed.records)
    if (sha(record.text) !== record.scopeSha256) throw new Error("donor scope mismatch");
  return parsed.records;
}
const donors = authenticate(fixtureText);
const captures = [
  undefined,
  "captureTemplateRawReadBinding",
  "captureInstanceReadBinding",
  "captureVecOrClosureReadBinding",
  "captureClosureReadBinding",
  "captureProtoIndexReadBinding",
  "captureGeneratorReadBinding",
  "captureReversePeerReadBinding",
];
const runtimeImports = [
  ["buildObjectGetBody"],
  ["TemplateRawReadBinding"],
  ["InstanceReadBinding"],
  ["VecOrClosureReadBinding"],
  ["ClosureReadBinding"],
  ["buildProtoIndexRead", "ProtoIndexReadBinding"],
  ["GeneratorReadBinding"],
  ["ReversePeerReadBinding"],
];
const importRewrites: Record<number, [string, string][]> = {
  0: [
    ["buildInstancePropGetArm,", "captureInstanceReadBinding,"],
    ["buildVecOrClosurePropGetMissArm,", "captureVecOrClosureReadBinding,"],
    ["protoIndexRecvGetMissInstrs,", "captureProtoIndexReadBinding,"],
    ["reverseGetArmInstrs,", "captureReversePeerReadBinding,"],
    ["import { buildTemplateRawGetArm }", "import { captureTemplateRawReadBinding }"],
    [
      "const templateRawGetArm = buildTemplateRawGetArm(ctx, ctx.templateVecTypeIdx, strFlattenIdx, strEqualsIdx);",
      "const templateRawReadBinding = captureTemplateRawReadBinding(\n    ctx,\n    ctx.templateVecTypeIdx,\n    strFlattenIdx,\n    strEqualsIdx,\n  );",
    ],
  ],
  2: [
    [
      'import {\n  reserveNativeGeneratorProtocolLookup,\n  nativeGeneratorProtocolReadPrefix,\n} from "./generators-native-protocol.js";',
      'import { reserveNativeGeneratorProtocolLookup, captureGeneratorReadBinding } from "./generators-native-protocol.js";',
    ],
  ],
  3: [["buildClosurePropGetMissArm,", "captureClosureReadBinding,"]],
  4: [
    ["import { protoIndexRecvGetMissInstrs }", "import { captureProtoIndexReadBinding, protoIndexRecvGetMissInstrs }"],
  ],
};
function parse(source: string) {
  const sf = ts.createSourceFile("donor.ts", source, ts.ScriptTarget.Latest, true);
  if (sf.parseDiagnostics.length) throw new Error("invalid donor source");
  return sf;
}
function scope(source: string, name: string) {
  const sf = parse(source);
  const nodes: ts.Node[] = [];
  function visit(n: ts.Node) {
    if (name === "initialExternGetBlock") {
      if (
        ts.isBlock(n) &&
        n.statements.some(
          (s) =>
            ts.isVariableStatement(s) &&
            s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === "callAccessorGetIdx"),
        )
      )
        nodes.push(n);
    } else if (ts.isFunctionDeclaration(n) && n.name?.text === name) nodes.push(n);
    ts.forEachChild(n, visit);
  }
  visit(sf);
  if (nodes.length !== 1) throw new Error(`expected one ${name}, got ${nodes.length}`);
  return { start: nodes[0]!.getStart(sf), end: nodes[0]!.end };
}
function functionText(source: string, name: string) {
  const s = scope(source, name);
  return source.slice(s.start, s.end);
}
function reconstruct(source: string, index: number) {
  if (index === 0) source = invertObjectRuntimePeer(source, "key");
  if (index === 5) source = invertConversionSource(protoIndexStorePath, source);
  return reconstructDonorSource(source, index);
}
// Historical mutations use a source obtained from the current candidate's exact inverse.
function reconstructDonorSource(source: string, index: number) {
  const donor = donors[index]!;
  const span = scope(source, index === 0 || index === 5 ? donor.name : captures[index]!);
  let end = span.end;
  if (index === 5) {
    const capture = scope(source, captures[index]!);
    if (capture.start < end || !/^(\s|\/\*[\s\S]*?\*\/)*$/.test(source.slice(end, capture.start)))
      throw new Error("noncontiguous capture adapter");
    end = capture.end;
  }
  source = source.slice(0, span.start) + donor.text + source.slice(end);
  const sf = parse(source);
  const imports = sf.statements.filter(
    (n): n is ts.ImportDeclaration =>
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      n.moduleSpecifier.text.startsWith("../runtime/wasmgc/values/object-get-"),
  );
  if (imports.length !== 1) throw new Error("runtime import count mismatch");
  const imported = imports[0]!;
  const expectedModule =
    index === 0 ? "../runtime/wasmgc/values/object-get-bodies.js" : "../runtime/wasmgc/values/object-get-arms.js";
  const clause = imported.importClause;
  if (
    (imported.moduleSpecifier as ts.StringLiteral).text !== expectedModule ||
    imported.attributes ||
    !clause ||
    clause.isTypeOnly !== (index !== 0 && index !== 5) ||
    clause.name ||
    !clause.namedBindings ||
    !ts.isNamedImports(clause.namedBindings) ||
    clause.namedBindings.elements.some((n) => n.propertyName) ||
    JSON.stringify(clause.namedBindings.elements.map((n) => n.name.text).sort()) !==
      JSON.stringify([...runtimeImports[index]!].sort())
  )
    throw new Error("runtime import contract mismatch");
  const importEnd = imported.end + (source[imported.end] === "\n" ? 1 : 0);
  source = source.slice(0, imported.getStart(sf)) + source.slice(importEnd);
  for (const [before, after] of importRewrites[index] ?? []) {
    if (source.split(after).length !== 2) throw new Error("adapter import/site mismatch");
    source = source.replace(after, before);
  }
  if (sha(source) !== donor.sha256) throw new Error("source outside owned donor changed");
  return source;
}

const constants = {
  IS_INSTANCE_EXPANDO_CARRIER: "__is_instance_expando_carrier",
  INSTANCE_PROP_GET: "__instance_prop_get",
  IS_VEC_PROP_CARRIER: "__is_vec_prop_carrier",
  VEC_PROP_GET: "__vec_prop_get",
  CLOSURE_PROP_GET: "__closure_prop_get",
  IS_CLOSURE_PROP_CARRIER: "__is_closure_prop_carrier",
  PROTOIDX_GET_R: "__protoidx_get_r",
  PROTOIDX_GET_K: "__protoidx_get_k",
  PROTOIDX_BRAND_OFF: "__protoidx_brand_off",
  NATIVE_GENERATOR_PROTOCOL_GET: "__native_generator_protocol_get",
};
interface TraceOptions {
  cache?: boolean;
  fnctor?: boolean;
  companion?: boolean;
  split?: boolean;
  instance?: boolean;
  generator?: boolean;
  closure?: boolean;
  closureTest?: boolean;
  vector?: boolean;
  metadata?: boolean;
  template?: boolean;
  boundary?: "host" | "peer" | "both" | "reverse" | "reverse-no-owned";
  singleton?: boolean;
  mutation?: boolean;
  reverseGlobal?: number;
  flatten?: boolean;
  equals?: boolean;
  missing?: string[];
}
interface CapturedFunction {
  name: string;
  params: ValType[];
  results: ValType[];
  locals: LocalDef[];
  body: Instr[];
}
function traceGetter(current: boolean, opts: TraceOptions, mutate?: (source: string) => string) {
  const trace: unknown[][] = [];
  const funcs = new Map(Object.values(constants).map((name, i) => [name, 0x40000040 + i]));
  const groups: [keyof TraceOptions, string[]][] = [
    ["instance", [constants.IS_INSTANCE_EXPANDO_CARRIER, constants.INSTANCE_PROP_GET]],
    ["generator", [constants.NATIVE_GENERATOR_PROTOCOL_GET]],
    ["closure", [constants.CLOSURE_PROP_GET]],
    ["closureTest", [constants.IS_CLOSURE_PROP_CARRIER]],
    ["vector", [constants.IS_VEC_PROP_CARRIER, constants.VEC_PROP_GET]],
    ["companion", [constants.PROTOIDX_GET_R]],
    ["split", [constants.PROTOIDX_GET_K, constants.PROTOIDX_BRAND_OFF]],
  ];
  for (const [option, names] of groups) if (opts[option] === false) for (const name of names) funcs.delete(name);
  for (const name of opts.missing ?? []) funcs.delete(name);
  let undefinedCalls = 0;
  const shared: Instr[] = [{ op: "global.get", index: 301 }, { op: "extern.convert_any" }];
  const ctx = {
    anyStrTypeIdx: 20,
    hashedStrTypeIdx: 23,
    templateVecTypeIdx: opts.template === false ? -1 : 24,
    funcMap: {
      get(name: string) {
        const value = funcs.get(name);
        trace.push(["get", name, value]);
        return value;
      },
    },
  };
  let captured: CapturedFunction | undefined;
  const undefinedExternInstrs = (received: typeof ctx) => {
    expect(received).toBe(ctx);
    trace.push(["undefined", ++undefinedCalls]);
    if (opts.mutation) {
      for (const [name, value] of funcs) funcs.set(name, value + 100);
      ctx.hashedStrTypeIdx++;
      shared.push({ op: "nop" });
    }
    return opts.singleton === false ? undefined : shared;
  };
  const helpers = donors
    .slice(1)
    .map((donor, i) =>
      current
        ? (i + 1 === 5 ? functionText(authenticatedProtoIndexReadSource(), donor.name) + "\n" : "") +
          functionText(i + 1 === 5 ? authenticatedProtoIndexReadSource() : read(donor.file), captures[i + 1]!)
        : donor.text,
    )
    .join("\n")
    .replace(/export function /g, "function ");
  let block = current ? functionText(read(donors[0]!.file), donors[0]!.name) : donors[0]!.text;
  if (mutate) block = mutate(block);
  const source =
    helpers +
    "\nfunction run() {\n" +
    (current
      ? "const templateRawReadBinding = captureTemplateRawReadBinding(ctx, ctx.templateVecTypeIdx, strFlattenIdx, strEqualsIdx);"
      : "const templateRawGetArm = buildTemplateRawGetArm(ctx, ctx.templateVecTypeIdx, strFlattenIdx, strEqualsIdx);") +
    "\n" +
    block +
    "\n}\nrun();";
  const bindings = {
    ...constants,
    ...arms,
    buildObjectGetBody,
    ctx,
    undefinedExternInstrs,
    load: (index: number): Instr => ({ op: "local.get", index }),
    nativeStringLiteralInstrs: (received: typeof ctx, value: string): Instr[] => {
      expect(received).toBe(ctx);
      trace.push(["literal", value, ctx.anyStrTypeIdx]);
      ctx.anyStrTypeIdx = 88;
      return [{ op: "global.get", index: 302 }];
    },
    reserveAccessorGetDriver: (received: typeof ctx) => {
      expect(received).toBe(ctx);
      trace.push(["reserveAccessor"]);
      return 0x40000100;
    },
    registerNative: (name: string, params: ValType[], results: ValType[], locals: LocalDef[], body: Instr[]) => {
      expect(captured).toBeUndefined();
      captured = { name, params, results, locals, body };
      trace.push(["register", name]);
      return 0x40000200;
    },
    strFlattenIdx: opts.flatten === false ? undefined : 0x40000101,
    strEqualsIdx: opts.equals === false ? undefined : 0x40000102,
    objectTypeIdx: 17,
    propEntryTypeIdx: 18,
    objFindIdx: 0x40000103,
    objectTerminalAllowsImplicitProtoIdx: 0x40000104,
    FLAG_ACCESSOR: 8,
    reflectGetReceiverActiveGlobalIdx: 11,
    reflectGetReceiverGlobalIdx: 12,
    protoCacheEnabled: opts.cache !== false,
    fnctorProtoStartIdx: opts.fnctor === false ? undefined : 0x40000105,
    bfnGetMetaIdx: opts.metadata === false ? undefined : 0x40000106,
    boundaryObjectGetIdx: opts.boundary === "host" || opts.boundary === "both" ? 0x40000107 : undefined,
    peerMemberGetIdx: opts.boundary === "peer" || opts.boundary === "both" ? 0x40000108 : undefined,
    reversePeerHops: {
      get: opts.boundary?.startsWith("reverse") ? 0x40000109 : undefined,
      ownedGlobal: opts.boundary === "reverse" ? (opts.reverseGlobal ?? 13) : undefined,
    },
    objRefNull: { kind: "ref_null", typeIdx: 17 },
    entryRefNull: { kind: "ref_null", typeIdx: 18 },
  };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  new Function(...Object.keys(bindings), js)(...Object.values(bindings));
  expect(captured).toBeDefined();
  return { captured: captured!, trace, undefinedCalls, shared };
}

const E = { kind: "externref" } as const,
  I = { kind: "i32" } as const,
  A = { kind: "anyref" } as const;
const load = (index: number): Instr => ({ op: "local.get", index });
const int = (value: number): Instr => ({ op: "i32.const", value });
const ref = (typeIdx: number): ValType => ({ kind: "ref", typeIdx });
const nullable = (typeIdx: number): ValType => ({ kind: "ref_null", typeIdx });
interface RuntimeOptions {
  cache?: boolean;
  companion?: boolean;
  fnctor?: boolean;
  metadata?: boolean;
  boundary?: boolean;
  reverse?: boolean;
  instance?: boolean;
  generator?: boolean;
  vector?: boolean;
  closure?: boolean;
}
function executable(opts: RuntimeOptions = {}, mutate?: (body: Instr[], d: ObjectGetBindings) => void) {
  // Actual WasmGC objects, property storage and body execution. Imported functions
  // are explicit observable fixture dependencies, not issued native resource packs.
  const mod = createEmptyModule();
  mod.types.push(
    {
      kind: "struct",
      name: "$Entry",
      fields: [A, A, I, I, A, A].map((type, i) => ({ name: `f${i}`, type, mutable: true })),
    },
    { kind: "array", name: "$Props", element: nullable(0), mutable: true },
    {
      kind: "struct",
      name: "$Object",
      fields: [nullable(2), ref(1), I, I, I, I].map((type, i) => ({ name: `f${i}`, type, mutable: true })),
    },
    {
      kind: "struct",
      name: "$Hash",
      fields: [I, I, I, I, I, nullable(2), nullable(0), nullable(1)].map((type, i) => ({
        name: `f${i}`,
        type,
        mutable: true,
      })),
    },
  );
  const active = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  const receiver = new WebAssembly.Global({ value: "externref", mutable: true }, null);
  const undefinedValue = new WebAssembly.Global({ value: "externref", mutable: false }, undefined);
  const owned = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  const observations: unknown[][] = [];
  const state = {
    metadata: null as unknown,
    boundary: null as unknown,
    reverse: null as unknown,
    reverseOwned: 0,
    instance: null as unknown,
    generator: undefined as unknown,
    generatorHandled: false,
    vector: undefined as unknown,
    closure: undefined as unknown,
    prototype: null as unknown,
    companion: undefined as unknown,
    implicitAllowed: true,
  };
  const controls: Record<string, unknown> = { active, receiver, undefinedValue, owned };
  for (const [name, type, mutable] of [
    ["active", I, true],
    ["receiver", E, true],
    ["undefinedValue", E, false],
    ["owned", I, true],
  ] as const)
    mod.imports.push({ module: "control", name, desc: { kind: "global", type, mutable } });
  let importedFunctions = 0;
  function imported(name: string, params: ValType[], results: ValType[], fn: (...args: unknown[]) => unknown) {
    const typeIdx = mod.types.length;
    mod.types.push({ kind: "func", params, results });
    mod.imports.push({ module: "control", name, desc: { kind: "func", typeIdx } });
    controls[name] = (...args: unknown[]) => {
      observations.push([name, ...args]);
      return fn(...args);
    };
    return importedFunctions++;
  }
  const eq = imported("keyEqual", [E, E], [I], (a, b) => (Object.is(a, b) ? 1 : 0));
  const accessor = imported("accessor", [E, E], [E], (recv, fn) => {
    observations.push(["active-at-getter", active.value]);
    if (typeof fn !== "function") throw new Error("fixture accessor is not callable");
    return Reflect.apply(fn, recv, []);
  });
  const metadata = imported("metadata", [E, E], [E], () => state.metadata);
  const boundary = imported("boundary", [E, E], [E], () => state.boundary);
  const reverse = imported("reverse", [E, E], [E], () => {
    owned.value = state.reverseOwned;
    return state.reverse;
  });
  const instanceIs = imported("instanceIs", [E], [I], () => 1);
  const instanceGet = imported("instanceGet", [E, E], [E], () => state.instance);
  const generatorGet = imported("generatorGet", [E, E], [I, E], () => [
    state.generatorHandled ? 1 : 0,
    state.generator,
  ]);
  const vectorIs = imported("vectorIs", [E], [I], () => 1);
  const vectorGet = imported("vectorGet", [E, E], [E], () => state.vector);
  const closureGet = imported("closureGet", [E, E], [E], () => state.closure);
  const protoStart = imported("protoStart", [E], [E], () => state.prototype);
  const brandOffset = imported("brandOffset", [E], [I], () => 42);
  const companion = imported("companion", [E, E, I], [E], () => state.companion);
  const terminal = imported("terminal", [nullable(2)], [I], () => (state.implicitAllowed ? 1 : 0));
  function define(name: string, params: ValType[], results: ValType[], locals: LocalDef[], body: Instr[]) {
    const index = importedFunctions + mod.functions.length,
      typeIdx = mod.types.length;
    mod.types.push({ kind: "func", params, results });
    mod.functions.push({ name, typeIdx, locals, body, exported: true });
    mod.exports.push({ name, desc: { kind: "func", index } });
    return index;
  }
  const find = define(
    "find",
    [ref(2), E],
    [nullable(0)],
    [{ name: "entry", type: nullable(0) }],
    [
      load(0),
      { op: "struct.get", typeIdx: 2, fieldIdx: 1 },
      int(0),
      { op: "array.get", typeIdx: 1 },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null", typeIdx: 0 }, { op: "return" }] },
      load(2),
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: 0, fieldIdx: 2 },
      int(128),
      { op: "i32.and" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null", typeIdx: 0 }, { op: "return" }] },
      load(2),
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: 0, fieldIdx: 0 },
      { op: "extern.convert_any" },
      load(1),
      { op: "call", funcIdx: eq },
      {
        op: "if",
        blockType: { kind: "val", type: nullable(0) },
        then: [load(2)],
        else: [{ op: "ref.null", typeIdx: 0 }],
      },
    ],
  );
  define(
    "make",
    [E, E, E, E, I],
    [E],
    [],
    [
      load(0),
      { op: "any.convert_extern" },
      { op: "ref.cast_null", typeIdx: 2 },
      load(1),
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: nullable(0) },
        then: [{ op: "ref.null", typeIdx: 0 }],
        else: [
          load(1),
          { op: "any.convert_extern" },
          load(2),
          { op: "any.convert_extern" },
          load(4),
          int(0),
          load(3),
          { op: "any.convert_extern" },
          { op: "ref.null", typeIdx: -18 },
          { op: "struct.new", typeIdx: 0 },
        ],
      },
      { op: "array.new_fixed", typeIdx: 1, length: 1 },
      int(1),
      int(0),
      int(0),
      int(0),
      { op: "struct.new", typeIdx: 2 },
      { op: "extern.convert_any" },
    ],
  );
  define(
    "hash",
    [],
    [E],
    [],
    [
      int(0),
      int(0),
      int(0),
      int(0),
      int(0),
      { op: "ref.null", typeIdx: 2 },
      { op: "ref.null", typeIdx: 0 },
      { op: "ref.null", typeIdx: 1 },
      { op: "struct.new", typeIdx: 3 },
      { op: "extern.convert_any" },
    ],
  );
  for (const [name, index, result] of [
    ["cacheFlag", 4, I],
    ["cacheOwner", 5, E],
    ["cacheEntry", 6, E],
    ["cacheProps", 7, E],
  ] as const)
    define(
      name,
      [E],
      [result],
      [],
      [
        load(0),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: 3 },
        { op: "struct.get", typeIdx: 3, fieldIdx: index },
        ...(result.kind === "externref" ? [{ op: "extern.convert_any" } as const] : []),
      ],
    );
  define(
    "ownProps",
    [E],
    [E],
    [],
    [
      load(0),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: 2 },
      { op: "struct.get", typeIdx: 2, fieldIdx: 1 },
      { op: "extern.convert_any" },
    ],
  );
  define(
    "ownEntry",
    [E],
    [E],
    [],
    [
      load(0),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: 2 },
      { op: "struct.get", typeIdx: 2, fieldIdx: 1 },
      int(0),
      { op: "array.get", typeIdx: 1 },
      { op: "extern.convert_any" },
    ],
  );
  const missing: arms.VecOrClosureReadBinding = {
    vector: opts.vector ? { isCarrier: vectorIs, get: vectorGet } : undefined,
    closure: opts.closure
      ? { kind: "closure", get: closureGet, companion: undefined }
      : { kind: "legacy-missing", undefinedValue: [{ op: "global.get", index: 2 }] },
  };
  const explicit = opts.cache ? 11 : 9;
  const d: ObjectGetBindings = {
    objectTypeIdx: 2,
    propEntryTypeIdx: 0,
    objFindIdx: find,
    callAccessorGetIdx: accessor,
    accessorFlag: 8,
    reflectGetReceiverActiveGlobalIdx: 0,
    reflectGetReceiverGlobalIdx: 1,
    explicitReceiverLocal: explicit,
    nullProtoRootLocal: opts.companion ? explicit + 1 : undefined,
    protoCacheEnabled: Boolean(opts.cache),
    hashedStringTypeIdx: 3,
    bfnGetMetaIdx: opts.metadata ? metadata : undefined,
    fnctorProtoStartIdx: opts.fnctor || opts.cache ? protoStart : undefined,
    objectTerminalAllowsImplicitProtoIdx: terminal,
    templateRaw: undefined,
    boundaryGet: opts.boundary ? boundary : undefined,
    reversePeer: opts.reverse ? { get: reverse, ownedGlobal: 3 } : undefined,
    instance: opts.instance
      ? {
          isCarrier: instanceIs,
          get: instanceGet,
          scratchLocal: explicit - 1,
          generator: opts.generator ? { get: generatorGet, valueLocal: explicit - 1 } : undefined,
        }
      : undefined,
    missingPrototype: missing,
    invalidPrototype: missing,
    objectProtoMiss: opts.companion
      ? { kind: "split-receiver", receiver: 0, key: 1, accessorReceiver: explicit, brandOffset, getKey: companion }
      : undefined,
    getterMiss: [{ op: "global.get", index: 2 }],
    terminalMiss: [{ op: "global.get", index: 2 }],
  };
  const body = buildObjectGetBody(d);
  mutate?.(body, d);
  const locals: LocalDef[] = [
    { name: "o", type: nullable(2) },
    { name: "e", type: nullable(0) },
    { name: "any", type: A },
    { name: "getter", type: E },
    { name: "bfmeta", type: E },
    { name: "fnctorProto", type: E },
    ...(opts.cache
      ? [
          { name: "kh", type: nullable(3) },
          { name: "canCache", type: I },
        ]
      : []),
    { name: "ispv", type: E },
    { name: "explicitReceiver", type: E },
    ...(opts.companion ? [{ name: "nullProtoRoot", type: nullable(2) }] : []),
  ];
  define("get", [E, E], [E], locals, body);
  const binary = emitBinary(mod);
  const module = new WebAssembly.Module(binary as BufferSource);
  expect(WebAssembly.Module.imports(module)).toHaveLength(importedFunctions + 4);
  const instance = new WebAssembly.Instance(module, { control: controls as WebAssembly.ModuleImports });
  const exports = instance.exports as Record<string, (...args: unknown[]) => unknown>;
  const make = (proto: unknown, key: unknown, value: unknown, getter: unknown = null, flags = 0): unknown =>
    exports.make!(proto, key, value, getter, flags);
  const get = (obj: unknown, key: unknown): unknown => exports.get!(obj, key);
  return { exports, make, get, active, receiver, owned, observations, state, body, binary };
}
function allInstructions(body: Instr[]): Instr[] {
  return body.flatMap((i) => [
    i,
    ...(i.op === "if"
      ? [...allInstructions(i.then), ...allInstructions(i.else ?? [])]
      : i.op === "block" || i.op === "loop"
        ? allInstructions(i.body)
        : []),
  ]);
}

describe("C1 initial object-get fixed donor preservation", () => {
  it.each(donors.map((d, index) => [d.file, index] as const))(
    "reconstructs the complete committed %s",
    (file, index) => {
      expect(sha(reconstruct(read(file), index))).toBe(donors[index]!.sha256);
    },
  );

  it("rejects a changed donor receipt after authenticating the original", () => {
    expect(authenticate(fixtureText)).toHaveLength(8);
    expect(() => authenticate(fixtureText.replace("reserveAccessorGetDriver", "otherAccessorGetDriver"))).toThrow(
      "digest mismatch",
    );
  });

  it("rejects a change to the retained Reflect receiver wrapper", () => {
    const current = read(donors[0]!.file);
    reconstruct(current, 0);
    const source = invertObjectRuntimePeer(current, "key");
    reconstructDonorSource(source, 0);
    expect(source).toContain('name: "previousActive"');
    expect(() =>
      reconstructDonorSource(source.replace('name: "previousActive"', 'name: "corruptedActive"'), 0),
    ).toThrow("outside owned donor");
  });

  it("rejects an altered early template dependency argument", () => {
    const current = read(donors[0]!.file);
    reconstruct(current, 0);
    const source = invertObjectRuntimePeer(current, "key");
    reconstructDonorSource(source, 0);
    const changed = source.replace(
      "    ctx.templateVecTypeIdx,\n    strFlattenIdx,",
      "    ctx.anyStrTypeIdx,\n    strFlattenIdx,",
    );
    expect(changed).not.toBe(source);
    expect(() => reconstructDonorSource(changed, 0)).toThrow("adapter import/site mismatch");
  });

  it("rejects duplicate or attributed runtime imports after a positive inverse", () => {
    const current = read(donors[0]!.file);
    reconstruct(current, 0);
    const source = invertObjectRuntimePeer(current, "key");
    reconstructDonorSource(source, 0);
    const statement = 'import { buildObjectGetBody } from "../runtime/wasmgc/values/object-get-bodies.js";';
    expect(source).toContain(statement);
    expect(() => reconstructDonorSource(source.replace(statement, `${statement}\n${statement}`), 0)).toThrow(
      "import count",
    );
    expect(() =>
      reconstructDonorSource(source.replace(statement, statement.slice(0, -1) + ' with { type: "json" };'), 0),
    ).toThrow("import contract");
  });

  it("keeps both pure builders limited to canonical data dependencies", () => {
    const files = ["object-get-bodies", "object-get-arms"];
    for (const name of files) {
      const sf = parse(read(`src/runtime/wasmgc/values/${name}.ts`));
      const imports = sf.statements.filter(ts.isImportDeclaration);
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.map((i) => (i.moduleSpecifier as ts.StringLiteral).text)).toEqual(
        name === "object-get-bodies"
          ? ["../../../wasm/model/instructions.js", "./object-get-arms.js"]
          : ["../../../wasm/model/instructions.js"],
      );
      const disallowed: string[] = [];
      function visit(n: ts.Node) {
        if (ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isFunctionTypeNode(n))
          disallowed.push(n.getText(sf));
        ts.forEachChild(n, visit);
      }
      visit(sf);
      expect(disallowed).toEqual([]);
    }
  });
});

const traceCases: [string, TraceOptions][] = [
  ["all selected", {}],
  ["no cache", { cache: false }],
  ["no fnctor", { fnctor: false, cache: false }],
  ["no companion", { companion: false }],
  ["direct companion", { split: false }],
  ["no instance", { instance: false }],
  ["no generator", { generator: false }],
  ["no closure", { closure: false }],
  ["no closure with no fnctor", { closure: false, fnctor: false, cache: false }],
  ["no closure test", { closureTest: false }],
  ["no vector", { vector: false }],
  ["no metadata", { metadata: false }],
  ["no template", { template: false }],
  ["no flatten", { flatten: false }],
  ["no equals", { equals: false }],
  ["no instance predicate", { missing: [constants.IS_INSTANCE_EXPANDO_CARRIER] }],
  ["no instance getter", { missing: [constants.INSTANCE_PROP_GET] }],
  ["no vector predicate", { missing: [constants.IS_VEC_PROP_CARRIER] }],
  ["no vector getter", { missing: [constants.VEC_PROP_GET] }],
  ["no split brand", { missing: [constants.PROTOIDX_BRAND_OFF] }],
  ["no split getter", { missing: [constants.PROTOIDX_GET_K] }],
  ["host boundary", { boundary: "host" }],
  ["peer boundary", { boundary: "peer" }],
  ["host before peer", { boundary: "both" }],
  ["reverse with zero global", { boundary: "reverse", reverseGlobal: 0 }],
  ["reverse without ownership channel", { boundary: "reverse-no-owned" }],
  ["legacy null fallback", { singleton: false, closure: false }],
  ["mutating missing closure and fnctor", { closure: false, mutation: true }],
  ["mutating missing closure without fnctor", { closure: false, mutation: true, fnctor: false, cache: false }],
  ["mutating absent companion", { closure: false, mutation: true, companion: false }],
];
describe("C1 getter acquisition and registration against original donor", () => {
  it.each(traceCases)("preserves %s", (_name, options) => {
    const old = traceGetter(false, options),
      actual = traceGetter(true, options);
    expect(actual).toEqual(old);
    expect(actual.captured.name).toBe("__extern_get");
    expect(actual.captured.body.length).toBeGreaterThan(12);
    expect(actual.trace[0]?.[0]).toBe(
      options.template === false || options.flatten === false || options.equals === false
        ? "reserveAccessor"
        : "literal",
    );
    expect(actual.trace.at(-1)).toEqual(["register", "__extern_get"]);
    expect(actual.undefinedCalls).toBeGreaterThanOrEqual(2);
  });

  it.each([false, true])("captures each missing operand list before later mutation (fnctor=%s)", (fnctor) => {
    const options = { closure: false, mutation: true, fnctor, cache: fnctor };
    const old = traceGetter(false, options),
      actual = traceGetter(true, options);
    expect(actual).toEqual(old);
    expect(actual.undefinedCalls).toBe(fnctor ? 4 : 3);
    const mutant = traceGetter(true, options, (source) => {
      expect(source).toContain("const getterMiss = [...getMiss()];");
      return source.replace("const getterMiss = [...getMiss()];", "const getterMiss = getMiss();");
    });
    expect(mutant.trace).toEqual(actual.trace);
    expect(mutant.captured.body).not.toEqual(actual.captured.body);
  });

  it("retains the companion else array identity while snapshots retain shared instruction identity", () => {
    for (const current of [false, true]) {
      const r = traceGetter(current, { closure: false, mutation: true });
      const terminal = r.captured.body.at(-1)!;
      expect(terminal.op).toBe("if");
      if (terminal.op !== "if") throw new Error("missing terminal branch");
      expect(terminal.else).toBe(r.shared);
      const refs = allInstructions(r.captured.body).filter((i) => i.op === "global.get" && i.index === 301);
      expect(refs).toHaveLength(4);
      for (const i of refs) expect(i).toBe(r.shared[0]);
      const originalLength = terminal.else!.length;
      r.shared.push({ op: "nop" });
      expect(terminal.else).toHaveLength(originalLength + 1);
    }
  });

  it("retains early template types and late local layout reads across reservation mutation", () => {
    const r = traceGetter(true, { closure: false, mutation: true });
    expect(r).toEqual(traceGetter(false, { closure: false, mutation: true }));
    const instructions = allInstructions(r.captured.body);
    expect(instructions.filter((i) => (i.op === "ref.test" || i.op === "ref.cast") && i.typeIdx === 20)).toHaveLength(
      2,
    );
    expect(instructions.some((i) => (i.op === "ref.test" || i.op === "ref.cast") && i.typeIdx === 88)).toBe(false);
    expect(r.captured.locals.find((l) => l.name === "kh")!.type).toEqual({ kind: "ref_null", typeIdx: 27 });
    const vecReads = r.trace.filter((row) => row[0] === "get" && row[1] === constants.VEC_PROP_GET);
    expect(vecReads).toHaveLength(2);
    expect(vecReads[1]![2]).toBe(Number(vecReads[0]![2]) + 100);
  });

  it("distinguishes a valid zero ownership global from a missing ownership channel", () => {
    const zero = traceGetter(true, { boundary: "reverse", reverseGlobal: 0 });
    expect(zero).toEqual(traceGetter(false, { boundary: "reverse", reverseGlobal: 0 }));
    const absent = traceGetter(true, { boundary: "reverse-no-owned" });
    expect(absent).toEqual(traceGetter(false, { boundary: "reverse-no-owned" }));
    expect(allInstructions(zero.captured.body).some((i) => i.op === "global.get" && i.index === 0)).toBe(true);
    expect(allInstructions(absent.captured.body).some((i) => i.op === "global.get" && i.index === 0)).toBe(false);
  });
});

function observed(r: ReturnType<typeof executable>, name: string) {
  return r.observations.filter((row) => row[0] === name);
}
describe("emitted initial getter with controlled dependencies (not completed native resource packs)", () => {
  it("reads own data before prototype data and preserves the missing case", () => {
    const r = executable();
    const proto = r.make(null, "key", 19),
      own = r.make(proto, "key", 31);
    expect(r.get(own, "key")).toBe(31);
    expect(r.get(r.make(proto, "other", 7), "key")).toBe(19);
    expect(r.get(own, "absent")).toBeUndefined();
    expect(observed(r, "keyEqual").length).toBeGreaterThan(2);
  });

  it.each([null, undefined])("keeps a present %s value ahead of the prototype and companion", (value) => {
    const r = executable({ companion: true });
    r.state.companion = 83;
    const proto = r.make(null, "key", 71),
      own = r.make(proto, "key", value);
    expect(r.get(own, "key")).toBe(value);
    expect(observed(r, "companion")).toEqual([]);
  });

  it("a null getter returns undefined rather than continuing into the prototype", () => {
    const r = executable();
    const proto = r.make(null, "key", 19);
    expect(r.get(r.make(proto, "key", 33, null, 8), "key")).toBeUndefined();
    expect(observed(r, "accessor")).toEqual([]);
  });

  it("calls an inherited getter exactly once with the original receiver", () => {
    const r = executable();
    const receivers: unknown[] = [];
    const proto = r.make(
      null,
      "key",
      99,
      function (this: unknown) {
        receivers.push(this);
        return 42;
      },
      8,
    );
    const object = r.make(proto, null, null);
    expect(r.get(object, "key")).toBe(42);
    expect(receivers).toEqual([object]);
    expect(observed(r, "accessor")).toHaveLength(1);
  });

  it("consumes an explicit receiver before a nested ordinary getter", () => {
    const r = executable();
    const seen: unknown[] = [],
      override = { receiver: "explicit" };
    const inner = r.make(
      null,
      "inside",
      null,
      function (this: unknown) {
        seen.push(this);
        return 7;
      },
      8,
    );
    const proto = r.make(
      null,
      "outside",
      null,
      function (this: unknown) {
        seen.push(this);
        return r.get(inner, "inside");
      },
      8,
    );
    const outer = r.make(proto, null, null);
    r.active.value = 1;
    r.receiver.value = override;
    expect(r.get(outer, "outside")).toBe(7);
    expect(seen).toEqual([override, inner]);
    expect(observed(r, "active-at-getter")).toEqual([
      ["active-at-getter", 0],
      ["active-at-getter", 0],
    ]);
    expect(r.active.value).toBe(0);
  });

  it("propagates the exact thrown getter value with the receiver latch already consumed", () => {
    const r = executable();
    const thrown = { identity: "getter exception" },
      override = { explicit: true };
    let seen: unknown;
    const object = r.make(
      null,
      "key",
      null,
      function (this: unknown) {
        seen = this;
        throw thrown;
      },
      8,
    );
    r.active.value = 1;
    r.receiver.value = override;
    let caught: unknown;
    try {
      r.get(object, "key");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(thrown);
    expect(seen).toBe(override);
    expect(r.active.value).toBe(0);
  });

  it("ignores an unflagged getter field and reads the data value", () => {
    const r = executable();
    const object = r.make(null, "key", 37, () => 82, 0);
    expect(r.get(object, "key")).toBe(37);
    expect(observed(r, "accessor")).toEqual([]);
  });

  it("preserves the external fnctor receiver on a prototype getter", () => {
    const r = executable({ fnctor: true });
    const original = { native: "fnctor" };
    let seen: unknown;
    r.state.prototype = r.make(
      null,
      "key",
      null,
      function (this: unknown) {
        seen = this;
        return 43;
      },
      8,
    );
    expect(r.get(original, "key")).toBe(43);
    expect(seen).toBe(original);
    expect(observed(r, "protoStart")).toEqual([["protoStart", original]]);
  });

  it("guards an invalid fnctor prototype before casting and follows the closure miss", () => {
    const r = executable({ fnctor: true, closure: true });
    r.state.prototype = 5;
    r.state.closure = 47;
    expect(r.get({}, "key")).toBe(47);
    expect(observed(r, "closureGet")).toHaveLength(1);
  });

  it("an instance-own undefined entry shadows a fnctor prototype", () => {
    const r = executable({ fnctor: true, instance: true });
    r.state.instance = undefined;
    r.state.prototype = r.make(null, "key", 91);
    expect(r.get({}, "key")).toBeUndefined();
    expect(observed(r, "protoStart")).toEqual([]);
    expect(observed(r, "instanceGet")).toHaveLength(1);
  });

  it("uses the generator handled channel even for a null result before instance lookup", () => {
    const r = executable({ instance: true, generator: true });
    r.state.generatorHandled = true;
    r.state.generator = null;
    r.state.instance = 91;
    expect(r.get({}, "key")).toBeNull();
    expect(observed(r, "generatorGet")).toHaveLength(1);
    expect(observed(r, "instanceGet")).toEqual([]);
  });

  it("falls through an unhandled generator into a real instance read", () => {
    const r = executable({ instance: true, generator: true });
    r.state.generatorHandled = false;
    r.state.generator = 17;
    r.state.instance = 53;
    expect(r.get({}, "key")).toBe(53);
    expect(observed(r, "instanceGet")).toHaveLength(1);
  });

  it.each([false, true])("selects vector before closure after a fnctor miss (fnctor=%s)", (fnctor) => {
    const r = executable({ fnctor, vector: true, closure: true });
    r.state.vector = 59;
    r.state.closure = 61;
    expect(r.get({}, "key")).toBe(59);
    expect(observed(r, "vectorGet")).toHaveLength(1);
    expect(observed(r, "closureGet")).toEqual([]);
  });

  it("runs metadata before boundary and consumes the receiver latch on its early return", () => {
    const r = executable({ metadata: true, boundary: true });
    r.state.metadata = 67;
    r.state.boundary = 71;
    r.active.value = 1;
    r.receiver.value = {};
    expect(r.get({}, "name")).toBe(67);
    expect(observed(r, "boundary")).toEqual([]);
    expect(r.active.value).toBe(0);
  });

  it("a boundary-owned undefined remains a value before native instance fallback", () => {
    const r = executable({ metadata: true, boundary: true, instance: true });
    r.state.boundary = undefined;
    r.state.instance = 73;
    expect(r.get({}, "key")).toBeUndefined();
    expect(observed(r, "boundary")).toHaveLength(1);
    expect(observed(r, "instanceGet")).toEqual([]);
  });

  it.each([
    [null, 1, null],
    [null, 0, undefined],
    [79, 0, 79],
    [undefined, 1, undefined],
  ] as const)("preserves reverse-peer result %s with owned=%s", (answer, owned, expected) => {
    const r = executable({ reverse: true });
    r.state.reverse = answer;
    r.state.reverseOwned = owned;
    expect(r.get({}, "key")).toBe(expected);
    expect(observed(r, "reverse")).toHaveLength(1);
  });

  it("keeps the walk root for terminal eligibility and passes the explicit companion receiver", () => {
    const r = executable({ companion: true });
    r.state.companion = 83;
    const proto = r.make(null, "other", 1),
      object = r.make(proto, null, null),
      override = { receiver: true };
    r.active.value = 1;
    r.receiver.value = override;
    expect(r.get(object, "key")).toBe(83);
    expect(observed(r, "terminal")).toEqual([["terminal", object]]);
    expect(observed(r, "brandOffset")).toEqual([["brandOffset", object]]);
    expect(observed(r, "companion")).toEqual([["companion", override, "key", 42]]);
  });

  it("an explicit null terminal refuses the implicit companion", () => {
    const r = executable({ companion: true });
    r.state.implicitAllowed = false;
    r.state.companion = 89;
    const object = r.make(null, null, null);
    expect(r.get(object, "key")).toBeUndefined();
    expect(observed(r, "terminal")).toHaveLength(1);
    expect(observed(r, "companion")).toEqual([]);
  });

  it.each([false, true])("populates the first-depth cache with exact owner, entry and table (fnctor=%s)", (fnctor) => {
    const r = executable({ cache: true });
    const key = r.exports.hash!(),
      object = r.make(null, key, 97);
    r.state.prototype = object;
    expect(r.get(fnctor ? {} : object, key)).toBe(97);
    expect(r.exports.cacheFlag!(key)).toBe(1);
    expect(r.exports.cacheOwner!(key)).toBe(object);
    expect(r.exports.cacheEntry!(key)).toBe(r.exports.ownEntry!(object));
    expect(r.exports.cacheProps!(key)).toBe(r.exports.ownProps!(object));
  });

  it("does not populate cache after walking past the first object", () => {
    const r = executable({ cache: true });
    const key = r.exports.hash!(),
      proto = r.make(null, key, 101);
    expect(r.get(r.make(proto, null, null), key)).toBe(101);
    expect(r.exports.cacheFlag!(key)).toBe(0);
    expect(r.exports.cacheOwner!(key)).toBeNull();
    expect(r.exports.cacheEntry!(key)).toBeNull();
    expect(r.exports.cacheProps!(key)).toBeNull();
  });

  it("does not cache an accessor even when it returns a value", () => {
    const r = executable({ cache: true });
    const key = r.exports.hash!(),
      object = r.make(null, key, null, () => 103, 8);
    expect(r.get(object, key)).toBe(103);
    expect(r.exports.cacheFlag!(key)).toBe(0);
  });
});

function replaceExactlyOne(body: Instr[], predicate: (i: Instr) => boolean, replacement: (i: Instr) => void) {
  const matches = allInstructions(body).filter(predicate);
  expect(matches).toHaveLength(1);
  replacement(matches[0]!);
}
describe("positive-first executable mutation controls", () => {
  it("detects losing receiver-latch consumption", () => {
    const observe = (r: ReturnType<typeof executable>) => {
      const seen: unknown[] = [],
        explicit = {};
      const inner = r.make(
        null,
        "b",
        null,
        function (this: unknown) {
          seen.push(this);
          return 5;
        },
        8,
      );
      const outer = r.make(
        null,
        "a",
        null,
        function (this: unknown) {
          seen.push(this);
          return r.get(inner, "b");
        },
        8,
      );
      r.active.value = 1;
      r.receiver.value = explicit;
      expect(r.get(outer, "a")).toBe(5);
      return { seen, explicit, inner };
    };
    const positive = observe(executable());
    expect(positive.seen).toEqual([positive.explicit, positive.inner]);
    const negative = observe(
      executable({}, (body) => {
        expect(body[3]).toEqual(int(0));
        body[3] = int(1);
      }),
    );
    expect(negative.seen).toEqual([negative.explicit, negative.explicit]);
  });

  it("detects using the target instead of the explicit accessor receiver", () => {
    const observe = (r: ReturnType<typeof executable>) => {
      const explicit = {};
      let seen: unknown;
      const target = r.make(
        null,
        "key",
        null,
        function (this: unknown) {
          seen = this;
          return 7;
        },
        8,
      );
      r.active.value = 1;
      r.receiver.value = explicit;
      expect(r.get(target, "key")).toBe(7);
      return { seen, explicit, target };
    };
    const positive = observe(executable());
    expect(positive.seen).toBe(positive.explicit);
    const negative = observe(
      executable({}, (body, d) =>
        replaceExactlyOne(
          body,
          (i) => i.op === "local.get" && i.index === d.explicitReceiverLocal,
          (i) => {
            if (i.op === "local.get") i.index = 0;
          },
        ),
      ),
    );
    expect(negative.seen).toBe(negative.target);
  });

  it("detects dropping the accessor flag test", () => {
    const observe = (r: ReturnType<typeof executable>) =>
      r.get(
        r.make(null, "key", 11, () => 13, 8),
        "key",
      );
    expect(observe(executable())).toBe(13);
    expect(
      observe(
        executable({}, (body, d) =>
          replaceExactlyOne(
            body,
            (i) => i.op === "i32.const" && i.value === d.accessorFlag,
            (i) => {
              if (i.op === "i32.const") i.value = 0;
            },
          ),
        ),
      ),
    ).toBe(11);
  });

  it("detects conflating reverse-peer present null with a miss", () => {
    const observe = (r: ReturnType<typeof executable>) => {
      r.state.reverse = null;
      r.state.reverseOwned = 1;
      return r.get({}, "key");
    };
    expect(observe(executable({ reverse: true }))).toBeNull();
    expect(
      observe(
        executable({ reverse: true }, (body, d) =>
          replaceExactlyOne(
            body,
            (i) => i.op === "global.get" && i.index === d.reversePeer!.ownedGlobal,
            (i) => Object.assign(i, { op: "i32.const", value: 0 }),
          ),
        ),
      ),
    ).toBeUndefined();
  });

  it("detects cache writes after leaving the first object", () => {
    const observe = (r: ReturnType<typeof executable>) => {
      const key = r.exports.hash!(),
        proto = r.make(null, key, 17),
        target = r.make(proto, null, null);
      expect(r.get(target, key)).toBe(17);
      return r.exports.cacheFlag!(key);
    };
    expect(observe(executable({ cache: true }))).toBe(0);
    expect(
      observe(
        executable({ cache: true }, (body) => {
          const instructions = allInstructions(body),
            stores = instructions.filter((i) => i.op === "local.set" && i.index === 9);
          expect(stores).toHaveLength(3);
          const advanceStore = instructions.indexOf(stores[2]!);
          expect(instructions[advanceStore - 1]).toEqual(int(0));
          Object.assign(instructions[advanceStore - 1]!, { value: 1 });
        }),
      ),
    ).toBe(1);
  });
});

const peerIdentities = {
  key: [
    "buildObjectPropertyKeyPrefix",
    "keyResources",
    "buildObjectPropertyKeyPrefix",
    "prependObjectKeyCoercion",
    "buildObjectHashBody",
    "buildObjectKeyEqualsBody",
    "buildObjectKeyClassification",
    "buildObjectFindBody",
    "buildObjectPropertyKeyLateArm",
  ],
  getter: [
    "buildObjectGetBody",
    "captureInstanceReadBinding",
    "captureVecOrClosureReadBinding",
    "captureProtoIndexReadBinding",
    "captureTemplateRawReadBinding",
    "captureReversePeerReadBinding",
    "captureTemplateRawReadBinding",
    "buildObjectGetBody",
  ],
};
// Historical mutations operate after the authenticated later conversion inverse.
// The source is always reconstructed from today's bytes, never substituted from a fixture.
function historicalPeerSource(): string {
  const current = read(donors[0]!.file);
  verifyObjectRuntimeComposition(current);
  return invertConversionSource(donors[0]!.file, current);
}
describe("authenticated signed key/getter composition", () => {
  it("reproduces both exact signed peers and the unchanged historical source in both orders", () => {
    const current = read(donors[0]!.file),
      result = verifyObjectRuntimeComposition(current);
    expect(sha(result.original)).toBe(donors[0]!.sha256);
    expect(reconstruct(current, 0)).toBe(result.original);
    expect(result.keyOnly).not.toBe(result.getterOnly);
    const receipt = authenticateObjectRuntimeComposition(objectRuntimeCompositionText);
    expect(receipt.peers.key.hunks).toHaveLength(9);
    expect(receipt.peers.getter.hunks).toHaveLength(8);
  });

  it.each(["key", "getter"] as const)("rejects altered semantic identities in every signed %s hunk", (peer) => {
    const source = historicalPeerSource();
    verifyHistoricalObjectRuntimeComposition(source);
    const hunks = authenticateObjectRuntimeComposition(objectRuntimeCompositionText).peers[peer].hunks;
    expect(peerIdentities[peer]).toHaveLength(hunks.length);
    for (const [index, hunk] of hunks.entries()) {
      const identity = peerIdentities[peer][index]!;
      expect(hunk.after).toContain(identity);
      const changed = source.replace(hunk.after, hunk.after.replace(identity, `corrupted_${identity}`));
      expect(changed).not.toBe(source);
      expect(() => verifyHistoricalObjectRuntimeComposition(changed)).toThrow("span missing or duplicated");
    }
  });

  it.each(["key", "getter"] as const)("rejects every removed signed %s hunk", (peer) => {
    const source = historicalPeerSource();
    verifyHistoricalObjectRuntimeComposition(source);
    for (const hunk of authenticateObjectRuntimeComposition(objectRuntimeCompositionText).peers[peer].hunks) {
      const changed = source.replace(hunk.after, "");
      expect(changed).not.toBe(source);
      expect(() => verifyHistoricalObjectRuntimeComposition(changed)).toThrow("span missing or duplicated");
    }
  });

  it.each(["key", "getter"] as const)("rejects every duplicated signed %s hunk", (peer) => {
    const source = historicalPeerSource();
    verifyHistoricalObjectRuntimeComposition(source);
    for (const hunk of authenticateObjectRuntimeComposition(objectRuntimeCompositionText).peers[peer].hunks) {
      const changed = source.replace(hunk.after, hunk.after + hunk.after);
      expect(changed).not.toBe(source);
      expect(() => verifyHistoricalObjectRuntimeComposition(changed)).toThrow("span missing or duplicated");
    }
  });

  it.each(["key", "getter"] as const)("rejects reordered signed %s hunks", (peer) => {
    const source = historicalPeerSource();
    verifyHistoricalObjectRuntimeComposition(source);
    const hunks = authenticateObjectRuntimeComposition(objectRuntimeCompositionText).peers[peer].hunks;
    const first = hunks[0]!.after,
      last = hunks.at(-1)!.after,
      token = "__signed_composition_test_placeholder__";
    expect(source).not.toContain(token);
    const changed = source.replace(first, token).replace(last, first).replace(token, last);
    expect(changed).not.toBe(source);
    expect(() => verifyHistoricalObjectRuntimeComposition(changed)).toThrow("span order mismatch");
  });

  it("rejects corruption outside both signed peer deltas", () => {
    const source = historicalPeerSource();
    verifyHistoricalObjectRuntimeComposition(source);
    expect(source).toContain('name: "previousActive"');
    expect(() =>
      verifyHistoricalObjectRuntimeComposition(source.replace('name: "previousActive"', 'name: "corruptedActive"')),
    ).toThrow("signed peer source mismatch");
  });

  it("rejects changed composition receipt bytes without reseeding any historical receipt", () => {
    expect(authenticateObjectRuntimeComposition(objectRuntimeCompositionText).base.sha256).toBe(donors[0]!.sha256);
    expect(() =>
      authenticateObjectRuntimeComposition(objectRuntimeCompositionText.replace("750fb7e7", "00000000")),
    ).toThrow("receipt digest mismatch");
    expect(authenticate(fixtureText)).toHaveLength(8);
  });
});
