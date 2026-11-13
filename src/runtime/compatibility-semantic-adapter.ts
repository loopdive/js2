// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ImportIntent } from "../index.js";

export interface CompatibilitySemanticAdapterContext {
  strictEqual(left: unknown, right: unknown): boolean;
  isWasmStruct(value: unknown): boolean;
  toPrimitive(value: unknown, hint: "default" | "number"): unknown;
  createProxy(target: unknown, handler: unknown): unknown;
}

const bigintBinaryOperations: ReadonlyArray<(left: any, right: any) => any> = [
  (left, right) => left + right,
  (left, right) => left - right,
  (left, right) => left * right,
  (left, right) => left / right,
  (left, right) => left % right,
  (left, right) => left ** right,
  (left, right) => left & right,
  (left, right) => left | right,
  (left, right) => left ^ right,
  (left, right) => left << right,
  (left, right) => left >> right,
  (left, right) => left >>> right,
];

export function isCompatibilitySemanticIntent(intent: ImportIntent): boolean {
  const type = intent.type;
  return (
    type === "string_literal" ||
    type === "await" ||
    type === "host_eq" ||
    type === "host_loose_eq" ||
    type === "host_add" ||
    type === "host_bigint_binop" ||
    type === "host_compare" ||
    type === "same_value_zero" ||
    type === "date_new" ||
    type === "date_method" ||
    type === "proxy_create"
  );
}

/** Resolve semantic fallbacks retained solely by the compatibility profile. */
export function resolveCompatibilitySemanticImport(
  intent: ImportIntent,
  context: CompatibilitySemanticAdapterContext,
): Function | undefined {
  const primitive = (value: unknown, hint: "default" | "number"): any =>
    value != null && typeof value === "object" && context.isWasmStruct(value)
      ? context.toPrimitive(value, hint)
      : value;

  switch (intent.type) {
    case "string_literal":
      return () => intent.value;
    case "await":
      return (value: unknown) => value;
    case "host_eq":
      return (left: unknown, right: unknown) => (context.strictEqual(left, right) ? 1 : 0);
    case "host_loose_eq":
      return (left: any, right: any) => {
        const leftStruct = left != null && typeof left === "object" && context.isWasmStruct(left);
        const rightStruct = right != null && typeof right === "object" && context.isWasmStruct(right);
        let leftValue = left;
        let rightValue = right;
        if (leftStruct && !rightStruct && (right == null || typeof right !== "object")) {
          leftValue = context.toPrimitive(left, "default");
        }
        if (rightStruct && !leftStruct && (left == null || typeof left !== "object")) {
          rightValue = context.toPrimitive(right, "default");
        }
        // biome-ignore lint/suspicious/noDoubleEquals: this adapter implements IsLooselyEqual.
        return leftValue == rightValue ? 1 : 0;
      };
    case "host_add":
      return (left: unknown, right: unknown) => primitive(left, "default") + primitive(right, "default");
    case "host_bigint_binop":
      return (opcode: number, left: unknown, right: unknown) => {
        const hint = opcode === 0 ? "default" : "number";
        const leftValue = primitive(left, hint);
        const rightValue = primitive(right, hint);
        if (!(typeof opcode === "number" && opcode >= 0 && opcode <= 11 && opcode % 1 === 0)) {
          throw new TypeError("Cannot mix BigInt and other types, use explicit conversions");
        }
        return bigintBinaryOperations[opcode]!(leftValue, rightValue);
      };
    case "host_compare":
      return (left: any, right: any) => {
        if (left < right) return -1;
        if (left > right) return 1;
        return left <= right ? 0 : 2;
      };
    case "same_value_zero":
      return (left: any, right: any) => {
        if (left === right) return 1;
        // biome-ignore lint/suspicious/noSelfCompare: IEEE-754 NaN detection.
        if (typeof left === "number" && typeof right === "number" && left !== left && right !== right) return 1;
        return 0;
      };
    case "date_new":
      return () => new Date();
    case "date_method":
      return (date: any) => date[intent.method]();
    case "proxy_create":
      return (target: unknown, handler: unknown) => context.createProxy(target, handler);
    default:
      return undefined;
  }
}
