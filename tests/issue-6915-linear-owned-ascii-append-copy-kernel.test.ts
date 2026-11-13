// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as linearCodegen from "../src/codegen-linear/index.js";
import * as runtime from "../src/codegen-linear/runtime.js";
import { walkInstructions } from "../src/codegen/walk-instructions.js";
import { emitBinary } from "../src/emit/binary.js";
import { resolveLayout } from "../src/emit/resolve-layout.js";
import { compile } from "../src/index.js";
import { getLastLinearIrReport, type LinearIrResult } from "../src/ir/backend/linear-integration.js";
import { assertFrozenIrBodyBatch, type FrozenIrBodyBatch } from "../src/ir/frozen-body-batch.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import { freezePreparedIrValue, preparedIrReadonlyMap } from "../src/ir/program.js";
import {
  LinearMemoryPlan,
  LINEAR_STRING_ELEMENTS_OFFSET as DATA,
  LINEAR_STRING_LENGTH_OFFSET as LENGTH,
  LINEAR_STRING_PAYLOAD_SIZE_OFFSET as SIZE,
  LINEAR_STRING_PAYLOAD_PREFIX_BYTES as PREFIX,
} from "../src/ir/analysis/linear-memory-plan.js";
import { createEmptyModule, type Instr, type WasmFunction, type WasmModule } from "../src/ir/types.js";

type Consumption = {
  batch: FrozenIrBodyBatch;
  backend: string;
  moduleSession: object | undefined;
  completed: boolean;
  outputs: { ownerUnitId: string; func: IrFunction; body: unknown }[];
  failure?: unknown;
};
const captures = vi.hoisted(() => ({
  modules: [] as WasmModule[],
  consumers: [] as Consumption[],
  restorers: [] as (() => void)[],
}));
// Transparent observation, not an alternate implementation or lowering adapter.
vi.mock("../src/codegen-linear/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codegen-linear/runtime.js")>();
  const original = actual.addLinearIrStringRuntime;
  const spy = vi.spyOn(actual, "addLinearIrStringRuntime").mockImplementation(function (this: unknown, ...args) {
    captures.modules.push(args[0]);
    return Reflect.apply(original, this, args);
  });
  captures.restorers.push(() => spy.mockRestore());
  return { ...actual, addLinearIrStringRuntime: spy };
});
vi.mock("../src/ir/backend/frozen-body-consumer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/backend/frozen-body-consumer.js")>();
  const original = actual.consumeFrozenIrBodyBatchWithFactories;
  const spy = vi.spyOn(actual, "consumeFrozenIrBodyBatchWithFactories").mockImplementation(function <B, V>(
    this: unknown,
    ...args: Parameters<typeof original<B, V>>
  ) {
    const input = args[0];
    const receipt: Consumption = {
      batch: input.batch,
      backend: input.backend,
      moduleSession: input.factories.moduleSession,
      completed: false,
      outputs: [],
    };
    captures.consumers.push(receipt);
    try {
      const result: ReturnType<typeof original<B, V>> = Reflect.apply(original<B, V>, this, args);
      receipt.outputs = result.map((output) => ({
        ownerUnitId: output.ownerUnitId,
        func: output.func,
        body: output.lowered.body,
      }));
      receipt.completed = true;
      return result;
    } catch (error) {
      receipt.failure = error;
      throw error;
    }
  });
  captures.restorers.push(() => spy.mockRestore());
  return { ...actual, consumeFrozenIrBodyBatchWithFactories: spy };
});

const TEST_PATH = "tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts";
const SOURCE_PATH = "website/public/benchmarks/competitive/programs/string-hash.js";
const FIXTURE_SHA = "66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c";
const BASELINE = "c41bca2bc07e9d8fddbb38ca77904dd1f0cac438";
const OPTIONS = { target: "linear", allocator: "bump", fileName: SOURCE_PATH } as const;
const APPEND = runtime.LINEAR_IR_STRING_APPEND_ASCII_FN;
const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
const IDS = [
  ...numbered("Runtime", 22),
  ...numbered("Source", 4),
  ...numbered("Import", 2),
  ...numbered("Negative", 8),
];
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const align8 = (size: number) => Math.ceil(size / 8) * 8;
const observed: string[] = [];
const failures: string[] = [];
const actionFailures: string[] = [];
const schemaFailures: string[] = [];
const emissionFailures: string[] = [];
const hookCleanupErrors: unknown[] = [];
type Outcome = { status: "passed" } | { status: "failed"; error: unknown };
type ParentIdentity = {
  runtime: string;
  consumer: string;
  integration: string;
  sourceTree: string;
  testSha256: string;
  fixture: string;
  head: string;
  command: string;
  effectiveFlags: { linearIr: "1"; nodeOptions: string | null; execArgv: string[] };
};
let approved: ParentIdentity | undefined;

type Artifact = { binaryBase64: string; sha256: string; byteLength: number; valid: boolean };
type MemoryState = { memoryBase64: string; byteLength: number; heap: number };
type Carrier = { pointer: number; header: number[]; capacity: number; length: number; payload: number[] };
type Construction = {
  kind: "C" | "S";
  bytes: number[];
  rawPointer: number;
  canonicalPointer: number;
  pointer: number;
  seedEmptyPointer: number | null;
};
type Transition = {
  before: MemoryState;
  after: MemoryState;
  left: Carrier;
  right: Carrier;
  result: Carrier;
  heapDelta: number;
  inferredAllocations: number;
  allocationCountAuthority: "installed-single-growth-malloc-call";
};
type Binding = { index: number; imports: number; helper: WasmFunction; mallocIndex: number };
type RuntimeProof = {
  kind: "runtime";
  module: WasmModule;
  artifact: Artifact;
  binding: Binding;
  construction: Construction[];
  transitions: Transition[];
  hostCalls: { unrelated: number; namesake: number };
  imported: boolean;
};
type SourceProof = {
  kind: "source";
  source: string;
  sourceSha256: string;
  options: typeof OPTIONS;
  input: number;
  expected: number;
  native: number;
  actual: number;
  module: WasmModule;
  artifact: Artifact;
  binding: Binding;
  // Detached projection excludes unrelated preparation plans containing cyclic ASTs.
  // The batch/module/function references remain the actual compiler-owned objects.
  report: Pick<LinearIrResult, "compiled" | "rejected" | "ownerEvidence" | "irModule" | "frozenBodyBatch" | "funcs">;
  receipt: Consumption;
  registrationModules: WasmModule[];
  logical: IrFunction;
  physical: WasmFunction;
  ownerUnitId: string;
  callIndices: number[];
  appendExecutionAuthority: "physical-call-binding-not-dynamic-counter";
};
type Positive = RuntimeProof | SourceProof;
type SourceProgress = {
  stage: "source";
  input: number;
  expected: number;
  sourceSha256: string;
  compile?: { success: boolean; errors: unknown };
  artifact?: Artifact;
  report?: {
    compiled: readonly string[];
    rejected: LinearIrResult["rejected"];
    ownerEvidence: LinearIrResult["ownerEvidence"];
  };
  consumers?: {
    digest: string;
    completed: boolean;
    backend: string;
    owners: FrozenIrBodyBatch["owners"];
    failure: string | null;
  }[];
};
type RuntimeProgress = {
  stage: "runtime";
  artifact?: Artifact;
  construction: Construction[];
  transitions: Transition[];
};
type NegativeProof = {
  stage: "negative";
  mutation: string;
  original: Positive;
  corrupted: Positive;
  rejected: boolean;
  rejection: string | null;
};
type Progress = { stage: "setup" } | SourceProgress | RuntimeProgress | Positive | NegativeProof;
type Journal = { evidence: Progress };
type RecordRow =
  | {
      kind: "provenance";
      schema: "6915-append-baseline-v2";
      issue: 6915;
      head: string;
      sourceTree: string;
      baseline: string;
      baselineSourceTree: string;
      sourceDirty: string;
      testSha256: string;
      fixtureSha256: string;
      productionHashes: { runtime: string; consumer: string; integration: string };
      options: typeof OPTIONS;
      node: string;
      v8: string;
      execArgv: string[];
      argv: string[];
      nodeOptions: string | null;
      linearIrFlag: string | null;
      command: string | null;
      ids: string[];
      expectedObservations: 36;
    }
  | {
      kind: "observation";
      id: string;
      passed: boolean;
      evidence: Progress;
      action: Outcome;
      schema: Outcome;
      emission: Outcome;
    }
  | {
      kind: "completion";
      ids: string[];
      duplicates: string[];
      missing: string[];
      unexpected: string[];
      failures: string[];
      actionFailures: string[];
      schemaFailures: string[];
      emissionFailures: string[];
      cleanupErrors: unknown[];
      passed: boolean;
      expectedObservations: 36;
    };

type GraphValue =
  | null
  | boolean
  | string
  | number
  | { ref: number }
  | { tag: "undefined" }
  | { tag: "bigint"; decimal: string }
  | { tag: "number"; value: "nan" | "+infinity" | "-infinity" | "-0" };
type GraphProperty = { key: string; value: GraphValue } & (
  | { descriptor: "data"; enumerable: boolean; configurable: boolean; writable: boolean }
  | {
      descriptor: "native-error-stack";
      getter: "fresh-native-error-getter";
      setter: "fresh-native-error-setter";
      enumerable: false;
      configurable: true;
    }
);
type GraphBase = { id: number; prototype: string; properties: GraphProperty[] };
type GraphNode = GraphBase &
  (
    | { kind: "object" | "array" | "error" }
    | { kind: "map"; size: number; entries: [GraphValue, GraphValue][] }
    | { kind: "set"; size: number; values: GraphValue[] }
    | { kind: "array-buffer"; byteLength: number; bytesBase64: string }
    | {
        kind: "typed-array" | "data-view";
        byteLength: number;
        byteOffset: number;
        buffer: GraphValue;
        bytesBase64: string;
      }
  );
