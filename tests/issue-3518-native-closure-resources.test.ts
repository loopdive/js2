// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { createEmptyModule, type Instr, type ValType } from "../src/ir/types.js";
import { internFunctionType } from "../src/wasm/physical/function-types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import * as funcSpace from "../src/codegen/func-space.js";
import * as canonical from "../src/runtime/wasmgc/values/closure-layouts.js";
import * as closureData from "../src/ir/program/data.js";
import * as closureDeclarations from "../src/backend/wasmgc/resources/native-resource-declarations.js";
import {
  reserveNativeClosureResources,
  declareNativeClosureResources,
  instantiateNativeClosureRequirements,
  nativeClosureReservationInventory,
  requireNativeClosureReservations,
  reserveNativeClosureResourcesPrefix,
  resumeNativeClosureResources,
  type NativeClosureRequirements,
  type NativeClosureSignatureRequest,
  type NativeClosureMetadataRequest,
} from "../src/backend/wasmgc/resources/native-closures.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";

const base = "bfe31c8bd96d748e867562e3e9b78343b72d1877";

describe("atomic compatibility of the same-owner engine", () => {
  it.each(["ordinary", "host-one-shot"] as const)(
    "keeps the complete frozen value shape for %s-first roots",
    (allocationMode) => {
      const request = { kind: "signature" as const, id: "root", params: [], results: [], allocationMode };
      const plan = declareNativeClosureResources({
        key: "atomic",
        startingClosureCounter: 0,
        requests: [request],
        referenceTypeKeys: [],
      });
      const input = { key: "atomic", startingClosureCounter: 0, requests: [request], referenceTypes: [] };
      const a = createEmptyModule(),
        b = createEmptyModule(),
        ta = new PhysicalModuleReservations(a),
        tb = new PhysicalModuleReservations(b);
      const atomic = reserveNativeClosureResources(ta, input, plan),
        completePrefix = reserveNativeClosureResourcesPrefix(tb, input, plan, 1);
      expect(a).toStrictEqual(b);
      expect(atomic).toStrictEqual(completePrefix);
      expect(Reflect.ownKeys(completePrefix)).toEqual([
        "root",
        "signatures",
        "metadata",
        "resultingClosureCounter",
        "registrations",
      ]);
      for (const key of Reflect.ownKeys(completePrefix))
        expect(Object.getOwnPropertyDescriptor(completePrefix, key)).toEqual(
          Object.getOwnPropertyDescriptor(atomic, key),
        );
      expect(Object.isFrozen(completePrefix)).toBe(true);
      expect(Object.isFrozen(completePrefix.signatures[0]!.binding.info)).toBe(true);
      expect(() => resumeNativeClosureResources(tb, completePrefix, 1)).toThrow("already complete");
    },
  );
});
// Prettier changed only the fixture's JSON whitespace at publication. All
// embedded donor text/hashes remain unchanged; pin the formatted transport.
const fixtureHash = "be6904328b9bb25981ca9ae109c3526d86931832eeb433bce66af41f99b96575";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
interface Donor {
  path: string;
  text: string;
  sha256: string;
  edits: {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    old: string[];
    replacement: string[];
  }[];
}
interface Fixture {
  schemaVersion: number;
  base: string;
  sources: Donor[];
  controls: { path: string; sha256: string }[];
  minimumObserver: { path: string; sourceSha256: string; start: number; end: number; text: string; sha256: string };
}
function authenticate(text: string): Fixture {
  if (hash(text) !== fixtureHash) throw new Error("closure fixture digest mismatch");
  const result = JSON.parse(text) as Fixture;
  if (result.schemaVersion !== 1 || result.base !== base || result.sources.length !== 3 || result.controls.length !== 4)
    throw new Error("closure donor population mismatch");
  for (const source of result.sources)
    if (hash(source.text) !== source.sha256) throw new Error("closure donor source receipt mismatch");
  const observer = result.minimumObserver;
  if (hash(observer.text) !== observer.sha256 || observer.end - observer.start !== observer.text.length)
    throw new Error("minimum observer span mismatch");
  return result;
}
// Independent exact-base originals and enumerated extraction edits; no runtime Git/fallback.
const fixtureText = read("tests/fixtures/issue-3518-native-closure-donors.json");
const fixture = authenticate(fixtureText);
const [headerDonor, wrapperDonor, metadataDonor] = fixture.sources as [Donor, Donor, Donor];
function inverse(source: string, donor: Donor): string {
  const lines = source.split("\n");
  for (const edit of [...donor.edits].reverse()) {
    const start = edit.newCount === 0 ? edit.newStart : edit.newStart - 1;
    if (JSON.stringify(lines.slice(start, start + edit.newCount)) !== JSON.stringify(edit.replacement))
      throw new Error("unapproved extraction/import span");
    lines.splice(start, edit.newCount, ...edit.old);
  }
  return lines.join("\n");
}
function requireDonor(source: string, donor: Donor): void {
  if (hash(inverse(source, donor)) !== donor.sha256) throw new Error("full donor reconstruction mismatch");
}
function replaceOnce(source: string, before: string, after: string): string {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) throw new Error("missing/ambiguous mutation target");
  return source.slice(0, at) + after + source.slice(at + before.length);
}

