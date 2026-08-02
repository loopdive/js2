// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2929 — EvalDeclarationInstantiation, inherited strictness, and lexical TDZ.

import { beforeAll, describe, expect, it } from "vitest";
import { executeDirectEval, executeIndirectEval, type DynamicParser } from "../../src/interp/dynamic-function.js";
import { collectEvalDeclarations } from "../../src/interp/eval-environment.js";
import type { EvalBindingCell, JSValue } from "../../src/interp/types.js";
import { loadAcorn, parse } from "./harness.js";

beforeAll(async () => {
  await loadAcorn();
});

const parser: DynamicParser = (source: JSValue): JSValue => parse(source as string);

function direct(source: string, cell: EvalBindingCell, callerStrict = false, globalObject: JSValue = {}): JSValue {
  return executeDirectEval(parser, source, globalObject, undefined, ["x"], [cell], callerStrict);
}

describe("#2929 eval declaration environments", () => {
  it("separates top-level eval lexicals from nested block declarations", () => {
    const ast = parse("let top; { let nested; function blockFn() {} var lifted; }") as any;
    const plan = collectEvalDeclarations(ast);
    expect(plan.lexicalNames).toEqual(["top"]);
    expect(plan.varNames).toEqual(["lifted"]);
    expect(plan.blockFunctionNames).toEqual(["blockFn"]);
  });

  it("keeps strict block-function initialization private to eval", () => {
    const globalObject: JSValue = {};
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("'use strict'; { function f() {} }", cell, false, globalObject)).toBe("use strict");
    expect("f" in globalObject).toBe(false);
  });

  it("keeps strict-source var declarations private from a direct-eval caller", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("'use strict'; var x = 1; x", cell)).toBe(1);
    expect(cell.value).toBe(40);
  });

  it("inherits caller strictness for var isolation and parser early errors", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("var x = 1; x", cell, true)).toBe(1);
    expect(cell.value).toBe(40);
    expect(() => direct("var arguments = 1", cell, true)).toThrow(SyntaxError);
  });

  it("keeps sloppy direct-eval var writes attached to an existing caller cell", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("var x = 1; x", cell)).toBe(1);
    expect(cell.value).toBe(1);
  });

  it("gives direct-eval lexical declarations a private TDZ binding", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("let x = 1; x", cell)).toBe(1);
    expect(cell.value).toBe(40);
    expect(() => direct("let x = x", cell)).toThrow(ReferenceError);
    expect(cell.value).toBe(40);
  });

  it("isolates strict indirect-eval declarations from the global object", () => {
    const globalObject: JSValue = { x: 40 };
    expect(executeIndirectEval(parser, "'use strict'; var x = 1; x", globalObject)).toBe(1);
    expect(globalObject.x).toBe(40);
  });

  it("preserves an existing global for an uninitialized sloppy var", () => {
    const globalObject: JSValue = { x: 40 };
    expect(executeIndirectEval(parser, "var x; x", globalObject)).toBe(40);
    expect(globalObject.x).toBe(40);
  });

  it("throws on strict unresolvable assignment and creates sloppy globals", () => {
    const strictGlobal: JSValue = {};
    expect(() => executeIndirectEval(parser, "'use strict'; missing = 1", strictGlobal)).toThrow(ReferenceError);
    expect("missing" in strictGlobal).toBe(false);

    const sloppyGlobal: JSValue = {};
    expect(executeIndirectEval(parser, "missing = 1", sloppyGlobal)).toBe(1);
    expect(sloppyGlobal.missing).toBe(1);
  });
});
