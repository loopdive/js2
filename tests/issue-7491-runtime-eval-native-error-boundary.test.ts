// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #7491 — a native error thrown inside a runtime-eval child module reaches the
// JS caller as a real JS Error of the same kind, not as the opaque Wasm struct.
import { describe, expect, it } from "vitest";
import { createEvalShim, createNewFunctionShim } from "../src/runtime-eval.js";

const CASES = [
  { body: "'use strict'; eval('public = 1;');", ctor: SyntaxError, message: /public/ },
  { body: "throw new TypeError('t');", ctor: TypeError, message: /^t$/ },
  { body: "throw new RangeError('r');", ctor: RangeError, message: /^r$/ },
  { body: "throw new Error('e');", ctor: Error, message: /^e$/ },
  { body: "null.x;", ctor: TypeError, message: /null/ },
  { body: "undefinedName;", ctor: ReferenceError, message: /undefinedName/ },
];

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("#7491 runtime-eval child exceptions cross as JS errors", () => {
  it.each(CASES)("new Function: $body", ({ body, ctor, message }) => {
    const error = caught(() => createNewFunctionShim()("a", body)());
    expect(error).toBeInstanceOf(ctor);
    expect((error as Error).name).toBe(ctor.name);
    expect((error as Error).message).toMatch(message);
  });

  it.each(CASES)("indirect eval: $body", ({ body, ctor, message }) => {
    const error = caught(() => createEvalShim()(body, 0));
    expect(error).toBeInstanceOf(ctor);
    expect((error as Error).message).toMatch(message);
  });

  it("leaves a thrown primitive untouched", () => {
    expect(caught(() => createNewFunctionShim()("", "throw 5;")())).toBe(5);
  });
});