const factoryHeaders = [
  "export function createSignatureWrapperType(name: string, superTypeIdx: number): StructTypeDef {",
  "export function createBuiltinFunctionMetadataType(typeIndex: number, signatureWrapperTypeIndex: number): StructTypeDef {",
  `export function buildBuiltinClosureValueInstrs(
  typeIndex: number,
  functionHandle: FuncHandle,
  arity: number,
  isMetadata: boolean,
): Instr[] {`,
] as const;
const allocationModeDeclaration = 'export type ClosureAllocationMode = "support" | "ordinary" | "host-one-shot";';
function completeFactories(source: string): { declarations: string[]; bodies: string[] } {
  const parsed = ts.createSourceFile("live-shapes.ts", source, ts.ScriptTarget.Latest, true);
  const functions = parsed.statements.filter(ts.isFunctionDeclaration);
  const declaration = (name: string) => {
    const matches = functions.filter((fn) => fn.name?.text === name);
    if (matches.length !== 1) throw new Error("missing/duplicate shape factory");
    return matches[0]!.getText(parsed);
  };
  const wrapper = declaration("createSignatureWrapperType"),
    metadata = declaration("createBuiltinFunctionMetadataType");
  const wrapperShape = declaration("createSignatureWrapperShape"),
    metadataShape = declaration("createBuiltinFunctionMetadataShape");
  const wrapperDelegate = `${factoryHeaders[0]}
  const { parent, ...shape } = createSignatureWrapperShape(name, superTypeIdx);
  return { ...shape, superTypeIdx: parent };
}`;
  const metadataDelegate = `${factoryHeaders[1]}
  const { parent, ...shape } = createBuiltinFunctionMetadataShape(
    \`__builtinfn_meta_\${typeIndex}_struct\`,
    signatureWrapperTypeIndex,
  );
  return { ...shape, superTypeIdx: parent };
}`;
  if (wrapper !== wrapperDelegate || metadata !== metadataDelegate)
    throw new Error("changed numeric factory delegation");
  let originalWrapper = replaceOnce(
    wrapperShape,
    "export function createSignatureWrapperShape<P>(name: string, parent: P) {",
    factoryHeaders[0],
  );
  originalWrapper = replaceOnce(
    originalWrapper,
    'return { kind: "struct" as const, name, fields, parent };',
    'return { kind: "struct", name, fields, superTypeIdx };',
  );
  let originalMetadata = replaceOnce(
    metadataShape,
    "export function createBuiltinFunctionMetadataShape<N, P>(name: N, parent: P) {",
    factoryHeaders[1],
  );
  originalMetadata = replaceOnce(originalMetadata, 'kind: "struct" as const,', 'kind: "struct",');
  originalMetadata = replaceOnce(originalMetadata, "    name,", "    name: `__builtinfn_meta_${typeIndex}_struct`,");
  originalMetadata = replaceOnce(originalMetadata, "    parent,", "    superTypeIdx: signatureWrapperTypeIndex,");
  let reconstructed = replaceOnce(source, wrapper + "\n\n" + wrapperShape, originalWrapper);
  reconstructed = replaceOnce(reconstructed, metadata + "\n\n" + metadataShape, originalMetadata);
  const complete = completeOriginalFactories(reconstructed);
  // Existing mutation controls still mutate the LIVE numeric delegates; the
  // bodies passed to the original donor inverse come from the live shapes.
  return { declarations: [wrapper, metadata, declaration("buildBuiltinClosureValueInstrs")], bodies: complete.bodies };
}
function completeOriginalFactories(source: string): { declarations: string[]; bodies: string[] } {
  const start = source.indexOf(allocationModeDeclaration);
  if (start < 0) throw new Error("missing canonical suffix population");
  const suffix = source.slice(start);
  const parsed = ts.createSourceFile("closure-factory-receipt.ts", suffix, ts.ScriptTarget.Latest, true);
  const statements = [...parsed.statements];
  if (
    statements.length !== 6 ||
    !ts.isTypeAliasDeclaration(statements[0]!) ||
    !ts.isVariableStatement(statements[1]!) ||
    !ts.isVariableStatement(statements[2]!) ||
    !statements.slice(3).every(ts.isFunctionDeclaration)
  ) {
    throw new Error("canonical suffix must contain mode, two constants, and three complete factories");
  }
  const declarations = statements.slice(3).map((statement) => statement.getText(parsed));
  const bodies = declarations.map((declaration, index) => {
    const header = factoryHeaders[index]!;
    if (!declaration.startsWith(header + "\n") || !declaration.endsWith("\n}")) {
      throw new Error("unapproved complete factory header/return shape");
    }
    // Retain EVERY body character, not selected statements or just the returned
    // initializer. Extra executable code and early returns survive reconstruction.
    return declaration.slice(header.length + 1, -2);
  });
  const expectedSuffix = [
    allocationModeDeclaration,
    "",
    "export const BFN_STATE_FIELD_IDX = 3;",
    "export const BFN_ID_FIELD_IDX = 4;",
    "",
    declarations[0],
    "",
    declarations[1],
    "",
    declarations[2],
    "",
  ].join("\n");
  if (suffix !== expectedSuffix) throw new Error("canonical suffix population/order/trivia mismatch");
  return { declarations, bodies };
}
function originalSpan(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker),
    end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < start) throw new Error("missing authenticated original factory span");
  return source.slice(start, end);
}

/**
 * Invert complete LIVE declarations using only the named extraction substitutions.
 * Original bodies are comparison targets, never the source of reconstructed code.
 * Existing whole-file hashes authenticate the resulting spans plus retained code.
 */
function requireCanonicalFactoryReceipts(source: string): void {
  const { bodies } = completeFactories(source);
  let wrapperBody = replaceOnce(bodies[0]!, "  const fields = [", "  const structFields = [");
  // The factory's parameterized return is expanded to the original append shape;
  // these two retained index declarations stay at their original caller position.
  wrapperBody = replaceOnce(
    wrapperBody,
    '  return { kind: "struct", name, fields, superTypeIdx };',
    `  const structTypeIdx = ctx.mod.types.length;
  const rootWrapperTypeIdx = (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx;
  ctx.mod.types.push({
    kind: "struct",
    name: \`\${closureName}_struct\`,
    fields: structFields,
    superTypeIdx: rootWrapperTypeIdx ?? -1, // first wrapper is the root; later signatures subtype it
  });`,
  );
  const wrapperSpan = originalSpan(wrapperDonor.text, "  const structFields = [", "  const liftedSelfTypeIdx =");
  let reconstructedWrapper = inverse(read(wrapperDonor.path), wrapperDonor);
  reconstructedWrapper = replaceOnce(reconstructedWrapper, wrapperSpan, wrapperBody + "\n");

  let metadataBody = replaceOnce(bodies[1]!, "  return {", "  ctx.mod.types.push({");
  metadataBody = replaceOnce(metadataBody, "\n  };", "\n  });");
  metadataBody = metadataBody
    .replace(/\btypeIndex\b/g, "typeIdx")
    .replace(/\bsignatureWrapperTypeIndex\b/g, "baseStructTypeIdx");
  const metadataFunction = metadataDonor.text.slice(
    metadataDonor.text.indexOf("export function ensureBuiltinFnMetaType("),
  );
  const metadataSpan = originalSpan(metadataFunction, "  ctx.mod.types.push({", "\n\n  ctx.closureInfoByTypeIdx.set");
  let reconstructedMetadata = inverse(read(metadataDonor.path), metadataDonor);
  reconstructedMetadata = replaceOnce(reconstructedMetadata, metadataSpan, metadataBody);

  const valueBody = bodies[2]!
    .replace(/\bfunctionHandle\b/g, "closure.funcIdx")
    .replace(/\btypeIndex\b/g, "closure.type.typeIdx")
    .replace(/\bisMetadata\b/g, "isMeta");
  const firstNewline = valueBody.indexOf("\n");
  if (firstNewline < 0) throw new Error("missing complete value initializer/body");
  const initial = valueBody.slice(0, firstNewline),
    tail = valueBody.slice(firstNewline + 1);
  const originalInitial = '  const instrs: Instr[] = [{ op: "ref.func", funcIdx: closure.funcIdx }];';
  const valueFunction = metadataDonor.text.slice(
    metadataDonor.text.indexOf("export function pushBuiltinFnClosureValueInstrs("),
  );
  const originalTail = originalSpan(valueFunction, '  instrs.push({ op: "i32.const", value: arity });', "\n}");
  reconstructedMetadata = replaceOnce(reconstructedMetadata, originalInitial, initial);
  reconstructedMetadata = replaceOnce(reconstructedMetadata, originalTail, tail);
  if (hash(reconstructedWrapper) !== wrapperDonor.sha256 || hash(reconstructedMetadata) !== metadataDonor.sha256) {
    throw new Error("complete live factory donor receipt mismatch");
  }
}

