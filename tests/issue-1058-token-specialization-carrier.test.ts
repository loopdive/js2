// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, wrapExports } from "../src/index.js";

const SOURCES = {
  "./types.ts": `
export type Mutable<T> = { -readonly [P in keyof T]: T[P] };

export interface Node {
  readonly kind: number;
  readonly pos: number;
  readonly end: number;
}

export interface Token<TKind extends number> extends Node {
  readonly kind: TKind;
}

export interface PunctuationToken<TKind extends number> extends Token<TKind> {}
export type QuestionToken = PunctuationToken<1>;

export interface PropertySignature extends Node {
  readonly name: number;
  readonly questionToken: QuestionToken | undefined;
}

export interface MethodSignature extends Node {
  readonly name: number;
  readonly questionToken: QuestionToken | undefined;
}

export interface NodeFactory {
  createToken<TKind extends number>(token: TKind): PunctuationToken<TKind>;
  createPropertySignature(name: number, questionToken: QuestionToken | undefined): PropertySignature;
  createMethodSignature(name: number, questionToken: QuestionToken | undefined): MethodSignature;
}
`,
  "./factory.ts": `
import type {
  MethodSignature,
  Mutable,
  Node,
  NodeFactory,
  PropertySignature,
  PunctuationToken,
  QuestionToken,
  Token,
} from "./types.js";

function createBaseNode(kind: number): Node {
  return { kind, pos: 40, end: 41 };
}

function createBaseToken<T extends Node>(kind: T["kind"]): Mutable<T> {
  return createBaseNode(kind) as Mutable<T>;
}

export function createNodeFactory(): NodeFactory {
  return { createToken, createPropertySignature, createMethodSignature };

  function createToken<TKind extends number>(token: TKind): PunctuationToken<TKind>;
  function createToken<TKind extends number>(token: TKind) {
    // Match TypeScript's real NodeFactory implementation: overload resolution
    // exposes a PunctuationToken<TKind>, but the allocation is performed through
    // the more general Token<TKind> view.
    const node = createBaseToken<Token<TKind>>(token);
    return node;
  }

  function createPropertySignature(name: number, questionToken: QuestionToken | undefined): PropertySignature {
    return { kind: 2, pos: 50, end: 51, name, questionToken };
  }

  function createMethodSignature(name: number, questionToken: QuestionToken | undefined): MethodSignature {
    return { kind: 3, pos: 60, end: 61, name, questionToken };
  }
}
`,
  "./entry.ts": `
import { createNodeFactory } from "./factory.js";

// TypeScript's production NodeFactory crosses the module/object bridge as an
// open structural capability.  Keep this receiver dynamic so the regression
// exercises the same host -> Wasm closure-argument ABI.
const factory: any = createNodeFactory();

export function withQuestionTokens(): number {
  const questionToken = factory.createToken(1);
  const property = factory.createPropertySignature(4, questionToken);
  const method = factory.createMethodSignature(5, questionToken);
  return property.questionToken!.kind * 1000
    + method.questionToken!.pos * 10
    + property.name
    + method.name;
}

export function withoutQuestionTokens(): number {
  // The open host bridge carries a typed missing ref as null.  Use that exact
  // carrier here; supplied JavaScript undefined exercises a separate
  // optional-argument normalization path.
  const property = factory.createPropertySignature(4, null);
  const method = factory.createMethodSignature(5, null);
  return property.kind * 1000 + method.kind * 100 + property.name * 10 + method.name;
}
`,
} as const;

const OBJECT_SPECIALIZATION_SOURCES = {
  "./types.ts": `
export interface Box<T extends object> { value: T; }
export interface A { a: number; }
export interface B { b: number; }
export type ABox = Box<A>;
export type BBox = Box<B>;
`,
  "./entry.ts": `
import type { ABox, BBox } from "./types.js";

export function run(): number {
  const x: ABox = { value: { a: 11 } };
  const y: BBox = { value: { b: 31 } };
  return x.value.a + y.value.b;
}
`,
} as const;

