// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readBeforeResumeMain } from "./resume-main-composition.js";
import ts from "typescript";
import * as storage from "../../src/runtime/wasmgc/values/ordinary-object-storage-bodies.js";
import * as keys from "../../src/runtime/wasmgc/values/object-key-bodies.js";
import { buildOrdinaryObjectDataDescriptorBody } from "../../src/runtime/wasmgc/values/ordinary-object-descriptor-data.js";
import { buildOrdinaryObjectAccessorDescriptorBody } from "../../src/runtime/wasmgc/values/ordinary-object-descriptor-accessor.js";
import { buildObjectSameValueBody } from "../../src/runtime/wasmgc/values/object-same-value-body.js";
import type { Instr, LocalDef, ValType } from "../../src/wasm/model/instructions.js";
import { beforeDescriptorUndefinedCorrection } from "./descriptor-undefined-correction.js";

export const readWriteSource = readBeforeResumeMain;
export const writeSourceHash = (source: string) => createHash("sha256").update(source).digest("hex");
export const writeDonorPath = "tests/fixtures/issue-3518-native-object-write-donor.json";
export const writeExtractionPath = "tests/fixtures/issue-3518-native-object-write-extraction.json";
const originalText = readWriteSource(writeDonorPath);
const originalHash = "ab3f3f2a04fad3cb9886bc736ff97d56c3db480112c37d14203397af0efc5d5a";
interface SourceRecord {
  file: string;
  gitBlob: string;
  sha256: string;
  source: string;
}
export function originalWriteDonors(text = originalText): SourceRecord[] {
  if (writeSourceHash(text) !== originalHash) throw Error("write donor fixture mismatch");
  const donor = JSON.parse(text) as { base: string; records: SourceRecord[] };
  if (donor.base !== "2e89b4cf62b3fb28e71cac5ef6fddf2fc1ae118e" || donor.records.length !== 3)
    throw Error("write donor provenance mismatch");
  for (const r of donor.records) {
    if (writeSourceHash(r.source) !== r.sha256) throw Error("write donor source mismatch");
    const blob = createHash("sha1")
      .update("blob " + Buffer.byteLength(r.source) + "\0")
      .update(r.source)
      .digest("hex");
    if (blob !== r.gitBlob) throw Error("write donor Git blob mismatch");
  }
  return donor.records;
}
interface Span {
  before: string;
  after: string;
  beforeOffset: number;
  afterOffset: number;
}
interface Delta {
  file: string;
  before: string;
  after: string;
  spans: Span[];
}
interface Receipt {
  base: string;
  donor: string;
  deltas: Delta[];
  modules: Record<string, string>;
}
export const writeExtractionText = () => readWriteSource(writeExtractionPath);
const extractionHash = "53fc4dee594d31cfcd097081c9836aa92c5b258adf4dcea7561fa29c51da921c";
export function authenticateWriteExtraction(text = writeExtractionText(), reader = readWriteSource): Receipt {
  if (writeSourceHash(text) !== extractionHash) throw Error("write extraction receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.base !== "2e89b4cf62b3fb28e71cac5ef6fddf2fc1ae118e" ||
    receipt.donor !== originalHash ||
    receipt.deltas.length !== 3
  )
    throw Error("write extraction provenance mismatch");
  for (const [file, hash] of Object.entries(receipt.modules)) {
    let historical: string;
    try {
      historical = beforeDescriptorUndefinedCorrection(file, reader(file));
    } catch (cause) {
      throw Error("write relocated module mismatch: " + file, { cause });
    }
    if (writeSourceHash(historical) !== hash) throw Error("write relocated module mismatch: " + file);
  }
  return receipt;
}
function transform(source: string, delta: Delta, direction: "forward" | "inverse"): string {
  const old = direction === "forward" ? "before" : "after",
    next = direction === "forward" ? "after" : "before";
  if (writeSourceHash(source) !== delta[old]) throw Error("write extraction source mismatch");
  let cursor = 0,
    result = "";
  for (const span of delta.spans) {
    const text = span[old],
      at = source.indexOf(text);
    if (
      !text ||
      at < cursor ||
      source.indexOf(text, at + 1) >= 0 ||
      at !== span[old === "before" ? "beforeOffset" : "afterOffset"]
    )
      throw Error("write extraction span missing, duplicated or reordered");
    result += source.slice(cursor, at) + span[next];
    cursor = at + text.length;
  }
  result += source.slice(cursor);
  if (writeSourceHash(result) !== delta[next]) throw Error("write extraction retained source mismatch");
  return result;
}
export function invertObjectWriteSource(
  file: string,
  current: string,
  text = writeExtractionText(),
  reader = readWriteSource,
): string {
  const receipt = authenticateWriteExtraction(text, reader),
    delta = receipt.deltas.find((d) => d.file === file);
  if (!delta) throw Error("unknown write donor path");
  const original = originalWriteDonors(reader(writeDonorPath)).find((r) => r.file === file)!;
  if (delta.before !== original.sha256) throw Error("write donor base mismatch");
  const result = transform(current, delta, "inverse");
  if (result !== original.source || transform(result, delta, "forward") !== current)
    throw Error("write donor reconstruction mismatch");
  return result;
}
/** Replay the pinned write layer after the unchanged historical inverses have run. */
export function replayObjectWriteSource(
  file: string,
  source: string,
  text = writeExtractionText(),
  reader = readWriteSource,
): string {
  const receipt = authenticateWriteExtraction(text, reader),
    delta = receipt.deltas.find((d) => d.file === file);
  if (!delta) throw Error("unknown write donor path");
  const original = originalWriteDonors(reader(writeDonorPath)).find((r) => r.file === file)!;
  if (delta.before !== original.sha256 || source !== original.source) throw Error("write donor base mismatch");
  const result = transform(source, delta, "forward");
  if (transform(result, delta, "inverse") !== source) throw Error("write donor replay mismatch");
  return result;
}
export function writeRegisterScope(source: string, name: string): string {
  const sf = ts.createSourceFile("write-donor.ts", source, ts.ScriptTarget.Latest, true);
  const found: ts.Block[] = [];
  function visit(n: ts.Node) {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "registerNative" &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0]) &&
      n.arguments[0].text === name
    ) {
      const block = n.parent.parent;
      if (!ts.isBlock(block)) throw Error("unrecognized write donor registration");
      found.push(block);
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  if (found.length !== 1) throw Error("write donor registration count mismatch");
  return found[0]!.getText(sf);
}
export interface CapturedDefinition {
  name: string;
  params: ValType[];
  results: ValType[];
  locals: LocalDef[];
  body: Instr[];
}
export function captureWriteDonor(
  scope: string,
  options: { symbol: boolean; own: boolean; carrier: boolean; offset: number; changing: boolean },
) {
  const trace: unknown[] = [],
    registrations: CapturedDefinition[] = [];
  let next = 300 + options.offset;
  const literal: Instr[] = [
    { op: "block", blockType: { kind: "val", type: { kind: "externref" } }, body: [{ op: "ref.null.extern" }] },
  ];
  const funcMap = new Map([
    ["__new_TypeError", 60],
    ["__object_is", 61],
    ["__typeof_number", 62],
    ["__typeof_boolean", 63],
    ["__typeof_bigint", 64],
    ["__unbox_number", 65],
    ["__unbox_boolean", 66],
    ["__to_bigint", 67],
    ...(options.own ? [["__hasOwnProperty", 68] as [string, number]] : []),
  ]);
  const get = funcMap.get.bind(funcMap);
  funcMap.get = (key) => {
    trace.push(["get", key, get(key)]);
    return get(key);
  };
  const keyResources = {
    anyStrTypeIdx: 2,
    nativeStrTypeIdx: 3,
    nativeStrRef: { kind: "ref" as const, typeIdx: 3 },
    strDataTypeIdx: 4,
    symbolTypeIdx: 5,
    symbolKeysEnabled: options.symbol,
    strFlattenIdx: 40,
    strEqualsIdx: 41,
  };
  const common = {
    ...keyResources,
    keyResources,
    ...storage,
    // Historical reconstruction supplies the original null operand explicitly.
    // Current caller captures may provide the corrected canonical operand.
    buildOrdinaryObjectDataDescriptorBody: (
      d: Parameters<typeof buildOrdinaryObjectDataDescriptorBody>[0],
      undefinedAnyValue?: readonly Instr[],
    ) => buildOrdinaryObjectDataDescriptorBody(d, undefinedAnyValue ?? [{ op: "ref.null", typeIdx: d.flags.noneHeap }]),
    buildOrdinaryObjectAccessorDescriptorBody,
    // Historical donors used only the original i64 comparison. The live native
    // owner must provide its authenticated canonical carrier equality instead.
    buildObjectSameValueBody: (
      d: Omit<Parameters<typeof buildObjectSameValueBody>[0], "bigint"> & { toBigIdx: number },
    ) => buildObjectSameValueBody({ ...d, bigint: { kind: "legacy-i64", toBigIdx: d.toBigIdx } }),
    objectTypeIdx: 10,
    propMapTypeIdx: 9,
    propEntryTypeIdx: 8,
    objRef: { kind: "ref", typeIdx: 10 },
    objRefNull: { kind: "ref_null", typeIdx: 10 },
    propMapRef: { kind: "ref", typeIdx: 9 },
    entryRefNull: { kind: "ref_null", typeIdx: 8 },
    INITIAL_CAP: 8,
    NONE_HEAP: -18,
    OBJ_FLAG_NONEXTENSIBLE: 1,
    OBJ_FLAG_SEALED: 2,
    OBJ_FLAG_FROZEN: 4,
    FLAG_WRITABLE: 1,
    FLAG_ENUMERABLE: 2,
    FLAG_CONFIGURABLE: 4,
    FLAG_ACCESSOR: 8,
    FLAG_TOMBSTONE: 128,
    objHashIdx: 42,
    keyEqualsIdx: 43,
    objFindIdx: 44,
    objInsertIdx: 45,
    objGrowIdx: 46,
    OWN_KEY_PREDICATE: "__hasOwnProperty",
    boundaryObjectDefinePropertyValueIdx: options.carrier ? 70 : undefined,
    boundaryObjectDefinePropertyAccessorIdx: options.carrier ? 71 : undefined,
    ctx: { funcMap, targetProfile: { semanticProviders: "native-first" } },
    emitClassifyKey: (...args: [number, number, number, number, number]) =>
      keys.buildObjectKeyClassification(keyResources, ...args),
    emitKeyMatch: (...args: [number, number, number, number]) =>
      keys.buildObjectKeyMatch({ ...keyResources, propEntryTypeIdx: 8, keyEqualsIdx: 43 }, ...args),
    withKeyCoercion: (local: number, body: Instr[]) => {
      trace.push(["coerce", local]);
      return keys.prependObjectKeyCoercion(49, local, body);
    },
    addUnionImportsViaRegistry: () => {
      trace.push(["union"]);
      if (options.changing) funcMap.set("__new_TypeError", ++next);
    },
    canonicalUndefinedExternInstrs: () => {
      trace.push(["undefined"]);
      return literal;
    },
    emitWasiErrorConstructor: (_ctx: unknown, name: string, arity: number) => {
      trace.push(["error", name, arity]);
      if (options.changing) funcMap.set("__object_is", ++next);
    },
    ensureExnTag: () => {
      trace.push(["tag"]);
      return 2;
    },
    addStringConstantGlobal: (_ctx: unknown, message: string) => {
      trace.push(["literal-reserve", message]);
      if (options.changing) funcMap.set("__object_is", ++next);
    },
    stringConstantExternrefInstrs: (_ctx: unknown, message: string) => {
      trace.push(["literal-load", message]);
      return structuredClone(literal);
    },
    defineCarrierBagSubstitutionArm: (_ctx: unknown, request: unknown) => {
      trace.push(["bag", request]);
      return options.carrier ? [{ op: "nop" }] : undefined;
    },
    vecOverlay: options.carrier ? { dpValueIdx: 72, dpAccessorIdx: 73 } : null,
    vecOverlayArm: (any: number, helper: number, arity: number) => {
      trace.push(["vec", any, helper, arity]);
      return options.carrier ? [{ op: "nop" }] : [];
    },
    registerNative: (name: string, params: ValType[], results: ValType[], locals: LocalDef[], body: Instr[]) => {
      trace.push(["register", name]);
      registrations.push({ name, params, results, locals, body });
      return 99;
    },
  };
  const code = ts.transpileModule(scope, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
  }).outputText;
  new Function(...Object.keys(common), code)(...Object.values(common));
  if (registrations.length !== 1) throw Error("missing write donor registration");
  return { trace, definition: registrations[0]! };
}
