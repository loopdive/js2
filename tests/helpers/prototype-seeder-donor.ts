// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import * as builders from "../../src/runtime/wasmgc/values/prototype-seeder-bodies.js";
import { applyPrototypeSeederExtraction } from "./prototype-seeder-extraction.js";

export const prototypeSeederFixture = "tests/fixtures/issue-3518-prototype-seeder-donor.json";
export const prototypeSeederBase = "d55fba79f766e52d66a0b214fdc65ebf93c460bb";
const fixtureHash = "0334a42f136f72443e5c7b924b46e214a57c99fb322332be998c636a98e46376";
export const prototypeSeederPaths = [
  "src/codegen/native-proto.ts",
  "src/codegen/builtin-proto-constructor-seed.ts",
] as const;
export const readCurrentPrototypeSeederSource = (path: string) =>
  readFileSync(new URL("../../" + path, import.meta.url), "utf8");
export const readPrototypeSeederSource = (path: string) => {
  const source = readCurrentPrototypeSeederSource(path);
  return prototypeSeederPaths.some((candidate) => candidate === path)
    ? applyPrototypeSeederExtraction(path, source, true)
    : source;
};
export const prototypeSeederHash = (text: string) => createHash("sha256").update(text).digest("hex");

interface Span {
  before: string;
  after: string;
  beforeOffset: number;
  afterOffset: number;
  beforeSHA256: string;
  afterSHA256: string;
}
export interface PrototypeSeederDonorRecord {
  path: string;
  gitBlob: string;
  sourceSHA256: string;
  source: string;
  selected: { start: number; end: number; text: string; sha256: string };
  candidateSHA256: string;
  spans: Span[];
}
interface Receipt {
  schemaVersion: number;
  base: string;
  status: string;
  records: PrototypeSeederDonorRecord[];
}

export function authenticatePrototypeSeederDonor(text = readPrototypeSeederSource(prototypeSeederFixture)): Receipt {
  if (prototypeSeederHash(text) !== fixtureHash) throw Error("prototype seeder receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.base !== prototypeSeederBase ||
    receipt.status !== "pure-recipe candidate; legacy adapter not installed" ||
    JSON.stringify(receipt.records.map((record) => record.path)) !== JSON.stringify(prototypeSeederPaths)
  )
    throw Error("prototype seeder provenance mismatch");
  for (const record of receipt.records) {
    const blob = createHash("sha1")
      .update("blob " + Buffer.byteLength(record.source) + "\0")
      .update(record.source)
      .digest("hex");
    if (blob !== record.gitBlob || prototypeSeederHash(record.source) !== record.sourceSHA256)
      throw Error("prototype seeder full donor mismatch");
    if (
      record.source.slice(record.selected.start, record.selected.end) !== record.selected.text ||
      prototypeSeederHash(record.selected.text) !== record.selected.sha256
    )
      throw Error("prototype seeder selected donor mismatch");
    for (const span of record.spans)
      if (
        prototypeSeederHash(span.before) !== span.beforeSHA256 ||
        prototypeSeederHash(span.after) !== span.afterSHA256
      )
        throw Error("prototype seeder span authority mismatch");
  }
  return receipt;
}

