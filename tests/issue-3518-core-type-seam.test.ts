// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as core from "../src/ir/core/types.js";
import * as nodes from "../src/ir/nodes.js";
import * as refinement from "../src/ir/core/tag-refinement.js";
import * as domain from "../src/ir/tag-domain.js";
import type { IrFnctorShape } from "../src/ir/core/fnctor-shapes.js";
import type { IrType, IrClassShape } from "../src/ir/core/types.js";
import type { ValType } from "../src/wasm/model/instructions.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { irFnctorShapeEquals, validateIrFnctorShape } from "../src/ir/fnctor-abi.js";
import { irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { createIrBindingId } from "../src/shared/contracts/identity-values.js";
import { createTestIrClassId, createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const parse = (path: string, source = read(path)) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const identities = createTestIrFunctionIdentityFactory("core-type-seam");
const constructorIdentity = identities.next("Node");
const f64 = core.irVal({ kind: "f64" });
const runtimeNames = [
  "irVal",
  "irVec",
  "irFnctor",
  "asVal",
  "irDynamic",
  "irTypeEquals",
  "classShapeEquals",
  "closureSignatureEquals",
  "objectShapeEquals",
] as const;
const canonicalPaths = [
  "src/ir/core/types.ts",
  "src/ir/core/fnctor-shapes.ts",
  "src/ir/core/value-references.ts",
  "src/ir/core/capability-provenance.ts",
  "src/ir/core/tag-refinement.ts",
  "src/shared/contracts/ir-identity.ts",
  "src/shared/contracts/source-origin.ts",
  "src/wasm/model/instructions.ts",
];

function shape(): IrFnctorShape {
  return {
    kind: "fnctor-shape",
    sourceId: identities.sourceId,
    constructorUnitId: constructorIdentity.unitId,
    constructorName: constructorIdentity.name,
    constructorTarget: irUnitFuncRef(constructorIdentity),
    reservedLayout: {
      kind: "type",
      name: "__fnctor_Node",
      binding: {
        kind: "source",
        bindingId: createIrBindingId({ ownerId: constructorIdentity.unitId, domain: "type", role: "layout" }),
      },
    },
    fields: [{ name: "value", type: f64, ordinal: 0 }],
    captures: [],
    userParamTypes: [],
    hiddenIdentity: false,
    constructorIdentity: { unitId: constructorIdentity.unitId, paramIndex: 0 },
  };
}

function classShape(ordinal = 0): IrClassShape {
  return {
    [core.IR_CLASS_SHAPE_CELL]: true,
    classId: createTestIrClassId("core-type-seam", ordinal),
    className: "Node",
    fields: [],
    methods: [],
    constructorParams: [],
  };
}

// This bounded source projection includes type edges. It is not proof of
// whole-node migration, public-root call reachability or retirement.
function canonicalClosure(overrides = new Map<string, string>()) {
  const modules = new Set<string>();
  const edges: { from: string; to: string; value: boolean }[] = [];
  function visit(path: string) {
    if (!canonicalPaths.includes(path)) throw new Error("outside canonical closure: " + path);
    if (modules.has(path)) return;
    modules.add(path);
    const file = parse(path, overrides.get(path) ?? read(path));
    if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
      throw new Error("unparsed module");
    const edge = (specifier: ts.Node | undefined, value: boolean) => {
      if (!specifier || !ts.isStringLiteralLike(specifier) || !specifier.text.startsWith("."))
        throw new Error("unknown import");
      const target = ts.resolveModuleName(
        specifier.text,
        resolve(root, path),
        { moduleResolution: ts.ModuleResolutionKind.Bundler },
        ts.sys,
      ).resolvedModule;
      if (!target) throw new Error("unresolved import: " + specifier.text);
      const to = relative(root, target.resolvedFileName);
      edges.push({ from: path, to, value });
      visit(to);
    };
    function walk(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const value =
          !clause ||
          (!clause.isTypeOnly &&
            (!!clause.name ||
              !bindings ||
              !ts.isNamedImports(bindings) ||
              bindings.elements.some((entry) => !entry.isTypeOnly)));
        edge(node.moduleSpecifier, value);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const clause = node.exportClause;
        edge(
          node.moduleSpecifier,
          !node.isTypeOnly &&
            (!clause || !ts.isNamedExports(clause) || clause.elements.some((entry) => !entry.isTypeOnly)),
        );
      } else if (ts.isImportTypeNode(node)) {
        if (!ts.isLiteralTypeNode(node.argument)) throw new Error("unknown import type");
        edge(node.argument.literal, false);
      } else if (
        ts.isImportEqualsDeclaration(node) ||
        (ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")))
      ) {
        throw new Error("unknown import form");
      }
      ts.forEachChild(node, walk);
    }
    walk(file);
  }
  visit("src/ir/core/types.ts");
  return { modules: [...modules].sort(), edges };
}

describe("canonical IR core types", () => {
  it.each(runtimeNames)("keeps the old and canonical %s function object identical", (name) => {
    expect(nodes[name]).toBe(core[name]);
  });

  it("keeps one class symbol, tag equality implementation and private recursion guard", () => {
    expect(nodes.IR_CLASS_SHAPE_CELL).toBe(core.IR_CLASS_SHAPE_CELL);
    expect(domain.tagRefinementEquals).toBe(refinement.tagRefinementEquals);
    expect(Object.keys(core).sort()).toEqual([...runtimeNames, "IR_CLASS_SHAPE_CELL"].sort());
    const variables = ["src/ir/nodes.ts", "src/ir/core/types.ts"].flatMap((path) =>
      parse(path)
        .statements.filter(ts.isVariableStatement)
        .flatMap((node) => node.declarationList.declarations.map((entry) => entry.name.getText())),
    );
    expect(variables.filter((name) => name === "IR_CLASS_SHAPE_CELL")).toHaveLength(1);
    expect(variables.filter((name) => name === "activeFnctorPairs")).toHaveLength(1);
    const old = parse("src/ir/nodes.ts");
    for (const name of ["irValSigned", "isDynamic"]) {
      expect(old.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)).toBe(true);
      expect(Object.keys(core)).not.toContain(name);
    }
    expect(old.statements.some((node) => ts.isTypeAliasDeclaration(node) && node.name.text === "IrInstr")).toBe(true);
    expect(old.statements.some((node) => ts.isInterfaceDeclaration(node) && node.name.text === "IrFunction")).toBe(
      true,
    );
  });

  it("resolves all eight canonical modules and twelve edges with only one runtime dependency", () => {
    const graph = canonicalClosure();
    expect(graph.modules).toEqual([...canonicalPaths].sort());
    expect(graph.edges).toHaveLength(12);
    expect(graph.edges.filter((edge) => edge.value)).toEqual([
      { from: "src/ir/core/types.ts", to: "src/ir/core/tag-refinement.ts", value: true },
    ]);
  });

  it.each([
    ['import "../nodes.js";', "outside canonical closure"],
    ['import type { IrFnctorShape } from "../fnctor-abi.js";', "outside canonical closure"],
    ['import type { IrUnitId } from "../identity.js";', "outside canonical closure"],
    ["import(variable);", "unknown import form"],
    ['export * from "./absent.js";', "unresolved import"],
    ["export {", "unparsed module"],
  ])("refuses injected dependency %s", (injection, message) => {
    const path = "src/ir/core/types.ts";
    expect(() => canonicalClosure(new Map([[path, read(path) + "\n" + injection]]))).toThrow(message);
  });

  it("loads constructors and equality without the old nodes, domains, validators or frontend in a fresh process", () => {
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { realpathSync } from 'node:fs';
      import { relative } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const root = realpathSync(process.cwd()), visited = new Set();
      const allowed = new Set(['src/ir/core/types.ts', 'src/ir/core/tag-refinement.ts']);
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (!result.url.startsWith('file:')) throw Error('forbidden dependency: ' + result.url);
        const path = relative(root, realpathSync(fileURLToPath(result.url)));
        if (!allowed.has(path)) throw Error('forbidden dependency: ' + path);
        visited.add(path);
        return result;
      }});
      const core = await import('./src/ir/core/types.ts');
      const scalar = { kind: 'f64' };
      assert.equal(core.asVal(core.irVal(scalar)), scalar);
      assert.equal(core.irTypeEquals(core.irVec(core.irVal(scalar)), core.irVec(core.irVal({kind:'f64'}))), true);
      assert.equal(core.irTypeEquals(core.irDynamic(), core.irDynamic(1)), false);
      assert.equal(core.irTypeEquals(core.irDynamic(1), core.irDynamic(1)), true);
      assert.equal(typeof core.IR_CLASS_SHAPE_CELL, 'symbol');
      await assert.rejects(import('./src/ir/nodes.ts'), /forbidden dependency:/);
      console.log(JSON.stringify([...visited].sort()));
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr + child.stdout).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(["src/ir/core/tag-refinement.ts", "src/ir/core/types.ts"]);
  });

  it("preserves opaque brands and nominal old/new type compatibility under the TypeScript checker", () => {
    const path = resolve(root, ".tmp/core-type-contract.ts");
    const source = `
      import type { TagId } from '../src/ir/core/tag-refinement.js';
      import type { TagId as OldTagId } from '../src/ir/tag-domain.js';
      import type { IrFuncRef } from '../src/ir/core/value-references.js';
      import type { IrFuncRef as OldRef } from '../src/ir/value-references.js';
      import type { IrDomCallbackAuthority } from '../src/ir/core/capability-provenance.js';
      import type { IrDomCallbackAuthority as OldAuthority } from '../src/ir/capability-provenance.js';
      import type { IrSourceId, IrUnitId, IrClassId, IrBindingId } from '../src/shared/contracts/ir-identity.js';
      declare let tag: TagId; declare let oldTag: OldTagId; tag = oldTag; oldTag = tag;
      declare let ref: IrFuncRef; declare let oldRef: OldRef; ref = oldRef; oldRef = ref;
      declare let auth: IrDomCallbackAuthority; declare let oldAuth: OldAuthority; auth = oldAuth; oldAuth = auth;
      declare let source: IrSourceId; declare let unit: IrUnitId; declare let klass: IrClassId; declare let binding: IrBindingId;
      // @ts-expect-error plain number cannot mint a TagId
      tag = 1;
      // @ts-expect-error plain string cannot mint a source
      source = 'source';
      // @ts-expect-error source and unit are distinct
      unit = source;
      // @ts-expect-error unit and class are distinct
      klass = unit;
      // @ts-expect-error unit and binding are distinct
      binding = unit;
    `;
    const diagnostics = (text: string) => {
      const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      };
      const host = ts.createCompilerHost(options);
      const original = host.getSourceFile.bind(host);
      host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
        fileName === path
          ? ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
          : original(fileName, languageVersion, onError, shouldCreateNewSourceFile);
      return ts.getPreEmitDiagnostics(ts.createProgram([path], options, host));
    };
    const valid = diagnostics(source);
    expect(valid.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n"))).toEqual([]);
    const invalid = diagnostics(source.replaceAll("@ts-expect-error", "negative control"));
    expect(invalid.map((entry) => entry.code)).toEqual([2322, 2322, 2322, 2322, 2322]);
  });

  it("preserves constructor defaults and every attached object reference", () => {
    const value: ValType = { kind: "ref_null", typeIdx: 17 };
    const wrapped = core.irVal(value);
    expect(core.asVal(wrapped)).toBe(value);
    expect(core.irVec(wrapped)).toEqual({ kind: "vec", elementType: wrapped, nullable: true });
    expect(core.irVec(wrapped, false)).toEqual({ kind: "vec", elementType: wrapped, nullable: false });
    const nominal = shape();
    expect(core.irFnctor(nominal)).toEqual({ kind: "fnctor", shape: nominal });
    expect((core.irFnctor(nominal) as Extract<IrType, { kind: "fnctor" }>).shape).toBe(nominal);
    expect(core.asVal(core.irVec(wrapped))).toBeNull();
    expect(core.irDynamic()).toEqual({ kind: "dynamic" });
    expect(Object.hasOwn(core.irDynamic(), "tag")).toBe(false);
    const tag = domain.asTagId(0);
    expect(core.irDynamic(tag)).toEqual({ kind: "dynamic", tag });
  });

  it("preserves signedness, underlying reference indices, and symbolic attachment insensitivity", () => {
    const i32 = core.irVal({ kind: "i32" });
    expect(core.irTypeEquals(i32, nodes.irValSigned({ kind: "i32" }, true))).toBe(true);
    expect(core.irTypeEquals(i32, nodes.irValSigned({ kind: "i32" }, false))).toBe(false);
    expect(core.irTypeEquals(core.irVal({ kind: "ref", typeIdx: 1 }), core.irVal({ kind: "ref", typeIdx: 2 }))).toBe(
      false,
    );
    expect(
      core.irTypeEquals(core.irVal({ kind: "ref", typeIdx: 1 }), core.irVal({ kind: "ref_null", typeIdx: 1 })),
    ).toBe(false);
    const nominal = shape();
    const attached: IrType = { kind: "val", val: { kind: "ref", typeIdx: 1 }, typeRef: nominal.reservedLayout };
    expect(core.irTypeEquals(attached, core.irVal({ kind: "ref", typeIdx: 1 }))).toBe(true);
    expect(core.irTypeEquals({ kind: "string", carrierRef: nominal.reservedLayout }, { kind: "string" })).toBe(true);
    expect(core.asVal(attached)).toBe(attached.val);
    expect(attached.typeRef).toBe(nominal.reservedLayout);
  });

  it("preserves exact nullish tag equality, including NaN and signed zero", () => {
    const tag = domain.asTagId(3);
    expect(refinement.tagRefinementEquals(undefined, undefined)).toBe(true);
    expect(refinement.tagRefinementEquals(tag, undefined)).toBe(false);
    expect(refinement.tagRefinementEquals(tag, tag)).toBe(true);
    expect(refinement.tagRefinementEquals(tag, domain.asTagId(4))).toBe(false);
    expect(refinement.tagRefinementEquals(domain.asTagId(-0), domain.asTagId(0))).toBe(true);
    expect(refinement.tagRefinementEquals(domain.asTagId(NaN), domain.asTagId(NaN))).toBe(false);
    expect(Reflect.apply(refinement.tagRefinementEquals, undefined, [null, undefined])).toBe(true);
  });

  it("preserves nominal class identity and structural closure/object order and defaults", () => {
    const klass = classShape();
    expect(core.classShapeEquals(klass, { ...klass, className: "renamed", parent: classShape(1) })).toBe(true);
    expect(core.classShapeEquals(klass, classShape(1))).toBe(false);
    const signature = { params: [f64], returnType: f64 };
    expect(core.closureSignatureEquals(signature, { ...signature, defaultParamStart: 1 })).toBe(true);
    expect(core.closureSignatureEquals(signature, { ...signature, defaultParamStart: 0 })).toBe(false);
    expect(core.closureSignatureEquals(signature, { ...signature, returnType: null })).toBe(false);
    const object = {
      fields: [
        { name: "a", type: f64 },
        { name: "b", type: core.irVec(f64) },
      ],
    };
    expect(core.objectShapeEquals(object, { fields: [...object.fields] })).toBe(true);
    expect(core.objectShapeEquals(object, { fields: [...object.fields].reverse() })).toBe(false);
    expect(
      core.irTypeEquals(
        { kind: "boxed", inner: { kind: "object", shape: object } },
        { kind: "boxed", inner: { kind: "object", shape: object } },
      ),
    ).toBe(true);
    expect(
      core.irTypeEquals(
        { kind: "union", members: [f64, core.irVec(f64)] },
        { kind: "union", members: [core.irVec(f64), f64] },
      ),
    ).toBe(false);
  });

  it("shares recursive fnctor equality state across old/new calls and clears it after failure or throw", () => {
    const leftFields: { name: string; type: IrType; ordinal: number }[] = [];
    const rightFields: { name: string; type: IrType; ordinal: number }[] = [];
    const left = { ...shape(), fields: leftFields };
    const right = { ...shape(), fields: rightFields };
    leftFields.push({ name: "self", type: nodes.irFnctor(left), ordinal: 0 });
    rightFields.push({ name: "self", type: core.irFnctor(right), ordinal: 0 });
    expect(nodes.irTypeEquals(core.irFnctor(left), nodes.irFnctor(right))).toBe(true);
    rightFields[0].name = "different";
    expect(core.irTypeEquals(nodes.irFnctor(left), core.irFnctor(right))).toBe(false);
    rightFields[0].name = "self";
    expect(core.irTypeEquals(nodes.irFnctor(left), core.irFnctor(right))).toBe(true);
    Object.defineProperty(right, "fields", {
      configurable: true,
      get() {
        throw new Error("field getter");
      },
    });
    expect(() => core.irTypeEquals(core.irFnctor(left), nodes.irFnctor(right))).toThrow("field getter");
    Object.defineProperty(right, "fields", { configurable: true, value: rightFields });
    rightFields[0].name = "different";
    expect(nodes.irTypeEquals(core.irFnctor(left), core.irFnctor(right))).toBe(false);
  });

  it("keeps real builder/verifier and fnctor-validator consumers on the canonical implementation", () => {
    const nominal = shape();
    expect(validateIrFnctorShape(nominal)).toBeNull();
    const make = vi.spyOn(core, "irFnctor");
    const equal = vi.spyOn(core, "irTypeEquals");
    try {
      const builder = new IrFunctionBuilder(identities.next("read"), [f64]);
      builder.openBlock();
      const instance = builder.emitFnctorNew(nominal, [], [], null);
      const value = builder.emitFnctorGet(instance, nominal, "value");
      builder.terminate({ kind: "return", values: [value] });
      const fn = builder.finish();
      expect(fn.blocks[0].instrs.map((instr) => instr.kind)).toEqual(["fnctor.new", "fnctor.get"]);
      expect(verifyIrFunction(fn)).toEqual([]);
      expect(irFnctorShapeEquals(nominal, shape())).toBe(true);
      expect(make).toHaveBeenCalledWith(nominal);
      expect(equal.mock.calls.length).toBeGreaterThan(0);
      const made = fn.blocks[0].instrs[0];
      expect(made.kind === "fnctor.new" && made.shape).toBe(nominal);
    } finally {
      equal.mockRestore();
      make.mockRestore();
    }
  });
});
