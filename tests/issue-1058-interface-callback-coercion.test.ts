// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { coercionInstrs } from "../src/codegen/type-coercion.js";
import { generateModule } from "../src/codegen/index.js";
import {
  isNominalStructParent,
  isSealedNominalStructParent,
  sealNominalStructParent,
  validateFinalStructHierarchies,
} from "../src/codegen/struct-hierarchy-layout.js";
import type { StructTypeDef, ValType } from "../src/ir/types.js";
import { compile, compileMulti } from "../src/index.js";

const SOURCE = `
interface Node {
  kind: number;
  flags: number;
  parent: Node | null;
}

interface Tag extends Node {
  kind: number;
  parent: Tag | null;
  name: number;
}

function isTag(node: Node | null): node is Tag {
  if (node === null) return false;
  node.flags += 1;
  return node.kind === 1;
}

export function test(): number {
  const first: Tag = { kind: 1, flags: 4, parent: null, name: 9 };
  const tags: Tag[] = [first, null as any, { kind: 2, flags: 7, parent: first, name: 8 }];
  const selected = tags.filter(isTag);
  return selected.length * 100 + first.flags * 10 + selected[0].name;
}
`;

const STRUCTURAL_FALLBACK_SOURCE = `
interface Base {
  kind: number;
  flags: number;
}

interface Extra {
  code: number;
}

interface MultiTag extends Base, Extra {
  name: number;
}

function isMultiTag(node: Base): node is MultiTag {
  return node.kind === 1;
}

function baseScore(node: Base | null): number {
  return node === null ? -1 : node.kind * 10 + node.flags;
}

export function testProjection(): number {
  const value: MultiTag = { kind: 1, flags: 4, code: 3, name: 9 };
  return baseScore(value) * 100 + baseScore(null);
}

export function testArrayFields(): number {
  const values: MultiTag[] = [{ kind: 1, flags: 4, code: 3, name: 9 }];
  return values[0].kind * 10 + values[0].flags;
}

export function test(): number {
  const values: MultiTag[] = [
    { kind: 1, flags: 4, code: 3, name: 9 },
    { kind: 2, flags: 7, code: 8, name: 6 },
  ];
  const selected = values.filter(isMultiTag);
  return selected.length;
}
`;

const LATE_METHOD_PARENT_SOURCE = `
interface PerformanceTime {
  now(): number;
  timeOrigin: number;
}

interface Performance extends PerformanceTime {
  mark(name: string): void;
}

function read(value: PerformanceTime): number {
  return value.now() + value.timeOrigin;
}

export function test(value: Performance): number {
  return read(value);
}
`;

const SEALED_PARENT_DYNAMIC_READ_SOURCE = `
interface NodeLike {
  kind: number;
  flags: number;
}

interface JSDocContainerLike extends NodeLike {
  _brand: any;
  docs?: number[];
}

function mutateBase(node: NodeLike): number {
  node.flags += 1;
  return node.flags;
}

function readDerivedThroughBase(node: NodeLike & { docs?: number[] }): number {
  return node.docs ? node.docs.length : 0;
}

export function test(): number {
  const child: JSDocContainerLike = { kind: 1, flags: 4, _brand: 0, docs: [7, 8] };
  const plain: NodeLike = { kind: 0, flags: 8 };
  const after = mutateBase(child);
  return (
    readDerivedThroughBase(child) * 1000 +
    readDerivedThroughBase(plain as NodeLike & { docs?: number[] }) * 100 +
    child.flags * 10 +
    after
  );
}
`;

