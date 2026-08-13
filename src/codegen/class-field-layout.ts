// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pre-emission finalization for exact forward class-field layouts.
 *
 * Class collection reserves structs in source order. A field on an earlier
 * class that names a later local class is therefore provisionally collected as
 * `externref`. Prepared IR must see the final storage ABI before it can decide
 * that the direct class-body emitter will never run.
 */
import { ts } from "../ts-api.js";
import type { FieldDef, StructTypeDef } from "../ir/types.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { CodegenContext } from "./context/types.js";

function hasStaticModifier(node: ts.Node & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) === true;
}

function fixedFieldName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return `__priv_${name.text.slice(1)}`;
  return undefined;
}

function exactLocalClassReference(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  typeNode: ts.TypeNode | undefined,
): ts.ClassDeclaration | undefined {
  const identity = ctx.irPlanningIdentityContext;
  if (
    !identity ||
    !typeNode ||
    !ts.isTypeReferenceNode(typeNode) ||
    !ts.isIdentifier(typeNode.typeName) ||
    (typeNode.typeArguments?.length ?? 0) !== 0
  ) {
    return undefined;
  }
  const declarations = ctx.oracle.declarationsOf(typeNode.typeName);
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0];
  if (!declaration || !ts.isClassDeclaration(declaration) || !declaration.name || declaration.parent !== sourceFile) {
    return undefined;
  }
  const classId = identity.classIdByDeclaration.get(declaration);
  return classId !== undefined && identity.declarationByClassId.get(classId) === declaration ? declaration : undefined;
}

function requireCommittedField(
  ctx: CodegenContext,
  declaration: ts.ClassDeclaration,
  fieldName: string,
): FieldDef | undefined {
  const className = declaration.name!.text;
  const typeIdx = ctx.structMap.get(className);
  const type = typeIdx === undefined ? undefined : ctx.mod.types[typeIdx];
  const fields = ctx.structFields.get(className);
  if (!type || type.kind !== "struct" || !fields || type.fields !== fields) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `forward field ${className}.${fieldName} has no exact committed class layout`,
    );
  }
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (field && !type.fields.includes(field)) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `forward field ${className}.${fieldName} is detached from its observed class layout`,
    );
  }
  return field;
}

/**
 * Commit exact references from top-level fields to later local classes
 * without replacing an observed StructTypeDef or changing type order.
 *
 * A derived layout reuses the exact FieldDef objects from its parent prefix,
 * so finalizing a parent-owned slot in place also finalizes every collected
 * descendant without rebuilding its subtype. Nested, generic, union,
 * optional, inferred, and externref-backed layouts remain on the typed direct
 * route.
 */
export function finalizeForwardClassFieldLayouts(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  if (!ctx.irPlanningIdentityContext) return;
  const declarations = sourceFile.statements.filter(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name !== undefined,
  );
  const nameCounts = new Map<string, number>();
  for (const declaration of declarations) {
    const name = declaration.name!.text;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  for (const owner of declarations) {
    const ownerName = owner.name!.text;
    if (nameCounts.get(ownerName) !== 1 || ctx.classExternrefBackedSet.has(ownerName)) {
      continue;
    }
    const fieldNameCounts = new Map<string, number>();
    for (const member of owner.members) {
      if (!ts.isPropertyDeclaration(member) || hasStaticModifier(member)) continue;
      const name = fixedFieldName(member.name);
      if (name !== undefined) fieldNameCounts.set(name, (fieldNameCounts.get(name) ?? 0) + 1);
    }

    for (const member of owner.members) {
      if (!ts.isPropertyDeclaration(member) || hasStaticModifier(member)) continue;
      const fieldName = fixedFieldName(member.name);
      const target = exactLocalClassReference(ctx, sourceFile, member.type);
      if (
        fieldName === undefined ||
        fieldNameCounts.get(fieldName) !== 1 ||
        !target?.name ||
        target.getStart(sourceFile) <= owner.getStart(sourceFile) ||
        nameCounts.get(target.name.text) !== 1 ||
        ctx.classExternrefBackedSet.has(target.name.text)
      ) {
        continue;
      }
      const targetTypeIdx = ctx.structMap.get(target.name.text);
      if (targetTypeIdx === undefined) continue;
      const targetType = ctx.mod.types[targetTypeIdx];
      if (!targetType || targetType.kind !== "struct" || targetType.name !== target.name.text) continue;

      const field = requireCommittedField(ctx, owner, fieldName);
      if (field?.type.kind !== "externref") continue;
      field.type = { kind: "ref_null", typeIdx: targetTypeIdx };
    }
  }
}
