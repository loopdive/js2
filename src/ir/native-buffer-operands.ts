// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7274) The admission table of the native ArrayBuffer / DataView surface:
 * which constructions, getters and calls the plan (`native-buffer-surface.ts`)
 * may certify, and which operands each accepts. Pure source predicates — the
 * certification of receivers and vars lives in the plan.
 */
import { ts } from "../ts-api.js";
import { isUnshadowedLibBinding, isUnshadowedUndefined } from "../shared/ambient-intrinsics.js";
import { stripParens } from "../shared/binding-writes.js";
import {
  IR_NATIVE_AB_BYTE_LENGTH_FN,
  IR_NATIVE_AB_MAX_BYTE_LENGTH_FN,
  IR_NATIVE_AB_RESIZABLE_FN,
  IR_NATIVE_AB_SLICE_FN,
  DATA_VIEW_ACCESSORS,
  dataViewAccessorFn,
  IR_NATIVE_DV_BYTE_LENGTH_FN,
  IR_NATIVE_DV_BYTE_OFFSET_FN,
} from "../shared/contracts/native-buffer-adapters.js";
import { makeIrAmbientBindingPredicate, makeIrPrimitiveExpressionClassifier } from "./module-bindings.js";

export type IrNativeBufferClass = "ArrayBuffer" | "DataView";

/**
 * What an operand may be:
 *  - `number`: number-typed; lowers to f64 (or the dynamic carrier);
 *  - `bound`: a number or `undefined`, boxed into the dynamic carrier;
 *  - `flag`: a number, boolean or `undefined`, boxed into the dynamic carrier.
 */
type OperandKind = "number" | "bound" | "flag";

export interface IrNativeBufferGetMember {
  readonly kind: "get";
  readonly fn: string;
  readonly result: "number" | "boolean";
}

export interface IrNativeBufferCallMember {
  readonly kind: "call";
  readonly fn: string;
  /** One kind per adapter operand; an omitted operand is passed as `undefined`. */
  readonly operands: readonly OperandKind[];
  /** The class of the handle the call returns; absent for a dynamic-carrier result. */
  readonly resultClass?: "ArrayBuffer";
}

type IrNativeBufferMember = IrNativeBufferGetMember | IrNativeBufferCallMember;

// The IR has no BigInt operand, so the BigInt accessors stay on legacy.
const DV_ACCESSOR_MEMBERS = Object.fromEntries(
  DATA_VIEW_ACCESSORS.filter((accessor) => !accessor.includes("BigInt")).map(
    (accessor): [string, IrNativeBufferMember] => [
      accessor,
      {
        kind: "call",
        fn: dataViewAccessorFn(accessor),
        operands: accessor.startsWith("get") ? ["number", "flag"] : ["number", "number", "flag"],
      },
    ],
  ),
);

const MEMBERS: Readonly<Record<IrNativeBufferClass, Readonly<Record<string, IrNativeBufferMember>>>> = {
  ArrayBuffer: {
    byteLength: { kind: "get", fn: IR_NATIVE_AB_BYTE_LENGTH_FN, result: "number" },
    maxByteLength: { kind: "get", fn: IR_NATIVE_AB_MAX_BYTE_LENGTH_FN, result: "number" },
    resizable: { kind: "get", fn: IR_NATIVE_AB_RESIZABLE_FN, result: "boolean" },
    slice: { kind: "call", fn: IR_NATIVE_AB_SLICE_FN, operands: ["bound", "bound"], resultClass: "ArrayBuffer" },
  },
  DataView: {
    byteLength: { kind: "get", fn: IR_NATIVE_DV_BYTE_LENGTH_FN, result: "number" },
    byteOffset: { kind: "get", fn: IR_NATIVE_DV_BYTE_OFFSET_FN, result: "number" },
    ...DV_ACCESSOR_MEMBERS,
  },
};

/** The table entry for `name` on a `cls` receiver. */
export function nativeBufferMember(cls: IrNativeBufferClass, name: string): IrNativeBufferMember | undefined {
  return Object.hasOwn(MEMBERS[cls], name) ? MEMBERS[cls][name] : undefined;
}

