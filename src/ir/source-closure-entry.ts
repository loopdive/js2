// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrType } from "./core/nodes.js";
import { irTypeEquals } from "./core/types.js";
import { classMemberUnitKind, hasStaticModifier } from "./analysis/class-definition-syntax.js";
import {
  requireIrPlanningClassRecord,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
} from "./planning-identity.js";
import { resolveOrdinaryObjectClosureSignature } from "./ordinary-object-closure-signatures.js";
import { IrUnsupportedError } from "./outcomes.js";
import type { IrUnitId } from "./identity.js";
import {
  prepareSourceClosureCaptures,
  sourceClosureEntryInvalid as invalid,
  sourceClosureDeclarationAttached as attached,
  type ClosureCaptureBinding,
  type SourceClosureCaptureInput,
} from "./source-closure-capture-bindings.js";
export { bindSourceClosureCaptures, type ClosureCaptureBinding } from "./source-closure-capture-bindings.js";

export type IrClosureLiteral =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;
type Member = ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;
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
  readonly captures: readonly SourceClosureCaptureInput[];
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
  const printer = ts.createPrinter({ removeComments: true });
  const syntax = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, declaration.getSourceFile());
  const captured = prepareSourceClosureCaptures(input, syntax);
  const parameters = declaration.parameters.map((parameter) => ({
    node: parameter,
    kind: parameter.kind,
    parent: parameter.parent,
    syntax: syntax(parameter),
  }));
  const resultNode = declaration.type;
  const resultSyntax = resultNode ? syntax(resultNode) : undefined;
  const entry: SourceClosureEntry = Object.freeze({
    unitId: unit.id,
    declaration,
    signature,
    captures: captured.captures,
    captureFieldTypes: captured.captureFieldTypes,
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
      captured.assertCurrent(entry.captureFieldTypes);
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
