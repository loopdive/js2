// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { TypeFact } from "./oracle.js";

/**
 * Enrich signature positions only; ordinary type classification stays shallow.
 * A returned callable's tag alone cannot describe an IR closure boundary. Keep
 * its registry-free signature when fixed arity is proven, and retain the tag
 * without a signature when overloaded, generic, receiver-dependent or cyclic.
 * This is type evidence, not permission to choose a Wasm carrier for a class.
 */
export function higherOrderSignatureTypeFact(
  checker: ts.TypeChecker,
  type: ts.Type,
  classify: (type: ts.Type) => TypeFact,
): TypeFact {
  return describePosition(checker, type, classify, 0, { remaining: 64, active: new Set() });
}

function describePosition(
  checker: ts.TypeChecker,
  type: ts.Type,
  classify: (type: ts.Type) => TypeFact,
  depth: number,
  budget: { remaining: number; active: Set<ts.Type> },
): TypeFact {
  const fact = classify(type);
  if (fact.kind !== "function" || depth >= 6 || budget.remaining === 0 || budget.active.has(type)) return fact;
  const signatures = type.getCallSignatures();
  if (signatures.length !== 1) return fact;
  const signature = signatures[0]!;
  if (signature.typeParameters?.length || signature.thisParameter) return fact;
  if (
    signature.parameters.some((parameter) => {
      const declaration = parameter.valueDeclaration;
      return (
        !declaration ||
        !ts.isParameter(declaration) ||
        declaration.questionToken !== undefined ||
        declaration.dotDotDotToken !== undefined ||
        declaration.initializer !== undefined
      );
    })
  )
    return fact;
  budget.remaining--;
  budget.active.add(type);
  const positionFact = (position: ts.Type): TypeFact =>
    describePosition(checker, position, classify, depth + 1, budget);
  const result: TypeFact = {
    kind: "function",
    signature: {
      // Instantiated symbols carry substitutions; querying their original
      // declaration would turn Callback<number>'s parameter back into T.
      params: signature.parameters.map((parameter) =>
        positionFact(checker.getTypeOfSymbolAtLocation(parameter, parameter.valueDeclaration!)),
      ),
      returns: positionFact(checker.getReturnTypeOfSignature(signature)),
      declaredArity: signature.parameters.length,
    },
  };
  budget.active.delete(type);
  return result;
}