const SEALED_PARENT_LOGICAL_ASSIGNMENT_SOURCE = `
interface NodeLike {
  kind: number;
  flags: number;
}

interface JSDocContainerLike extends NodeLike {
  _brand: any;
  docs?: number[];
  score: number;
}

interface DocA extends JSDocContainerLike {
  a: number;
}

interface DocB extends JSDocContainerLike {
  b: number;
}

type HasDocs = DocA | DocB;

function canHaveDocs(node: NodeLike): node is HasDocs {
  return node.kind === 1 || node.kind === 2;
}

function cache(node: NodeLike): number {
  if (!canHaveDocs(node)) return -1;
  return (node.docs ??= [9]).length;
}

function bumpScore(node: NodeLike): number {
  if (!canHaveDocs(node)) return -1;
  return (node.score += 2);
}

function concreteLength(node: DocB): number {
  return node.docs ? node.docs.length : -1;
}

function concreteSet(node: DocB): number {
  node.docs = [1, 2, 3];
  return node.docs.length;
}

export function test(): number {
  const a: DocA = { kind: 1, flags: 4, _brand: 0, docs: [7, 8], score: 3, a: 9 };
  const b: DocB = { kind: 2, flags: 5, _brand: 0, score: 4, b: 6 };
  const existing = cache(a);
  const initialized = cache(b);
  const direct = concreteLength(b);
  const replaced = concreteSet(b);
  const dynamicAfter = cache(b);
  return existing * 10000 + initialized * 1000 + direct * 100 + replaced * 10 + dynamicAfter;
}

export function testCompound(): number {
  const b: DocB = { kind: 2, flags: 5, _brand: 0, score: 4, b: 6 };
  return bumpScore(b) * 10 + b.score;
}
`;

const SEALED_PARENT_COMPUTED_LITERAL_SOURCE = `
interface NodeLike {
  kind: number;
}

interface ChildLike extends NodeLike {
  _brand: any;
}

function readExtra(node: NodeLike & { extra: number }): number {
  return node.extra;
}

export function test(): number {
  const key = "extra";
  const node: NodeLike = { kind: 1, [key]: 9 } as NodeLike;
  return node.kind * 10 + readExtra(node as NodeLike & { extra: number });
}
`;

const SEALED_PARENT_OPTIONAL_CHAIN_SOURCE = `
interface NodeLike {
  kind: number;
}

interface CacheLike {
  values?: number[];
}

interface JSDocContainerLike extends NodeLike {
  _brand: any;
  docs?: CacheLike;
}

function readCache(node: NodeLike & { docs?: CacheLike }): number {
  const values = node.docs?.values;
  return values ? values.length : 0;
}

export function test(): number {
  const present: JSDocContainerLike = { kind: 1, _brand: 0, docs: { values: [7, 8] } };
  const absent: NodeLike = { kind: 2 };
  return readCache(present) * 10 + readCache(absent as NodeLike & { docs?: CacheLike });
}
`;

const ASSERTION_ERASED_COMPOUND_SOURCE = `
interface NodeLike {
  readonly pos: number;
  readonly end: number;
  readonly kind: number;
  readonly flags: number;
  readonly parent: NodeLike | null;
}

interface NodeContainerLike extends NodeLike {
  _brand: any;
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

function observeMutable(node: Mutable<NodeLike>): number {
  return node.pos + node.end + node.kind + node.flags + (node.parent ? 1 : 0);
}

function aggregateChildData(node: NodeLike): void {
  if (!(node.flags & 2)) {
    if ((node.flags & 1) !== 0) {
      (node as Mutable<NodeLike>).flags |= 4;
    }
    (node as Mutable<NodeLike>).flags |= 2;
  }
}

export function test(): number {
  const node: NodeContainerLike = { pos: 0, end: 1, kind: 9, flags: 1, parent: null, _brand: 0 };
  const before = observeMutable(node);
  aggregateChildData(node);
  return before * 100 + node.flags * 10 + node.kind;
}
`;

