// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7294) A builtin prototype's OWN member read as a value
 * (`<B>.prototype.<m>`) or through `Object.getOwnPropertyDescriptor(
 * <B>.prototype, "<m>")`. Each lowers to ONE call of the codegen support
 * function legacy's own synthesis is built from (`builtinProtoMemberInstrs`,
 * `src/codegen/native-proto-value-read.ts`), so the IR and legacy answer with
 * the same singleton closure and the same descriptor.
 *
 * The shapes are syntactic (`src/shared/ambient-intrinsics.ts`); the semantic
 * half is the lane's `builtinProtoMember(builtin, member, anchor)` answer: an
 * own member of the registered native-proto glue that the source does not
 * override, on a native, non-fast lane. Selector and from-ast admit through
 * {@link admittedBuiltinProtoMember} and nothing else.
 */
import ts from "typescript";

import {
  builtinProtoDescriptorCall,
  builtinProtoMemberGlobalsUnshadowed,
  builtinProtoMemberSymbol,
  builtinProtoMemberValueRead,
  type BuiltinProtoMemberRef,
  type BuiltinProtoMemberRole,
} from "../shared/ambient-intrinsics.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { irDynamic, type IrValueId } from "./nodes.js";

/** What the admission reads from the lane (selection options and the from-ast resolver both supply it). */
export interface BuiltinProtoMemberLane {
  readonly isLibOnlyBinding: (node: ts.Identifier) => boolean;
  readonly builtinProtoMember:
    | ((builtin: string, member: string, anchor: ts.Node) => "method" | "getter" | undefined)
    | undefined;
}

/**
 * The shape `expr` is, admitted on this lane. An ES module's units lower as
 * prepared components, whose Program ABI names no support function of this
 * family, so only scripts (every test262 body) are admitted.
 */
export function admittedBuiltinProtoMember(
  expr: ts.Expression,
  lane: BuiltinProtoMemberLane,
): { readonly role: BuiltinProtoMemberRole; readonly ref: BuiltinProtoMemberRef } | undefined {
  const descriptor = ts.isCallExpression(expr) ? builtinProtoDescriptorCall(expr) : undefined;
  const ref = descriptor ?? builtinProtoMemberValueRead(expr);
  if (ref === undefined || ts.isExternalModule(expr.getSourceFile())) return undefined;
  if (!builtinProtoMemberGlobalsUnshadowed(ref, lane.isLibOnlyBinding)) return undefined;
  const kind = lane.builtinProtoMember?.(ref.builtin.text, ref.member, expr);
  // A getter's own descriptor is answered; a plain read of it INVOKES it (legacy's Site 3), not this value.
  if (kind === undefined || (descriptor === undefined && kind !== "method")) return undefined;
  return { role: descriptor !== undefined ? "descriptor" : "value", ref };
}

/** from-ast's half: the admitted shape as one call of its support function (a dynamic carrier). */
export function lowerBuiltinProtoMember(
  expr: ts.Expression,
  builder: IrFunctionBuilder,
  lane: BuiltinProtoMemberLane,
): IrValueId | null {
  const admitted = admittedBuiltinProtoMember(expr, lane);
  if (admitted === undefined) return null;
  const symbol = builtinProtoMemberSymbol(admitted.role, admitted.ref.builtin.text, admitted.ref.member);
  return builder.emitCall(irRuntimeFuncRef(symbol), [], irDynamic())!; // non-void support function
}