function transform(record: PrototypeSeederDonorRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  let cursor = 0,
    result = "";
  for (const span of record.spans) {
    const at = source.indexOf(span[from]);
    if (!span[from] || at < 0 || source.indexOf(span[from], at + 1) >= 0)
      throw Error("prototype seeder span missing or duplicated");
    if (at < cursor || at !== span[inverse ? "afterOffset" : "beforeOffset"])
      throw Error("prototype seeder span order or offset mismatch");
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  if (prototypeSeederHash(source) !== record[inverse ? "candidateSHA256" : "sourceSHA256"])
    throw Error("prototype seeder retained source mismatch");
  result += source.slice(cursor);
  if (prototypeSeederHash(result) !== record[inverse ? "sourceSHA256" : "candidateSHA256"])
    throw Error("prototype seeder reconstruction mismatch");
  return result;
}

/** A proposed adapter's reciprocal proof, not a claim that the production adapter has been installed. */
export function transformPrototypeSeederCandidate(path: string, source: string, inverse: boolean): string {
  const record = authenticatePrototypeSeederDonor().records.find((record) => record.path === path);
  if (!record) throw Error("unrecorded prototype seeder path");
  const result = transform(record, source, inverse);
  if (transform(record, result, !inverse) !== source) throw Error("prototype seeder reciprocal replay mismatch");
  return result;
}

export function selectPrototypeSeederFunction(path: string, source: string): string {
  const isConstructorSeed = path === prototypeSeederPaths[1];
  const start = source.indexOf(
    isConstructorSeed
      ? "export function pushCompanionConstructorSeed("
      : "export function ensureNativeProtoCompanionSeeder(",
  );
  const end = isConstructorSeed
    ? source.length
    : source.indexOf("\n/**\n * `stringConstantExternrefInstrs` already", start);
  if (start < 0 || end < start) throw Error("prototype seeder function selection missing");
  return source.slice(start, end);
}

export interface PrototypeSeederScenario {
  readonly name?: string;
  readonly csv?: string;
  readonly getters?: readonly string[];
  readonly data?: readonly (readonly [string, string | number])[];
  readonly accessors?: readonly { key: string; get: string; set: string }[];
  readonly tag?: string;
  readonly constructorCarrier?: "extern" | "ref" | "missing" | "declined";
  readonly missingClosures?: readonly string[];
  readonly crossBrandAlias?: boolean;
  readonly changing?: boolean;
  readonly reenter?: boolean;
  readonly standalone?: boolean;
  readonly memberDirty?: boolean;
  readonly missingGlue?: boolean;
  readonly missingValue?: boolean;
  readonly missingAccessor?: boolean;
  readonly missingNumber?: boolean;
  readonly missingSymbol?: boolean;
  readonly invalidBrand?: boolean;
  readonly existing?: boolean;
  readonly deferred?: boolean;
}

interface Frame {
  body: Instr[];
  locals: { name: string; type: ValType }[];
  params: { name: string; type: ValType }[];
  localMap: Map<string, number>;
}

/** Executes selected actual adapter or fixed donor/candidate functions with acquisition observers. */
export function capturePrototypeSeeder(
  candidate: boolean | "current",
  scenario: PrototypeSeederScenario,
  currentReader = readCurrentPrototypeSeederSource,
) {
  const receipt = authenticatePrototypeSeederDonor();
  const sources = receipt.records.map((record) =>
    selectPrototypeSeederFunction(
      record.path,
      candidate === "current"
        ? currentReader(record.path)
        : candidate
          ? transformPrototypeSeederCandidate(record.path, record.source, false)
          : record.source,
    ).replace("export function", "function"),
  );
  const constants = [
    "PROTO_METHOD_DEFINE_FLAGS",
    "PROTO_SYMBOL_TAG_DEFINE_FLAGS",
    "PROTO_CONST_DEFINE_FLAGS",
    "PROTO_ACCESSOR_DEFINE_FLAGS",
  ]
    .map((name) => receipt.records[0]!.source.match(new RegExp(`const ${name} = [^;]+;`))![0])
    .join("\n");
  const trace: unknown[] = [];
  const registered: unknown[] = [];
  const published: unknown[] = [],
    borrowed: Instr[] = [];
  let epoch = 0,
    literal = 0,
    closureOrdinal = 0,
    currentFrame: Frame | undefined,
    reentered = false;
  const base = -1000,
    brand = scenario.invalidBrand ? 5 : base + 3;
  const registry = new Map<number, string>();
  if (scenario.existing) registry.set(brand, "already_registered");
  const pending = new Set<number>(),
    constructors = new Set<number>();
  const closures = new Map<string, { type: { kind: "ref"; typeIdx: number }; funcIdx: number }>();
  const defined = new Map<string, number>();
  const builtinIndices: Readonly<Record<string, number>> = {
    __defineProperty_value: 11,
    __defineProperty_accessor: 12,
    __box_number: 13,
    __box_symbol: 14,
  };
  const funcMap = {
    get(name: string) {
      trace.push(["get", name, epoch]);
      if (
        (name === "__defineProperty_value" && scenario.missingValue) ||
        (name === "__defineProperty_accessor" && scenario.missingAccessor) ||
        (name === "__box_number" && scenario.missingNumber) ||
        (name === "__box_symbol" && scenario.missingSymbol)
      )
        return undefined;
      return defined.get(name) ?? (builtinIndices[name] ?? 100) + epoch;
    },
    set(name: string, value: number) {
      trace.push(["set", name, value]);
      defined.set(name, value);
    },
  };
  const ctx = { standalone: scenario.standalone ?? true, protoMemberDirty: scenario.memberDirty ?? true, funcMap };
  const glue = {
    name: scenario.name ?? "Error",
    memberCsv: scenario.csv ?? "run",
    memberKind(member: string) {
      trace.push(["kind", member]);
      return scenario.getters?.includes(member) ? "getter" : "method";
    },
    ...(scenario.crossBrandAlias
      ? {
          memberBrandAliasOf: (_ctx: unknown, member: string) => {
            trace.push(["alias", member]);
            return brand + 2;
          },
        }
      : {}),
    dataProps: scenario.data,
    accessorProps: scenario.accessors,
    symbolTag: scenario.tag,
  };
  const shiftCalls = (value: unknown, delta: number): void => {
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (object.op === "call" && typeof object.funcIdx === "number") object.funcIdx += delta;
    for (const child of Object.values(object)) shiftCalls(child, delta);
  };
  const scope = {
    ...builders,
    EXTERNREF: { kind: "externref" },
    BUILTIN_BRAND_BASE: base,
    BUILTIN_BRAND_COUNT: 50,
    nativeProtoSeederRegistry: () => registry,
    nativeProtoSeededConstructorBrands: () => constructors,
    pendingNativeProtoSeeds: () => pending,
    getNativeProtoBuiltinGlue: () => (scenario.missingGlue ? undefined : glue),
    taCtorKindOf: (name: string) => (name === "Uint8Array" ? 1 : -1),
    makeNativeClosureFctx: (name: string) => {
      trace.push(["frame", name]);
      currentFrame = { body: [], locals: [], params: [], localMap: new Map() };
      return currentFrame;
    },
    hasBuiltinProtoConstructorCarrier: (name: string) => {
      trace.push(["has-constructor", name]);
      return scenario.constructorCarrier !== "missing";
    },
    addStringConstantGlobal: (_ctx: unknown, value: string) => {
      trace.push(["intern", value, epoch, currentFrame?.body.length]);
      if (scenario.changing) epoch++;
    },
    stringConstantExternrefInstrs: (_ctx: unknown, value: string): Instr[] => {
      trace.push(["literal", value, epoch, currentFrame?.body.length]);
      const node: Instr = scenario.deferred
        ? { op: "global.get", index: 300 + literal++ + epoch }
        : { op: "call", funcIdx: 300 + literal++ + epoch };
      borrowed.push(node);
      return [node];
    },
    emitBuiltinProtoConstructorValue: (_ctx: unknown, frame: Frame, name: string): ValType | null => {
      trace.push(["constructor", name, epoch, structuredClone(frame.body)]);
      if (scenario.constructorCarrier === "declined") return null;
      frame.body.push({ op: "call", funcIdx: 800 + epoch });
      return scenario.constructorCarrier === "ref" ? { kind: "ref", typeIdx: 900 } : { kind: "externref" };
    },
    coerceType: (_ctx: unknown, frame: Frame, from: ValType, to: ValType) => {
      trace.push(["coerce", from, to]);
      frame.body.push({ op: "extern.convert_any" });
    },
    flushLateImportShifts: (_ctx: unknown, frame: Frame) => {
      trace.push(["flush", epoch, structuredClone(frame.body)]);
      if (scenario.changing) {
        epoch += 17;
        shiftCalls(frame.body, 17);
      }
    },
    ensureStandaloneNativeMethodClosure: (
      _ctx: unknown,
      closureBrand: number,
      member: string,
      kind: string,
      options?: unknown,
    ) => {
      trace.push(["closure", closureBrand, member, kind, options, epoch]);
      if (scenario.reenter && !reentered) {
        reentered = true;
        trace.push(["reentered", invoke(ctx, brand)]);
      }
      if (scenario.changing) epoch += 2;
      if (scenario.missingClosures?.includes(member)) return null;
      const key = `${closureBrand}:${member}:${kind}`;
      if (!closures.has(key))
        closures.set(key, { type: { kind: "ref", typeIdx: 200 + closureOrdinal++ }, funcIdx: 600 + epoch });
      return closures.get(key);
    },
    pushBuiltinFnSingletonValueInstrs: (
      _ctx: unknown,
      closure: { type: { kind: "ref"; typeIdx: number }; funcIdx: number },
    ): Instr[] => {
      trace.push(["singleton", closure, epoch, currentFrame?.body.length]);
      if (scenario.changing) epoch += 3;
      const instructions: Instr[] = [
        { op: "ref.func", funcIdx: closure.funcIdx },
        { op: "struct.new", typeIdx: closure.type.typeIdx },
      ];
      borrowed.push(...instructions);
      return instructions;
    },
    ensureSymbolCarrier: () => {
      trace.push(["symbol", epoch]);
      if (scenario.changing) epoch += 5;
    },
    addFuncType: (_ctx: unknown, params: unknown, results: unknown, name: string) => {
      trace.push(["type", params, results, name, epoch]);
      return 701 + epoch;
    },
    mintDefinedFunc: () => {
      trace.push(["mint", epoch]);
      return 702 + epoch;
    },
    pushDefinedFunc: (_ctx: unknown, index: number, definition: unknown) => {
      trace.push(["publish", index]);
      published.push(definition);
      registered.push(structuredClone(definition));
    },
  };
  const code = ts.transpileModule(constants + "\n" + sources.reverse().join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const invoke: (ctx: unknown, brand: number) => string | undefined = new Function(
    ...Object.keys(scope),
    code + "\nreturn ensureNativeProtoCompanionSeeder;",
  )(...Object.values(scope));
  const result = invoke(ctx, brand);
  const deferred = scenario.deferred ? observeBorrowedSeederNodes(published, borrowed) : undefined;
  return {
    result,
    registered,
    trace,
    registry: [...registry],
    pending: [...pending],
    constructors: [...constructors],
    ...(deferred ? { deferred } : {}),
  };
}

function observeBorrowedSeederNodes(published: unknown[], borrowed: Instr[]) {
  const nodes = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || nodes.has(node)) return;
    nodes.add(node);
    Object.values(node).forEach(visit);
  };
  visit(published);
  const before = structuredClone(published);
  for (const node of borrowed) {
    if (node.op === "global.get") node.index += 500;
    if (node.op === "ref.func") node.funcIdx += 700;
  }
  return { retained: borrowed.map((node) => nodes.has(node)), before, after: structuredClone(published) };
}