const VISIT_NODE_RETURN_CARRIER_SOURCE = `
import { collisionWitness } from "./visit-node-collision.js";

interface NodeLike {
  kind: number;
  flags: number;
}

interface ChildNodeLike extends NodeLike {
  _brand: any;
}

type VisitResult = NodeLike | readonly NodeLike[] | undefined;
type Visitor = (node: NodeLike) => VisitResult;
type Lift = (nodes: readonly NodeLike[]) => NodeLike;

function isNodeArray(value: VisitResult): value is readonly NodeLike[] {
  return Array.isArray(value);
}

function extractSingleNode(nodes: readonly NodeLike[]): NodeLike | undefined {
  return nodes.length === 1 ? nodes[0] : undefined;
}

function visitNode(node: NodeLike, visitor: Visitor, lift?: Lift): NodeLike | undefined {
  if (node === undefined) {
    return node;
  }
  const visited = visitor(node);
  let visitedNode: NodeLike | undefined;
  if (visited === undefined) {
    return undefined;
  } else if (isNodeArray(visited)) {
    visitedNode = (lift || extractSingleNode)(visited);
  } else {
    visitedNode = visited;
  }
  return visitedNode;
}

function direct(node: NodeLike): VisitResult {
  return node;
}

function array(node: NodeLike): VisitResult {
  return [node];
}

export function test(): number {
  const node: ChildNodeLike = { kind: 7, flags: 1, _brand: 0 };
  const first = visitNode(node, direct);
  const second = visitNode(first || node, array);
  return (first ? first.kind : 0) * 100 + (second ? second.flags : 0) * 10 + collisionWitness();
}
`;

const VISIT_NODE_COLLISION_SOURCE = `
function visitNode<T>(cbNode: (value: number) => T, value: number): T {
  return cbNode(value);
}

function opaque(value: number): any {
  return value;
}

export function collisionWitness(): number {
  return visitNode(opaque, 1);
}
`;

const SCAN_NUMBER_FRAGMENT_CAPTURE_SOURCE = `
function createScanner(textInitial: string, start?: number): number {
  var text = textInitial;
  var pos: number;
  var end: number;

  setText(text, start);

  function charCodeUnchecked(index: number): number {
    return text.charCodeAt(index);
  }

  function scanNumberFragment(): string {
    let start = pos;
    let result = "";
    while (pos < text.length) {
      const ch = charCodeUnchecked(pos);
      if (ch === 95) {
        result += text.substring(start, pos);
        pos++;
        start = pos;
        continue;
      }
      pos++;
    }
    return result + text.substring(start, pos);
  }

  function scanNumber(): string {
    let start = pos;
    let mainFragment = scanNumberFragment();
    let end = pos;
    let result: string;
    if (mainFragment) {
      result = mainFragment;
    } else {
      result = text.substring(start, end);
    }
    return result;
  }

  function setText(newText: string, start: number | undefined): void {
    text = newText || "";
    pos = start || 0;
    end = text.length;
  }

  return scanNumber().length + (end === pos ? 0 : 100);
}

export function test(): number {
  return createScanner("12_34", 0);
}

export function testForwarding(): number {
  var start = 10;

  function bumpOuterStart(): number {
    start += 1;
    return start;
  }

  function scanNumber(): number {
    let start = 2;
    return bumpOuterStart() * 10 + start;
  }

  return scanNumber();
}

export function testParameterForwarding(): number {
  var start = 10;

  function bumpOuterStart(): number {
    start += 1;
    return start;
  }

  function scanNumber(start: number): number {
    return bumpOuterStart() * 10 + start;
  }

  return scanNumber(2);
}

export function testValueForwarding(): number {
  var start = 10;

  function bumpOuterStart(): number {
    start += 1;
    return start;
  }

  function scanNumber(): number {
    let start = 2;
    const bump = bumpOuterStart;
    return bump() * 10 + start;
  }

  return scanNumber();
}

export function testDefaultEnvironment(): number {
  var start = 1;

  function bumpOuterStart(): number {
    start += 10;
    return start;
  }

  function scanNumber(initial = start): number {
    let start = 2;
    return initial * 100 + bumpOuterStart() * 10 + start;
  }

  return scanNumber();
}
`;