/** A construction the table admits, before its buffer operand (a DataView's) is certified. */
export type IrNativeBufferConstruct =
  | {
      readonly kind: "construct";
      readonly length: ts.Expression | undefined;
      /** Absent for a fixed buffer (no options, `{}`, or `maxByteLength: undefined`). */
      readonly maxByteLength: ts.Expression | undefined;
    }
  | {
      readonly kind: "construct-view";
      readonly buffer: ts.Expression;
      readonly offset: ts.Expression | undefined;
      readonly length: ts.Expression | undefined;
    };

export interface IrNativeBufferOperands {
  operand(kind: OperandKind, expr: ts.Expression): boolean;
  construction(expr: ts.NewExpression): IrNativeBufferConstruct | undefined;
}

/**
 * A read of the global `undefined`, or of a `var` initialized to it (whose
 * lowering is the dynamic carrier, whatever is written to it later). Name
 * resolution only, like the primitive classifier's own provenance walk.
 */
function isUndefinedOperand(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  const candidate = stripParens(expr);
  if (isUnshadowedUndefined(candidate)) return true;
  if (!ts.isIdentifier(candidate)) return false;
  const declaration = checker.getSymbolAtLocation(candidate)?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    isUnshadowedUndefined(declaration.initializer)
  );
}

/**
 * A `maxByteLength` operand that cannot throw or run code: a number literal,
 * possibly negated. Legacy validates the length BEFORE evaluating the option
 * (new-indexed.ts) while the IR's call evaluates both first; with a literal
 * option (even a TDZ read could throw) the two orders cannot be told apart.
 */
function isLiteralNumber(expr: ts.Expression): boolean {
  const candidate = stripParens(expr);
  return (
    ts.isNumericLiteral(candidate) ||
    (ts.isPrefixUnaryExpression(candidate) &&
      candidate.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(candidate.operand))
  );
}

/** `{}` → fixed; `{maxByteLength: undefined}` → fixed; `{maxByteLength: <literal>}` → resizable. */
function maxByteLengthOption(options: ts.Expression): { readonly max: ts.Expression | undefined } | undefined {
  if (!ts.isObjectLiteralExpression(options) || options.properties.length > 1) return undefined;
  const property = options.properties[0];
  if (property === undefined) return { max: undefined };
  if (
    !ts.isPropertyAssignment(property) ||
    !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
    property.name.text !== "maxByteLength"
  ) {
    return undefined;
  }
  const max = property.initializer;
  if (isUnshadowedUndefined(max)) return { max: undefined };
  return isLiteralNumber(max) ? { max } : undefined;
}

export function makeIrNativeBufferOperands(checker: ts.TypeChecker): IrNativeBufferOperands {
  const isLibOnly = makeIrAmbientBindingPredicate(checker, "every");
  const classify = makeIrPrimitiveExpressionClassifier(checker);
  const operand = (kind: OperandKind, expr: ts.Expression): boolean => {
    const family = classify(expr);
    if (family === "number") return true;
    if (kind === "number") return false;
    return isUndefinedOperand(checker, expr) || (kind === "flag" && family === "boolean");
  };
  const construction = (expr: ts.NewExpression): IrNativeBufferConstruct | undefined => {
    const callee = expr.expression;
    if (!ts.isIdentifier(callee) || (callee.text !== "ArrayBuffer" && callee.text !== "DataView")) return undefined;
    if (!isUnshadowedLibBinding(callee, isLibOnly) || (expr.typeArguments?.length ?? 0) > 0) return undefined;
    const args = expr.arguments ?? [];
    if (args.some(ts.isSpreadElement)) return undefined;
    if (callee.text === "DataView") {
      const [buffer, offset, length] = args;
      if (buffer === undefined || args.length > 3) return undefined;
      if (offset !== undefined && !operand("number", offset)) return undefined;
      if (length !== undefined && !operand("bound", length)) return undefined;
      return { kind: "construct-view", buffer, offset, length };
    }
    const [length, options] = args;
    if (args.length > 2 || (length !== undefined && !operand("number", length))) return undefined;
    const option = options === undefined ? { max: undefined } : maxByteLengthOption(options);
    return option && { kind: "construct", length, maxByteLength: option.max };
  };
  return { operand, construction };
}
