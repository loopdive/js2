// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { JSValue } from "./types.js";

/** Resolve Error-family constructors absent from the sparse standalone global. */
export function intrinsicErrorConstructor(name: JSValue): JSValue {
  if (name === "Error") return Error;
  if (name === "TypeError") return TypeError;
  if (name === "RangeError") return RangeError;
  if (name === "SyntaxError") return SyntaxError;
  if (name === "ReferenceError") return ReferenceError;
  if (name === "EvalError") return EvalError;
  if (name === "URIError") return URIError;
  if (name === "AggregateError") return AggregateError;
  return null;
}

/** Invoke a native constructor without relying on spread syntax. */
export function constructValue(callee: JSValue, args: JSValue[]): JSValue {
  switch (args.length) {
    case 0:
      return new (callee as new () => JSValue)();
    case 1:
      return new (callee as new (a0: JSValue) => JSValue)(args[0]);
    case 2:
      return new (callee as new (a0: JSValue, a1: JSValue) => JSValue)(args[0], args[1]);
    case 3:
      return new (callee as new (a0: JSValue, a1: JSValue, a2: JSValue) => JSValue)(args[0], args[1], args[2]);
    case 4:
      return new (callee as new (...a: JSValue[]) => JSValue)(args[0], args[1], args[2], args[3]);
    case 5:
      return new (callee as new (...a: JSValue[]) => JSValue)(args[0], args[1], args[2], args[3], args[4]);
    case 6:
      return new (callee as new (...a: JSValue[]) => JSValue)(args[0], args[1], args[2], args[3], args[4], args[5]);
    case 7:
      return new (callee as new (...a: JSValue[]) => JSValue)(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
        args[6],
      );
    case 8:
      return new (callee as new (...a: JSValue[]) => JSValue)(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
        args[6],
        args[7],
      );
    default:
      throw new RangeError("interpreter Construct supports at most 8 arguments in Phase 1");
  }
}

/** A short description of a non-callable value for TypeError messages. */
export function describe(value: JSValue): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const kind = typeof value;
  if (kind === "string") return JSON.stringify(value);
  if (kind === "number" || kind === "boolean") return String(value);
  return kind;
}