function evaluate(source: string, dependencies: Record<string, unknown> = {}): Record<string, any> {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, any> = {};
  new Function("exports", "require", output)(exports, (name: string) => {
    if (!(name in dependencies)) throw new Error(`unexpected closure donor import ${name}`);
    return dependencies[name];
  });
  return exports;
}
function modules(live: boolean, producers: Record<string, unknown> = canonical, wrapperSource?: string) {
  const header = live
    ? evaluate(read(headerDonor.path), { "../../runtime/wasmgc/values/closure-layouts.js": producers })
    : evaluate(headerDonor.text);
  const registry = {
    addFuncType: (ctx: any, params: ValType[], results: ValType[], name?: string) =>
      internFunctionType(ctx.mod.types, ctx.funcTypeCache, params, results, name),
  };
  const wrapper = evaluate(wrapperSource ?? (live ? read(wrapperDonor.path) : wrapperDonor.text), {
    "../../ts-api.js": { ts },
    "../func-space.js": funcSpace,
    "../registry/types.js": registry,
    "./closure-header-layout.js": header,
    "../../runtime/wasmgc/values/closure-layouts.js": producers,
  });
  const metadata = evaluate(live ? read(metadataDonor.path) : metadataDonor.text, {
    "./closures/funcref-wrapper-types.js": wrapper,
    "./func-space.js": funcSpace,
    "../runtime/wasmgc/values/closure-layouts.js": producers,
  });
  return { header, wrapper, metadata };
}
const signature = (
  id: string,
  params: ValType[] = [{ kind: "externref" }],
  results: ValType[] = [],
  allocationMode: canonical.ClosureAllocationMode = "ordinary",
  minimumArgumentCount?: number,
): NativeClosureSignatureRequest => ({
  kind: "signature",
  id,
  params,
  results,
  allocationMode,
  ...(minimumArgumentCount === undefined ? {} : { minimumArgumentCount }),
});
const metadata = (
  id: string,
  signatureId: string,
  key = "promise:settle",
  name = "",
  length = 1,
): NativeClosureMetadataRequest => ({ kind: "metadata", id, signatureId, key, name, length });
function requirements(
  requests: NativeClosureRequirements["requests"] = [signature("settle"), metadata("settle-meta", "settle")],
): NativeClosureRequirements {
  return { key: "module:closures", startingClosureCounter: 7, requests, referenceTypes: [] };
}
function reserve(input = requirements()) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const pack = reserveNativeClosureResources(tx, input);
  return { module, tx, pack };
}
function legacy(
  input: NativeClosureRequirements,
  live: boolean,
  producers: Record<string, unknown> = canonical,
  wrapperSource?: string,
) {
  const api = modules(live, producers, wrapperSource);
  const ctx: any = {
    mod: createEmptyModule(),
    closureCounter: input.startingClosureCounter,
    funcTypeCache: new Map(),
    closureInfoByTypeIdx: new Map(),
    closureMinimumArgumentCountByFuncTypeIdx: new Map(),
    funcRefWrapperCache: new Map(),
    constructibleFuncRefWrapperCache: new Map(),
    closureMap: new Map(),
    constructibleClosureTypeIdxs: new Set(),
    funcMap: new Map(),
    numImportFuncs: 0,
    numImportGlobals: 0,
  };
  // Genuine synchronization helper, including copied records in closureMap.
  const observer = evaluate(
    `export function make(ctx: any) { ${fixture.minimumObserver.text}\nreturn observeMinimumArgumentCount; }`,
  ).make(ctx);
  const signatures = new Map<string, any>(),
    metas = new Map<string, number>();
  for (const request of input.requests) {
    if (request.kind === "signature") {
      const row = api.wrapper.getOrCreateFuncRefWrapperTypes(
        ctx,
        [...request.params],
        [...request.results],
        request.allocationMode,
      );
      if (request.minimumArgumentCount !== undefined) observer(row, request.minimumArgumentCount);
      signatures.set(request.id, row);
    } else {
      const row = signatures.get(request.signatureId);
      metas.set(
        request.id,
        api.metadata.ensureBuiltinFnMetaType(
          ctx,
          row.structTypeIdx,
          row.closureInfo,
          request.key,
          request.name,
          request.length,
        ),
      );
    }
  }
  return { ctx, api, signatures, metas, observer };
}

