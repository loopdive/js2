// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";

function unwrapParenthesizedTypeNode(node: ts.TypeNode): ts.TypeNode {
  let current = node;
  while (ts.isParenthesizedTypeNode(current)) current = current.type;
  return current;
}

function isTypeParameterReference(node: ts.TypeNode, name: string): boolean {
  const current = unwrapParenthesizedTypeNode(node);
  return ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName) && current.typeName.text === name;
}

/**
 * Return the representation-bearing argument of an exact homomorphic
 * readonly-erasure mapped alias:
 *
 *   type Mutable<T> = { -readonly [K in keyof T]: T[K] };
 *
 * The alias name is deliberately irrelevant. Removing `readonly` changes only
 * TypeScript's write checking, not the runtime object layout, so minting a
 * second anonymous Wasm struct is both unnecessary and unsafe: the checker can
 * enumerate the mapped properties in a different order from the declared
 * interface (and can widen optional fields), producing two incompatible
 * physical representations for the same object.
 *
 * Fail closed for every other mapped type. Optionality changes, key remapping,
 * transformed value types, extra members, multiple type parameters, and
 * non-homomorphic key constraints may all change the value representation and
 * retain their normal anonymous-struct lowering.
 */
export function readonlyErasureMappedAliasTarget(tsType: ts.Type): ts.Type | undefined {
  const alias = tsType.aliasSymbol;
  const aliasArgs = tsType.aliasTypeArguments;
  if (!alias || aliasArgs?.length !== 1) return undefined;

  const declarations = alias
    .getDeclarations()
    ?.filter((declaration): declaration is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(declaration));
  if (declarations?.length !== 1) return undefined;

  const declaration = declarations[0]!;
  if (declaration.typeParameters?.length !== 1) return undefined;
  const sourceParamName = declaration.typeParameters[0]!.name.text;
  const mapped = unwrapParenthesizedTypeNode(declaration.type);
  if (
    !ts.isMappedTypeNode(mapped) ||
    mapped.readonlyToken?.kind !== ts.SyntaxKind.MinusToken ||
    mapped.questionToken !== undefined ||
    mapped.nameType !== undefined ||
    mapped.type === undefined ||
    (mapped.members?.length ?? 0) !== 0
  ) {
    return undefined;
  }

  const keyParamName = mapped.typeParameter.name.text;
  const constraint = mapped.typeParameter.constraint
    ? unwrapParenthesizedTypeNode(mapped.typeParameter.constraint)
    : undefined;
  if (
    !constraint ||
    !ts.isTypeOperatorNode(constraint) ||
    constraint.operator !== ts.SyntaxKind.KeyOfKeyword ||
    !isTypeParameterReference(constraint.type, sourceParamName)
  ) {
    return undefined;
  }

  const valueType = unwrapParenthesizedTypeNode(mapped.type);
  if (
    !ts.isIndexedAccessTypeNode(valueType) ||
    !isTypeParameterReference(valueType.objectType, sourceParamName) ||
    !isTypeParameterReference(valueType.indexType, keyParamName)
  ) {
    return undefined;
  }

  const target = aliasArgs[0]!;
  return target === tsType ? undefined : target;
}
