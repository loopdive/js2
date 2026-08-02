// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2929 — EvalDeclarationInstantiation, inherited strictness, and lexical TDZ.

import { beforeAll, describe, expect, it } from "vitest";
import { executeDirectEval, executeIndirectEval, type DynamicParser } from "../../src/interp/dynamic-function.js";
import { collectEvalDeclarations } from "../../src/interp/eval-environment.js";
import { type EvalBindingCell, type JSValue } from "../../src/interp/types.js";
import { loadAcorn, parse } from "./harness.js";

beforeAll(async () => {
  await loadAcorn();
});

const parser: DynamicParser = (source: JSValue): JSValue => parse(source as string);

function direct(source: string, cell: EvalBindingCell, callerStrict = false, globalObject: JSValue = {}): JSValue {
  return executeDirectEval(
    parser,
    source,
    globalObject,
    undefined,
    [],
    [],
    ["x"],
    [cell],
    [],
    [],
    [],
    [],
    callerStrict,
    [],
  );
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

  it("persists a new sloppy var in the current activation without overwriting an outer capture", () => {
    const activationNames: JSValue[] = [];
    const activationSlots: JSValue[] = [];
    const createdVarNames: JSValue[] = [];
    const createdVarSlots: JSValue[] = [];
    const outerCell: EvalBindingCell = { value: 40 };
    const run = (source: string): JSValue =>
      executeDirectEval(
        parser,
        source,
        {},
        undefined,
        createdVarNames,
        createdVarSlots,
        activationNames,
        activationSlots,
        [],
        [],
        ["x"],
        [outerCell],
        false,
        [],
      );

    expect(run("var x = 1; x")).toBe(1);
    expect(outerCell.value).toBe(40);
    expect(activationNames).toEqual([]);
    expect(createdVarNames).toEqual(["x"]);
    expect((createdVarSlots[0] as EvalBindingCell).value).toBe(1);

    expect(run("x = x + 1; x")).toBe(2);
    expect(outerCell.value).toBe(40);
    expect((createdVarSlots[0] as EvalBindingCell).value).toBe(2);
  });

  it("keeps mapped parameters and arguments indices aliased in eval execution order", () => {
    const argumentsObject: JSValue[] = [1];
    const argumentsCell: EvalBindingCell = { value: argumentsObject };
    const parameterCell: EvalBindingCell = { value: 1 };
    const run = (source: string): JSValue =>
      executeDirectEval(
        parser,
        source,
        {},
        undefined,
        [],
        [],
        ["arguments", "a"],
        [argumentsCell, parameterCell],
        [],
        [],
        [],
        [],
        false,
        ["a"],
      );

    expect(run("a = 2")).toBe(2);
    expect(parameterCell.value).toBe(2);
    expect(argumentsObject[0]).toBe(2);

    expect(run("arguments[0] = 3")).toBe(3);
    expect(parameterCell.value).toBe(3);
    expect(argumentsObject[0]).toBe(3);

    expect(run("a = 4; arguments[0] = 5")).toBe(5);
    expect(parameterCell.value).toBe(5);
    expect(argumentsObject[0]).toBe(5);

    expect(run("arguments[0] = 6; a = 7")).toBe(7);
    expect(parameterCell.value).toBe(7);
    expect(argumentsObject[0]).toBe(7);
  });

  it("gives direct-eval lexical declarations a private TDZ binding", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("let x = 1; x", cell)).toBe(1);
    expect(cell.value).toBe(40);
    expect(() => direct("let x = x", cell)).toThrow(ReferenceError);
    expect(cell.value).toBe(40);
  });

  it("creates real nested lexical environments with shadowing and closure capture", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("let x = 1; { let x = 2; x; } x", cell)).toBe(1);
    expect(direct("{ let y = 1; y; } typeof y", cell)).toBe("undefined");
    expect(direct("var f; { let y = 3; f = function () { return y; }; } f()", cell)).toBe(3);
    expect(() => direct("{ x; let x = 1; }", cell)).toThrow(ReferenceError);
    expect(cell.value).toBe(40);
  });

  it("keeps a strict block function live only inside its block", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("'use strict'; { function f() { return 1; } f(); } typeof f", cell)).toBe("undefined");
  });

  it("applies sloppy Annex B block-function var initialization without crossing lexical conflicts", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("{ function f() { return 2; } } f()", cell)).toBe(2);
    expect(direct("let f = 3; { function f() { return 2; } } f", cell)).toBe(3);
    expect(direct("{ let f = 3; { function f() { return 2; } } f; }", cell)).toBe(3);
    expect(direct("if (false) { function f() {} } f", cell)).toBeUndefined();
  });

  it("persists a sloppy Annex B block function across later direct eval calls", () => {
    const createdVarNames: JSValue[] = [];
    const createdVarSlots: JSValue[] = [];
    const run = (source: string): JSValue =>
      executeDirectEval(
        parser,
        source,
        {},
        undefined,
        createdVarNames,
        createdVarSlots,
        [],
        [],
        [],
        [],
        [],
        [],
        false,
        [],
      );

    expect(run("{ function f() { return 4; } } 0")).toBe(0);
    expect(run("f()")).toBe(4);
  });

  it("executes bounded class declarations and expressions on interpreted closures", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(
      direct(
        "class C { constructor(x) { this.x = x; } value() { return this.x; } static two() { return 2; } } var c = new C(5); c.value() + C.two()",
        cell,
      ),
    ).toBe(7);
    expect(direct("var C = class Named { value() { return 4; } }; new C().value()", cell)).toBe(4);
  });

  it("enforces class TDZ, block lifetime, and call-without-new rejection", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("{ class C { static value() { return 3; } } C.value(); } typeof C", cell)).toBe("undefined");
    expect(() => direct("C; class C {}", cell)).toThrow(ReferenceError);
    expect(direct("class C {} try { C(); } catch (error) { error.name }", cell)).toBe("TypeError");
  });

  it("restores nested lexical environments across break and catch control flow", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("var r = 0; while (true) { let y = 1; r = y; break; } typeof y === 'undefined' ? r : -1", cell)).toBe(
      1,
    );
    expect(
      direct(
        "var r = 0; try { { let y = 1; throw 7; } } catch (error) { r = error; } typeof y === 'undefined' ? r : -1",
        cell,
      ),
    ).toBe(7);
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