const MERGED_TYPE_NODE_DESCENDANT_SOURCES = {
  "./src/compiler/types.ts": `
export type Mutable<T> = { -readonly [P in keyof T]: T[P] };

export interface Node {
  readonly kind: number;
  readonly pos: number;
  readonly end: number;
}

// Note: 'brands' in our syntax nodes serve to give us a small amount of nominal typing.
// The brands are never actually given values. At runtime they have zero cost.
export interface TypeNode extends Node {
  _typeNodeBrand: any;
}

export interface TypeNode extends Node {
  readonly kind: number;
}

export interface NodeWithTypeArguments extends TypeNode {
  readonly typeArguments?: TypeNode[];
}

export interface TypeReferenceNode extends NodeWithTypeArguments {
  readonly kind: 184;
  readonly typeName: number;
}

export interface PropertySignature extends Node {
  readonly name: number;
  readonly type: TypeNode | undefined;
}

export interface BaseNodeFactory {
  createBaseNode(kind: number): Node;
}

export interface NodeFactory {
  createTypeReferenceNode(typeName: number): TypeReferenceNode;
  createPropertySignature(
    modifiers: unknown,
    name: number,
    questionToken: unknown,
    type: TypeNode | undefined,
  ): PropertySignature;
}
`,
  "./src/compiler/factory.ts": `
import type {
  BaseNodeFactory,
  Mutable,
  Node,
  NodeFactory,
  PropertySignature,
  TypeNode,
  TypeReferenceNode,
} from "./types.js";

function NodeConstructor(this: Mutable<Node>, kind: number, pos: number, end: number): void {
  this.kind = kind;
  this.pos = pos;
  this.end = end;
}

const objectAllocator = {
  getNodeConstructor(): new (kind: number, pos: number, end: number) => Node {
    return NodeConstructor as any;
  },
};

function createBaseNodeFactory(): BaseNodeFactory {
  let Ctor: new (kind: number, pos: number, end: number) => Node;
  return { createBaseNode };

  function createBaseNode(kind: number): Node {
    return new (Ctor || (Ctor = objectAllocator.getNodeConstructor()))(kind, -1, -1);
  }
}

export function createNodeFactory(): NodeFactory {
  const baseFactory = createBaseNodeFactory();
  return { createTypeReferenceNode, createPropertySignature };

  function createBaseNode<T extends Node>(kind: T["kind"]): Mutable<T> {
    return baseFactory.createBaseNode(kind) as Mutable<T>;
  }

  function createTypeReferenceNode(typeName: number): TypeReferenceNode {
    const node = createBaseNode<TypeReferenceNode>(184);
    node.typeName = typeName;
    node.typeArguments = undefined;
    return node;
  }

  function createPropertySignature(
    _modifiers: unknown,
    name: number,
    _questionToken: unknown,
    type: TypeNode | undefined,
  ): PropertySignature {
    return { kind: 2, pos: 50, end: 51, name, type };
  }
}
`,
  "./src/compiler/entry.ts": `
import { createNodeFactory } from "./factory.js";

const factory: any = createNodeFactory();

export function run(): number {
  const type = factory.createTypeReferenceNode(7);
  const property = factory.createPropertySignature(null, 4, null, type);
  return property.type!.kind + property.type!.typeName;
}
`,
} as const;

describe("#1058 generic token specialization carrier", () => {
  it.each(["gc", "standalone"] as const)(
    "uses the Token<K> allocation carrier for empty token views in the %s lane",
    async (target) => {
      const result = await compileMulti(SOURCES, "./entry.ts", {
        target,
        platform: "node",
        skipSemanticDiagnostics: true,
        experimentalIR: false,
        emitWat: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect(result.wat).toContain("__call_fn_method_2");

      const module = new WebAssembly.Module(result.binary);
      const imports = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
      const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as {
        withQuestionTokens(): number;
        withoutQuestionTokens(): number;
      };

      expect(exports.withoutQuestionTokens()).toBe(2345);
      expect(exports.withQuestionTokens()).toBe(1409);
      if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
    },
  );

  it("keeps sibling object specializations on their generic standalone carrier", async () => {
    const result = await compileMulti(OBJECT_SPECIALIZATION_SOURCES, "./entry.ts", {
      target: "standalone",
      platform: "node",
      skipSemanticDiagnostics: true,
      experimentalIR: false,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as {
      run(): number;
    };
    expect(exports.run()).toBe(42);
  });

  it.each(["gc", "standalone"] as const)(
    "keeps descendants of an erased merged TypeNode on its Node carrier in the %s lane",
    async (target) => {
      const result = await compileMulti(MERGED_TYPE_NODE_DESCENDANT_SOURCES, "./src/compiler/entry.ts", {
        target,
        platform: "node",
        skipSemanticDiagnostics: true,
        experimentalIR: false,
        emitWat: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect(result.wat).toContain("__call_fn_method_4");

      const imports = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
      const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as {
        run(): number;
      };
      expect(exports.run()).toBe(191);
    },
  );
});
