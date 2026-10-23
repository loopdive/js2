// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrType, IrValueId } from "./core/nodes.js";
import { irTypeEquals } from "./core/types.js";
import { collectOuterWrites, collectTransitiveClosureCaptures } from "./closure-captures.js";
import { isFunctionScopeBoundary } from "./analysis/ast-scope.js";
import { classMemberUnitKind, hasStaticModifier } from "./analysis/class-definition-syntax.js";
import {
  requireIrPlanningClassRecord,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
} from "./planning-identity.js";
import { resolveOrdinaryObjectClosureSignature } from "./ordinary-object-closure-signatures.js";
import { IrInvariantError, IrUnsupportedError } from "./outcomes.js";
import type { IrUnitId } from "./identity.js";

export type IrClosureLiteral =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;
type Member = ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;
export interface ClosureCaptureBinding {
  readonly name: string;
  readonly withField?: { readonly name: string; readonly type: IrType };
}

/** Shared by original terminal entries and ordinary lifted closure entries. */
export function bindSourceClosureCaptures(
  captures: readonly ClosureCaptureBinding[],
  fieldTypes: readonly IrType[],
  self: IrValueId,
  builder: IrFunctionBuilder,
  bind: (capture: ClosureCaptureBinding, value: IrValueId, fieldType: IrType) => void,
): void {
  for (const [index, capture] of captures.entries()) {
    const fieldType = fieldTypes[index]!;
    bind(capture, builder.emitClosureCap(self, index, fieldType), fieldType);
  }
}

export interface SourceClosureEntry {
  readonly unitId: IrUnitId;
  readonly declaration: Member;
  readonly signature: Extract<
    ReturnType<typeof resolveOrdinaryObjectClosureSignature>,
    { kind: "supported" }
  >["signature"];
  readonly captures: readonly ClosureCaptureBinding[];
  readonly captureFieldTypes: readonly IrType[];
  assertCurrent(declaration: ts.Node, unitId: IrUnitId): void;
}
const issued = new WeakSet<SourceClosureEntry>();
function invalid(detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", "build", `source closure entry: ${detail}`);
}

function attached(node: ts.Node, source: ts.SourceFile): boolean {
  for (let current = node; current !== source; ) {
    const parent = current.parent;
    if (!parent || !ts.forEachChild(parent, (child) => (child === current ? true : undefined))) return false;
    current = parent;
  }
  return true;
}

function exactMember(identity: IrPlanningIdentityContext, declaration: Member) {
  const id = identity.unitIdByDeclaration.get(declaration);
  const unit = id && identity.unitByUnitId.get(id);
  const parent = declaration.parent;
  const source = declaration.getSourceFile();
  const sourceId = requireIrPlanningSourceId(identity, source);
  if (!ts.isClassDeclaration(parent) && !ts.isClassExpression(parent)) invalid("member has no original class");
  const owner = requireIrPlanningClassRecord(identity, parent);
  if (
    !attached(declaration, source) ||
    !unit ||
    !unit.terminal ||
    identity.declarationByUnitId.get(unit.id) !== declaration ||
    !identity.inventory.allUnits.includes(unit) ||
    !identity.inventory.terminalUnits.includes(unit) ||
    unit.terminalOwnerId !== unit.id ||
    unit.kind !== classMemberUnitKind(declaration) ||
    unit.staticClassMember !== hasStaticModifier(declaration) ||
    unit.lexicalOwnerId !== owner.id ||
    unit.sourceId !== sourceId ||
    identity.sourceFileBySourceId.get(sourceId) !== source
  )
    invalid("original member identity diverged");
  return unit;
}