function stagedModule(source: string) {
  return evaluate(source, {
    "../../../ir/program/data.js": closureData,
    "../../../runtime/wasmgc/values/closure-layouts.js": canonical,
    "./native-resource-declarations.js": closureDeclarations,
  });
}
function assertStagedDonor(api: ReturnType<typeof stagedModule>) {
  // Every expectation comes from the unchanged full original donor, not a
  // second invocation of the candidate atomic implementation.
  for (const timing of ["before-first", "after-first", "after-other-signature"] as const) {
    const initial =
      timing === "after-other-signature"
        ? [signature("other", [{ kind: "f64" }], [], "support", 1), signature("settle")]
        : [signature("settle", undefined, undefined, "ordinary", timing === "after-first" ? 1 : undefined)];
    const input = requirements([
      ...initial,
      metadata("copied", "settle"),
      signature("lower", undefined, undefined, "ordinary", 0),
      signature("delay", [], [], "host-one-shot"),
    ]);
    const donor = legacy(input, false);
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const plan = api.declareNativeClosureResources({
      key: input.key,
      startingClosureCounter: input.startingClosureCounter,
      requests: input.requests,
      referenceTypeKeys: [],
    });
    const cut = initial.length + 1;
    const pack = api.reserveNativeClosureResourcesPrefix(tx, input, plan, cut);
    const rows = pack.signatures,
      metas = pack.metadata,
      root = pack.root;
    const info = pack.metadata[0].binding.info;
    expect(Object.isFrozen(pack)).toBe(false);
    expect(() => api.nativeClosureReservationInventory(tx, pack, plan)).toThrow("incomplete");
    expect(api.resumeNativeClosureResources(tx, pack, input.requests.length)).toBe(pack);
    expect(pack.signatures).toBe(rows);
    expect(pack.metadata).toBe(metas);
    expect(pack.root).toBe(root);
    expect(pack.metadata[0].binding.info).toBe(info);
    expect(module.types).toEqual(donor.ctx.mod.types);
    expect(pack.resultingClosureCounter).toBe(donor.ctx.closureCounter);
    for (const row of pack.signatures) expect(row.binding.info).toEqual(donor.signatures.get(row.id).closureInfo);
    for (const row of pack.metadata)
      expect(row.binding.info).toEqual(donor.ctx.closureInfoByTypeIdx.get(donor.metas.get(row.id)));
    expect(Object.isFrozen(pack)).toBe(true);
    expect(emitBinary(module)).toEqual(emitBinary(donor.ctx.mod));
    expect(emitWat(module)).toBe(emitWat(donor.ctx.mod));
  }
}
describe("staged engine live mutations against complete original donor receipts", () => {
  function assertFullPreflight(api: ReturnType<typeof stagedModule>) {
    const input = requirements([
      signature("settle"),
      metadata("meta", "settle"),
      signature("delay", [], [], "host-one-shot"),
    ]);
    const plan = api.declareNativeClosureResources({
      key: input.key,
      startingClosureCounter: input.startingClosureCounter,
      requests: input.requests,
      referenceTypeKeys: [],
    });
    const good = new PhysicalModuleReservations(createEmptyModule());
    const pack = api.reserveNativeClosureResourcesPrefix(good, input, plan, 2);
    expect(api.requireNativeClosureReservationPrefix(good, pack, "meta")).toBe(pack);
    const bad = structuredClone(input);
    Object.assign(bad.requests[2]!, { minimumArgumentCount: 1 });
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    expect(() => api.reserveNativeClosureResourcesPrefix(tx, bad, plan, 2)).toThrow("invalid observed minimum arity");
    expect(module).toStrictEqual(createEmptyModule());
    const laterMetadata = requirements([...input.requests, metadata("cached-meta", "settle")]);
    const laterPlan = api.declareNativeClosureResources({
      key: laterMetadata.key,
      startingClosureCounter: laterMetadata.startingClosureCounter,
      requests: laterMetadata.requests,
      referenceTypeKeys: [],
    });
    expect(() => api.reserveNativeClosureResourcesPrefix(tx, laterMetadata, laterPlan, 2)).toThrow(
      "metadata cannot remain",
    );
    expect(module).toStrictEqual(createEmptyModule());
  }
  it.each(["suffix-preflight", "metadata-after-pause"] as const)(
    "rejects live %s weakening after positive controls",
    (mutation) => {
      const source = read("src/backend/wasmgc/resources/native-closures.ts");
      assertFullPreflight(stagedModule(source));
      let changed: string;
      if (mutation === "metadata-after-pause")
        changed = replaceOnce(
          source,
          'fail("metadata cannot remain after a closure pause");',
          'void "removed metadata barrier";',
        );
      else {
        const start = source.indexOf("function validateRequests("),
          end = source.indexOf("/** Atomic compatibility", start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const validator = source.slice(start, end);
        const weakened = replaceOnce(
          validator,
          "for (const request of requirements.requests) {",
          "for (const request of requirements.requests.slice(0, 2)) {",
        );
        changed = source.slice(0, start) + weakened + source.slice(end);
        // The complete symbolic walk independently rejects this invalid suffix.
        // Weakening only the physical check is therefore an equivalent mutant
        // for this witness; retain that measured protection explicitly.
        assertFullPreflight(stagedModule(changed));
        const walkStart = changed.indexOf("function walkClosureDeclarations("),
          walkEnd = changed.indexOf("function validateCut(", walkStart);
        expect(walkStart).toBeGreaterThan(0);
        expect(walkEnd).toBeGreaterThan(walkStart);
        const walk = changed.slice(walkStart, walkEnd);
        changed =
          changed.slice(0, walkStart) +
          replaceOnce(
            walk,
            "for (const request of requirements.requests) {",
            "for (const request of requirements.requests.slice(0, 2)) {",
          ) +
          changed.slice(walkEnd);
      }
      expect(changed).not.toBe(source);
      expect(() => assertFullPreflight(stagedModule(changed))).toThrow();
    },
  );
  it("retains all three lazy observer timings across a pause", () => {
    assertStagedDonor(stagedModule(read("src/backend/wasmgc/resources/native-closures.ts")));
  });
  for (const [name, before, after] of [
    [
      "reset cache",
      "if (requestCursor < requirements.requests.length) yield pack;",
      "if (requestCursor < requirements.requests.length) { yield pack; cache.clear(); }",
    ],
    [
      "reset lazy observer",
      "if (requestCursor < requirements.requests.length) yield pack;",
      "if (requestCursor < requirements.requests.length) { yield pack; minimumObserverInfos = undefined; }",
    ],
    [
      "freeze early",
      "if (requestCursor < requirements.requests.length) yield pack;",
      "if (requestCursor < requirements.requests.length) yield Object.freeze(pack);",
    ],
    [
      "replace issued pack",
      "if (requestCursor < requirements.requests.length) yield pack;",
      "if (requestCursor < requirements.requests.length) yield { ...pack };",
    ],
    [
      "wrong canonical offset",
      "stepEnds.push(reservationSteps.length);",
      "stepEnds.push(reservationSteps.length + 1);",
    ],
    [
      "incomplete inventory",
      'if (!owner.complete) fail("incomplete closure reservation population");',
      "void owner.complete;",
    ],
  ] as const) {
    it(`rejects ${name} after the unchanged positive`, () => {
      const source = read("src/backend/wasmgc/resources/native-closures.ts");
      assertStagedDonor(stagedModule(source));
      const changed = replaceOnce(source, before, after);
      expect(changed).not.toBe(source);
      expect(() => assertStagedDonor(stagedModule(changed))).toThrow();
    });
  }
});

describe("native closure identities and settlement metadata", () => {
  for (const [before, after] of [
    ["export function createSignatureWrapperShape<P>", "export async function createSignatureWrapperShape<P>"],
    [
      '  return { kind: "struct" as const, name, fields, parent };',
      '  void 0;\n  return { kind: "struct" as const, name, fields, parent };',
    ],
    ["    parent,", "    parent: undefined,"],
    [
      '      { name: "bfnstate", type: { kind: "i32" as const }, mutable: true },',
      '      { name: "bfnstate", type: { kind: "i32" as const }, mutable: false },',
    ],
  ])
    it(`rejects live shape factoring mutation ${before}`, () => {
      const source = read("src/runtime/wasmgc/values/closure-layouts.ts");
      requireCanonicalFactoryReceipts(source);
      expect(() => requireCanonicalFactoryReceipts(replaceOnce(source, before!, after!))).toThrow();
    });
  it("feeds a pure declaration to the live observer loop without changing donor descriptors or aliases", () => {
    const input = requirements([
      signature("first", [{ kind: "externref" }], [], "ordinary", 1),
      metadata("meta", "first"),
      signature("alias", [{ kind: "externref" }], [], "support", 0),
      metadata("meta-alias", "alias"),
    ]);
    const plan = declareNativeClosureResources({
      key: input.key,
      startingClosureCounter: input.startingClosureCounter,
      requests: input.requests as Parameters<typeof declareNativeClosureResources>[0]["requests"],
      referenceTypeKeys: [],
    });
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const physical = instantiateNativeClosureRequirements(tx, plan, new Map());
    const pack = reserveNativeClosureResources(tx, physical, plan);
    const original = legacy(input, false);
    expect(module.types).toStrictEqual(original.ctx.mod.types);
    expect(pack.signatures[0]!.binding).toBe(pack.signatures[1]!.binding);
    expect(pack.metadata[0]!.binding).toBe(pack.metadata[1]!.binding);
    expect(pack.metadata[0]!.binding.metadata.length).toBe(1);
    expect(pack.signatures[0]!.binding.info.minimumArgumentCount).toBe(0);
    const rows = nativeClosureReservationInventory(tx, pack, plan);
    expect(rows.map((row) => row.key)).toEqual(plan.declarations.map((row) => row.key));
    expect(rows).toHaveLength(2);
    tx.freezeReservations();
    expect(nativeClosureReservationInventory(tx, pack, plan)).toEqual(rows);
    expect(() => nativeClosureReservationInventory(tx, pack, structuredClone(plan))).toThrow();
    expect(() => nativeClosureReservationInventory(tx, { ...pack }, plan)).toThrow();
  });
  it("reconstructs all original factory/body spans from complete live canonical declarations", () => {
    requireCanonicalFactoryReceipts(read("src/runtime/wasmgc/values/closure-layouts.ts"));
  });
  for (const index of [0, 1, 2]) {
    for (const mutation of ["extra-executable", "early-return", "missing-factory", "renamed-factory"] as const) {
      it(`rejects complete canonical factory ${index} ${mutation} after a genuine positive`, () => {
        const source = read("src/runtime/wasmgc/values/closure-layouts.ts");
        requireCanonicalFactoryReceipts(source);
        const { declarations, bodies } = completeFactories(source);
        const declaration = declarations[index]!,
          body = bodies[index]!;
        const changed =
          mutation === "extra-executable"
            ? factoryHeaders[index] + "\n" + body + "\n  void 0;\n}"
            : mutation === "early-return"
              ? factoryHeaders[index] + "\n  return undefined as never;\n" + body + "\n}"
              : mutation === "missing-factory"
                ? ""
                : declaration.replace("export function ", "export function renamed_");
        const mutant = replaceOnce(source, declaration, changed);
        expect(mutant).not.toBe(source);
        expect(() => requireCanonicalFactoryReceipts(mutant)).toThrow(/factory|factories|suffix|mutation target/);
      });
    }
  }
  for (const mutation of [
    "wrapper-construction-order",
    "value-construction-order",
    "field-mutability",
    "metadata-id",
  ] as const) {
    it(`rejects live canonical ${mutation} through fixed donor receipts`, () => {
      const source = read("src/runtime/wasmgc/values/closure-layouts.ts");
      requireCanonicalFactoryReceipts(source);
      const { declarations, bodies } = completeFactories(source);
      const index = mutation === "wrapper-construction-order" ? 0 : mutation === "field-mutability" ? 1 : 2;
      let changedBody = bodies[index]!;
      if (mutation === "wrapper-construction-order") {
        const returned = '  return { kind: "struct", name, fields, superTypeIdx };';
        changedBody = returned + "\n" + replaceOnce(changedBody, "\n" + returned, "");
      } else if (mutation === "value-construction-order") {
        changedBody = replaceOnce(
          changedBody,
          '  instrs.push({ op: "i32.const", value: arity });\n  instrs.push(closureBagInitInstr()); // (#4241) $bag field 2',
          '  instrs.push(closureBagInitInstr()); // (#4241) $bag field 2\n  instrs.push({ op: "i32.const", value: arity });',
        );
      } else if (mutation === "field-mutability") {
        changedBody = replaceOnce(
          changedBody,
          '{ name: "bfnstate", type: { kind: "i32" as const }, mutable: true }',
          '{ name: "bfnstate", type: { kind: "i32" as const }, mutable: false }',
        );
      } else
        changedBody = replaceOnce(
          changedBody,
          '{ op: "i32.const", value: typeIndex }',
          '{ op: "i32.const", value: typeIndex + 1 }',
        );
      let mutant: string;
      if (mutation === "wrapper-construction-order") {
        const returned = '  return { kind: "struct" as const, name, fields, parent };';
        const header = "export function createSignatureWrapperShape<P>(name: string, parent: P) {";
        mutant = replaceOnce(replaceOnce(source, "\n" + returned, ""), header, header + "\n" + returned);
      } else if (mutation === "field-mutability") {
        mutant = replaceOnce(
          source,
          '{ name: "bfnstate", type: { kind: "i32" as const }, mutable: true }',
          '{ name: "bfnstate", type: { kind: "i32" as const }, mutable: false }',
        );
      } else mutant = replaceOnce(source, declarations[index]!, factoryHeaders[index] + "\n" + changedBody + "\n}");
      expect(mutant).not.toBe(source);
      expect(() => requireCanonicalFactoryReceipts(mutant)).toThrow(/factory donor receipt mismatch/);
    });
  }
  for (const mutation of ["mode", "constant", "factory-order", "extra-declaration"] as const) {
    it(`pins the complete canonical suffix population against ${mutation}`, () => {
      const source = read("src/runtime/wasmgc/values/closure-layouts.ts");
      requireCanonicalFactoryReceipts(source);
      const { declarations } = completeFactories(source);
      let mutant: string;
      if (mutation === "mode")
        mutant = replaceOnce(
          source,
          allocationModeDeclaration,
          allocationModeDeclaration.replace('"support"', '"unsupported"'),
        );
      else if (mutation === "constant")
        mutant = replaceOnce(source, "export const BFN_ID_FIELD_IDX = 4;", "export const BFN_ID_FIELD_IDX = 5;");
      else if (mutation === "extra-declaration") mutant = source + "export const extraFactoryState = 0;\n";
      else {
        const firstStart = source.indexOf(declarations[0]!),
          secondStart = source.indexOf(declarations[1]!),
          thirdStart = source.indexOf(declarations[2]!);
        const first = source.slice(firstStart, secondStart),
          second = source.slice(secondStart, thirdStart);
        mutant = replaceOnce(source, first + second, second + first);
      }
      expect(mutant).not.toBe(source);
      expect(() => requireCanonicalFactoryReceipts(mutant)).toThrow(/suffix|factory header/);
    });
  }

  it("authenticates fixed originals and rejects altered receipts", () => {
    expect(fixture.sources.map((source) => source.path)).toEqual([
      "src/codegen/closures/closure-header-layout.ts",
      "src/codegen/closures/funcref-wrapper-types.ts",
      "src/codegen/builtin-fn-meta.ts",
    ]);
    expect(() => authenticate(fixtureText.replace('"schemaVersion": 1', '"schemaVersion": 2'))).toThrow(/digest/);
  });
  for (const donor of fixture.sources) {
    it(`inverse reconstructs ALL of ${donor.path}`, () => {
      requireDonor(read(donor.path), donor);
    });
    for (const mutation of ["missing", "renamed"] as const) {
      it(`rejects ${mutation} canonical imports/forwards in ${donor.path}`, () => {
        const source = read(donor.path);
        requireDonor(source, donor);
        const first = source.indexOf("runtime/wasmgc/values/closure-layouts.js");
        if (first < 0) throw new Error("missing canonical import control");
        const mutant =
          source.slice(0, first) +
          (mutation === "missing" ? "" : "runtime/wasmgc/values/renamed.js") +
          source.slice(first + "runtime/wasmgc/values/closure-layouts.js".length);
        expect(() => requireDonor(mutant, donor)).toThrow(/extraction|reconstruction/);
      });
    }
  }
  it("preserves all moved header documentation, predicates and eleven forwards", () => {
    const source = read("src/runtime/wasmgc/values/closure-layouts.ts");
    const end = source.indexOf("\nexport type ClosureAllocationMode =");
    if (end < 0) throw new Error("missing header boundary");
    let reconstructed = source.slice(0, end).trimEnd() + "\n";
    // Only accurate scalar return annotations changed in the retained header;
    // invert those exact signatures, preserving every implementation character.
    reconstructed = replaceOnce(
      reconstructed,
      'export function closureArityField(): { name: string; type: { kind: "i32" }; mutable: false } {',
      "export function closureArityField(): { name: string; type: ValType; mutable: false } {",
    );
    reconstructed = replaceOnce(
      reconstructed,
      'export function closureBagField(): { name: string; type: { kind: "externref" }; mutable: true } {',
      "export function closureBagField(): { name: string; type: ValType; mutable: true } {",
    );
    const restored = reconstructed.replace(
      'import type { Instr, FuncHandle } from "../../../wasm/model/instructions.js";\nimport type { FieldDef, StructTypeDef } from "../../../wasm/model/module-records.js";',
      'import type { FieldDef, Instr, ValType } from "../../ir/types.js";',
    );
    expect(hash(restored)).toBe(headerDonor.sha256);
    const old = modules(false).header,
      live = modules(true).header;
    expect(Object.keys(live).sort()).toEqual(Object.keys(old).sort());
    expect(Object.keys(live)).toHaveLength(11);
    const fields = canonical.createSignatureWrapperType("root", -1).fields;
    for (const probe of [[], fields, [...fields, fields[0]], [{ ...fields[0]!, mutable: true }, ...fields.slice(1)]]) {
      expect(live.hasClosureHeaderPrefix(probe)).toBe(old.hasClosureHeaderPrefix(probe));
      expect(live.isCanonicalClosureHeader(probe)).toBe(old.isCanonicalClosureHeader(probe));
    }
  });
  it("retains original source controls and the full minimum-arity authority", () => {
    for (const control of fixture.controls) expect(hash(read(control.path))).toBe(control.sha256);
    expect(hash(read(fixture.minimumObserver.path))).toBe(fixture.minimumObserver.sourceSha256);
  });
  it("rejects retained catalog changes and publication reorder", () => {
    const source = read(metadataDonor.path);
    requireDonor(source, metadataDonor);
    const changed = replaceOnce(
      source,
      '"Array.isArray": { name: "isArray", length: 1 }',
      '"Array.isArray": { name: "isArray", length: 2 }',
    );
    const before =
      "  ctx.builtinFnMetaByTypeIdx.set(typeIdx, { name, length });\n  ctx.builtinFnMetaTypeByKey.set(cacheKey, typeIdx);";
    const reordered = replaceOnce(
      source,
      before,
      "  ctx.builtinFnMetaTypeByKey.set(cacheKey, typeIdx);\n  ctx.builtinFnMetaByTypeIdx.set(typeIdx, { name, length });",
    );
    expect(() => requireDonor(changed, metadataDonor)).toThrow(/reconstruction/);
    expect(() => requireDonor(reordered, metadataDonor)).toThrow(/reconstruction/);
  });

  for (const first of ["settle", "numeric"] as const) {
    it(`matches independent donors and actual legacy callers with ${first} first`, () => {
      const settle = signature("settle", [{ kind: "externref" }], [], "host-one-shot", 1);
      const numeric = signature("numeric", [{ kind: "f64" }], [{ kind: "f64" }], "support");
      const input = requirements([
        ...(first === "settle" ? [settle, numeric] : [numeric, settle]),
        metadata("meta", "settle"),
        signature("hit", [{ kind: "externref" }], [], "ordinary", 0),
        metadata("again", "hit"),
        metadata("distinct", "hit", "builtin:other", "other", 1),
      ]);
      const old = legacy(input, false),
        live = legacy(input, true),
        { module, tx, pack } = reserve(input);
      requireNativeClosureReservations(tx, pack);
      expect(live.ctx.mod).toEqual(old.ctx.mod);
      expect(module.types).toEqual(old.ctx.mod.types);
      expect(pack.resultingClosureCounter).toBe(old.ctx.closureCounter);
      for (const row of pack.signatures) expect(row.binding.info).toEqual(old.signatures.get(row.id).closureInfo);
      for (const row of pack.metadata) {
        expect(row.binding.type.typeIndex).toBe(old.metas.get(row.id));
        expect(row.binding.info).toEqual(old.ctx.closureInfoByTypeIdx.get(row.binding.type.typeIndex));
      }
      expect(pack.signatures[2]!.binding).toBe(pack.signatures.find((row) => row.id === "settle")!.binding);
      expect(pack.metadata[0]!.binding).toBe(pack.metadata[1]!.binding);
      expect(pack.metadata[0]!.binding.metadata.id).not.toBe(pack.metadata[2]!.binding.metadata.id);
      expect(pack.registrations.filter((record) => record.kind === "root")).toHaveLength(1);
      expect(pack.registrations.filter((record) => record.kind === "closure-info")).toHaveLength(4);
      expect(pack.registrations.map((record) => record.kind)).toEqual([
        "counter",
        "type",
        "root",
        "signature",
        "closure-info",
        "wrapper-cache",
        "counter",
        "type",
        "signature",
        "closure-info",
        "wrapper-cache",
        "type",
        "closure-info",
        "metadata",
        "metadata-cache",
        "type",
        "closure-info",
        "metadata",
        "metadata-cache",
      ]);
      expect(
        pack.metadata.every(
          (row) => row.binding.type.object.kind === "struct" && row.binding.type.object.fields.length === 5,
        ),
      ).toBe(true);
      expect(module.functions).toEqual([]);
      expect(module.globals).toEqual([]);
      tx.freezeReservations();
      requireNativeClosureReservations(tx, pack);
      tx.seal();
      expect(emitBinary(module)).toEqual(emitBinary(old.ctx.mod));
      expect(emitWat(module)).toBe(emitWat(old.ctx.mod));
      expect(emitBinary(live.ctx.mod)).toEqual(emitBinary(old.ctx.mod));
    });
  }
  for (const modes of [
    ["support", "support"],
    ["host-one-shot", "support"],
    ["host-one-shot", "ordinary"],
    ["ordinary", "host-one-shot"],
  ] as const) {
    it(`preserves allocation observations ${modes.join(" then ")}`, () => {
      const input = requirements([
        signature("a", undefined, undefined, modes[0], 1),
        signature("b", undefined, undefined, modes[1], 0),
      ]);
      const { pack } = reserve(input),
        old = legacy(input, false);
      expect(pack.signatures[0]!.binding).toBe(pack.signatures[1]!.binding);
      expect(pack.signatures[1]!.binding.info).toEqual(old.signatures.get("b").closureInfo);
      expect(pack.resultingClosureCounter).toBe(8);
    });
  }
  for (const timing of ["before-first", "after-first", "after-other-signature"] as const) {
    it(`preserves metadata-copy minima ${timing} observation without rescanning late copies`, () => {
      const initial: NativeClosureRequirements["requests"] =
        timing === "after-other-signature"
          ? [signature("other", [{ kind: "f64" }], [{ kind: "f64" }], "support", 1), signature("settle")]
          : [signature("settle", [{ kind: "externref" }], [], "ordinary", timing === "after-first" ? 1 : undefined)];
      const input = requirements([
        ...initial,
        metadata("copied", "settle"),
        signature("lower", [{ kind: "externref" }], [], "ordinary", 0),
        metadata("reused", "lower"),
        metadata("fresh", "lower", "builtin:fresh", "fresh", 1),
      ]);
      const original = legacy(input, false),
        live = legacy(input, true);
      const expected = timing === "before-first" ? 0 : timing === "after-first" ? 1 : undefined;
      const originalCopied = original.ctx.closureInfoByTypeIdx.get(original.metas.get("copied"));
      expect(originalCopied.minimumArgumentCount).toBe(expected);
      expect(live.ctx.closureInfoByTypeIdx.get(live.metas.get("copied"))).toEqual(originalCopied);
      const { pack } = reserve(input);
      const copied = pack.metadata.find((row) => row.id === "copied")!.binding;
      const reused = pack.metadata.find((row) => row.id === "reused")!.binding;
      const fresh = pack.metadata.find((row) => row.id === "fresh")!.binding;
      expect(copied).toBe(reused);
      expect(copied.info).toEqual(originalCopied);
      expect(copied.info.minimumArgumentCount).toBe(expected);
      expect(copied.signature.info.minimumArgumentCount).toBe(0);
      expect(fresh.info.minimumArgumentCount).toBe(0);
      for (const row of pack.metadata)
        expect(row.binding.info).toEqual(original.ctx.closureInfoByTypeIdx.get(original.metas.get(row.id)));
    });
  }

  it("retains actual minimum synchronization across copied closureMap and both caches", () => {
    const input = requirements([signature("first")]);
    for (const live of [false, true]) {
      const result = legacy(input, live),
        row = result.signatures.get("first");
      const copies = [1, 2, 3].map((id) => ({ ...row.closureInfo, structTypeIdx: 100 + id }));
      result.ctx.closureMap.set("capture", copies[0]);
      result.ctx.constructibleFuncRefWrapperCache.set("constructible", copies[1]);
      result.ctx.closureInfoByTypeIdx.set(103, copies[2]);
      result.observer(row, 0);
      expect(copies.map((record) => record.minimumArgumentCount)).toEqual([0, 0, 0]);
    }
  });

  it("retains live arity selection and nested singleton initializer bodies", () => {
    for (const isMetadata of [false, true])
      for (const variadic of [false, true]) {
        const input = requirements(isMetadata ? [signature("s"), metadata("m", "s")] : [signature("s")]);
        const old = legacy(input, false),
          live = legacy(input, true);
        const index = isMetadata ? old.metas.get("m")! : old.signatures.get("s").structTypeIdx;
        for (const result of [old, live]) result.ctx.closureInfoByTypeIdx.get(index).nativeProtoVariadic = variadic;
        const closure = { type: { kind: "ref", typeIdx: index }, funcIdx: 42 };
        expect(live.api.metadata.pushBuiltinFnClosureValueInstrs(live.ctx, closure)).toEqual(
          old.api.metadata.pushBuiltinFnClosureValueInstrs(old.ctx, closure),
        );
        expect(live.api.metadata.pushBuiltinFnSingletonValueInstrs(live.ctx, closure)).toEqual(
          old.api.metadata.pushBuiltinFnSingletonValueInstrs(old.ctx, closure),
        );
        expect(live.ctx.mod.globals).toEqual(old.ctx.mod.globals);
        expect(live.ctx.builtinFnSingletonGlobalByTypeIdx).toEqual(old.ctx.builtinFnSingletonGlobalByTypeIdx);
        expect(live.api.metadata.BFN_STATE_FIELD_IDX).toBe(3);
        expect(live.api.metadata.BFN_ID_FIELD_IDX).toBe(4);
      }
  });
  it("authenticates external ref/null-ref types and preserves their exact indices", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const external = tx.reserveType("external", { kind: "struct", name: "external", fields: [] });
    const input = {
      ...requirements([
        signature(
          "typed",
          [{ kind: "ref", typeIdx: external.typeIndex }],
          [{ kind: "ref_null", typeIdx: external.typeIndex }],
        ),
      ]),
      referenceTypes: [external],
    };
    const pack = reserveNativeClosureResources(tx, input);
    expect(pack.root.typeIndex).toBe(1);
    requireNativeClosureReservations(tx, pack);
    tx.freezeReservations();
    requireNativeClosureReservations(tx, pack);
    tx.seal();
  });
  for (const provenance of ["foreign", "copied"] as const) {
    it(`rejects ${provenance} matching-index type before allocation`, () => {
      const module = createEmptyModule(),
        tx = new PhysicalModuleReservations(module);
      const other = new PhysicalModuleReservations(createEmptyModule());
      const local = tx.reserveType("external", { kind: "struct", name: "external", fields: [] });
      const foreign = other.reserveType("external", { kind: "struct", name: "external", fields: [] });
      const token = provenance === "foreign" ? foreign : { ...local };
      expect(token.typeIndex).toBe(local.typeIndex);
      const before = structuredClone(module);
      const input = { ...requirements([signature("typed", [{ kind: "ref", typeIdx: 0 }])]), referenceTypes: [token] };
      expect(() => reserveNativeClosureResources(tx, input)).toThrow(/foreign|forged/);
      expect(module).toEqual(before);
      expect(module.funcOrdinalToPosition).toEqual([]);
    });
  }
  it("rejects copied/foreign packs and changed request sequences", () => {
    const input = requirements(),
      a = reserve(input),
      b = reserve();
    expect(() => requireNativeClosureReservations(a.tx, { ...a.pack })).toThrow(/copied/);
    expect(() => requireNativeClosureReservations(a.tx, b.pack)).toThrow(/foreign/);
    (input.requests[0] as { allocationMode: string }).allocationMode = "support";
    expect(() => requireNativeClosureReservations(a.tx, a.pack)).toThrow(/stale/);
  });
  it("rejects stale field content and missing references before reservation changes", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const external = tx.reserveType("external", canonical.createSignatureWrapperType("external", -1));
    if (external.object.kind !== "struct") throw new Error("expected struct");
    external.object.fields[2]!.mutable = false;
    const before = structuredClone(module);
    expect(() =>
      reserveNativeClosureResources(tx, {
        ...requirements([signature("typed", [{ kind: "ref", typeIdx: 0 }])]),
        referenceTypes: [external],
      }),
    ).toThrow(/altered/);
    expect(module).toEqual(before);
    const clean = createEmptyModule(),
      fresh = new PhysicalModuleReservations(clean);
    expect(() =>
      reserveNativeClosureResources(fresh, requirements([signature("missing", [{ kind: "ref", typeIdx: 9 }])])),
    ).toThrow(/missing concrete/);
    expect(clean.types).toEqual([]);
  });
  for (const requests of [
    [],
    [metadata("forward", "missing")],
    [signature("a"), signature("a")],
    [signature("a"), metadata("bad", "a", "promise:settle", "wrong")],
  ] as NativeClosureRequirements["requests"][]) {
    it(`rejects invalid request population ${JSON.stringify(requests)}`, () => {
      const module = createEmptyModule(),
        tx = new PhysicalModuleReservations(module);
      expect(() => reserveNativeClosureResources(tx, requirements(requests))).toThrow();
      expect(module.types).toEqual([]);
      expect(module.functions).toEqual([]);
    });
  }

  for (const mutant of ["bag-mutability", "field-order", "metadata-id"] as const) {
    it(`independent legacy control rejects canonical ${mutant}`, () => {
      const input = requirements(),
        old = legacy(input, false),
        live = legacy(input, true);
      expect(live.ctx.mod).toEqual(old.ctx.mod);
      const replacements: Record<string, unknown> = { ...canonical };
      if (mutant !== "metadata-id")
        replacements.createBuiltinFunctionMetadataType = (index: number, parent: number) => {
          const type = canonical.createBuiltinFunctionMetadataType(index, parent);
          if (mutant === "bag-mutability") type.fields[2]!.mutable = false;
          else [type.fields[3], type.fields[4]] = [type.fields[4]!, type.fields[3]!];
          return type;
        };
      else
        replacements.buildBuiltinClosureValueInstrs = (index: number, handle: number, arity: number, meta: boolean) => {
          const body = canonical.buildBuiltinClosureValueInstrs(index, handle, arity, meta);
          if (meta) body[4] = { op: "i32.const", value: index + 1 };
          return body;
        };
      const changed = legacy(input, true, replacements);
      if (mutant === "metadata-id") {
        const index = live.metas.get("settle-meta")!,
          closure = { type: { kind: "ref", typeIdx: index }, funcIdx: 42 };
        const positive = live.api.metadata.pushBuiltinFnClosureValueInstrs(live.ctx, closure);
        const expected = old.api.metadata.pushBuiltinFnClosureValueInstrs(old.ctx, closure);
        expect(positive).toEqual(expected);
        const body = changed.api.metadata.pushBuiltinFnClosureValueInstrs(changed.ctx, closure);
        expect(() => expect(body).toEqual(expected)).toThrow();
      } else expect(() => expect(changed.ctx.mod).toEqual(old.ctx.mod)).toThrow();
    });
  }
  for (const mutant of ["root-self", "duplicate-root", "cache-update", "publication"] as const) {
    it(`rejects live wrapper ${mutant} after a genuine positive`, () => {
      const input = requirements([
        signature("first", [], []),
        signature("settle", undefined, undefined, "host-one-shot"),
        signature("hit", undefined, undefined, "ordinary"),
      ]);
      const source = read(wrapperDonor.path),
        old = legacy(input, false),
        live = legacy(input, true);
      expect(live.ctx.mod).toEqual(old.ctx.mod);
      let altered: string;
      if (mutant === "root-self")
        altered = replaceOnce(
          source,
          'const liftedParams: ValType[] = [{ kind: "ref", typeIdx: liftedSelfTypeIdx }, ...userParams];',
          'const liftedParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }, ...userParams];',
        );
      else if (mutant === "duplicate-root")
        altered = replaceOnce(
          source,
          "createSignatureWrapperType(`${closureName}_struct`, rootWrapperTypeIdx ?? -1)",
          "createSignatureWrapperType(`${closureName}_struct`, -1)",
        );
      else if (mutant === "cache-update")
        altered = replaceOnce(
          source,
          "    observeAllocation(cached, allocationMode);",
          "    // mutant drops cache-hit allocation observation",
        );
      else
        altered = replaceOnce(
          source,
          "  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);\n  ctx.funcRefWrapperCache.set(sigKey, closureInfo);",
          "  ctx.funcRefWrapperCache.set(sigKey, closureInfo);\n  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);",
        );
      const changed = legacy(input, true, canonical, altered);
      if (mutant === "cache-update")
        expect(() =>
          expect(changed.signatures.get("hit").closureInfo).toEqual(old.signatures.get("hit").closureInfo),
        ).toThrow();
      else if (mutant !== "publication") expect(() => expect(changed.ctx.mod).toEqual(old.ctx.mod)).toThrow();
      expect(() => requireDonor(altered, wrapperDonor)).toThrow(/extraction|reconstruction/);
    });
  }

  it("executes generated metadata values through actual typed functions and independently reads all fields", () => {
    const input = requirements([
      signature("identity", [{ kind: "externref" }], [{ kind: "externref" }]),
      metadata("identity-meta", "identity", "builtin:identity", "identity", 1),
      signature("settle"),
      metadata("settle-meta", "settle"),
    ]);
    const { module, tx, pack } = reserve(input);
    const identity = pack.signatures[0]!.binding,
      settle = pack.signatures[1]!.binding;
    const target = tx.reserveFunction("target:identity", "identity", {
      params: [{ kind: "ref", typeIdx: pack.root.typeIndex }, { kind: "externref" }],
      results: [{ kind: "externref" }],
    });
    const settleTarget = tx.reserveFunction("target:settle", "settle", {
      params: [{ kind: "ref", typeIdx: pack.root.typeIndex }, { kind: "externref" }],
      results: [],
    });
    expect(target.object.typeIdx).toBe(identity.liftedFuncTypeIndex);
    expect(settleTarget.object.typeIdx).toBe(settle.liftedFuncTypeIndex);
    const factories = pack.metadata.map((row, index) =>
      tx.reserveFunction(`factory:${index}`, `make${index}`, { params: [], results: [{ kind: "externref" }] }),
    );
    const invoke = tx.reserveFunction("invoke", "invoke", {
      params: [{ kind: "externref" }, { kind: "externref" }],
      results: [{ kind: "externref" }],
    });
    const reads = pack.metadata.flatMap((row, index) =>
      [1, 2, 3, 4].map((field) => ({
        row,
        index,
        field,
        fn: tx.reserveFunction(`read:${index}:${field}`, `read${index}_${field}`, {
          params: [{ kind: "externref" }],
          results: [{ kind: "i32" }],
        }),
      })),
    );
    tx.freezeReservations();
    requireNativeClosureReservations(tx, pack);
    tx.fillFunction(target, { locals: [], body: [{ op: "local.get", index: 1 }] });
    tx.fillFunction(settleTarget, { locals: [], body: [] });
    tx.declareFunctionReference(target);
    tx.declareFunctionReference(settleTarget);
    for (let i = 0; i < factories.length; i++) {
      const row = pack.metadata[i]!.binding;
      tx.fillFunction(factories[i]!, {
        locals: [],
        body: [
          ...canonical.buildBuiltinClosureValueInstrs(
            row.type.typeIndex,
            i === 0 ? target.handle : settleTarget.handle,
            row.metadata.length,
            true,
          ),
          { op: "extern.convert_any" },
        ],
      });
      tx.defineExport(`export:make${i}`, `make${i}`, factories[i]!);
    }
    const self = (): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: pack.root.typeIndex },
    ];
    tx.fillFunction(invoke, {
      locals: [],
      body: [
        ...self(),
        { op: "local.get", index: 1 },
        ...self(),
        { op: "struct.get", typeIdx: pack.root.typeIndex, fieldIdx: 0 },
        { op: "ref.cast", typeIdx: identity.liftedFuncTypeIndex },
        { op: "call_ref", typeIdx: identity.liftedFuncTypeIndex },
      ],
    });
    tx.defineExport("export:invoke", "invoke", invoke);
    for (const { row, index, field, fn } of reads) {
      const body: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: row.binding.type.typeIndex },
        { op: "struct.get", typeIdx: row.binding.type.typeIndex, fieldIdx: field },
      ];
      if (field === 2) body.push({ op: "ref.is_null" });
      tx.fillFunction(fn, { locals: [], body });
      tx.defineExport(`export:read${index}_${field}`, `read${index}_${field}`, fn);
    }
    tx.seal();
    const binary = emitBinary(module);
    expect(WebAssembly.validate(binary)).toBe(true);
    const api = new WebAssembly.Instance(new WebAssembly.Module(binary)).exports as Record<
      string,
      (...args: any[]) => any
    >;
    const value = api.make0!(),
      payload = { identity: 17 };
    expect(api.invoke!(value, payload)).toBe(payload);
    for (let index = 0; index < 2; index++) {
      const closure = api[`make${index}`]!();
      expect(api[`read${index}_1`]!(closure)).toBe(1);
      expect(api[`read${index}_2`]!(closure)).toBe(1);
      expect(api[`read${index}_3`]!(closure)).toBe(0);
      expect(api[`read${index}_4`]!(closure)).toBe(pack.metadata[index]!.binding.metadata.id);
    }
  });
});
