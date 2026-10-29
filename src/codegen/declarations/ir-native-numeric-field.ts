// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import { hostFreeEnvironment, type CodegenContext } from "../context/types.js";
import type { IrType } from "../../ir/nodes.js";
import { nativeTypeOfDeclaration } from "../native-type-annotations.js";

/**
 * Recover source domains only after the shared native-alias proof succeeds.
 * No-host lanes only: the gc lane keeps its existing class shapes byte-identical.
 */
export function irNativeNumericFieldType(ctx: CodegenContext, node: ts.Node): IrType | null {
  if (!hostFreeEnvironment(ctx) || !ts.isPropertyDeclaration(node)) return null;
  const native = nativeTypeOfDeclaration(ctx.oracle, node);
  const annotation = node.type;
  if (!native || native.kind !== "i32" || !annotation || !ts.isTypeReferenceNode(annotation)) return null;
  if (!ts.isIdentifier(annotation.typeName)) return null;
  if (annotation.typeName.text === "u32") return { kind: "val", val: native, signed: false };
  return annotation.typeName.text === "i32" ? { kind: "val", val: native } : null;
}

/**
 * Member signatures are projected from the checker's `number` (f64), but the
 * legacy ABI pins a native annotation on a parameter or result (`class-bodies.ts`).
 * A non-f64 pin is an ABI the descriptor cannot reproduce, and a claimed body on
 * the f64 ABI fails the hard class-member parity check, so the member stays legacy.
 * No-host lanes only, like the field typing above.
 */
export function irNativeSignatureDiverges(ctx: CodegenContext, member: ts.SignatureDeclaration): boolean {
  return (
    hostFreeEnvironment(ctx) &&
    [member, ...member.parameters].some((decl) => {
      const native = nativeTypeOfDeclaration(ctx.oracle, decl);
      return native !== null && native.kind !== "f64";
    })
  );
}
