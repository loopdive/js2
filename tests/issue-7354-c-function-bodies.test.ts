// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 C step C1 — the realm's `js.function.*` adapters as pure bodies: one module holding the builtin-object
// kernel, the real closure invocation and the adapters, instantiated and driven directly (not yet wired into the
// program pipeline). The closure's body writes `this.x = v` through the ordinary define and returns `v`.
import { beforeAll, describe, expect, it } from "vitest";
import {
  FUNCTION_OBJECT_INIT_FLAGS,
  irFunctionObjectCallableDeclaration,
} from "../src/ir/runtime/function-object-callables.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime/callable-declarations.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import {
  FUNCTION_OBJECT_SOURCE,
  FUNCTION_OBJECT_TEXTS,
  functionObjectRuntime,
  preparedScript,
  type FunctionObjectRuntime,
} from "./helpers/native-source-function-objects.js";

let r: FunctionObjectRuntime;
beforeAll(async () => {
  r = functionObjectRuntime(await preparedScript(FUNCTION_OBJECT_SOURCE));
}, 240_000);

const key = (text: string) => r.text(FUNCTION_OBJECT_TEXTS.indexOf(text));
const { constructible } = FUNCTION_OBJECT_INIT_FLAGS;
/** A source function object as `js.function.init` leaves it. */
function sourceFunction(flags = constructible, length = 1) {
  const fn = r.makeClosure();
  r.init(fn, key("x"), length, flags);
  return fn;
}
function ownKeys(object: unknown) {
  const list = r.ownKeys(object);
  return Array.from({ length: r.vectorLength(list) }, (_, i) => r.vectorAt(list, i));
}
/** `run` throws the realm's TypeError carrying `message`. */
function throwsTypeError(run: () => unknown, message: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WebAssembly.Exception);
  expect((caught as WebAssembly.Exception).is(r.exception)).toBe(true);
  expect(r.errorMessage((caught as WebAssembly.Exception).getArg(r.exception, 0))).toBe(key(message));
}
const NOT_CONSTRUCTOR = "TypeError: function is not a constructor";
const FUNCTION_PROTOTYPE = "TypeError: new with a function-valued prototype needs a function [[Prototype]] link";
const NOT_CALLABLE = "Value is not callable";
const NON_OBJECT_PROTOTYPE = "TypeError: instanceof needs an object prototype";
const UNBOUND_SLOPPY = "TypeError: unbound sloppy this needs the realm global object";
const PRIMITIVE_SLOPPY = "TypeError: sloppy this of a primitive needs ToObject";

describe("#7354 C — the function-object contracts", () => {
  it("declares construct:N as one arity family and the rest as exact symbols", () => {
    expect(irFunctionObjectCallableDeclaration(irIntrinsicFuncRef("js.function.construct:2"))?.params).toHaveLength(3);
    expect(irFunctionObjectCallableDeclaration(irIntrinsicFuncRef("js.function.construct:02"))).toBeUndefined();
    expect(irFunctionObjectCallableDeclaration(irIntrinsicFuncRef("js.function.construct"))).toBeUndefined();
    expect(irRuntimeCallableDeclaration(irIntrinsicFuncRef("js.function.init"))?.feature).toBe("js.function.init");
  });
});