/** Source binding identity is checked before a name is allowed into the lowering scope. */
export function prepareSourceClosureEntry(input: {
  readonly identity: IrPlanningIdentityContext;
  readonly checker: ts.TypeChecker;
  readonly declaration: Member;
  readonly captures: readonly {
    readonly declaration: ts.VariableDeclaration | ts.ParameterDeclaration;
    readonly fieldType: IrType;
  }[];
}): SourceClosureEntry {
  const { identity, checker, declaration } = input;
  const unit = exactMember(identity, declaration);
  const resolve = () => {
    const result = resolveOrdinaryObjectClosureSignature(checker, declaration);
    if (result.kind === "unsupported")
      throw new IrUnsupportedError("type-resolution-unsupported", "build", result.detail);
    return result.signature;
  };
  const signature = resolve();
  const free = () => collectTransitiveClosureCaptures(declaration, declaration, checker).bindings;
  const bindings = free();
  const orderedSymbols = [...bindings.keys()];
  const printer = ts.createPrinter({ removeComments: true });
  const syntax = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, declaration.getSourceFile());
  const declaringScope = (binding: ts.Declaration): ts.Node => {
    let scope: ts.Node | undefined = binding.parent;
    while (scope && !isFunctionScopeBoundary(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    if (!scope || ts.isSourceFile(scope))
      throw new IrUnsupportedError(
        "body-shape-rejected",
        "build",
        "module binding capture needs its actual storage owner",
      );
    let lexicalScope: ts.Node = scope;
    if (
      ts.isVariableDeclaration(binding) &&
      ((ts.isVariableDeclarationList(binding.parent) && (binding.parent.flags & ts.NodeFlags.BlockScoped) !== 0) ||
        ts.isCatchClause(binding.parent))
    ) {
      for (let node: ts.Node | undefined = binding.parent; node && node !== scope; node = node.parent)
        if (
          ts.isBlock(node) ||
          ts.isCaseBlock(node) ||
          ts.isForStatement(node) ||
          ts.isForInStatement(node) ||
          ts.isForOfStatement(node) ||
          ts.isCatchClause(node)
        ) {
          lexicalScope = node;
          break;
        }
    }
    let enclosed = false;
    for (let node: ts.Node | undefined = declaration.parent; node; node = node.parent)
      if (node === lexicalScope) {
        enclosed = true;
        break;
      }
    if (!enclosed) invalid("capture declaration is outside the member's lexical evaluation scope");
    return scope;
  };
  const parameters = declaration.parameters.map((parameter) => ({
    node: parameter,
    kind: parameter.kind,
    parent: parameter.parent,
    syntax: syntax(parameter),
  }));
  const resultNode = declaration.type;
  const resultSyntax = resultNode ? syntax(resultNode) : undefined;
  const seen = new Set<ts.Symbol>();
  const captures = input.captures.map((capture, index) => {
    if (!ts.isIdentifier(capture.declaration.name) || capture.declaration.name.text === "this") invalid("capture name");
    const name = capture.declaration.name.text;
    const symbol = checker.getSymbolAtLocation(capture.declaration.name);
    const binding = symbol && bindings.get(symbol);
    if (
      !symbol ||
      !binding ||
      seen.has(symbol) ||
      symbol !== orderedSymbols[index] ||
      declaration.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)
    )
      invalid("capture is not one exact free source binding");
    seen.add(symbol);
    const scope = declaringScope(capture.declaration);
    const outerWrites = collectOuterWrites(declaration, scope);
    const logical = capture.fieldType.kind === "boxed" ? capture.fieldType.inner : capture.fieldType;
    const sourceType = checker.getTypeAtLocation(capture.declaration.name);
    const expected: IrType | undefined =
      sourceType.flags & ts.TypeFlags.NumberLike
        ? { kind: "val", val: { kind: "f64" } }
        : sourceType.flags & ts.TypeFlags.BooleanLike
          ? { kind: "val", val: { kind: "i32", boolean: true } }
          : sourceType.flags & ts.TypeFlags.StringLike
            ? { kind: "string" }
            : undefined;
    if (
      !expected ||
      !irTypeEquals(logical, expected) ||
      ((binding.written || outerWrites.has(name)) && capture.fieldType.kind !== "boxed")
    )
      invalid("capture storage differs from its source value or writes");
    return {
      name,
      declaration: capture.declaration,
      kind: capture.declaration.kind,
      parent: capture.declaration.parent,
      parentFlags: capture.declaration.parent.flags,
      type: capture.declaration.type,
      syntax: syntax(capture.declaration),
      scope,
      symbol,
      written: binding.written,
      outerWritten: outerWrites.has(name),
      references: [...binding.references],
      fieldType: structuredClone(capture.fieldType),
    };
  });
  if (seen.size !== bindings.size) invalid("incomplete free binding population");
  const entry: SourceClosureEntry = Object.freeze({
    unitId: unit.id,
    declaration,
    signature,
    captures: Object.freeze(captures.map(({ name }) => Object.freeze({ name }))),
    captureFieldTypes: Object.freeze(captures.map(({ fieldType }) => structuredClone(fieldType))),
    assertCurrent(node: ts.Node, ownerId: IrUnitId) {
      if (node !== declaration || ownerId !== unit.id || exactMember(identity, declaration) !== unit)
        invalid("foreign entry declaration or owner");
      if (
        declaration.parameters.length !== parameters.length ||
        declaration.type !== resultNode ||
        (declaration.type ? syntax(declaration.type) : undefined) !== resultSyntax ||
        declaration.parameters.some(
          (parameter, index) =>
            parameter !== parameters[index]!.node ||
            parameter.kind !== parameters[index]!.kind ||
            parameter.parent !== parameters[index]!.parent ||
            syntax(parameter) !== parameters[index]!.syntax,
        )
      )
        invalid("changed source parameter or result syntax");
      const current = resolve();
      if (!irTypeEquals({ kind: "closure", signature }, { kind: "closure", signature: current }))
        invalid("changed signature");
      const actual = free();

      if (actual.size !== captures.length) invalid("changed free binding population");
      for (const [index, capture] of captures.entries()) {
        const binding = actual.get(capture.symbol);
        const currentOuterWrites = collectOuterWrites(declaration, capture.scope);
        if (
          capture.declaration.kind !== capture.kind ||
          !attached(capture.declaration, declaration.getSourceFile()) ||
          capture.declaration.parent !== capture.parent ||
          capture.declaration.parent.flags !== capture.parentFlags ||
          capture.declaration.type !== capture.type ||
          syntax(capture.declaration) !== capture.syntax ||
          declaringScope(capture.declaration) !== capture.scope
        )
          invalid("changed captured declaration or source type");
        if (
          !binding ||
          [...actual.keys()][index] !== capture.symbol ||
          binding.written !== capture.written ||
          currentOuterWrites.has(capture.name) !== capture.outerWritten ||
          !irTypeEquals(entry.captureFieldTypes[index]!, capture.fieldType) ||
          binding.references.length !== capture.references.length ||
          binding.references.some((reference, index) => reference !== capture.references[index])
        )
          invalid("changed capture identity");
      }
    },
  });
  issued.add(entry);
  return entry;
}

export function requireSourceClosureEntry(
  entry: SourceClosureEntry,
  declaration: ts.Node,
  unitId: IrUnitId,
): SourceClosureEntry {
  if (!issued.has(entry)) invalid("unissued or copied entry");
  entry.assertCurrent(declaration, unitId);
  return entry;
}