type Graph = { root: GraphValue; nodes: GraphNode[] };
const MAX_NODES = 250_000;
const MAX_FIELDS = 2_000_000;
const MAX_BYTES = 64 * 1024 * 1024;
const frozenMapPrototype: unknown = Object.getPrototypeOf(preparedIrReadonlyMap([]));
const frozenSetPrototype: unknown = Object.getPrototypeOf(freezePreparedIrValue(new Set()));
const nativeStackReference = Object.getOwnPropertyDescriptor(new Error("stack reference one"), "stack");
const independentStackReference = Object.getOwnPropertyDescriptor(new Error("stack reference two"), "stack");
function isFrozenMap(value: object): value is ReadonlyMap<unknown, unknown> {
  return Object.getPrototypeOf(value) === frozenMapPrototype;
}
function isFrozenSet(value: object): value is ReadonlySet<unknown> {
  return Object.getPrototypeOf(value) === frozenSetPrototype;
}
function requireCondition(condition: boolean, detail: string): asserts condition {
  if (!condition) throw new Error(`6915 evidence: ${detail}`);
}
function integer(value: unknown, maximum: number, label: string): asserts value is number {
  requireCondition(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum, label);
}
function text(value: unknown, label: string): asserts value is string {
  requireCondition(typeof value === "string", label);
}
function fields(value: unknown, required: string[], optional: string[] = []): void {
  requireCondition(value !== null && typeof value === "object", "record is not an object");
  const keys = Reflect.ownKeys(value);
  requireCondition(
    required.every((key) => keys.includes(key)),
    "missing required field",
  );
  requireCondition(
    keys.every((key) => typeof key === "string" && [...required, ...optional].includes(key)),
    "unknown field",
  );
}
function field(value: unknown, key: string): unknown {
  requireCondition(value !== null && typeof value === "object", "field owner is not an object");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  requireCondition(descriptor !== undefined && "value" in descriptor, `missing/data-only field ${key}`);
  const result: unknown = descriptor.value;
  return result;
}
function list(value: unknown, maximum = MAX_FIELDS): asserts value is unknown[] {
  requireCondition(Array.isArray(value) && value.length <= maximum, "invalid/big collection");
}
function strings(value: unknown, maximum = MAX_FIELDS): asserts value is string[] {
  list(value, maximum);
  for (const item of value) text(item, "non-string collection member");
}
function encodeGraph(root: unknown): Graph {
  const nodes: GraphNode[] = [];
  const ids = new WeakMap<object, number>();
  let fieldCount = 0;
  let byteCount = 0;
  let textBytes = 0;
  const dataValue = (owner: object, key: string): unknown => {
    let current: object | null = owner;
    for (let hops = 0; current !== null && hops < 32; hops++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        requireCondition("value" in descriptor, `unsupported inherited accessor ${key}`);
        const result: unknown = descriptor.value;
        return result;
      }
      const next: unknown = Object.getPrototypeOf(current);
      requireCondition(next === null || typeof next === "object", "invalid descriptor-walk prototype");
      current = next;
    }
    throw new Error(`6915 evidence: missing/deep data descriptor ${key}`);
  };
  const encode = (value: unknown, depth: number): GraphValue => {
    requireCondition(depth <= 256, "graph depth exceeded");
    if (typeof value === "string") {
      textBytes += Buffer.byteLength(value);
      requireCondition(textBytes <= MAX_BYTES, "graph string cap exceeded");
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (value === undefined) return { tag: "undefined" };
    if (typeof value === "bigint") return { tag: "bigint", decimal: value.toString(10) };
    if (typeof value === "number") {
      if (Number.isNaN(value)) return { tag: "number", value: "nan" };
      if (value === Infinity) return { tag: "number", value: "+infinity" };
      if (value === -Infinity) return { tag: "number", value: "-infinity" };
      if (Object.is(value, -0)) return { tag: "number", value: "-0" };
      return value;
    }
    requireCondition(typeof value === "object", `unsupported ${typeof value}`);
    const prior = ids.get(value);
    if (prior !== undefined) return { ref: prior };
    requireCondition(nodes.length < MAX_NODES, "graph node cap exceeded");
    const id = nodes.length;
    ids.set(value, id);
    // Finish every own-descriptor check before any native stack materialization.
    const descriptors: { key: string; descriptor: PropertyDescriptor }[] = [];
    for (const key of Reflect.ownKeys(value)) {
      requireCondition(typeof key === "string", "unsupported symbol property");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireCondition(descriptor !== undefined, "missing own descriptor");
      if (!("value" in descriptor))
        requireCondition(
          value instanceof Error &&
            key === "stack" &&
            typeof nativeStackReference?.get === "function" &&
            typeof nativeStackReference.set === "function" &&
            nativeStackReference.get === independentStackReference?.get &&
            nativeStackReference.set === independentStackReference?.set &&
            descriptor.get === nativeStackReference.get &&
            descriptor.set === nativeStackReference.set &&
            descriptor.enumerable === false &&
            descriptor.configurable === true,
          "unsupported accessor property",
        );
      descriptors.push({ key, descriptor });
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    // Do not mistake an ordinary own `constructor` data field for its prototype.
    let prototypeConstructor: unknown = null;
    if (prototype !== null) {
      requireCondition(typeof prototype === "object" && prototype !== null, "prototype must be an object");
      prototypeConstructor = dataValue(prototype, "constructor");
    }
    requireCondition(
      prototypeConstructor === null || typeof prototypeConstructor === "function",
      "unknown object prototype",
    );
    const name = prototypeConstructor === null ? "null" : dataValue(prototypeConstructor, "name");
    text(name, "constructor name must be data text");
    if (value instanceof Error) {
      text(dataValue(value, "name"), "Error name must be data text");
      text(dataValue(value, "message"), "Error message must be data text");
    }
    const properties: GraphProperty[] = [];
    const common = { id, prototype: name, properties };
    nodes.push({ ...common, kind: "object" }); // Reserve identity before descending into cycles.
    let node: GraphNode;
    if (value instanceof Map || isFrozenMap(value)) {
      const entries = [...value.entries()];
      requireCondition(entries.length === value.size, "map population mismatch");
      fieldCount += entries.length * 2;
      requireCondition(fieldCount <= MAX_FIELDS, "map entry cap exceeded");
      node = {
        ...common,
        kind: "map",
        size: value.size,
        entries: entries.map(([key, item]) => [encode(key, depth + 1), encode(item, depth + 1)]),
      };
    } else if (value instanceof Set || isFrozenSet(value)) {
      const items = [...value.values()];
      requireCondition(items.length === value.size, "set population mismatch");
      fieldCount += items.length;
      requireCondition(fieldCount <= MAX_FIELDS, "set entry cap exceeded");
      node = { ...common, kind: "set", size: value.size, values: items.map((item) => encode(item, depth + 1)) };
    } else if (value instanceof ArrayBuffer) {
      byteCount += value.byteLength;
      node = {
        ...common,
        kind: "array-buffer",
        byteLength: value.byteLength,
        bytesBase64: base64(new Uint8Array(value)),
      };
    } else if (ArrayBuffer.isView(value)) {
      byteCount += value.byteLength;
      node = {
        ...common,
        kind: value instanceof DataView ? "data-view" : "typed-array",
        byteLength: value.byteLength,
        byteOffset: value.byteOffset,
        buffer: encode(value.buffer, depth + 1),
        bytesBase64: base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      };
    } else {
      requireCondition(
        Array.isArray(value) ||
          value instanceof Error ||
          value instanceof LinearMemoryPlan ||
          prototype === null ||
          prototype === Object.prototype,
        `unsupported object ${name}`,
      );
      node = { ...common, kind: Array.isArray(value) ? "array" : value instanceof Error ? "error" : "object" };
    }
    requireCondition(byteCount <= MAX_BYTES, "graph byte cap exceeded");
    for (const { key, descriptor } of descriptors) {
      if (!("value" in descriptor)) {
        requireCondition(
          value instanceof Error &&
            key === "stack" &&
            typeof nativeStackReference?.get === "function" &&
            typeof nativeStackReference.set === "function" &&
            nativeStackReference.get === independentStackReference?.get &&
            nativeStackReference.set === independentStackReference?.set &&
            descriptor.get === nativeStackReference.get &&
            descriptor.set === nativeStackReference.set &&
            descriptor.enumerable === false &&
            descriptor.configurable === true,
          "unsupported accessor property",
        );
        const stack: unknown = Reflect.apply(nativeStackReference.get, value, []);
        text(stack, "native Error stack must be text");
        requireCondition(++fieldCount <= MAX_FIELDS, "graph field cap exceeded");
        properties.push({
          key,
          value: encode(stack, depth + 1),
          descriptor: "native-error-stack",
          getter: "fresh-native-error-getter",
          setter: "fresh-native-error-setter",
          enumerable: false,
          configurable: true,
        });
        continue;
      }
      const item: unknown = descriptor.value;
      requireCondition(++fieldCount <= MAX_FIELDS, "graph field cap exceeded");
      properties.push({
        key,
        descriptor: "data",
        value: encode(item, depth + 1),
        enumerable: descriptor.enumerable === true,
        configurable: descriptor.configurable === true,
        writable: descriptor.writable === true,
      });
    }
    nodes[id] = node;
    return { ref: id };
  };
  return { root: encode(root, 0), nodes };
}
function validateGraph(graph: Graph): void {
  fields(graph, ["root", "nodes"]);
  list(graph.nodes, MAX_NODES);
  const references: number[] = [];
  const atom = (value: GraphValue): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      requireCondition(Number.isFinite(value) && !Object.is(value, -0), "untagged special number");
      return;
    }
    if ("ref" in value) {
      fields(value, ["ref"]);
      integer(value.ref, graph.nodes.length - 1, "dangling graph reference");
      references.push(value.ref);
      return;
    }
    if (value.tag === "undefined") {
      fields(value, ["tag"]);
      return;
    }
    if (value.tag === "bigint") {
      fields(value, ["tag", "decimal"]);
      text(value.decimal, "BigInt decimal type");
      requireCondition(
        /^(0|-?[1-9][0-9]*)$/.test(value.decimal) && BigInt(value.decimal).toString(10) === value.decimal,
        "noncanonical BigInt",
      );
      return;
    }
    fields(value, ["tag", "value"]);
    requireCondition(
      value.tag === "number" && ["nan", "+infinity", "-infinity", "-0"].includes(value.value),
      "unknown scalar tag",
    );
  };
  atom(graph.root);
  let fieldsSeen = 0;
  for (const [index, node] of graph.nodes.entries()) {
    integer(node.id, MAX_NODES, "graph node ID");
    requireCondition(node.id === index, "duplicate/noncanonical node ID");
    text(node.prototype, "node prototype");
    list(node.properties, MAX_FIELDS);
    const keys = new Set<string>();
    for (const property of node.properties) {
      fields(
        property,
        property.descriptor === "data"
          ? ["key", "value", "descriptor", "enumerable", "configurable", "writable"]
          : ["key", "value", "descriptor", "getter", "setter", "enumerable", "configurable"],
      );
      text(property.key, "property key");
      requireCondition(!keys.has(property.key) && ++fieldsSeen <= MAX_FIELDS, "duplicate/too many graph fields");
      keys.add(property.key);
      if (property.descriptor === "data")
        requireCondition(
          [property.enumerable, property.configurable, property.writable].every((flag) => typeof flag === "boolean"),
          "descriptor flags",
        );
      else
        requireCondition(
          property.descriptor === "native-error-stack" &&
            node.kind === "error" &&
            property.key === "stack" &&
            property.getter === "fresh-native-error-getter" &&
            property.setter === "fresh-native-error-setter" &&
            property.enumerable === false &&
            property.configurable === true &&
            typeof property.value === "string",
          "native stack accessor markers",
        );
      atom(property.value);
    }
    const common = ["id", "prototype", "properties", "kind"];
    if (node.kind === "map") {
      fields(node, [...common, "size", "entries"]);
      list(node.entries);
      integer(node.size, MAX_FIELDS, "map size");
      requireCondition(node.entries.length === node.size, "lost map entries");
      requireCondition(
        new Set(node.entries.map(([key]) => JSON.stringify(key))).size === node.size,
        "duplicate map keys",
      );
      for (const pair of node.entries) {
        list(pair, 2);
        requireCondition(pair.length === 2, "map pair");
        atom(pair[0]);
        atom(pair[1]);
      }
    } else if (node.kind === "set") {
      fields(node, [...common, "size", "values"]);
      list(node.values);
      integer(node.size, MAX_FIELDS, "set size");
      requireCondition(node.values.length === node.size, "lost set entries");
      for (const item of node.values) atom(item);
      requireCondition(
        new Set(node.values.map((value) => JSON.stringify(value))).size === node.size,
        "duplicate set values",
      );
    } else if (node.kind === "array-buffer" || node.kind === "typed-array" || node.kind === "data-view") {
      fields(
        node,
        node.kind === "array-buffer"
          ? [...common, "byteLength", "bytesBase64"]
          : [...common, "byteLength", "bytesBase64", "byteOffset", "buffer"],
      );
      integer(node.byteLength, MAX_BYTES, "buffer size");
      text(node.bytesBase64, "buffer encoding");
      const bytes = Buffer.from(node.bytesBase64, "base64");
      requireCondition(
        bytes.byteLength === node.byteLength && base64(bytes) === node.bytesBase64,
        "noncanonical/lost buffer bytes",
      );
      if (node.kind !== "array-buffer") {
        integer(node.byteOffset, MAX_BYTES, "view offset");
        atom(node.buffer);
        requireCondition(
          node.buffer !== null && typeof node.buffer === "object" && "ref" in node.buffer,
          "view buffer is not a node",
        );
        const buffer = graph.nodes[node.buffer.ref];
        requireCondition(
          buffer?.kind === "array-buffer" && node.byteOffset + node.byteLength <= buffer.byteLength,
          "view outside buffer",
        );
        const backing = Buffer.from(buffer.bytesBase64, "base64");
        requireCondition(
          base64(backing.subarray(node.byteOffset, node.byteOffset + node.byteLength)) === node.bytesBase64,
          "view/backing byte disagreement",
        );
      }
    } else {
      fields(node, common);
      requireCondition(["object", "array", "error"].includes(node.kind), "unknown graph node");
    }
  }
  // Explicit edges also establish that no node was silently summarized or orphaned.
  const reached = new Set<number>();
  const pending: GraphValue[] = [graph.root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (
      value === undefined ||
      value === null ||
      typeof value !== "object" ||
      !("ref" in value) ||
      reached.has(value.ref)
    )
      continue;
    reached.add(value.ref);
    const node = graph.nodes[value.ref];
    for (const property of node.properties) pending.push(property.value);
    if (node.kind === "map") for (const [key, item] of node.entries) pending.push(key, item);
    if (node.kind === "set") for (const item of node.values) pending.push(item);
    if (node.kind === "typed-array" || node.kind === "data-view") pending.push(node.buffer);
  }
  requireCondition(
    reached.size === graph.nodes.length && references.every((id) => reached.has(id)),
    "unreachable graph nodes",
  );
}
function emit(row: RecordRow): void {
  const graph = encodeGraph(row);
  validateGraph(graph);
  console.log(
    JSON.stringify({
      schema: "6915-evidence-graph-v1",
      issue: 6915,
      kind: row.kind,
      id: row.kind === "observation" ? row.id : null,
      graph,
    }),
  );
}
function errorText(error: unknown): string {
  try {
    const graph = encodeGraph(error);
    validateGraph(graph);
    if (error instanceof Error) {
      const stack = graph.nodes[0]?.properties.find((property) => property.key === "stack");
      requireCondition(stack !== undefined && typeof stack.value === "string", "diagnostic Error stack is not text");
      return stack.value;
    }
    return JSON.stringify({ schema: "6915-diagnostic-value-v1", graph });
  } catch {
    // Never coerce an unsupported thrown object; the original remains in aggregation.
    return "[6915 incomplete-evidence: unsupported diagnostic value]";
  }
}
function diagnostic(id: string | null, action: Outcome, schema: Outcome, emission: Outcome): void {
  console.log(
    JSON.stringify({
      schema: "6915-incomplete-evidence-v1",
      issue: 6915,
      kind: "diagnostic",
      id,
      passed: false,
      actionFailure: action.status === "failed" ? errorText(action.error) : null,
      schemaFailure: schema.status === "failed" ? errorText(schema.error) : null,
      emissionFailure: emission.status === "failed" ? errorText(emission.error) : null,
    }),
  );
}
function runCleanups(actions: (() => void)[]): unknown[] {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
function throwRetained(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message, { cause: errors[0] });
}
async function observation(id: string, action: (journal: Journal) => Promise<void>): Promise<void> {
  const journal: Journal = { evidence: { stage: "setup" } };
  let actionOutcome: Outcome = { status: "passed" };
  let schemaOutcome: Outcome = { status: "passed" };
  let emissionOutcome: Outcome = { status: "passed" };
  try {
    await action(journal);
  } catch (error) {
    actionOutcome = { status: "failed", error };
  }
  observed.push(id);
  const row: Extract<RecordRow, { kind: "observation" }> = {
    kind: "observation",
    id,
    passed: actionOutcome.status === "passed",
    evidence: journal.evidence,
    action: actionOutcome,
    schema: schemaOutcome,
    emission: emissionOutcome,
  };
  try {
    validateRecord(row, approved);
  } catch (error) {
    schemaOutcome = { status: "failed", error };
    row.schema = schemaOutcome;
    row.passed = false;
  }
  try {
    if (schemaOutcome.status === "failed") diagnostic(id, actionOutcome, schemaOutcome, emissionOutcome);
    else emit(row);
  } catch (error) {
    emissionOutcome = { status: "failed", error };
    try {
      diagnostic(id, actionOutcome, schemaOutcome, emissionOutcome);
    } catch (diagnosticError) {
      emissionOutcome = {
        status: "failed",
        error: new AggregateError([error, diagnosticError], "full and incomplete evidence emission failed"),
      };
    }
  }
  if (actionOutcome.status === "failed") actionFailures.push(id);
  if (schemaOutcome.status === "failed") schemaFailures.push(id);
  if (emissionOutcome.status === "failed") emissionFailures.push(id);
  const errors = [actionOutcome, schemaOutcome, emissionOutcome].flatMap((outcome) =>
    outcome.status === "failed" ? [outcome.error] : [],
  );
  if (errors.length > 0) {
    failures.push(id);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `${id}: action/schema/emission failures retained`, { cause: errors[0] });
  }
}
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
function parseParentIdentity(input: unknown): ParentIdentity {
  text(input, "JS2WASM_APPEND_EXPECTED_PROVENANCE is required");
  const value: unknown = JSON.parse(input);
  fields(value, [
    "runtime",
    "consumer",
    "integration",
    "sourceTree",
    "testSha256",
    "fixture",
    "head",
    "command",
    "effectiveFlags",
  ]);
  const digest = (key: string, length: number): string => {
    const result = field(value, key);
    text(result, `parent ${key}`);
    requireCondition(new RegExp(`^[a-f0-9]{${length}}$`).test(result), `parent ${key} digest`);
    return result;
  };
  const command = field(value, "command");
  text(command, "parent command");
  requireCondition(command.trim().length > 0, "empty parent command");
  const flags = field(value, "effectiveFlags");
  fields(flags, ["linearIr", "nodeOptions", "execArgv"]);
  requireCondition(field(flags, "linearIr") === "1", "approved Linear IR flag must be 1");
  const nodeOptions = field(flags, "nodeOptions");
  requireCondition(nodeOptions === null || typeof nodeOptions === "string", "parent NODE_OPTIONS");
  const execArgv = field(flags, "execArgv");
  strings(execArgv, 256);
  return {
    runtime: digest("runtime", 64),
    consumer: digest("consumer", 64),
    integration: digest("integration", 64),
    sourceTree: digest("sourceTree", 40),
    testSha256: digest("testSha256", 64),
    fixture: digest("fixture", 64),
    head: digest("head", 40),
    command,
    effectiveFlags: { linearIr: "1", nodeOptions, execArgv },
  };
}
function validateOutcome(value: unknown): void {
  const status = field(value, "status");
  requireCondition(status === "passed" || status === "failed", "unknown outcome");
  fields(value, status === "passed" ? ["status"] : ["status", "error"]);
}
function validateMemory(value: unknown): void {
  fields(value, ["memoryBase64", "byteLength", "heap"]);
  const bytes = field(value, "byteLength");
  integer(bytes, MAX_BYTES, "memory byte length");
  requireCondition(bytes > 0 && bytes % 65536 === 0, "memory page population");
  integer(field(value, "heap"), bytes, "bounded actual heap");
  const encoded = field(value, "memoryBase64");
  text(encoded, "memory base64");
  const decoded = Buffer.from(encoded, "base64");
  requireCondition(decoded.byteLength === bytes && base64(decoded) === encoded, "lossy memory encoding");
}
function validateCarrierShape(value: unknown): void {
  fields(value, ["pointer", "header", "capacity", "length", "payload"]);
  integer(field(value, "pointer"), MAX_BYTES - DATA, "carrier pointer");
  const capacity = field(value, "capacity");
  integer(capacity, MAX_BYTES - DATA, "carrier capacity");
  const length = field(value, "length");
  integer(length, capacity, "carrier length");
  const header = field(value, "header");
  list(header, DATA);
  requireCondition(header.length === DATA, "full header population");
  const payload = field(value, "payload");
  list(payload, MAX_BYTES);
  requireCondition(payload.length === length, "full payload population");
  for (const byte of [...header, ...payload]) integer(byte, 255, "byte");
}
function validateConstructionShape(value: unknown): void {
  fields(value, ["kind", "bytes", "rawPointer", "canonicalPointer", "pointer", "seedEmptyPointer"]);
  const kind = field(value, "kind");
  requireCondition(kind === "C" || kind === "S", "construction recipe");
  const bytes = field(value, "bytes");
  list(bytes, 4097);
  for (const byte of bytes) integer(byte, 127, "construction ASCII byte");
  for (const key of ["rawPointer", "canonicalPointer", "pointer"]) {
    const pointer = field(value, key);
    integer(pointer, MAX_BYTES - DATA, "construction pointer");
    requireCondition(pointer % 8 === 0, "unaligned construction pointer");
  }
  const seed = field(value, "seedEmptyPointer");
  if (kind === "C") requireCondition(seed === null, "canonical construction has a seed");
  else {
    integer(seed, MAX_BYTES - DATA, "spare-capacity seed pointer");
    requireCondition(bytes.length > 0 && bytes.length <= 16, "S recipe length");
  }
}
function validateTransitionShape(value: unknown): void {
  fields(value, [
    "before",
    "after",
    "left",
    "right",
    "result",
    "heapDelta",
    "inferredAllocations",
    "allocationCountAuthority",
  ]);
  validateMemory(field(value, "before"));
  validateMemory(field(value, "after"));
  for (const key of ["left", "right", "result"]) validateCarrierShape(field(value, key));
  integer(field(value, "heapDelta"), MAX_BYTES, "heap usage");
  integer(field(value, "inferredAllocations"), 1, "inferred allocation count");
  requireCondition(
    field(value, "allocationCountAuthority") === "installed-single-growth-malloc-call",
    "allocation authority",
  );
}
function validateArtifactShape(value: unknown): void {
  fields(value, ["binaryBase64", "sha256", "byteLength", "valid"]);
  text(field(value, "binaryBase64"), "artifact base64");
  text(field(value, "sha256"), "artifact hash");
  integer(field(value, "byteLength"), MAX_BYTES, "artifact size");
  requireCondition(typeof field(value, "valid") === "boolean", "artifact validity type");
}
function validateProgress(value: unknown): void {
  const discriminator = Object.hasOwn(Object(value), "kind") ? field(value, "kind") : field(value, "stage");
  if (discriminator === "setup") {
    fields(value, ["stage"]);
    return;
  }
  if (discriminator === "negative") {
    fields(value, ["stage", "mutation", "original", "corrupted", "rejected", "rejection"]);
    text(field(value, "mutation"), "negative mutation");
    requireCondition(typeof field(value, "rejected") === "boolean", "negative rejection type");
    const rejection = field(value, "rejection");
    requireCondition(rejection === null || typeof rejection === "string", "negative rejection");
    for (const key of ["original", "corrupted"]) {
      const positive = field(value, key);
      requireCondition(["runtime", "source"].includes(String(field(positive, "kind"))), "negative evidence kind");
      validateProgress(positive);
    }
    return;
  }
  requireCondition(discriminator === "runtime" || discriminator === "source", "unknown evidence discriminant");
  const complete = Object.hasOwn(Object(value), "kind");
  if (discriminator === "runtime") {
    fields(
      value,
      complete
        ? ["kind", "module", "artifact", "binding", "construction", "transitions", "hostCalls", "imported"]
        : ["stage", "construction", "transitions"],
      complete ? [] : ["artifact"],
    );
    const construction = field(value, "construction");
    list(construction, 128);
    for (const entry of construction) validateConstructionShape(entry);
    const steps = field(value, "transitions");
    list(steps, 33);
    for (const step of steps) validateTransitionShape(step);
    if (complete) {
      requireCondition(typeof field(value, "imported") === "boolean", "import flag");
      const host = field(value, "hostCalls");
      fields(host, ["unrelated", "namesake"]);
      integer(field(host, "unrelated"), 1, "decoy host calls");
      integer(field(host, "namesake"), 1, "namesake host calls");
    }
  } else {
    fields(
      value,
      complete
        ? [
            "kind",
            "source",
            "sourceSha256",
            "options",
            "input",
            "expected",
            "native",
            "actual",
            "module",
            "artifact",
            "binding",
            "report",
            "receipt",
            "registrationModules",
            "logical",
            "physical",
            "ownerUnitId",
            "callIndices",
            "appendExecutionAuthority",
          ]
        : ["stage", "input", "expected", "sourceSha256"],
      complete ? [] : ["compile", "artifact", "report", "consumers"],
    );
    for (const key of complete ? ["input", "expected", "native", "actual"] : ["input", "expected"])
      integer(field(value, key), 862771296, `source ${key}`);
    text(field(value, "sourceSha256"), "source hash");
    if (complete) {
      text(field(value, "source"), "complete source");
      text(field(value, "ownerUnitId"), "owner ID");
      const indices = field(value, "callIndices");
      list(indices, MAX_FIELDS);
      for (const index of indices) integer(index, MAX_NODES, "physical call index");
      const modules = field(value, "registrationModules");
      list(modules, 128);
      requireCondition(modules.length > 0, "registration population");
    }
  }
  if (Object.hasOwn(Object(value), "artifact")) validateArtifactShape(field(value, "artifact"));
  if (complete) {
    const module = field(value, "module");
    requireCondition(module !== null && typeof module === "object", "module missing");
    const binding = field(value, "binding");
    fields(binding, ["index", "imports", "helper", "mallocIndex"]);
    for (const key of ["index", "imports", "mallocIndex"]) integer(field(binding, key), MAX_NODES, "helper index");
    requireCondition(
      typeof field(binding, "helper") === "object" && field(binding, "helper") !== null,
      "defined helper missing",
    );
  }
}
function validateRecord(row: RecordRow, expected: ParentIdentity | undefined): void {
  requireCondition(expected !== undefined, "parent identity absent");
  if (row.kind === "provenance") {
    fields(row, [
      "kind",
      "schema",
      "issue",
      "head",
      "sourceTree",
      "baseline",
      "baselineSourceTree",
      "sourceDirty",
      "testSha256",
      "fixtureSha256",
      "productionHashes",
      "options",
      "node",
      "v8",
      "execArgv",
      "argv",
      "nodeOptions",
      "linearIrFlag",
      "command",
      "ids",
      "expectedObservations",
    ]);
    requireCondition(
      row.schema === "6915-append-baseline-v2" && row.issue === 6915 && row.expectedObservations === 36,
      "provenance schema",
    );
    requireCondition(row.sourceDirty === "", "dirty source epoch");
    requireCondition(
      row.baseline === BASELINE && row.baselineSourceTree === "68296a0d34ceea94dbc9ca9398f71bc8a1b742b8",
      "historical baseline metadata",
    );
    fields(row.productionHashes, ["runtime", "consumer", "integration"]);
    fields(row.options, ["target", "allocator", "fileName"]);
    for (const [actual, wanted] of [
      [row.head, expected.head],
      [row.sourceTree, expected.sourceTree],
      [row.testSha256, expected.testSha256],
      [row.fixtureSha256, expected.fixture],
      [row.command, expected.command],
      [row.productionHashes.runtime, expected.runtime],
      [row.productionHashes.consumer, expected.consumer],
      [row.productionHashes.integration, expected.integration],
    ])
      requireCondition(typeof actual === "string" && actual === wanted, "incompatible parent identity");
    requireCondition(
      row.fixtureSha256 === FIXTURE_SHA &&
        row.linearIrFlag === "1" &&
        row.linearIrFlag === expected.effectiveFlags.linearIr &&
        row.nodeOptions === expected.effectiveFlags.nodeOptions,
      "incompatible effective flags/fixture",
    );
    strings(row.execArgv, 256);
    strings(row.argv, 256);
    text(row.node, "Node version");
    text(row.v8, "V8 version");
    requireCondition(
      JSON.stringify(row.execArgv) === JSON.stringify(expected.effectiveFlags.execArgv),
      "incompatible execArgv",
    );
    requireCondition(JSON.stringify(row.options) === JSON.stringify(OPTIONS), "changed source options");
    requireCondition(
      JSON.stringify(row.ids) === JSON.stringify(IDS) && new Set(row.ids).size === 36,
      "provenance manifest",
    );
  } else if (row.kind === "observation") {
    fields(row, ["kind", "id", "passed", "evidence", "action", "schema", "emission"]);
    requireCondition(
      typeof row.id === "string" && IDS.includes(row.id) && observed.filter((id) => id === row.id).length === 1,
      "unknown/duplicate observation",
    );
    requireCondition(typeof row.passed === "boolean", "observation status");
    for (const outcome of [row.action, row.schema, row.emission]) validateOutcome(outcome);
    requireCondition(
      row.passed === [row.action, row.schema, row.emission].every((outcome) => outcome.status === "passed"),
      "inconsistent observation outcomes",
    );
    validateProgress(row.evidence);
    if (row.passed) {
      if ("kind" in row.evidence) {
        validatePositive(row.evidence);
        if (row.evidence.kind === "runtime")
          requireCondition(
            row.evidence.transitions.length === (row.id === "Runtime22" ? 33 : 1),
            "observation transition floor",
          );
      } else {
        requireCondition(
          row.evidence.stage === "negative" && row.evidence.rejected && row.evidence.rejection !== null,
          "passing incomplete/negative evidence",
        );
        validatePositive(row.evidence.original);
      }
    }
  } else {
    fields(row, [
      "kind",
      "ids",
      "duplicates",
      "missing",
      "unexpected",
      "failures",
      "actionFailures",
      "schemaFailures",
      "emissionFailures",
      "cleanupErrors",
      "passed",
      "expectedObservations",
    ]);
    requireCondition(row.kind === "completion" && row.expectedObservations === 36, "completion discriminant");
    for (const population of [row.ids, row.duplicates, row.missing, row.unexpected, row.failures])
      strings(population, 36);
    for (const population of [row.actionFailures, row.schemaFailures, row.emissionFailures]) strings(population, 38);
    list(row.cleanupErrors, 36 * 3 + captures.restorers.length);
    requireCondition(
      JSON.stringify(row.ids) === JSON.stringify(observed) && JSON.stringify(row.failures) === JSON.stringify(failures),
      "completion accounting",
    );
    requireCondition(
      row.passed ===
        (row.ids.length === 36 &&
          row.duplicates.length === 0 &&
          row.missing.length === 0 &&
          row.unexpected.length === 0 &&
          row.failures.length === 0 &&
          row.actionFailures.length === 0 &&
          row.schemaFailures.length === 0 &&
          row.emissionFailures.length === 0 &&
          row.cleanupErrors.length === 0),
      "completion status",
    );
  }
}
function instrumentSelfChecks(provenance: Extract<RecordRow, { kind: "provenance" }>, expected: ParentIdentity): void {
  const mustReject = (action: () => void): void => {
    let rejected = false;
    try {
      action();
    } catch {
      rejected = true;
    }
    requireCondition(rejected, "instrument self-check accepted invalid evidence");
  };
  const large = (1n << 200n) + 123n;
  const shared = { text: "shared", bytes: new Uint8Array([0, 127, 255]) };
  type Fixture = {
    self: Fixture | null;
    shared: typeof shared;
    again: typeof shared;
    values: unknown[];
    map: ReadonlyMap<unknown, unknown>;
    set: unknown;
    nativeMap: Map<unknown, unknown>;
    nativeSet: Set<unknown>;
    error: Error;
  };
  const fixture: Fixture = {
    self: null,
    shared,
    again: shared,
    values: [large, -large, NaN, Infinity, -Infinity, -0, undefined],
    map: preparedIrReadonlyMap<unknown, unknown>([
      ["large", large],
      ["shared", shared],
    ]),
    set: freezePreparedIrValue(new Set([large, "frozen"])),
    nativeMap: new Map([["shared", shared]]),
    nativeSet: new Set([shared, "native"]),
    error: new AggregateError([new Error("action"), new Error("emission")], "both preserved"),
  };
  fixture.self = fixture;
  const graph = encodeGraph(fixture);
  validateGraph(graph);
  const stackProperties = graph.nodes
    .filter((node) => node.kind === "error")
    .flatMap((node) => node.properties.filter((property) => property.key === "stack"));
  requireCondition(
    stackProperties.length === 3 && stackProperties.every((property) => typeof property.value === "string"),
    "Error self-check stack text lost",
  );
  if (typeof nativeStackReference?.get === "function")
    requireCondition(
      stackProperties.every((property) => property.descriptor === "native-error-stack"),
      "native Error accessor descriptor lost",
    );
  let arbitraryGetterCalls = 0;
  const arbitraryError = new Error("arbitrary getter must not run");
  Object.defineProperty(arbitraryError, "stack", {
    get: () => {
      arbitraryGetterCalls++;
      return "not native";
    },
    configurable: true,
  });
  mustReject(() => encodeGraph(arbitraryError));
  requireCondition(arbitraryGetterCalls === 0, "arbitrary Error getter was invoked");
  requireCondition(
    errorText(arbitraryError) === "[6915 incomplete-evidence: unsupported diagnostic value]",
    "arbitrary diagnostic stack was accepted",
  );
  requireCondition(arbitraryGetterCalls === 0, "diagnostic path invoked arbitrary stack");
  const counters = {
    ownMessage: 0,
    inheritedName: 0,
    prototypeConstructor: 0,
    functionName: 0,
    nonStringName: 0,
    nonStringMessage: 0,
  };
  const ownMessage = new Error("own message getter");
  Object.defineProperty(ownMessage, "message", {
    get: () => {
      counters.ownMessage++;
      return "unsafe";
    },
    configurable: true,
  });
  const inheritedName = new Error("inherited name getter");
  Object.setPrototypeOf(
    inheritedName,
    Object.create(Error.prototype, {
      name: {
        get: () => {
          counters.inheritedName++;
          return "unsafe";
        },
      },
    }),
  );
  const prototypeConstructor = new Error("prototype constructor getter");
  Object.setPrototypeOf(
    prototypeConstructor,
    Object.create(Error.prototype, {
      constructor: {
        get: () => {
          counters.prototypeConstructor++;
          return Error;
        },
      },
    }),
  );
  const functionName = new Error("constructor function name getter");
  const localConstructor = () => undefined;
  Object.defineProperty(localConstructor, "name", {
    get: () => {
      counters.functionName++;
      return "unsafe";
    },
  });
  Object.setPrototypeOf(functionName, Object.create(Error.prototype, { constructor: { value: localConstructor } }));
  const nonStringName = new Error("non-string data name");
  Object.defineProperty(nonStringName, "name", {
    value: {
      toString: () => {
        counters.nonStringName++;
        return "unsafe";
      },
    },
  });
  const nonStringMessage = new Error("non-string data message");
  Object.defineProperty(nonStringMessage, "message", {
    value: {
      toString: () => {
        counters.nonStringMessage++;
        return "unsafe";
      },
    },
  });
  for (const error of [
    ownMessage,
    inheritedName,
    prototypeConstructor,
    functionName,
    nonStringName,
    nonStringMessage,
  ]) {
    mustReject(() => encodeGraph(error));
    requireCondition(
      errorText(error) === "[6915 incomplete-evidence: unsupported diagnostic value]",
      "unsupported diagnostic was not marked incomplete",
    );
  }
  requireCondition(
    Object.values(counters).every((count) => count === 0) && arbitraryGetterCalls === 0,
    "descriptor boundary invoked a getter/coercion",
  );
  const root = graph.nodes[0];
  const property = (key: string): GraphValue => {
    const result = root.properties.find((entry) => entry.key === key);
    requireCondition(result !== undefined, "self-check missing graph field");
    return result.value;
  };
  requireCondition(JSON.stringify(property("self")) === JSON.stringify(graph.root), "cycle identity lost");
  requireCondition(JSON.stringify(property("shared")) === JSON.stringify(property("again")), "repeated identity lost");
  for (const name of ["FrozenMap", "Map", "FrozenSet", "Set"]) {
    const node = graph.nodes.find((entry) => entry.prototype === name);
    requireCondition(
      node !== undefined && (node.kind === "map" || node.kind === "set") && node.size > 0,
      "native/frozen collection contents lost",
    );
  }
  const scalars = graph.nodes.flatMap((node) => node.properties.map((entry) => entry.value));
  requireCondition(
    scalars.some(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        "tag" in value &&
        value.tag === "bigint" &&
        value.decimal === large.toString(10),
    ),
    "large BigInt lost",
  );
  requireCondition(
    scalars.some(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        "tag" in value &&
        value.tag === "bigint" &&
        value.decimal === (-large).toString(10),
    ),
    "negative BigInt lost",
  );
  for (const special of ["nan", "+infinity", "-infinity", "-0"])
    requireCondition(
      scalars.some(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          "tag" in value &&
          value.tag === "number" &&
          value.value === special,
      ),
      "special number lost",
    );
  requireCondition(
    scalars.some((value) => value !== null && typeof value === "object" && "tag" in value && value.tag === "undefined"),
    "undefined lost",
  );
  const wrongReference = structuredClone(graph);
  wrongReference.root = { ref: wrongReference.nodes.length };
  mustReject(() => validateGraph(wrongReference));
  const duplicateNode = structuredClone(graph);
  duplicateNode.nodes[0].id = 1;
  mustReject(() => validateGraph(duplicateNode));
  const lostMap = structuredClone(graph);
  const map = lostMap.nodes.find((node) => node.kind === "map");
  requireCondition(map?.kind === "map", "self-check map absent");
  map.entries.pop();
  mustReject(() => validateGraph(lostMap));
  mustReject(() => encodeGraph(() => undefined));
  mustReject(() => encodeGraph(Symbol("unsupported")));
  mustReject(() => parseParentIdentity(undefined));
  const missingParent = { ...expected };
  Reflect.deleteProperty(missingParent, "testSha256");
  mustReject(() => parseParentIdentity(JSON.stringify(missingParent)));
  mustReject(() =>
    parseParentIdentity(JSON.stringify({ ...expected, effectiveFlags: { ...expected.effectiveFlags, linearIr: "0" } })),
  );
  const missing = { ...provenance };
  Reflect.deleteProperty(missing, "head");
  mustReject(() => validateRecord(missing, expected));
  mustReject(() => validateRecord({ ...provenance, head: "0".repeat(40) }, expected));
  mustReject(() =>
    validateRecord(
      { ...provenance, productionHashes: { ...provenance.productionHashes, runtime: "0".repeat(64) } },
      expected,
    ),
  );
  mustReject(() => validateRecord({ ...provenance, linearIrFlag: "0" }, expected));
  mustReject(() => validateRecord({ ...provenance, ids: [...IDS.slice(0, 35), IDS[0]] }, expected));
}
beforeAll(() => {
  let phase: "schema" | "emission" = "schema";
  try {
    approved = parseParentIdentity(process.env.JS2WASM_APPEND_EXPECTED_PROVENANCE);
    const provenance: Extract<RecordRow, { kind: "provenance" }> = {
      kind: "provenance",
      schema: "6915-append-baseline-v2",
      issue: 6915,
      head: git("rev-parse", "HEAD"),
      sourceTree: git("rev-parse", "HEAD:src"),
      baseline: BASELINE,
      baselineSourceTree: "68296a0d34ceea94dbc9ca9398f71bc8a1b742b8",
      sourceDirty: git("status", "--porcelain", "--", "src"),
      testSha256: sha256(readFileSync(TEST_PATH)),
      fixtureSha256: sha256(readFileSync(SOURCE_PATH)),
      productionHashes: {
        runtime: sha256(readFileSync("src/codegen-linear/runtime.ts")),
        consumer: sha256(readFileSync("src/ir/backend/frozen-body-consumer.ts")),
        integration: sha256(readFileSync("src/ir/backend/linear-integration.ts")),
      },
      options: OPTIONS,
      node: process.version,
      v8: process.versions.v8,
      execArgv: process.execArgv,
      argv: process.argv,
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      linearIrFlag: process.env.JS2WASM_LINEAR_IR ?? null,
      command: process.env.JS2WASM_APPEND_TEST_COMMAND ?? null,
      ids: IDS,
      expectedObservations: 36,
    };
    instrumentSelfChecks(provenance, approved);
    validateRecord(provenance, approved);
    phase = "emission";
    emit(provenance);
    expect(provenance.fixtureSha256).toBe(FIXTURE_SHA);
    expect(provenance.sourceDirty).toBe("");
    expect(provenance.testSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(IDS).toHaveLength(36);
    expect(new Set(IDS).size).toBe(36);
  } catch (error) {
    if (phase === "schema") schemaFailures.push("provenance");
    else emissionFailures.push("provenance");
    try {
      diagnostic(
        null,
        { status: "passed" },
        phase === "schema" ? { status: "failed", error } : { status: "passed" },
        phase === "emission" ? { status: "failed", error } : { status: "passed" },
      );
    } catch (diagnosticError) {
      throw new AggregateError([error, diagnosticError], "provenance and diagnostic failures retained", {
        cause: error,
      });
    }
    throw error;
  }
});
afterEach(() => {
  const errors = runCleanups([
    () => {
      captures.modules.length = 0;
    },
    () => {
      captures.consumers.length = 0;
    },
    () => {
      vi.unstubAllEnvs();
    },
  ]);
  if (errors.length > 0) {
    hookCleanupErrors.push(...errors);
    if (!actionFailures.includes("afterEach-cleanup")) actionFailures.push("afterEach-cleanup");
  }
  throwRetained(errors, "afterEach cleanup errors retained");
});
afterAll(() => {
  const finalErrors = runCleanups([...captures.restorers].reverse());
  if (finalErrors.length > 0) actionFailures.push("final-restorers");
  const cleanupErrors = [...hookCleanupErrors, ...finalErrors];
  const duplicates = observed.filter((id, i) => observed.indexOf(id) !== i);
  const missing = IDS.filter((id) => !observed.includes(id));
  const unexpected = observed.filter((id) => !IDS.includes(id));
  const completion: Extract<RecordRow, { kind: "completion" }> = {
    kind: "completion",
    ids: observed,
    duplicates,
    missing,
    unexpected,
    failures,
    actionFailures,
    schemaFailures,
    emissionFailures,
    cleanupErrors,
    passed:
      duplicates.length === 0 &&
      missing.length === 0 &&
      unexpected.length === 0 &&
      observed.length === 36 &&
      failures.length === 0 &&
      actionFailures.length === 0 &&
      schemaFailures.length === 0 &&
      emissionFailures.length === 0 &&
      cleanupErrors.length === 0,
    expectedObservations: 36,
  };
  const errors = [...cleanupErrors];
  let phase: "schema" | "emission" = "schema";
  try {
    validateRecord(completion, approved);
    phase = "emission";
    emit(completion);
  } catch (error) {
    errors.push(error);
    if (phase === "schema") schemaFailures.push("completion");
    else emissionFailures.push("completion");
    try {
      diagnostic(
        null,
        cleanupErrors.length
          ? { status: "failed", error: new AggregateError(cleanupErrors, "final cleanup failures") }
          : { status: "passed" },
        phase === "schema" ? { status: "failed", error } : { status: "passed" },
        phase === "emission" ? { status: "failed", error } : { status: "passed" },
      );
    } catch (diagnosticError) {
      errors.push(diagnosticError);
    }
  }
  errors.push(
    ...runCleanups([
      () => {
        expect(duplicates).toEqual([]);
      },
      () => {
        expect(missing).toEqual([]);
      },
      () => {
        expect(unexpected).toEqual([]);
      },
      () => {
        expect(observed).toHaveLength(36);
      },
      () => {
        expect(actionFailures).toEqual([]);
      },
      () => {
        expect(schemaFailures).toEqual([]);
      },
      () => {
        expect(emissionFailures).toEqual([]);
      },
      () => {
        expect(failures).toEqual([]);
      },
    ]),
  );
  throwRetained(errors, "completion, cleanup and diagnostic errors retained");
});

function artifact(binary: Uint8Array): Artifact {
  return {
    binaryBase64: base64(binary),
    sha256: sha256(binary),
    byteLength: binary.byteLength,
    valid: WebAssembly.validate(new Uint8Array(binary)),
  };
}
function validateArtifact(value: Artifact): void {
  const bytes = new Uint8Array(Buffer.from(value.binaryBase64, "base64"));
  expect(bytes.byteLength).toBeGreaterThan(0);
  expect(value.byteLength).toBe(bytes.byteLength);
  expect(value.sha256).toBe(sha256(bytes));
  expect(value.valid).toBe(true);
  expect(WebAssembly.validate(bytes)).toBe(true);
}
function defined(module: WasmModule, name: string): Binding {
  const position = module.functions.findIndex((fn) => fn.name === name);
  const helper = module.functions[position];
  if (!helper) throw new Error(`missing defined ${name}`);
  const imports = module.imports.filter((entry) => entry.desc.kind === "func").length;
  const mallocPosition = module.functions.findIndex((fn) => fn.name === "__malloc");
  if (mallocPosition < 0) throw new Error("missing real allocator");
  return { helper, imports, index: imports + position, mallocIndex: imports + mallocPosition };
}
function calls(body: Instr[]): Extract<Instr, { op: "call" }>[] {
  const result: Extract<Instr, { op: "call" }>[] = [];
  walkInstructions(body, (instruction) => {
    if (instruction.op === "call") result.push(instruction);
  });
  return result;
}
function validateBinding(module: WasmModule, binding: Binding): void {
  const actual = defined(module, APPEND);
  expect(binding.index).toBe(actual.index);
  expect(binding.imports).toBe(actual.imports);
  expect(binding.helper).toBe(actual.helper);
  expect(binding.mallocIndex).toBe(actual.mallocIndex);
  const signature = module.types[binding.helper.typeIdx];
  if (!signature || signature.kind !== "func") throw new Error("append helper signature is not a function");
  expect(signature.params).toEqual([{ kind: "i32" }, { kind: "i32" }]);
  expect(signature.results).toEqual([{ kind: "i32" }]);
  expect(binding.helper.locals).toHaveLength(7);
  const layout = resolveLayout(module);
  const mallocCalls = calls(binding.helper.body).filter((entry) => layout.func(entry.funcIdx) === binding.mallocIndex);
  expect(mallocCalls).toHaveLength(1);
  const growth = binding.helper.body.find((entry) => entry.op === "if");
  if (!growth || growth.op !== "if") throw new Error("missing structural growth branch");
  expect(calls(growth.then).filter((entry) => layout.func(entry.funcIdx) === binding.mallocIndex)).toHaveLength(1);
  expect(calls(growth.else ?? []).filter((entry) => layout.func(entry.funcIdx) === binding.mallocIndex)).toHaveLength(
    0,
  );
}
function call(exports: WebAssembly.Exports, name: string, ...args: number[]): number {
  const fn = exports[name];
  if (typeof fn !== "function") throw new Error(`missing callable export ${name}`);
  const value: unknown = fn(...args);
  if (typeof value !== "number") throw new Error(`${name} did not return a number`);
  return value;
}
function bounds(bytes: Uint8Array, pointer: number, length: number): void {
  expect(Number.isSafeInteger(pointer)).toBe(true);
  expect(Number.isSafeInteger(length)).toBe(true);
  expect(pointer).toBeGreaterThanOrEqual(0);
  expect(length).toBeGreaterThanOrEqual(0);
  expect(pointer + length).toBeLessThanOrEqual(bytes.byteLength);
}
function carrier(bytes: Uint8Array, pointer: number): Carrier {
  bounds(bytes, pointer, DATA);
  expect(pointer % 8).toBe(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const capacity = view.getUint32(pointer + SIZE, true) - PREFIX;
  const length = view.getUint32(pointer + LENGTH, true);
  expect(length).toBeLessThanOrEqual(capacity);
  bounds(bytes, pointer + DATA, capacity);
  return {
    pointer,
    header: [...bytes.slice(pointer, pointer + DATA)],
    capacity,
    length,
    payload: [...bytes.slice(pointer + DATA, pointer + DATA + length)],
  };
}
function validateTransition(step: Transition): void {
  const before = new Uint8Array(Buffer.from(step.before.memoryBase64, "base64"));
  const after = new Uint8Array(Buffer.from(step.after.memoryBase64, "base64"));
  expect(before.byteLength).toBe(step.before.byteLength);
  expect(after.byteLength).toBe(step.after.byteLength);
  expect(step.left).toEqual(carrier(before, step.left.pointer));
  expect(step.right).toEqual(carrier(before, step.right.pointer));
  expect(step.result).toEqual(carrier(after, step.result.pointer));
  const payload = [...step.left.payload, ...step.right.payload];
  const growing = payload.length > step.left.capacity;
  const capacity = growing ? Math.max(2 * step.left.capacity, 16, payload.length) : step.left.capacity;
  const pointer = growing ? step.before.heap : step.left.pointer;
  const usage = growing ? align8(DATA + capacity) : 0;
  expect(step.result.pointer).toBe(pointer);
  expect(step.result.capacity).toBe(capacity);
  expect(step.result.length).toBe(payload.length);
  expect(step.result.payload).toEqual(payload);
  expect(step.heapDelta).toBe(usage);
  expect(step.after.heap - step.before.heap).toBe(usage);
  expect(step.inferredAllocations).toBe(growing ? 1 : 0);
  expect(step.allocationCountAuthority).toBe("installed-single-growth-malloc-call");
  expect(after.byteLength).toBe(Math.max(before.byteLength, Math.ceil(step.after.heap / 65536) * 65536));
  const expected = new Uint8Array(after.byteLength);
  expected.set(before);
  bounds(expected, pointer, DATA + capacity);
  const view = new DataView(expected.buffer);
  if (growing) {
    view.setUint32(pointer, 0, true); // Oracle only: real allocator cleared the actual fresh header.
    view.setUint32(pointer + SIZE, capacity + PREFIX, true);
  }
  view.setUint32(pointer + LENGTH, payload.length, true);
  expected.set(payload, pointer + DATA);
  // Includes padding, spare capacity, old allocations, cache bits, RHS and every untouched byte.
  expect(step.after.memoryBase64).toBe(base64(expected));
}
function validatePositive(proof: Positive): void {
  validateArtifact(proof.artifact);
  validateBinding(proof.module, proof.binding);
  if (proof.kind === "runtime") {
    expect(typeof proof.imported).toBe("boolean");
    expect(proof.transitions.length).toBeGreaterThan(0);
    validateConstructionCustody(proof);
    for (const step of proof.transitions) validateTransition(step);
    expect(proof.hostCalls).toEqual({ unrelated: 0, namesake: 0 });
    expect(proof.binding.imports).toBe(proof.imported ? 2 : 0);
    if (proof.imported) {
      expect(proof.module.imports.map((entry) => ({ name: entry.name, kind: entry.desc.kind }))).toEqual([
        { name: "unused", kind: "func" },
        { name: "table", kind: "table" },
        { name: APPEND, kind: "func" },
      ]);
    }
  } else validateSource(proof);
}
function validateConstructionCustody(proof: RuntimeProof): void {
  requireCondition(
    proof.construction.length > 0 && proof.construction.length <= 128,
    "genuine construction population",
  );
  const first = proof.transitions[0];
  requireCondition(first !== undefined, "no initial operands");
  const before = new Uint8Array(Buffer.from(first.before.memoryBase64, "base64"));
  const pointers = new Set<number>();
  for (const entry of proof.construction) {
    validateConstructionShape(entry);
    bounds(before, entry.rawPointer, entry.bytes.length);
    expect([...before.slice(entry.rawPointer, entry.rawPointer + entry.bytes.length)]).toEqual(entry.bytes);
    expect(entry.canonicalPointer).toBe(entry.rawPointer + align8(entry.bytes.length));
    const canonical = carrier(before, entry.canonicalPointer);
    expect(canonical.capacity).toBe(entry.bytes.length);
    expect(canonical.length).toBe(entry.bytes.length);
    expect(canonical.payload).toEqual(entry.bytes);
    if (entry.kind === "C") expect(entry.pointer).toBe(entry.canonicalPointer);
    else {
      const seed = proof.construction.find(
        (candidate) =>
          candidate.kind === "C" && candidate.pointer === entry.seedEmptyPointer && candidate.bytes.length === 0,
      );
      requireCondition(seed !== undefined, "S seed lacks genuine C(empty) custody");
      expect(entry.pointer).toBe(seed.pointer + align8(DATA));
      expect(carrier(before, entry.pointer).capacity).toBe(16);
      expect(carrier(before, entry.pointer).payload).toEqual(entry.bytes);
    }
    requireCondition(!pointers.has(entry.pointer), "duplicate unexplained construction pointer");
    pointers.add(entry.pointer);
  }
  requireCondition(
    pointers.has(first.left.pointer) && pointers.has(first.right.pointer),
    "initial operand lacks real construction custody",
  );
  for (let i = 1; i < proof.transitions.length; i++) {
    const previous = proof.transitions[i - 1];
    const current = proof.transitions[i];
    expect(current.before).toEqual(previous.after);
    expect(current.left.pointer).toBe(previous.result.pointer);
    expect(current.right.pointer).toBe(first.right.pointer);
    requireCondition(pointers.has(current.right.pointer), "repeated RHS lacks original construction custody");
  }
}
function validateSource(proof: SourceProof): void {
  expect(
    [proof.input, proof.expected, proof.native, proof.actual].every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ),
  ).toBe(true);
  expect([
    [0, 0],
    [1, 96500],
    [100, 36729899],
    [20000, 862771296],
  ]).toContainEqual([proof.input, proof.expected]);
  expect(proof.appendExecutionAuthority).toBe("physical-call-binding-not-dynamic-counter");
  expect(proof.sourceSha256).toBe(FIXTURE_SHA);
  expect(sha256(proof.source)).toBe(FIXTURE_SHA);
  expect(proof.options).toEqual(OPTIONS);
  expect(proof.native).toBe(proof.expected);
  expect(proof.actual).toBe(proof.expected);
  expect(proof.registrationModules).toContain(proof.module);
  assertFrozenIrBodyBatch(proof.receipt.batch);
  expect(proof.report.frozenBodyBatch).toBe(proof.receipt.batch);
  expect(proof.report.irModule).toBe(proof.receipt.batch.module);
  expect(proof.receipt.moduleSession).toBe(proof.module);
  expect(proof.receipt.backend).toBe("linear");
  expect(proof.receipt.completed).toBe(true);
  expect(proof.receipt.failure).toBeUndefined();
  expect(proof.report.compiled).toEqual(["run"]);
  expect(proof.report.rejected).toEqual([]);
  expect(proof.logical.name).toBe("run");
  expect(proof.logical.unitId).toBe(proof.ownerUnitId);
  expect(proof.receipt.batch.module.functions).toContain(proof.logical);
  expect(proof.receipt.batch.owners).toContainEqual(
    expect.objectContaining({ ownerUnitId: proof.ownerUnitId, legacyName: "run", outcome: "built" }),
  );
  const output = proof.receipt.outputs.find((entry) => entry.ownerUnitId === proof.ownerUnitId);
  if (!output) throw new Error("missing actual completed run owner output");
  expect(output.func).toBe(proof.logical);
  expect(proof.report.ownerEvidence).toContainEqual({
    outcome: "compiled",
    ownerUnitId: proof.logical.unitId,
    legacyName: "run",
  });
  expect(proof.report.funcs.get(proof.logical.unitId)).toBe(proof.physical);
  expect(proof.module.functions).toContain(proof.physical);
  expect(proof.physical.body).toBe(output.body);
  const instructions: IrInstr[] = [];
  for (const block of proof.logical.blocks)
    for (const instr of block.instrs)
      forEachInstrDeep(instr, (nested) => {
        instructions.push(nested);
      });
  const concats = instructions.filter((instr) => instr.kind === "string.concat");
  expect(concats).toHaveLength(3);
  expect(concats.every((instr) => instr.concatMode === "owned-append" && instr.encodingEvidence === "ascii")).toBe(
    true,
  );
  const layout = resolveLayout(proof.module);
  const indices = calls(proof.physical.body).map((entry) => layout.func(entry.funcIdx));
  expect(proof.callIndices).toEqual(indices);
  expect(indices.filter((index) => index === proof.binding.index).length).toBeGreaterThan(0);
  expect(proof.module.functions[proof.binding.index - proof.binding.imports]).toBe(proof.binding.helper);
}

type RuntimeInstance = {
  module: WasmModule;
  artifact: Artifact;
  binding: Binding;
  exports: WebAssembly.Exports;
  memory: WebAssembly.Memory;
  heap: WebAssembly.Global;
  construction: Construction[];
  hostCalls: { unrelated: number; namesake: number };
  imported: boolean;
};
async function runtimeInstance(imported = false, progress?: RuntimeProgress): Promise<RuntimeInstance> {
  const module = createEmptyModule();
  if (imported) {
    module.types.push(
      { kind: "func", params: [], results: [] },
      { kind: "func", params: [{ kind: "i32" }, { kind: "i32" }], results: [{ kind: "i32" }] },
    );
    module.imports.push(
      { module: "probe", name: "unused", desc: { kind: "func", typeIdx: 0 } },
      { module: "probe", name: "table", desc: { kind: "table", elementType: "funcref", min: 1 } },
      { module: "probe", name: APPEND, desc: { kind: "func", typeIdx: 1 } },
    );
  }
  runtime.addRuntime(module);
  // Real string builder dependencies, in the production registration order.
  runtime.addUint8ArrayRuntime(module);
  runtime.addArrayRuntime(module);
  runtime.addStringRuntime(module);
  runtime.addLinearIrStringRuntime(module);
  for (const name of ["__malloc", "__str_from_data", "__str_is_ascii", APPEND]) {
    module.exports.push({ name, desc: { kind: "func", index: defined(module, name).index } });
  }
  const heapIndex = module.globals.findIndex((entry) => entry.name === "__heap_ptr");
  if (heapIndex < 0) throw new Error("missing actual allocator usage global");
  module.exports.push({ name: "heap", desc: { kind: "global", index: heapIndex } });
  const binary = emitBinary(module);
  const witness = artifact(binary);
  if (progress) progress.artifact = witness;
  validateArtifact(witness);
  const hostCalls = { unrelated: 0, namesake: 0 };
  const imports: WebAssembly.Imports = imported
    ? {
        probe: {
          unused: () => {
            hostCalls.unrelated++;
            throw new Error("wrong unrelated import called");
          },
          [APPEND]: () => {
            hostCalls.namesake++;
            throw new Error("wrong append namesake called");
          },
          table: new WebAssembly.Table({ element: "anyfunc", initial: 1 }),
        },
      }
    : {};
  const { instance } = await WebAssembly.instantiate(new Uint8Array(binary), imports);
  const memory = instance.exports.memory;
  const heap = instance.exports.heap;
  if (!(memory instanceof WebAssembly.Memory) || !(heap instanceof WebAssembly.Global))
    throw new Error("missing real runtime memory/heap exports");
  return {
    module,
    artifact: witness,
    binding: defined(module, APPEND),
    exports: instance.exports,
    memory,
    heap,
    construction: [],
    hostCalls,
    imported,
  };
}
function state(instance: RuntimeInstance): MemoryState {
  const heap: unknown = instance.heap.value;
  if (typeof heap !== "number" || !Number.isSafeInteger(heap) || heap < 0) throw new Error("invalid actual heap value");
  const bytes = new Uint8Array(instance.memory.buffer);
  bounds(bytes, heap, 0);
  return { heap, byteLength: bytes.byteLength, memoryBase64: base64(bytes) };
}
function construct(instance: RuntimeInstance, kind: "C" | "S", text: string): number {
  const bytes = new TextEncoder().encode(text);
  expect([...bytes].every((byte) => byte < 128)).toBe(true);
  const rawPointer = call(instance.exports, "__malloc", bytes.length);
  const memory = new Uint8Array(instance.memory.buffer);
  bounds(memory, rawPointer, bytes.length);
  expect(rawPointer % 8).toBe(0);
  memory.set(bytes, rawPointer); // Only raw input bytes: no record/header fabrication.
  const canonical = call(instance.exports, "__str_from_data", rawPointer, bytes.length);
  const initial = carrier(new Uint8Array(instance.memory.buffer), canonical);
  expect(initial.capacity).toBe(bytes.length);
  expect(initial.payload).toEqual([...bytes]);
  expect(initial.header.slice(0, 4)).toEqual([0, 0, 0, 0]);
  let pointer = canonical;
  let seedEmptyPointer: number | null = null;
  if (kind === "S") {
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThanOrEqual(16);
    seedEmptyPointer = construct(instance, "C", "");
    pointer = call(instance.exports, APPEND, seedEmptyPointer, canonical);
    expect(carrier(new Uint8Array(instance.memory.buffer), pointer).capacity).toBe(16);
  }
  instance.construction.push({
    kind,
    bytes: [...bytes],
    rawPointer,
    canonicalPointer: canonical,
    pointer,
    seedEmptyPointer,
  });
  return pointer;
}
function transition(instance: RuntimeInstance, leftPointer: number, rightPointer: number, steps: Transition[]): number {
  const before = state(instance);
  const beforeBytes = new Uint8Array(Buffer.from(before.memoryBase64, "base64"));
  const left = carrier(beforeBytes, leftPointer);
  const right = carrier(beforeBytes, rightPointer);
  const resultPointer = call(instance.exports, APPEND, leftPointer, rightPointer);
  const after = state(instance);
  const result = carrier(new Uint8Array(instance.memory.buffer), resultPointer);
  const step: Transition = {
    before,
    after,
    left,
    right,
    result,
    heapDelta: after.heap - before.heap,
    inferredAllocations: left.length + right.length > left.capacity ? 1 : 0,
    allocationCountAuthority: "installed-single-growth-malloc-call",
  };
  steps.push(step); // Retain the actual failed witness before any oracle assertion.
  validateTransition(step);
  return resultPointer;
}
const pattern = (length: number, start: number) =>
  Array.from({ length }, (_, i) => String.fromCharCode(start + (i % 13))).join("");
type RuntimeCase = {
  id: string;
  label: string;
  leftKind: "C" | "S";
  left: string;
  right: string;
  self?: boolean;
  cached?: boolean;
};
const RUNTIME_CASES: RuntimeCase[] = [
  { id: "Runtime01", label: "empty + empty", leftKind: "C", left: "", right: "" },
  { id: "Runtime02", label: "empty + one", leftKind: "C", left: "", right: "q" },
  { id: "Runtime03", label: "empty + seventeen", leftKind: "C", left: "", right: pattern(17, 97) },
  { id: "Runtime04", label: "canonical nonempty + empty", leftKind: "C", left: "ABC", right: "" },
  ...([3, 3, 3, 3, 6, 7, 8, 14, 15, 15] as const).map(
    (length, index): RuntimeCase => ({
      id: `Runtime${String(index + 5).padStart(2, "0")}`,
      label: `boundary ${length}+${index === 2 || index === 3 ? 4 : index === 9 ? 2 : 1}`,
      leftKind: index === 1 || index === 3 ? "C" : "S",
      left: pattern(length, 65),
      right: pattern(index === 2 || index === 3 ? 4 : index === 9 ? 2 : 1, 97),
    }),
  ),
  { id: "Runtime15", label: "self with spare capacity", leftKind: "S", left: "ABCD", right: "ABCD", self: true },
  { id: "Runtime16", label: "self with growth", leftKind: "C", left: "ABCDEFGHI", right: "ABCDEFGHI", self: true },
  { id: "Runtime17", label: "distinct equal content", leftKind: "S", left: "ABCD", right: "ABCD" },
  { id: "Runtime18", label: "ASCII NUL", leftKind: "S", left: "A\0", right: "\0B" },
  { id: "Runtime19", label: "bounded long payload", leftKind: "C", left: pattern(4096, 65), right: pattern(4097, 97) },
  { id: "Runtime20", label: "cached no growth", leftKind: "S", left: "ABCD", right: "q", cached: true },
  { id: "Runtime21", label: "cached growth", leftKind: "C", left: "ABCD", right: "q", cached: true },
];
async function runtimeCase(entry: RuntimeCase, journal: Journal, imported = false): Promise<RuntimeProof> {
  const progress: RuntimeProgress = { stage: "runtime", construction: [], transitions: [] };
  journal.evidence = progress;
  const instance = await runtimeInstance(imported, progress);
  progress.artifact = instance.artifact;
  progress.construction = instance.construction;
  const left = construct(instance, entry.leftKind, entry.left);
  const right = entry.self ? left : construct(instance, "C", entry.right);
  if (!entry.self) expect(right).not.toBe(left);
  if (entry.cached) {
    expect(call(instance.exports, "__str_is_ascii", left)).toBe(1);
    expect(carrier(new Uint8Array(instance.memory.buffer), left).header[1]).toBe(1);
  }
  transition(instance, left, right, progress.transitions);
  const proof: RuntimeProof = {
    kind: "runtime",
    module: instance.module,
    artifact: instance.artifact,
    binding: instance.binding,
    construction: instance.construction,
    transitions: progress.transitions,
    hostCalls: instance.hostCalls,
    imported,
  };
  journal.evidence = proof;
  validatePositive(proof);
  return proof;
}

async function sourceCase(input: number, expected: number, journal: Journal): Promise<SourceProof> {
  const source = readFileSync(SOURCE_PATH, "utf8");
  const progress: SourceProgress = { stage: "source", input, expected, sourceSha256: sha256(source) };
  journal.evidence = progress;
  const hadFlag = Object.hasOwn(process.env, "JS2WASM_LINEAR_IR");
  const oldFlag = process.env.JS2WASM_LINEAR_IR;
  const generate = vi.spyOn(linearCodegen, "generateLinearModule");
  let sourceOutcome: Outcome = { status: "passed" };
  try {
    expect(sha256(source)).toBe(FIXTURE_SHA);
    const nativeModule: unknown = await import(pathToFileURL(`${process.cwd()}/${SOURCE_PATH}`).href);
    if (
      !nativeModule ||
      typeof nativeModule !== "object" ||
      !("run" in nativeModule) ||
      typeof nativeModule.run !== "function"
    )
      throw new Error("unchanged native fixture run absent");
    const native: unknown = nativeModule.run(input);
    if (typeof native !== "number") throw new Error("native fixture returned non-number");
    expect(native).toBe(expected);
    expect(process.env.JS2WASM_LINEAR_IR).toBe("1");
    const result = await compile(source, OPTIONS);
    progress.compile = { success: result.success, errors: result.errors };
    progress.artifact = artifact(result.binary);
    const report = getLastLinearIrReport();
    if (report)
      progress.report = { compiled: report.compiled, rejected: report.rejected, ownerEvidence: report.ownerEvidence };
    progress.consumers = captures.consumers.map((entry) => ({
      digest: entry.batch.digest,
      completed: entry.completed,
      backend: entry.backend,
      owners: entry.batch.owners,
      failure: entry.failure === undefined ? null : String(entry.failure),
    }));
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    const generated = generate.mock.results[0];
    if (!generated || generated.type !== "return") throw new Error("missing real generator return");
    const module = generated.value;
    if (!report) throw new Error("missing actual compiler report");
    const receipt = captures.consumers.find(
      (entry) => entry.batch === report.frozenBodyBatch && entry.moduleSession === module,
    );
    if (!receipt) throw new Error("no exact current frozen batch/module consumer join");
    const logical = report.irModule.functions.find((entry) => entry.name === "run");
    if (!logical) throw new Error("unchanged run was not IR-admitted");
    const physical = report.funcs.get(logical.unitId);
    if (!physical) throw new Error("missing actual owned run body");
    validateArtifact(progress.artifact);
    const { instance } = await WebAssembly.instantiate(new Uint8Array(result.binary), result.importObject ?? {});
    const layout = resolveLayout(module);
    const proof: SourceProof = {
      kind: "source",
      source,
      sourceSha256: sha256(source),
      options: OPTIONS,
      input,
      expected,
      native,
      actual: call(instance.exports, "run", input),
      module,
      artifact: progress.artifact,
      binding: defined(module, APPEND),
      report: {
        compiled: report.compiled,
        rejected: report.rejected,
        ownerEvidence: report.ownerEvidence,
        irModule: report.irModule,
        frozenBodyBatch: report.frozenBodyBatch,
        funcs: report.funcs,
      },
      receipt,
      registrationModules: [...captures.modules],
      logical,
      physical,
      ownerUnitId: logical.unitId,
      callIndices: calls(physical.body).map((entry) => layout.func(entry.funcIdx)),
      appendExecutionAuthority: "physical-call-binding-not-dynamic-counter",
    };
    journal.evidence = proof;
    validatePositive(proof);
    return proof;
  } catch (error) {
    sourceOutcome = { status: "failed", error };
    throw error;
  } finally {
    const cleanupErrors = runCleanups([
      () => {
        generate.mockRestore();
      },
      () => {
        vi.unstubAllEnvs();
      },
      () => {
        expect(Object.hasOwn(process.env, "JS2WASM_LINEAR_IR")).toBe(hadFlag);
      },
      () => {
        expect(process.env.JS2WASM_LINEAR_IR).toBe(oldFlag);
      },
    ]);
    if (cleanupErrors.length > 0)
      throwRetained(
        sourceOutcome.status === "failed" ? [sourceOutcome.error, ...cleanupErrors] : cleanupErrors,
        "source action and all cleanup errors retained",
      );
  }
}

describe("#6915 independently owned append baseline", () => {
  for (const entry of RUNTIME_CASES)
    it(`${entry.id}: ${entry.label}`, () =>
      observation(entry.id, async (journal) => {
        await runtimeCase(entry, journal);
      }));
  it("Runtime22: all 33 one-byte repeated-growth transitions", () =>
    observation("Runtime22", async (journal) => {
      const instance = await runtimeInstance();
      const proof: RuntimeProof = {
        kind: "runtime",
        module: instance.module,
        artifact: instance.artifact,
        binding: instance.binding,
        construction: instance.construction,
        transitions: [],
        hostCalls: instance.hostCalls,
        imported: false,
      };
      journal.evidence = proof;
      let left = construct(instance, "C", "");
      const right = construct(instance, "C", "q");
      for (let i = 0; i < 33; i++) left = transition(instance, left, right, proof.transitions);
      expect(proof.transitions).toHaveLength(33);
      expect(proof.transitions.map((step) => step.result.length)).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
      expect(proof.transitions.map((step) => step.result.capacity)).toEqual([
        ...Array<number>(16).fill(16),
        ...Array<number>(16).fill(32),
        64,
      ]);
      validatePositive(proof);
    }));
  for (const [i, input, expected] of [
    [1, 0, 0],
    [2, 1, 96500],
    [3, 100, 36729899],
    [4, 20000, 862771296],
  ] as const) {
    const id = `Source0${i}`;
    it(
      `${id}: unchanged string-hash(${input})`,
      () =>
        observation(id, async (journal) => {
          await sourceCase(input, expected, journal);
        }),
      120_000,
    );
  }
  for (const [id, kind] of [
    ["Import01", "S"],
    ["Import02", "C"],
  ] as const) {
    it(`${id}: ${kind === "S" ? "no growth" : "growth"} with function/table import custody`, () =>
      observation(id, async (journal) => {
        await runtimeCase({ id, label: "import custody", leftKind: kind, left: "ABCD", right: "q" }, journal, true);
      }));
  }
  const mutations = [
    "result/payload",
    "owner identity",
    "consumer completion",
    "helper binding",
    "heap delta",
    "header bytes",
    "untouched memory",
    "import binding",
  ] as const;
  for (const [index, mutation] of mutations.entries()) {
    const id = `Negative${String(index + 1).padStart(2, "0")}`;
    it(
      `${id}: same validator rejects ${mutation}`,
      () =>
        observation(id, async (journal) => {
          const original: Positive =
            index >= 1 && index <= 3
              ? await sourceCase(1, 96500, journal)
              : await runtimeCase(
                  { id, label: mutation, leftKind: "S", left: "ABCD", right: "q" },
                  journal,
                  index === 7,
                );
          validatePositive(original);
          const corrupted = corrupt(original, index);
          const negative: NegativeProof = {
            stage: "negative",
            mutation,
            original,
            corrupted,
            rejected: false,
            rejection: null,
          };
          journal.evidence = negative;
          try {
            validatePositive(corrupted);
          } catch (error) {
            negative.rejected = true;
            negative.rejection = String(error);
          }
          expect(negative.rejected).toBe(true);
          expect(negative.rejection).not.toBeNull();
          validatePositive(original);
        }),
      120_000,
    );
  }
});
function corrupt(proof: Positive, index: number): Positive {
  if (proof.kind === "source") {
    if (index === 1) return { ...proof, ownerUnitId: "foreign-owner" };
    if (index === 2) return { ...proof, receipt: { ...proof.receipt, completed: false } };
    if (index === 3) return { ...proof, binding: { ...proof.binding, index: proof.binding.index + 1 } };
    throw new Error("unmapped source negative control");
  }
  const transitions = structuredClone(proof.transitions);
  const step = transitions[0];
  if (!step) throw new Error("negative control has no positive transition");
  if (index === 0) step.result.payload[0] ^= 1;
  else if (index === 4) step.heapDelta++;
  else if (index === 5) {
    const bytes = new Uint8Array(Buffer.from(step.after.memoryBase64, "base64"));
    bytes[step.result.pointer] ^= 1;
    step.after.memoryBase64 = base64(bytes);
    step.result = carrier(bytes, step.result.pointer);
  } else if (index === 6) {
    const bytes = new Uint8Array(Buffer.from(step.after.memoryBase64, "base64"));
    bytes[0] ^= 1;
    step.after.memoryBase64 = base64(bytes);
  } else if (index === 7) return { ...proof, binding: { ...proof.binding, index: 1 } };
  else throw new Error("unmapped runtime negative control");
  return { ...proof, transitions };
}
