// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, LocalDef, ValType } from "../model/instructions.js";
import type {
  TypeDef,
  FuncTypeDef,
  WasmFunction,
  Import,
  ImportDesc,
  GlobalDef,
  TagDef,
  Table,
  Element,
  WasmExport,
} from "../model/module-records.js";
import { appendDefinedFunc, commitDefinedFuncOrdinal, mintDefinedFunc, STABLE_FUNC_BASE } from "./function-handles.js";
import { indexPhysicalTypes, planPhysicalTypeSection } from "./type-layout.js";
import { funcTypeKey, internFunctionType, sameValTypes } from "./function-types.js";

/** The physical fields of the SAME module ultimately passed to the emitter. */
export interface PhysicalModuleStorage {
  types: TypeDef[];
  /** Retained encoded group; the range addresses the flat physical type table. */
  canonicalRuntimeRecGroup?: { start: number; end: number; abiVersion: number };
  imports: Import[];
  functions: WasmFunction[];
  globals: GlobalDef[];
  tags: TagDef[];
  tables: Table[];
  elements: Element[];
  exports: WasmExport[];
  stringPool: string[];
  memories: { min: number; max?: number }[];
  dataSegments: { offset: number; bytes: Uint8Array; passive?: boolean }[];
  declaredFuncRefs: FuncHandle[];
  funcOrdinalToPosition: number[];
  startFuncIdx?: FuncHandle;
}

/** Keys are supplied by the backend's existing identity/role plan, never minted here. */
export type PhysicalResourceKey = string;
export interface PhysicalFunctionSignature {
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
}
export type PhysicalModuleState = "reserving" | "filling" | "sealed" | "failed";

interface Reservation<K extends string, T> {
  readonly kind: K;
  readonly key: PhysicalResourceKey;
  /** Exact allocator-owned object, not a locator copy. */
  readonly object: T;
}
export interface TypeReservation extends Reservation<"type", TypeDef> {
  /** Type indices do not have a separate stable-handle regime. */
  readonly typeIndex: number;
}
export interface FunctionReservation extends Reservation<"function", WasmFunction> {
  /** For emitted instructions; NOT a physical index for ProgramAbiMap. */
  readonly handle: FuncHandle;
}
export interface FunctionImportReservation extends Reservation<"function-import", Import> {
  readonly handle: FuncHandle;
}
export type GlobalReservation = Reservation<"global", GlobalDef>;
export type GlobalImportReservation = Reservation<"global-import", Import>;
export type TagReservation = Reservation<"tag", TagDef>;
export type TagImportReservation = Reservation<"tag-import", Import>;
export type TableReservation = Reservation<"table", Table>;
export type MemoryReservation = Reservation<"memory", PhysicalModuleStorage["memories"][number]>;
export type DataReservation = Reservation<"data", PhysicalModuleStorage["dataSegments"][number]>;
export type StringReservation = Reservation<"string", string>;
export type CallableReservation = FunctionReservation | FunctionImportReservation;
export type ExportableReservation =
  | CallableReservation
  | GlobalReservation
  | GlobalImportReservation
  | TagReservation
  | TagImportReservation
  | TableReservation
  | MemoryReservation;
export type PhysicalReservation = ExportableReservation | TypeReservation | DataReservation | StringReservation;
export type TagLinkage =
  | { readonly kind: "defined"; readonly name: string }
  | { readonly kind: "import"; readonly module: string; readonly name: string };

export interface PhysicalModuleCensus {
  readonly types: number;
  readonly imports: number;
  readonly functions: number;
  readonly globals: number;
  readonly tags: number;
  readonly tables: number;
  readonly elements: number;
  readonly exports: number;
  readonly memories: number;
  readonly dataSegments: number;
  readonly strings: number;
  readonly declaredFuncRefs: number;
  readonly completedFunctions: number;
  readonly completedGlobals: number;
}

/** Shared append primitive; host allowlisting, counters and diagnostics stay in codegen. */
export function appendPhysicalImport(
  storage: Pick<PhysicalModuleStorage, "imports">,
  module: string,
  name: string,
  desc: ImportDesc,
): Import {
  const record: Import = { module, name, desc };
  storage.imports.push(record);
  return record;
}

const populationKeys = [
  "types",
  "imports",
  "functions",
  "globals",
  "tags",
  "tables",
  "elements",
  "exports",
  "stringPool",
  "memories",
  "dataSegments",
  "declaredFuncRefs",
  "funcOrdinalToPosition",
] as const;
type PopulationKey = (typeof populationKeys)[number];
type PhysicalData =
  | TypeDef
  | Import
  | WasmFunction
  | Pick<WasmFunction, "name" | "typeIdx" | "exported">
  | GlobalDef
  | Pick<GlobalDef, "name" | "type" | "mutable">
  | TagDef
  | Table
  | Element
  | WasmExport
  | PhysicalModuleStorage["memories"][number]
  | PhysicalModuleStorage["dataSegments"][number]
  | PhysicalModuleStorage["canonicalRuntimeRecGroup"]
  | string
  | Instr[]
  | LocalDef[];