const CONSTRUCTOR_TYPE_NODE_CONDITIONAL_SOURCE = `
interface ConstructorNodeLike {
  kind: number;
}

function fail(message: string): never {
  throw message;
}

function createFactory(base: number): number {
  function createConstructorTypeNode1(
    modifiers: number | undefined,
    typeParameters: number,
    parameters: number,
    type: number,
  ): ConstructorNodeLike {
    return { kind: base + (modifiers || 0) + typeParameters + parameters + type };
  }

  function createConstructorTypeNode2(
    typeParameters: number,
    parameters: number,
    type: number,
  ): ConstructorNodeLike {
    return createConstructorTypeNode1(undefined, typeParameters, parameters, type);
  }

  function createConstructorTypeNode(
    ...args: Parameters<typeof createConstructorTypeNode1 | typeof createConstructorTypeNode2>
  ): any {
    return args.length === 4
      ? createConstructorTypeNode1(...args)
      : args.length === 3
        ? createConstructorTypeNode2(...args)
        : fail("Incorrect number of arguments specified.");
  }

  return createConstructorTypeNode1(1, 2, 3, 4).kind * 10 + createConstructorTypeNode2(5, 6, 7).kind;
}

export function test(): number {
  return createFactory(0);
}
`;

const ref = (typeIdx: number): ValType => ({ kind: "ref", typeIdx });
const refNull = (typeIdx: number): ValType => ({ kind: "ref_null", typeIdx });