describe("#7354 C — the realm's function-object adapters", () => {
  it("is-callable admits exactly the realm's function objects", () => {
    expect(r.isCallable(sourceFunction())).toBe(1);
    expect(r.isCallable(r.makeClosure())).toBe(1);
    expect(r.isCallable(r.functionPrototype())).toBe(1);
    for (const value of [r.boxNumber(1), key("x"), null, r.undefinedValue(), r.createDefault(), r.objectPrototype()])
      expect(r.isCallable(value)).toBe(0);
  });

  it("init seeds length, name, then prototype/constructor, with their attributes", () => {
    const fn = sourceFunction(constructible, 2);
    expect(ownKeys(fn)).toEqual([key("length"), key("name"), key("prototype")]);
    expect(r.ownDescriptor(fn, key("length")).slice(0, 2)).toEqual([1, 4]);
    expect(r.unboxNumber(r.ownDescriptor(fn, key("length"))[2])).toBe(2);
    expect(r.ownDescriptor(fn, key("name")).slice(0, 3)).toEqual([1, 4, key("x")]);
    const [present, attributes, prototype] = r.ownDescriptor(fn, key("prototype"));
    expect([present, attributes]).toEqual([1, 1]);
    expect(r.ordinaryCount(prototype)).toBe(1);
    expect(r.ordinaryFlags(prototype, key("constructor"))).toBe(5);
    expect(r.get(prototype, key("constructor"), prototype)).toEqual([1, fn]);
    expect(r.objectProto(prototype)).toBe(r.objectPrototype());
    expect(r.getPrototypeOf(fn)).toBe(r.functionPrototype());
    expect(ownKeys(sourceFunction(0))).toEqual([key("length"), key("name")]);
  });

  it("construct:N runs the closure on a new object of the constructor's prototype", () => {
    const fn = sourceFunction();
    const object = r.construct1(fn, r.boxNumber(5));
    expect(r.unboxNumber(r.get(object, key("x"), object)[1])).toBe(5);
    expect(r.objectProto(object)).toBe(r.get(fn, key("prototype"), fn)[1]);
    expect(r.get(object, key("constructor"), object)).toEqual([1, fn]);
    const replacement = r.createDefault();
    expect(r.construct1(fn, replacement)).toBe(replacement);
    expect(r.writeOwn(fn, key("prototype"), r.boxNumber(1))).toBe(1);
    expect(r.objectProto(r.construct1(fn, r.boxNumber(1)))).toBe(r.objectPrototype());
    expect(r.writeOwn(fn, key("prototype"), r.functionPrototype())).toBe(1);
    throwsTypeError(() => r.construct1(fn, r.boxNumber(1)), FUNCTION_PROTOTYPE);
  });

  it("construct:N refuses a value without [[Construct]]", () => {
    for (const callee of [sourceFunction(0), r.functionPrototype(), r.boxNumber(1), r.createDefault(), null])
      throwsTypeError(() => r.construct1(callee, r.boxNumber(1)), NOT_CONSTRUCTOR);
  });

  it("has-instance walks the value's prototype chain", () => {
    const fn = sourceFunction(),
      other = sourceFunction();
    const object = r.construct1(fn, r.boxNumber(1));
    expect(r.hasInstance(object, fn)).toBe(1);
    expect(r.hasInstance(object, other)).toBe(0);
    expect(r.hasInstance(r.construct1(other, r.boxNumber(1)), fn)).toBe(0);
    expect(r.hasInstance(r.objectPrototype(), fn)).toBe(0);
    expect(r.hasInstance(fn, fn)).toBe(0);
    for (const value of [r.boxNumber(1), key("x"), null, r.undefinedValue()]) expect(r.hasInstance(value, fn)).toBe(0);
    // Two steps up: object -> fn.prototype -> Object.prototype; and a function's own chain.
    expect(r.writeOwn(other, key("prototype"), r.objectPrototype())).toBe(1);
    expect(r.hasInstance(object, other)).toBe(1);
    expect(r.writeOwn(other, key("prototype"), r.functionPrototype())).toBe(1);
    expect(r.hasInstance(fn, other)).toBe(1);
  });

  it("has-instance throws on a non-callable callee and on a non-object prototype", () => {
    const fn = sourceFunction();
    for (const callee of [r.boxNumber(1), r.createDefault(), null])
      throwsTypeError(() => r.hasInstance(fn, callee), NOT_CALLABLE);
    expect(r.writeOwn(fn, key("prototype"), r.boxNumber(1))).toBe(1);
    throwsTypeError(() => r.hasInstance(r.objectPrototype(), fn), NON_OBJECT_PROTOTYPE);
    // A non-object value answers false before the prototype is read.
    expect(r.hasInstance(r.boxNumber(1), fn)).toBe(0);
  });

  it("this answers the installed receiver, and names what sloppy code still needs", () => {
    const receiver = r.createDefault();
    r.currentThis.value = receiver;
    expect(r.bindThis(1)).toBe(receiver);
    expect(r.bindThis(0)).toBe(receiver);
    for (const [value, message] of [
      [r.undefinedValue(), UNBOUND_SLOPPY],
      [null, UNBOUND_SLOPPY],
      [r.boxNumber(1), PRIMITIVE_SLOPPY],
    ] as const) {
      r.currentThis.value = value;
      expect(r.bindThis(1)).toBe(value);
      throwsTypeError(() => r.bindThis(0), message);
    }
  });
});