// Snapshots describe plain compiler-produced data, not transport authentication.
// JSON alone erases NaN/infinities/-0 and present-undefined fields. Encode all
// scalar kinds and own field presence explicitly, including array holes/length.
// No Node dependency: the same snapshots work in the browser compiler.
function dataText(data: PhysicalData): string {
  const active = new Set<object>();
  const numberBits = new DataView(new ArrayBuffer(8));
  const encode = (value: object | string | number | bigint | boolean | undefined | null): string => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    switch (typeof value) {
      case "string":
        return `string:${JSON.stringify(value)}`;
      case "boolean":
        return `boolean:${value}`;
      case "bigint":
        return `bigint:${value}`;
      case "number":
        // Same Float64 store as WasmEncoder.f64: even distinct NaN payloads
        // can change emitted bytes. Do not normalize or stringify the value.
        numberBits.setFloat64(0, value, true);
        return `number:${numberBits.getUint32(4, true).toString(16).padStart(8, "0")}${numberBits.getUint32(0, true).toString(16).padStart(8, "0")}`;
      case "object": {
        if (active.has(value)) throw new Error("cyclic physical descriptor");
        active.add(value);
        const tag = Array.isArray(value) ? `array:${value.length}` : value instanceof Uint8Array ? "bytes" : "object";
        const fields = Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry)}`);
        active.delete(value);
        return `${tag}{${fields.join(",")}}`;
      }
      default:
        throw new Error("unsupported physical descriptor value");
    }
  };
  return encode(data);
}

/**
 * Completion ledger around the existing module allocator. Start on empty
 * physical storage; reserve the complete ordered demand set, freeze, fill,
 * publish and seal. It does not authenticate IR or create another ABI owner.
 * Sealing certifies this boundary, not all later mutations of WasmModule.
 */
export class PhysicalModuleReservations {
  readonly #module: PhysicalModuleStorage;
  #state: PhysicalModuleState = "reserving";
  readonly #cache = new Map<string, number>();
  readonly #keys = new Set<PhysicalResourceKey>();
  readonly #tokens = new Set<PhysicalReservation>();
  readonly #objects = new Set<object>();
  readonly #positions = new Map<PhysicalReservation, number>();
  readonly #records = new Map<PhysicalReservation, string>();
  readonly #typeRecords = new Map<TypeDef, { text: string; members: readonly TypeDef[] }>();
  readonly #arrays: { [K in PopulationKey]: PhysicalModuleStorage[K] };
  readonly #expected: { [K in PopulationKey]: PhysicalModuleStorage[K] };
  readonly #filledFunctions = new Map<FunctionReservation, { locals: LocalDef[]; body: Instr[]; text: string }>();
  readonly #filledGlobals = new Map<GlobalReservation, { init: Instr[]; text: string }>();
  readonly #publications = new Map<Element | WasmExport, string>();
  readonly #exportNames = new Set<string>();
  #start: number | undefined;
  #startPresent: boolean;
  #canonicalGroup: PhysicalModuleStorage["canonicalRuntimeRecGroup"];
  #canonicalGroupPresent: boolean;
  #canonicalGroupText: string;
  #canonicalGroupRegistered = false;
  #importsClosed = false;

  constructor(module: PhysicalModuleStorage) {
    this.#module = module;
    this.#startPresent = Object.hasOwn(module, "startFuncIdx");
    this.#canonicalGroup = module.canonicalRuntimeRecGroup;
    this.#canonicalGroupPresent = Object.hasOwn(module, "canonicalRuntimeRecGroup");
    this.#canonicalGroupText = this.#snapshot(module.canonicalRuntimeRecGroup);
    this.#arrays = {
      types: module.types,
      imports: module.imports,
      functions: module.functions,
      globals: module.globals,
      tags: module.tags,
      tables: module.tables,
      elements: module.elements,
      exports: module.exports,
      stringPool: module.stringPool,
      memories: module.memories,
      dataSegments: module.dataSegments,
      declaredFuncRefs: module.declaredFuncRefs,
      funcOrdinalToPosition: module.funcOrdinalToPosition,
    };
    this.#expected = {
      types: [],
      imports: [],
      functions: [],
      globals: [],
      tags: [],
      tables: [],
      elements: [],
      exports: [],
      stringPool: [],
      memories: [],
      dataSegments: [],
      declaredFuncRefs: [],
      funcOrdinalToPosition: [],
    };
    if (
      populationKeys.some((key) => module[key].length !== 0) ||
      module.startFuncIdx !== undefined ||
      module.canonicalRuntimeRecGroup !== undefined
    ) {
      this.#fail("transaction requires empty physical storage; existing resources cannot be silently adopted");
    }
  }

  get state(): PhysicalModuleState {
    return this.#state;
  }

  #fail(detail: string): never {
    this.#state = "failed";
    throw new Error(`physical module reservations: ${detail}`);
  }

  #snapshot(data: PhysicalData): string {
    try {
      return dataText(data);
    } catch (error) {
      return this.#fail(error instanceof Error ? error.message : String(error));
    }
  }

  #require(phase: "reserving" | "filling"): void {
    if (this.#state !== phase) this.#fail(`operation requires ${phase}, observed ${this.#state}`);
    this.#verifyLayout();
  }

  #key(key: PhysicalResourceKey): void {
    if (!key || this.#keys.has(key)) this.#fail(`empty or duplicate resource key ${key}`);
    this.#keys.add(key);
  }

  #register<T extends PhysicalReservation>(token: T, position: number): T {
    if (typeof token.object === "object") {
      if (this.#objects.has(token.object)) this.#fail("same allocator object reserved twice");
      this.#objects.add(token.object);
    }
    Object.freeze(token);
    this.#tokens.add(token);
    this.#positions.set(token, position);
    this.#records.set(token, this.#recordText(token));
    return token;
  }

  #recordText(token: PhysicalReservation): string {
    if (token.kind === "function") {
      const { name, typeIdx, exported } = token.object;
      return this.#snapshot({ name, typeIdx, exported });
    }
    if (token.kind === "global") {
      const { name, type, mutable } = token.object;
      return this.#snapshot({ name, type, mutable });
    }
    return this.#snapshot(token.object);
  }

  #owned(token: PhysicalReservation): void {
    if (!this.#tokens.has(token)) this.#fail("foreign or forged reservation token");
  }

  #verifyLayout(): void {
    for (const key of populationKeys) {
      const actual = this.#module[key];
      const expected = this.#expected[key];
      if (actual !== this.#arrays[key] || actual.length !== expected.length) {
        this.#fail(`unregistered, substituted or reordered ${key} population`);
      }
      // Array.some skips holes and can even consult an inherited index. Every
      // expected slot must remain an own property of the actual population.
      for (let index = 0; index < expected.length; index++) {
        if (!Object.hasOwn(actual, index) || !Object.is(actual[index], expected[index])) {
          this.#fail(`missing, substituted or reordered ${key} population slot ${index}`);
        }
      }
    }
    if (
      !Object.is(this.#module.startFuncIdx, this.#start) ||
      Object.hasOwn(this.#module, "startFuncIdx") !== this.#startPresent
    )
      this.#fail("unregistered or altered start publication");
    if (
      this.#module.canonicalRuntimeRecGroup !== this.#canonicalGroup ||
      Object.hasOwn(this.#module, "canonicalRuntimeRecGroup") !== this.#canonicalGroupPresent ||
      this.#snapshot(this.#module.canonicalRuntimeRecGroup) !== this.#canonicalGroupText
    ) {
      this.#fail("unregistered, substituted or altered canonical runtime rec-group");
    }
    for (const [token, text] of this.#records) {
      if (this.#recordText(token) !== text) this.#fail(`altered ${token.kind} descriptor ${token.key}`);
    }
    for (const [type, { text, members }] of this.#typeRecords) {
      if (this.#snapshot(type) !== text) this.#fail("altered reserved type definition/signature");
      const current = this.#typeMembers(type);
      if (current.length !== members.length || current.some((member, index) => member !== members[index]))
        this.#fail("substituted reserved type member/payload");
    }
    for (const [token, fill] of this.#filledFunctions) {
      if (
        token.object.locals !== fill.locals ||
        token.object.body !== fill.body ||
        this.#snapshot(token.object) !== fill.text
      )
        this.#fail(`altered completed function ${token.key}`);
    }
    for (const [token, fill] of this.#filledGlobals) {
      if (token.object.init !== fill.init || this.#snapshot(fill.init) !== fill.text)
        this.#fail(`altered completed global ${token.key}`);
    }
    for (const [record, text] of this.#publications) {
      if (this.#snapshot(record) !== text) this.#fail("altered publication descriptor");
    }
  }

  #importCount(kind: ImportDesc["kind"]): number {
    return this.#module.imports.filter((record) => record.desc.kind === kind).length;
  }

  #import(module: string, name: string, desc: ImportDesc): Import {
    if (this.#importsClosed) this.#fail("imports must precede defined functions/globals/tables/memories");
    if (desc.kind === "tag" && this.#module.tags.length > 0) this.#fail("tag imports must precede defined tags");
    const record = appendPhysicalImport(this.#module, module, name, desc);
    this.#expected.imports.push(record);
    return record;
  }

  /** Preserve original interning points and hit naming. After freeze this is cache-only. */
  internFunctionType(params: readonly ValType[], results: readonly ValType[], name?: string): number {
    if (this.#state !== "reserving" && this.#state !== "filling") this.#fail(`type lookup in ${this.#state}`);
    this.#verifyLayout();
    const key = funcTypeKey([...params], [...results]);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      const type = this.#type(cached);
      if (type?.kind !== "func" || !sameValTypes(type.params, params) || !sameValTypes(type.results, results)) {
        this.#fail("cached function signature contradicts exact reference/brand requirements");
      }
      return cached;
    }
    if (this.#state !== "reserving") this.#fail(`function signature was not reserved: ${key}`);
    const index = this.#flatTypes().length;
    // The shared allocator appends to the actual outer record array. Convert
    // only its index coordinate; no cloned type objects or second allocator.
    const recordIndex = internFunctionType(
      this.#module.types,
      this.#cache,
      [...params],
      [...results],
      name ?? `type${index}`,
    );
    const type = this.#module.types[recordIndex]!;
    this.#cache.set(key, index);
    this.#expected.types.push(type);
    this.#typeRecords.set(type, { text: this.#snapshot(type), members: this.#typeMembers(type) });
    return index;
  }

  reserveType(key: PhysicalResourceKey, definition: TypeDef): TypeReservation {
    this.#require("reserving");
    this.#key(key);
    if (this.#typeRecords.has(definition)) this.#fail("same type object reserved twice");
    const typeIndex = this.#flatTypes().length;
    this.#module.types.push(definition);
    this.#expected.types.push(definition);
    this.#flatTypes();
    this.#typeRecords.set(definition, { text: this.#snapshot(definition), members: this.#typeMembers(definition) });
    return this.#register({ kind: "type", key, object: definition, typeIndex }, typeIndex);
  }

  /** Authenticate a prerequisite before allocating dependents; exposes no final index. */
  assertTypeReservation(token: TypeReservation): void {
    this.#require("reserving");
    this.#owned(token);
    if (token.kind !== "type") this.#fail("expected type reservation token");
  }

  /** Reserve the emitter-affecting descriptor before freeze, including future members. */
  reserveCanonicalRuntimeRecGroup(
    key: PhysicalResourceKey,
    definition: NonNullable<PhysicalModuleStorage["canonicalRuntimeRecGroup"]>,
  ): void {
    this.#require("reserving");
    this.#key(key);
    if (this.#canonicalGroupRegistered) this.#fail("canonical runtime rec-group already reserved");
    this.#canonicalGroupRegistered = true;
    this.#module.canonicalRuntimeRecGroup = definition;
    this.#canonicalGroup = definition;
    this.#canonicalGroupPresent = true;
    this.#canonicalGroupText = this.#snapshot(definition);
  }

  reserveFunctionImport(
    key: PhysicalResourceKey,
    moduleName: string,
    field: string,
    signature: PhysicalFunctionSignature,
  ): FunctionImportReservation {
    this.#require("reserving");
    this.#key(key);
    const typeIdx = this.internFunctionType(signature.params, signature.results);
    const handle = this.#importCount("func");
    const object = this.#import(moduleName, field, { kind: "func", typeIdx });
    return this.#register({ kind: "function-import", key, object, handle }, handle);
  }

  reserveGlobalImport(
    key: PhysicalResourceKey,
    moduleName: string,
    field: string,
    type: ValType,
    mutable: boolean,
  ): GlobalImportReservation {
    this.#require("reserving");
    this.#key(key);
    const index = this.#importCount("global");
    const object = this.#import(moduleName, field, { kind: "global", type, mutable });
    return this.#register({ kind: "global-import", key, object }, index);
  }

  reserveFunction(key: PhysicalResourceKey, name: string, signature: PhysicalFunctionSignature): FunctionReservation {
    this.#require("reserving");
    this.#key(key);
    const typeIdx = this.internFunctionType(signature.params, signature.results);
    this.#importsClosed = true;
    const object: WasmFunction = { name, typeIdx, locals: [], body: [], exported: false };
    const handle = mintDefinedFunc(this.#module);
    commitDefinedFuncOrdinal(this.#module, handle);
    const position = this.#module.functions.length;
    appendDefinedFunc(this.#module, object);
    this.#expected.functions.push(object);
    this.#expected.funcOrdinalToPosition.push(position);
    return this.#register({ kind: "function", key, object, handle }, position);
  }

  reserveGlobal(key: PhysicalResourceKey, name: string, type: ValType, mutable: boolean): GlobalReservation {
    this.#require("reserving");
    this.#key(key);
    this.#importsClosed = true;
    const object: GlobalDef = { name, type, mutable, init: [] };
    const position = this.#module.globals.length;
    this.#module.globals.push(object);
    this.#expected.globals.push(object);
    return this.#register({ kind: "global", key, object }, position);
  }

  reserveTag(
    key: PhysicalResourceKey,
    signature: PhysicalFunctionSignature,
    linkage: TagLinkage,
  ): TagReservation | TagImportReservation {
    this.#require("reserving");
    this.#key(key);
    if (signature.results.length !== 0) this.#fail("exception tag signature must have no results");
    const typeIdx = this.internFunctionType(signature.params, signature.results);
    if (linkage.kind === "import") {
      const index = this.#importCount("tag");
      const object = this.#import(linkage.module, linkage.name, { kind: "tag", typeIdx });
      return this.#register({ kind: "tag-import", key, object }, index);
    }
    const object: TagDef = { name: linkage.name, typeIdx };
    const position = this.#module.tags.length;
    this.#module.tags.push(object);
    this.#expected.tags.push(object);
    return this.#register({ kind: "tag", key, object }, position);
  }

  reserveTable(key: PhysicalResourceKey, definition: Table): TableReservation {
    this.#require("reserving");
    this.#key(key);
    this.#importsClosed = true;
    const position = this.#module.tables.length;
    this.#module.tables.push(definition);
    this.#expected.tables.push(definition);
    return this.#register({ kind: "table", key, object: definition }, position);
  }

  reserveMemory(key: PhysicalResourceKey, definition: PhysicalModuleStorage["memories"][number]): MemoryReservation {
    this.#require("reserving");
    this.#key(key);
    this.#importsClosed = true;
    const position = this.#module.memories.length;
    this.#module.memories.push(definition);
    this.#expected.memories.push(definition);
    return this.#register({ kind: "memory", key, object: definition }, position);
  }

  reserveDataSegment(
    key: PhysicalResourceKey,
    definition: PhysicalModuleStorage["dataSegments"][number],
  ): DataReservation {
    this.#require("reserving");
    this.#key(key);
    const position = this.#module.dataSegments.length;
    this.#module.dataSegments.push(definition);
    this.#expected.dataSegments.push(definition);
    return this.#register({ kind: "data", key, object: definition }, position);
  }

  reserveString(key: PhysicalResourceKey, value: string): StringReservation {
    this.#require("reserving");
    this.#key(key);
    const position = this.#module.stringPool.length;
    this.#module.stringPool.push(value);
    this.#expected.stringPool.push(value);
    return this.#register({ kind: "string", key, object: value }, position);
  }

  freezeReservations(): void {
    this.#require("reserving");
    this.#validateResources();
    this.#state = "filling";
  }

  /** Final raw index at this frozen layout; never hand .handle to ProgramAbiMap. */
  physicalIndex(token: PhysicalReservation): number {
    if (this.#state !== "filling" && this.#state !== "sealed") this.#fail(`physical index requested in ${this.#state}`);
    this.#verifyLayout();
    this.#owned(token);
    const position = this.#positions.get(token)!;
    switch (token.kind) {
      case "function":
        return this.#importCount("func") + this.#module.funcOrdinalToPosition[token.handle - STABLE_FUNC_BASE]!;
      case "global":
        return this.#importCount("global") + position;
      case "tag":
        return this.#importCount("tag") + position;
      case "table":
        return this.#importCount("table") + position;
      case "memory":
        return this.#importCount("memory") + position;
      default:
        return position;
    }
  }

  /** Authenticate producer completion without sealing unrelated reservations. */
  assertCompletedReservation(token: FunctionReservation | GlobalReservation): void {
    if (this.#state !== "filling" && this.#state !== "sealed") this.#fail(`completion requested in ${this.#state}`);
    this.#verifyLayout();
    this.#owned(token);
    if (token.kind === "function") {
      if (!this.#filledFunctions.has(token)) this.#fail(`missing function fill ${token.key}`);
    } else if (token.kind === "global") {
      if (!this.#filledGlobals.has(token)) this.#fail(`missing global fill ${token.key}`);
    } else this.#fail("completion requires a defined function or global");
  }

  fillFunction(token: FunctionReservation, definition: { locals: LocalDef[]; body: Instr[] }): void {
    this.#require("filling");
    this.#owned(token);
    if (token.kind !== "function") this.#fail("function fill requires a defined-function token");
    if (this.#filledFunctions.has(token)) this.#fail(`duplicate function fill ${token.key}`);
    for (const local of definition.locals) this.#validateValue(local.type);
    this.#validateInstructions(definition.body);
    token.object.locals = definition.locals;
    token.object.body = definition.body;
    this.#filledFunctions.set(token, { ...definition, text: this.#snapshot(token.object) });
  }

  fillGlobal(token: GlobalReservation, initializer: Instr[]): void {
    this.#require("filling");
    this.#owned(token);
    if (token.kind !== "global") this.#fail("global fill requires a defined-global token");
    if (this.#filledGlobals.has(token)) this.#fail(`duplicate global fill ${token.key}`);
    if (initializer.length === 0) this.#fail(`global initializer is empty ${token.key}`);
    this.#validateInstructions(initializer);
    token.object.init = initializer;
    this.#filledGlobals.set(token, { init: initializer, text: this.#snapshot(initializer) });
  }

  defineElement(
    key: PhysicalResourceKey,
    table: TableReservation,
    offset: Instr[],
    functions: readonly CallableReservation[],
  ): Element {
    this.#require("filling");
    this.#key(key);
    this.#owned(table);
    if (table.kind !== "table" || table.object.elementType !== "funcref")
      this.#fail("function element requires a funcref table");
    if (offset.length === 0) this.#fail("element offset is empty");
    this.#validateInstructions(offset);
    for (const fn of functions) this.#callable(fn);
    const element: Element = {
      tableIdx: this.physicalIndex(table),
      offset,
      funcIndices: functions.map((fn) => this.physicalIndex(fn)),
    };
    this.#module.elements.push(element);
    this.#expected.elements.push(element);
    this.#publications.set(element, this.#snapshot(element));
    return element;
  }

  defineExport(key: PhysicalResourceKey, externalName: string, target: ExportableReservation): WasmExport {
    this.#require("filling");
    this.#key(key);
    this.#owned(target);
    if (this.#exportNames.has(externalName)) this.#fail(`duplicate export name ${externalName}`);
    let kind: WasmExport["desc"]["kind"];
    switch (target.kind) {
      case "function":
      case "function-import":
        kind = "func";
        break;
      case "global":
      case "global-import":
        kind = "global";
        break;
      case "tag":
      case "tag-import":
        kind = "tag";
        break;
      case "table":
        kind = "table";
        break;
      case "memory":
        kind = "memory";
        break;
      default:
        return this.#fail("resource kind cannot be exported");
    }
    const exported: WasmExport = { name: externalName, desc: { kind, index: this.physicalIndex(target) } };
    this.#exportNames.add(externalName);
    this.#module.exports.push(exported);
    this.#expected.exports.push(exported);
    this.#publications.set(exported, this.#snapshot(exported));
    return exported;
  }

  #callable(token: CallableReservation): void {
    this.#owned(token);
    if (token.kind !== "function" && token.kind !== "function-import")
      this.#fail("target is not a callable reservation");
  }

  defineStart(target: CallableReservation): number {
    this.#require("filling");
    this.#callable(target);
    if (this.#start !== undefined) this.#fail("start function already published");
    const typeIdx =
      target.kind === "function"
        ? target.object.typeIdx
        : target.object.desc.kind === "func"
          ? target.object.desc.typeIdx
          : this.#fail("start import is not a function");
    const signature = this.#functionType(typeIdx);
    if (signature.params.length || signature.results.length) this.#fail("start function must have signature () -> ()");
    const index = this.physicalIndex(target);
    this.#module.startFuncIdx = index;
    this.#start = index;
    this.#startPresent = true;
    return index;
  }

  declareFunctionReference(target: CallableReservation): void {
    this.#require("filling");
    this.#callable(target);
    if (this.#module.declaredFuncRefs.includes(target.handle)) this.#fail("duplicate declarative function reference");
    this.#module.declaredFuncRefs.push(target.handle);
    this.#expected.declaredFuncRefs.push(target.handle);
  }

  /** Only completed, unchanged actual resources contribute to this census. */
  seal(): PhysicalModuleCensus {
    this.#require("filling");
    this.#validateResources();
    for (const token of this.#tokens) {
      if (token.kind === "function" && !this.#filledFunctions.has(token))
        this.#fail(`missing function fill ${token.key}`);
      if (token.kind === "global" && !this.#filledGlobals.has(token)) this.#fail(`missing global fill ${token.key}`);
    }
    this.#validateDeclaredFunctionReferences();
    this.#state = "sealed";
    const m = this.#module;
    return Object.freeze({
      types: this.#flatTypes().length,
      imports: m.imports.length,
      functions: m.functions.length,
      globals: m.globals.length,
      tags: m.tags.length,
      tables: m.tables.length,
      elements: m.elements.length,
      exports: m.exports.length,
      memories: m.memories.length,
      dataSegments: m.dataSegments.length,
      strings: m.stringPool.length,
      declaredFuncRefs: m.declaredFuncRefs.length,
      completedFunctions: this.#filledFunctions.size,
      completedGlobals: this.#filledGlobals.size,
    });
  }

  #index(index: number, count: number, kind: string): void {
    if (!Number.isInteger(index) || index < 0 || index >= count) this.#fail(`unresolved ${kind} index ${index}`);
  }

  /** Retain exact nested type objects alongside the existing content snapshot. */
  #typeMembers(type: TypeDef): TypeDef[] {
    if (type.kind === "rec") return type.types.flatMap((member) => [member, ...this.#typeMembers(member)]);
    return type.kind === "sub" ? [type.type] : [];
  }

  /** Wasm rec wrappers occupy no index; each subtype/member occupies one. */
  #flatTypes(): Exclude<TypeDef, { kind: "rec" }>[] {
    try {
      return indexPhysicalTypes(this.#module.types).entries.map((entry) => entry.definition);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
    }
  }

  #type(index: number): Exclude<TypeDef, { kind: "rec" } | { kind: "sub" }> {
    const flat = this.#flatTypes();
    this.#index(index, flat.length, "type");
    const type = flat[index]!;
    return type.kind === "sub" ? type.type : type;
  }

  #functionType(index: number): FuncTypeDef {
    const type = this.#type(index);
    if (type.kind !== "func") this.#fail(`type ${index} is not a function signature`);
    return type;
  }

  #validateValue(value: ValType): void {
    if (value.kind === "ref" || value.kind === "ref_null") {
      this.#type(value.typeIdx);
    }
  }

  #validateType(type: TypeDef): void {
    switch (type.kind) {
      case "func":
        for (const value of [...type.params, ...type.results]) this.#validateValue(value);
        break;
      case "struct":
        if (
          type.superTypeIdx !== undefined &&
          type.superTypeIdx !== -1 &&
          this.#type(type.superTypeIdx).kind !== "struct"
        ) {
          this.#fail("struct parent is not a struct");
        }
        for (const field of type.fields) this.#validateValue(field.type);
        break;
      case "array":
        this.#validateValue(type.element);
        break;
      case "rec":
        for (const member of type.types) this.#validateType(member);
        break;
      case "sub":
        if (type.superType !== null) {
          this.#type(type.superType);
        }
        this.#validateType(type.type);
        break;
    }
  }

  #validateCanonicalGroup(): void {
    const group = this.#module.canonicalRuntimeRecGroup;
    if (group === undefined) return;
    const flat = this.#flatTypes();
    this.#index(group.start, flat.length, "canonical rec-group start");
    this.#index(group.end, flat.length, "canonical rec-group end");
    if (group.end < group.start || !Number.isInteger(group.abiVersion) || group.abiVersion < 1) {
      this.#fail("invalid canonical runtime rec-group descriptor");
    }
    this.#planTypes([[group.start, group.end]]);
  }

  #planTypes(forced: ReadonlyArray<readonly [number, number]> = []): void {
    try {
      planPhysicalTypeSection(indexPhysicalTypes(this.#module.types), forced);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
    }
  }

  #functionIndex(handle: FuncHandle): number {
    if (handle >= STABLE_FUNC_BASE) {
      const position = this.#module.funcOrdinalToPosition[handle - STABLE_FUNC_BASE];
      if (position === undefined) this.#fail(`unresolved function handle ${handle}`);
      this.#index(position, this.#module.functions.length, "defined function");
      return this.#importCount("func") + position;
    }
    this.#index(handle, this.#importCount("func") + this.#module.functions.length, "function");
    return handle;
  }

  #validateDeclaredFunctionReferences(): void {
    const declared = new Set<number>();
    for (const handle of this.#module.declaredFuncRefs) declared.add(this.#functionIndex(handle));
    for (const element of this.#module.elements) {
      for (const handle of element.funcIndices) declared.add(this.#functionIndex(handle));
      this.#validateInstructions(element.offset, declared);
    }
    for (const global of this.#module.globals) this.#validateInstructions(global.init, declared);
    for (const exported of this.#module.exports) {
      if (exported.desc.kind === "func") declared.add(this.#functionIndex(exported.desc.index));
    }
    // Publication is complete now. Startup alone and other function bodies
    // are not declaration routes (the existing #4257/emitter contract).
    for (const fn of this.#module.functions) {
      const used = new Set<number>();
      this.#validateInstructions(fn.body, used);
      for (const index of used) {
        if (!declared.has(index)) this.#fail(`undeclared ref.func target ${index} in ${fn.name}`);
      }
    }
  }

  #validateResources(): void {
    const m = this.#module;
    this.#validateCanonicalGroup();
    for (const type of m.types) this.#validateType(type);
    this.#planTypes();
    for (const imp of m.imports) {
      if (imp.desc.kind === "func" || imp.desc.kind === "tag") {
        const signature = this.#functionType(imp.desc.typeIdx);
        if (imp.desc.kind === "tag" && signature.results.length) this.#fail("tag import has results");
      } else if (imp.desc.kind === "global") this.#validateValue(imp.desc.type);
    }
    for (const fn of m.functions) this.#functionType(fn.typeIdx);
    for (const global of m.globals) this.#validateValue(global.type);
    for (const tag of m.tags) if (this.#functionType(tag.typeIdx).results.length) this.#fail("tag has results");
    const positions = new Set<number>();
    for (const position of m.funcOrdinalToPosition) {
      this.#index(position, m.functions.length, "function ordinal");
      if (positions.has(position)) this.#fail("duplicate function ordinal position");
      positions.add(position);
    }
    if (positions.size !== m.functions.length) this.#fail("function lacks minted ordinal");
    if (m.functions.length + this.#importCount("func") >= STABLE_FUNC_BASE)
      this.#fail("physical function space overlaps stable handles");
    for (const descriptor of [...m.tables, ...m.memories]) {
      if (
        !Number.isInteger(descriptor.min) ||
        descriptor.min < 0 ||
        (descriptor.max !== undefined && (!Number.isInteger(descriptor.max) || descriptor.max < descriptor.min))
      ) {
        this.#fail("invalid table/memory limits");
      }
    }
    for (const data of m.dataSegments) {
      if (!data.passive) {
        this.#index(0, m.memories.length + this.#importCount("memory"), "active data memory");
        if (!Number.isInteger(data.offset) || data.offset < 0) this.#fail("invalid active data offset");
      }
    }
  }

  #validateInstructions(body: Instr[], refTargets?: Set<number>): void {
    const m = this.#module;
    for (const instr of body) {
      if ("funcIdx" in instr) {
        const index = this.#functionIndex(instr.funcIdx);
        if (instr.op === "ref.func") refTargets?.add(index);
      }
      if ("typeIdx" in instr) {
        // Existing abstract heap immediates are not module indices.
        const abstractHeap =
          ["ref.cast", "ref.cast_null", "ref.test", "ref.null"].includes(instr.op) &&
          [-16, -17, -18, -19, -20, -21, -22, -23, -24, -25].includes(instr.typeIdx);
        if (!abstractHeap) {
          const type = this.#type(instr.typeIdx);
          if (
            (instr.op.startsWith("struct.") && type.kind !== "struct") ||
            (instr.op.startsWith("array.") && type.kind !== "array")
          )
            this.#fail(`wrong resource kind for ${instr.op}`);
          if (["call_indirect", "call_ref", "return_call_ref"].includes(instr.op)) this.#functionType(instr.typeIdx);
          if ("fieldIdx" in instr && type.kind === "struct")
            this.#index(instr.fieldIdx, type.fields.length, "struct field");
        }
      }
      if (instr.op === "array.copy") {
        if (this.#type(instr.dstTypeIdx).kind !== "array" || this.#type(instr.srcTypeIdx).kind !== "array")
          this.#fail("array.copy requires array types");
      }
      if (instr.op === "global.get" || instr.op === "global.set")
        this.#index(instr.index, this.#importCount("global") + m.globals.length, "global");
      if ("tableIdx" in instr) this.#index(instr.tableIdx, this.#importCount("table") + m.tables.length, "table");
      if ("tagIdx" in instr) this.#index(instr.tagIdx, this.#importCount("tag") + m.tags.length, "tag");
      if ("dataIdx" in instr) this.#index(instr.dataIdx, m.dataSegments.length, "data segment");
      if (instr.op.startsWith("memory.") || "align" in instr)
        this.#index(0, this.#importCount("memory") + m.memories.length, "memory");
      if ("blockType" in instr) {
        if (instr.blockType.kind === "val") this.#validateValue(instr.blockType.type);
        if (instr.blockType.kind === "type") this.#functionType(instr.blockType.typeIdx);
      }
      if ("body" in instr) this.#validateInstructions(instr.body, refTargets);
      if (instr.op === "if") {
        this.#validateInstructions(instr.then, refTargets);
        if (instr.else) this.#validateInstructions(instr.else, refTargets);
      }
      if (instr.op === "try" || instr.op === "try_table") {
        for (const clause of instr.catches) {
          if (clause.tagIdx !== undefined)
            this.#index(clause.tagIdx, this.#importCount("tag") + m.tags.length, "catch tag");
          else if ("kind" in clause && (clause.kind === "catch" || clause.kind === "catch_ref"))
            this.#fail("tagged catch has no tag");
          if ("body" in clause) this.#validateInstructions(clause.body, refTargets);
        }
        if (instr.op === "try" && instr.catchAll) this.#validateInstructions(instr.catchAll, refTargets);
      }
    }
  }
}