describe("#1058 interface array callback coercion", () => {
  it("covers all nullability combinations for a declared interface upcast", () => {
    const parent: StructTypeDef = {
      kind: "struct",
      name: "Parent",
      fields: [{ name: "kind", type: { kind: "f64" }, mutable: true }],
      superTypeIdx: -1,
    };
    const child: StructTypeDef = {
      kind: "struct",
      name: "Child",
      fields: [
        { name: "kind", type: { kind: "f64" }, mutable: true },
        { name: "name", type: { kind: "f64" }, mutable: true },
      ],
      superTypeIdx: 0,
    };
    const ctx = {
      mod: { types: [parent, child] },
      anyValueTypeIdx: -1,
      noBrandShapeTypes: new Set<number>(),
    } as never;
    const fctx = { body: [], savedBodies: [], locals: [] } as never;

    expect(coercionInstrs(ctx, ref(1), ref(0), fctx)).toEqual([]);
    expect(coercionInstrs(ctx, ref(1), refNull(0), fctx)).toEqual([]);
    expect(coercionInstrs(ctx, refNull(1), refNull(0), fctx)).toEqual([]);
    expect(coercionInstrs(ctx, refNull(1), ref(0), fctx)).toEqual([{ op: "ref.as_non_null" }]);
  });

  it("passes derived interface values to a base predicate without losing identity or null", async () => {
    const generated = generateModule(analyzeSource(SOURCE, "issue-1058-interface-callback-coercion-layout.ts"), {
      standalone: true,
    });
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const nodeIdx = generated.module.types.findIndex((type) => type.kind === "struct" && type.name === "Node");
    const tag = generated.module.types.find(
      (type): type is StructTypeDef => type.kind === "struct" && type.name === "Tag",
    );
    expect(nodeIdx).toBeGreaterThanOrEqual(0);
    expect(tag).toBeDefined();
    expect(tag!.superTypeIdx).toBe(nodeIdx);
    const node = generated.module.types[nodeIdx] as StructTypeDef;
    expect(tag!.fields.slice(0, node.fields.length)).toEqual(node.fields);

    const result = await compile(SOURCE, {
      fileName: "issue-1058-interface-callback-coercion.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as unknown as { test(): number };
    // 1 selected tag, mutation through the Node view is visible on `first`,
    // and the selected Tag still exposes its derived `name` field.
    expect(exports.test()).toBe(159);
  });

  it("projects flattened multiple inheritance and separately preserves a nullable projection", async () => {
    const generated = generateModule(
      analyzeSource(STRUCTURAL_FALLBACK_SOURCE, "issue-1058-interface-structural-fallback.ts"),
      { standalone: true },
    );
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const multiTag = generated.module.types.find(
      (type): type is StructTypeDef => type.kind === "struct" && type.name === "MultiTag",
    );
    const baseIdx = generated.module.types.findIndex((type) => type.kind === "struct" && type.name === "Base");
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(multiTag).toBeDefined();
    // Multiple TypeScript heritage clauses are still flattened physically, but
    // the one compatible declared prefix remains a useful nominal Wasm parent.
    expect(multiTag!.superTypeIdx).toBe(baseIdx);
    expect(multiTag!.fields.map((field) => field.name)).toEqual(["kind", "flags", "code", "name"]);

    const result = await compile(STRUCTURAL_FALLBACK_SOURCE, {
      fileName: "issue-1058-interface-structural-fallback.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as unknown as {
      test(): number;
      testProjection(): number;
      testArrayFields(): number;
    };
    expect(exports.testProjection()).toBe(1399);
    expect(exports.testArrayFields()).toBe(14);
    expect(exports.test()).toBe(1);
  });

  it("eagerly flattens method-bearing interfaces without nominally linking them", async () => {
    const generated = generateModule(
      analyzeSource(LATE_METHOD_PARENT_SOURCE, "issue-1058-interface-late-method-parent.ts"),
      { standalone: true },
    );
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const performanceTime = generated.module.types.find(
      (type): type is StructTypeDef => type.kind === "struct" && type.name === "PerformanceTime",
    );
    const performance = generated.module.types.find(
      (type): type is StructTypeDef => type.kind === "struct" && type.name === "Performance",
    );
    expect(performanceTime?.fields.map((field) => field.name)).toEqual(["now", "timeOrigin"]);
    expect(performance?.fields.map((field) => field.name)).toEqual(["now", "timeOrigin", "mark"]);
    expect(performance?.superTypeIdx).toBeUndefined();

    const result = await compile(LATE_METHOD_PARENT_SOURCE, {
      fileName: "issue-1058-interface-late-method-parent.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("keeps a nominal parent sealed and dynamically reads a derived-only optional field", async () => {
    const generated = generateModule(
      analyzeSource(SEALED_PARENT_DYNAMIC_READ_SOURCE, "issue-1058-sealed-parent-dynamic-read-layout.ts"),
      { standalone: true },
    );
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);

    const nodeIdx = generated.module.types.findIndex((type) => type.kind === "struct" && type.name === "NodeLike");
    const node = generated.module.types[nodeIdx] as StructTypeDef;
    const container = generated.module.types.find(
      (type): type is StructTypeDef => type.kind === "struct" && type.name === "JSDocContainerLike",
    );
    expect(nodeIdx).toBeGreaterThanOrEqual(0);
    expect(node.fields.map((field) => field.name)).toEqual(["kind", "flags"]);
    expect(container?.superTypeIdx).toBe(nodeIdx);
    expect(container?.fields.slice(0, node.fields.length)).toEqual(node.fields);
    expect(generated.module.functions.some((func) => func.name === "__get_member_docs")).toBe(true);

    const result = await compile(SEALED_PARENT_DYNAMIC_READ_SOURCE, {
      fileName: "issue-1058-sealed-parent-dynamic-read.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as unknown as { test(): number };
    // Present derived docs contribute 2000; absent base docs contribute zero;
    // the mutation through NodeLike remains visible on the original child.
    expect(exports.test()).toBe(2055);
  });

  it("keeps union-narrowed logical and compound assignments on the derived slots", async () => {
    const generated = generateModule(
      analyzeSource(SEALED_PARENT_LOGICAL_ASSIGNMENT_SOURCE, "issue-1058-sealed-parent-rmw-layout.ts"),
      { standalone: true },
    );
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);

    const nodeIdx = generated.module.types.findIndex((type) => type.kind === "struct" && type.name === "NodeLike");
    const node = generated.module.types[nodeIdx] as StructTypeDef;
    const container = generated.module.types.find(
      (type): type is StructTypeDef => type.kind === "struct" && type.name === "JSDocContainerLike",
    );
    expect(node.fields.map((field) => field.name)).toEqual(["kind", "flags"]);
    expect(container?.superTypeIdx).toBe(nodeIdx);
    expect(container?.fields.slice(0, node.fields.length)).toEqual(node.fields);
    expect(generated.module.functions.some((func) => func.name === "__get_member_docs")).toBe(true);
    expect(generated.module.functions.some((func) => func.name === "__set_member_docs")).toBe(true);
    expect(generated.module.functions.some((func) => func.name === "__get_member_score")).toBe(true);
    expect(generated.module.functions.some((func) => func.name === "__set_member_nonstrict_score")).toBe(true);

    const result = await compile(SEALED_PARENT_LOGICAL_ASSIGNMENT_SOURCE, {
      fileName: "issue-1058-sealed-parent-rmw.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as unknown as { test(): number; testCompound(): number };
    // Existing docs survive ??= (2), missing docs initialize the concrete B
    // slot (1), concrete read/write and a later dynamic read all agree (1/3/3).
    expect(exports.test()).toBe(21133);
    // Compound assignment writes the same concrete score slot it read.
    expect(exports.testCompound()).toBe(66);
  });

  it("uses a fresh subtype when a computed literal would widen a sealed parent", async () => {
    const generated = generateModule(
      analyzeSource(SEALED_PARENT_COMPUTED_LITERAL_SOURCE, "issue-1058-sealed-parent-literal-layout.ts"),
      { standalone: true },
    );
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);

    const nodeIdx = generated.module.types.findIndex((type) => type.kind === "struct" && type.name === "NodeLike");
    const node = generated.module.types[nodeIdx] as StructTypeDef;
    const literal = generated.module.types.find(
      (type): type is StructTypeDef => type.kind === "struct" && type.name.startsWith("__sealed_literal_"),
    );
    expect(node.fields.map((field) => field.name)).toEqual(["kind"]);
    expect(literal?.superTypeIdx).toBe(nodeIdx);
    expect(literal?.fields.map((field) => field.name)).toEqual(["kind", "extra"]);

    const result = await compile(SEALED_PARENT_COMPUTED_LITERAL_SOURCE, {
      fileName: "issue-1058-sealed-parent-literal.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as unknown as { test(): number };
    expect(exports.test()).toBe(19);
  });

  it("converts a sealed-parent dynamic read before an optional-chain struct guard", async () => {
    const generated = generateModule(
      analyzeSource(SEALED_PARENT_OPTIONAL_CHAIN_SOURCE, "issue-1058-sealed-parent-optional-chain-layout.ts"),
      { standalone: true },
    );
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);

    const nodeIdx = generated.module.types.findIndex((type) => type.kind === "struct" && type.name === "NodeLike");
    const node = generated.module.types[nodeIdx] as StructTypeDef;
    const container = generated.module.types.find(
      (type): type is StructTypeDef => type.kind === "struct" && type.name === "JSDocContainerLike",
    );
    expect(node.fields.map((field) => field.name)).toEqual(["kind"]);
    expect(container?.superTypeIdx).toBe(nodeIdx);
    expect(generated.module.functions.some((func) => func.name === "__get_member_docs")).toBe(true);

    const result = await compile(SEALED_PARENT_OPTIONAL_CHAIN_SOURCE, {
      fileName: "issue-1058-sealed-parent-optional-chain.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as unknown as { test(): number };
    expect(exports.test()).toBe(20);
  });

  it("uses the assertion-erased receiver carrier for mapped-type compound writes", async () => {
    const result = await compile(ASSERTION_ERASED_COMPOUND_SOURCE, {
      fileName: "issue-1058-assertion-erased-compound.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as unknown as { test(): number };
    expect(exports.test()).toBe(1179);
  });

  it("keeps a registered visitNode return ABI across a same-named generic specialization", async () => {
    const result = await compileMulti(
      {
        "issue-1058-visit-node-return-carrier.ts": VISIT_NODE_RETURN_CARRIER_SOURCE,
        "visit-node-collision.ts": VISIT_NODE_COLLISION_SOURCE,
      },
      "issue-1058-visit-node-return-carrier.ts",
      {
        target: "gc",
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    let validationError: unknown;
    try {
      new WebAssembly.Module(result.binary);
    } catch (error) {
      validationError = error;
    }
    expect(validationError).toBeUndefined();

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    const exports = instance.exports as unknown as { test(): number };
    expect(exports.test()).toBe(711);
  });

  it("does not box a function-body lexical that shadows an outer scanner parameter", async () => {
    const result = await compile(SCAN_NUMBER_FRAGMENT_CAPTURE_SOURCE, {
      fileName: "issue-1058-scan-number-fragment-capture.ts",
      target: "gc",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    const exports = instance.exports as unknown as {
      test(): number;
      testForwarding(): number;
      testParameterForwarding(): number;
      testValueForwarding(): number;
      testDefaultEnvironment(): number;
    };
    expect(exports.test()).toBe(4);
    expect(exports.testForwarding()).toBe(112);
    expect(exports.testParameterForwarding()).toBe(112);
    expect(exports.testValueForwarding()).toBe(112);
    expect(exports.testDefaultEnvironment()).toBe(212);
  });

  it("keeps a capturing function prefix below source-level spread arguments", async () => {
    const result = await compile(CONSTRUCTOR_TYPE_NODE_CONDITIONAL_SOURCE, {
      fileName: "issue-1058-constructor-type-node-conditional.ts",
      target: "gc",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    let validationError: unknown;
    try {
      new WebAssembly.Module(result.binary);
    } catch (error) {
      validationError = error;
    }
    expect(validationError).toBeUndefined();

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    const exports = instance.exports as unknown as { test(): number };
    expect(exports.test()).toBe(118);
  });

  it("keeps declaration-time sealing after a live hierarchy edge is detached", () => {
    const parent: StructTypeDef = {
      kind: "struct",
      name: "Parent",
      fields: [{ name: "kind", type: { kind: "f64" }, mutable: true }],
      superTypeIdx: -1,
    };
    const child: StructTypeDef = {
      kind: "struct",
      name: "Child",
      fields: [{ name: "kind", type: { kind: "f64" }, mutable: true }],
      superTypeIdx: 0,
    };
    const ctx = { mod: { types: [parent, child] } } as never;

    sealNominalStructParent(ctx, 0);
    child.superTypeIdx = undefined;
    expect(isNominalStructParent({ types: [parent, child] } as never, 0)).toBe(false);
    expect(isSealedNominalStructParent(ctx, 0)).toBe(true);
  });

  it("fails closed when a nominal parent prefix is mutated after linking", () => {
    const parent: StructTypeDef = {
      kind: "struct",
      name: "Parent",
      fields: [{ name: "kind", type: { kind: "f64" }, mutable: true }],
      superTypeIdx: -1,
    };
    const child: StructTypeDef = {
      kind: "struct",
      name: "Child",
      fields: [
        { name: "kind", type: { kind: "f64" }, mutable: true },
        { name: "brand", type: { kind: "externref" }, mutable: true },
      ],
      superTypeIdx: 0,
    };
    const errors: Array<{ message: string }> = [];
    const ctx = { mod: { types: [parent, child] }, errors } as never;

    expect(isNominalStructParent({ types: [parent, child] } as never, 0)).toBe(true);
    expect(validateFinalStructHierarchies(ctx)).toBe(true);
    parent.fields.push({ name: "late", type: { kind: "f64" }, mutable: true });
    expect(validateFinalStructHierarchies(ctx)).toBe(false);
    expect(errors.at(-1)?.message).toContain("is no longer an exact mutable-field prefix");
  });

  it("rejects a child linked to a parent emitted as an implicitly final plain struct", () => {
    const parent: StructTypeDef = {
      kind: "struct",
      name: "PlainParent",
      fields: [{ name: "kind", type: { kind: "f64" }, mutable: true }],
    };
    const child: StructTypeDef = {
      kind: "struct",
      name: "Child",
      fields: [{ name: "kind", type: { kind: "f64" }, mutable: true }],
      superTypeIdx: 0,
    };
    const errors: Array<{ message: string }> = [];
    const ctx = { mod: { types: [parent, child] }, errors } as never;

    expect(validateFinalStructHierarchies(ctx)).toBe(false);
    expect(errors[0]?.message).toContain("was not emitted as an open hierarchy type");
  });
});
