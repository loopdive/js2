// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2929 — EvalDeclarationInstantiation, inherited strictness, and lexical TDZ.

import { beforeAll, describe, expect, it } from "vitest";
import { executeDirectEval, executeIndirectEval, type DynamicParser } from "../../src/interp/dynamic-function.js";
import { collectEvalDeclarations } from "../../src/interp/eval-environment.js";
import {
  RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY,
  type EvalBindingCell,
  type JSValue,
} from "../../src/interp/types.js";
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

  it("does not synthesize Annex B vars across root or ancestor lexical conflicts", () => {
    const rootConflict = collectEvalDeclarations(parse("if (true) function f() {}; let f") as any);
    expect(rootConflict.blockFunctionNames).toEqual([]);
    const ancestorConflict = collectEvalDeclarations(parse("{ let f; if (true) function f() {} }") as any);
    expect(ancestorConflict.blockFunctionNames).toEqual([]);
  });

  it("collects switch-clause vars and Annex B functions without leaking switch lexicals", () => {
    const plan = collectEvalDeclarations(
      parse("switch (1) { case 1: var lifted; function selected() {} let local; }") as any,
    );
    expect(plan.varNames).toEqual(["lifted"]);
    expect(plan.lexicalNames).toEqual([]);
    expect(plan.blockFunctionNames).toEqual(["selected"]);

    const conflict = collectEvalDeclarations(
      parse("{ let selected; switch (1) { case 1: function selected() {} } }") as any,
    );
    expect(conflict.blockFunctionNames).toEqual([]);
  });

  it("does not synthesize Annex B vars across for-in/of lexical bindings", () => {
    const forOfConflict = collectEvalDeclarations(
      parse("for (let f of [0]) { switch (1) { case 1: function f() {} } }") as any,
    );
    expect(forOfConflict.blockFunctionNames).toEqual([]);

    const forInConflict = collectEvalDeclarations(
      parse("for (let f in { key: 0 }) { if (true) function f() {} }") as any,
    );
    expect(forInConflict.blockFunctionNames).toEqual([]);
  });

  it("does not synthesize Annex B vars across classic-for lexical bindings", () => {
    const conflict = collectEvalDeclarations(parse("for (let f; ; ) { { function f() {} } break; }") as any);
    expect(conflict.blockFunctionNames).toEqual([]);

    const globalObject: JSValue = {};
    expect(executeIndirectEval(parser, "for (let f; ; ) { { function f() {} } break; } typeof f", globalObject)).toBe(
      "undefined",
    );
    expect("f" in globalObject).toBe(false);
  });

  it("preserves the caller's established this binding in direct eval", () => {
    const cell: EvalBindingCell = { value: 40 };
    const globalObject: JSValue = {};
    expect(direct("this", cell, false, globalObject)).toBe(globalObject);
    expect(direct("'use strict'; this", cell, false, globalObject)).toBe(globalObject);
    expect(direct("this", cell, true, globalObject)).toBeUndefined();
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

  it("severs a mapped arguments index after successful eval deletion", () => {
    const argumentsObject: JSValue[] = [1];
    const argumentsCell: EvalBindingCell = { value: argumentsObject };
    const parameterCell: EvalBindingCell = { value: 1 };
    const mappedNames: JSValue[] = ["a"];
    const result = executeDirectEval(
      parser,
      "delete arguments[0]; a = 2; typeof arguments[0] === 'undefined' ? a : -1",
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
      mappedNames,
    );

    expect(result).toBe(2);
    expect(parameterCell.value).toBe(2);
    expect(argumentsObject[0]).toBeUndefined();
    expect(mappedNames).toEqual([null]);
  });

  it("updates and conditionally severs mapped arguments through defineProperty", () => {
    const run = (source: string): { result: JSValue; argument: JSValue; parameter: JSValue; mapping: JSValue[] } => {
      const argumentsObject: JSValue[] = [1];
      const argumentsCell: EvalBindingCell = { value: argumentsObject };
      const parameterCell: EvalBindingCell = { value: 1 };
      const mappedNames: JSValue[] = ["a"];
      const result = executeDirectEval(
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
        mappedNames,
      );
      return { result, argument: argumentsObject[0], parameter: parameterCell.value, mapping: mappedNames };
    };

    expect(run("Object.defineProperty(arguments, '0', { value: 3, writable: true }); a = 4; arguments[0]")).toEqual({
      result: 4,
      argument: 4,
      parameter: 4,
      mapping: ["a"],
    });
    expect(run("Object.defineProperty(arguments, '0', { value: 5, writable: false }); a = 6; arguments[0]")).toEqual({
      result: 5,
      argument: 5,
      parameter: 6,
      mapping: [null],
    });
    expect(
      run("Object.defineProperty(arguments, '0', { get: function () { return 7; } }); a = 8; arguments[0]"),
    ).toEqual({ result: 7, argument: 7, parameter: 8, mapping: [null] });
  });

  it("refuses non-configurable mapped deletion and throws for strict eval", () => {
    const createState = () => {
      const argumentsObject: JSValue[] = [1];
      const argumentsCell: EvalBindingCell = { value: argumentsObject };
      const parameterCell: EvalBindingCell = { value: 1 };
      const mappedNames: JSValue[] = ["a"];
      const execute = (source: string, callerStrict: boolean): JSValue =>
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
          callerStrict,
          mappedNames,
        );
      return { argumentsObject, parameterCell, mappedNames, execute };
    };

    const sloppy = createState();
    expect(
      sloppy.execute("Object.defineProperty(arguments, '0', { configurable: false }); delete arguments[0]", false),
    ).toBe(false);
    expect(sloppy.mappedNames).toEqual(["a"]);
    expect(sloppy.execute("a = 3; arguments[0]", false)).toBe(3);

    const strict = createState();
    expect(() =>
      strict.execute("Object.defineProperty(arguments, '0', { configurable: false }); delete arguments[0]", true),
    ).toThrow(TypeError);
    expect(strict.mappedNames).toEqual(["a"]);
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

  it("executes Annex B single-statement function declarations in selected if arms", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("if (true) function f() { return 2; } f()", cell)).toBe(2);
    expect(direct("if (false) function f() { return 2; } typeof f", cell)).toBe("undefined");
    expect(direct("if (false) function f() { return 2; } else function f() { return 4; } f()", cell)).toBe(4);
    expect(direct("let f = 3; if (true) function f() { return 2; } f", cell)).toBe(3);
    expect(direct("{ let f = 3; if (true) function f() { return 2; } f; }", cell)).toBe(3);
  });

  it("executes switch matching, fallthrough, default, break, and completion values", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(
      direct(
        "var result = 0; switch (2) { case 1: result = 1; break; case 2: result = 2; case 3: result = result + 3; break; default: result = 9; } result",
        cell,
      ),
    ).toBe(5);
    expect(direct("switch (9) { case 1: 1; break; default: 4; }", cell)).toBe(4);
    expect(direct("switch (0) { default: 2; case 1: 3; }", cell)).toBe(3);
  });

  it("uses one lexical switch environment and publishes only selected Annex B functions", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(
      direct(
        "var result = 0; switch (1) { case typeof f === 'function' ? 1 : 0: result = f(); break; default: function f() { return 4; } } typeof f === 'undefined' ? result : -1",
        cell,
      ),
    ).toBe(4);
    expect(direct("switch (1) { case 1: function f() { return 2; } } f()", cell)).toBe(2);
    expect(direct("switch (0) { case 1: function skipped() {} } typeof skipped", cell)).toBe("undefined");
    expect(direct("switch (1) { case 1: let local = 3; x = local; break; } typeof local", cell)).toBe("undefined");
    expect(cell.value).toBe(3);
  });

  it("preserves pre-switch var values and independent Annex B switch bindings", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("var f = 123; var before = f; switch (1) { case 1: function f() {} } before", cell)).toBe(123);
    expect(
      direct(
        "var initial, current; switch (1) { case 1: function f() { initial = f; f = 123; current = f; return 'decl'; } } var first = f(); (first === 'decl' ? 1 : 0) + (typeof initial === 'function' ? 2 : 0) + (current === 123 ? 4 : 0) + (initial() === 'decl' ? 8 : 0) + (f() === 'decl' ? 16 : 0)",
        cell,
      ),
    ).toBe(31);
  });

  it("executes bounded for-in/of loops with per-iteration lexical environments", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(
      direct(
        "var sum = 0; for (let value of [1, 2, 3]) { if (value === 2) continue; sum = sum + value; } typeof value === 'undefined' ? sum : -1",
        cell,
      ),
    ).toBe(4);
    expect(direct("var keys = ''; for (let key in { a: 1, b: 2 }) { keys = keys + key; } keys", cell)).toBe("ab");
    expect(
      direct(
        "var closures = []; for (let value of [1, 2]) { closures[closures.length] = function () { return value; }; } closures[0]() * 10 + closures[1]()",
        cell,
      ),
    ).toBe(12);
    expect(
      direct(
        "for (let f of [0]) { switch (1) { case 1: function f() {} } } for (let g in { key: 0 }) { if (true) function g() {} } typeof f === 'undefined' && typeof g === 'undefined'",
        cell,
      ),
    ).toBe(true);
  });

  it("resolves realm Error constructors after a sparse global miss", () => {
    const cell: EvalBindingCell = { value: 40 };
    expect(direct("ReferenceError", cell)).toBe(ReferenceError);
    expect(direct("typeof ReferenceError", cell)).toBe("function");

    const shadow = { marker: 1 };
    expect(direct("ReferenceError", cell, false, { ReferenceError: shadow })).toBe(shadow);
    expect(direct("let ReferenceError = 3; ReferenceError", cell)).toBe(3);
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

  it("creates eval global vars with deletable ordinary data descriptors", () => {
    const globalObject: JSValue = {};
    expect(executeIndirectEval(parser, "var x = 9; x", globalObject)).toBe(9);
    expect(Object.getOwnPropertyDescriptor(globalObject, "x")).toEqual({
      value: 9,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  it("updates an existing non-configurable global var without replacing its descriptor", () => {
    const globalObject: JSValue = {};
    Object.defineProperty(globalObject, "x", {
      value: 23,
      writable: true,
      enumerable: true,
      configurable: false,
    });
    expect(executeIndirectEval(parser, "var initial = x; var x = 45; initial", globalObject)).toBe(23);
    expect(Object.getOwnPropertyDescriptor(globalObject, "x")).toEqual({
      value: 45,
      writable: true,
      enumerable: true,
      configurable: false,
    });
  });

  it("resolves indirect eval through the declarative half of the global environment", () => {
    const globalObject: JSValue = {};
    const cell: EvalBindingCell = { value: "outside" };
    Object.defineProperty(globalObject, RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY, {
      value: ["x", cell],
      writable: true,
      enumerable: false,
      configurable: false,
    });
    expect(executeIndirectEval(parser, "x", globalObject)).toBe("outside");
    expect(executeIndirectEval(parser, "'use strict'; x", globalObject)).toBe("outside");
    expect(executeIndirectEval(parser, "x = 'updated'; x", globalObject)).toBe("updated");
    expect(cell.value).toBe("updated");
    expect(Object.getOwnPropertyDescriptor(globalObject, "x")).toBeUndefined();
  });

  it("rejects an indirect-eval var collision with a global lexical binding atomically", () => {
    const globalObject: JSValue = {};
    const cell: EvalBindingCell = { value: undefined };
    Object.defineProperty(globalObject, RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY, {
      value: ["x", cell],
      writable: true,
      enumerable: false,
      configurable: false,
    });
    expect(() => executeIndirectEval(parser, "var before; var x; var after", globalObject)).toThrow(SyntaxError);
    expect(Object.getOwnPropertyDescriptor(globalObject, "before")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(globalObject, "x")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(globalObject, "after")).toBeUndefined();
  });

  it("reconfigures a configurable global property for a function declaration", () => {
    const globalObject: JSValue = {};
    Object.defineProperty(globalObject, "f", {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    expect(executeIndirectEval(parser, "var initial = f; function f() { return 345; } initial()", globalObject)).toBe(
      345,
    );
    const descriptor = Object.getOwnPropertyDescriptor(globalObject, "f")!;
    expect(descriptor.writable).toBe(true);
    expect(descriptor.enumerable).toBe(true);
    expect(descriptor.configurable).toBe(true);
  });

  it("preflights non-definable functions atomically", () => {
    const globalObject: JSValue = {};
    expect(() =>
      executeIndirectEval(
        parser,
        "var shouldNotBeDefined1; function before() {} function NaN() {} function after() {}",
        globalObject,
      ),
    ).toThrow(TypeError);
    expect(Object.getOwnPropertyDescriptor(globalObject, "shouldNotBeDefined1")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(globalObject, "before")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(globalObject, "after")).toBeUndefined();
  });

  it("throws on strict unresolvable assignment and creates sloppy globals", () => {
    const strictGlobal: JSValue = {};
    expect(() => executeIndirectEval(parser, "'use strict'; missing = 1", strictGlobal)).toThrow(ReferenceError);
    expect("missing" in strictGlobal).toBe(false);

    const sloppyGlobal: JSValue = {};
    expect(executeIndirectEval(parser, "missing = 1", sloppyGlobal)).toBe(1);
    expect(sloppyGlobal.missing).toBe(1);
  });

  it("resolves sloppy with statements through an object environment record", () => {
    const globalObject: JSValue = {};
    expect(executeIndirectEval(parser, "with ({ a: 1 }) { a; }", globalObject)).toBe(1);
    expect(
      executeIndirectEval(
        parser,
        "var target = { a: 1 }; var outer = 10; with (target) { a = 2; outer = outer + 1; } target.a * 100 + outer",
        globalObject,
      ),
    ).toBe(211);
  });

  it("restores a with environment across break and catch control flow", () => {
    const globalObject: JSValue = {};
    expect(
      executeIndirectEval(
        parser,
        "var target = { a: 1 }; var a = 10; while (true) { with (target) { a = 2; break; } } a * 100 + target.a",
        globalObject,
      ),
    ).toBe(1002);
    expect(
      executeIndirectEval(
        parser,
        "var target = { a: 1 }; var a = 10; try { with (target) { throw 7; } } catch (error) { a = a + error; } a * 100 + target.a",
        globalObject,
      ),
    ).toBe(1701);
  });

  it("keeps syntactic nested eval direct against the live eval VariableEnvironment", () => {
    const globalObject: JSValue = {};
    const createdVarNames: JSValue[] = [];
    const createdVarSlots: JSValue[] = [];
    const result = executeDirectEval(
      parser,
      "var x = 1; eval('x = 2'); x",
      globalObject,
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
    expect(result).toBe(2);
  });

  it("runs an eval alias globally from inside direct eval", () => {
    const globalObject: JSValue = { g: "global" };
    const createdVarNames: JSValue[] = [];
    const createdVarSlots: JSValue[] = [];
    const result = executeDirectEval(
      parser,
      "var g = 'local'; var indirect = eval; indirect(\"'global' === g\")",
      globalObject,
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
    expect(result).toBe(true);
  });

  it("keeps globalThis and the realm eval identity visible through eval lexical environments", () => {
    const globalObject: JSValue = {};
    const result = executeDirectEval(
      parser,
      "let lexical = 0; var indirect = eval; " +
        "(indirect === eval ? 1 : 0) + " +
        "(indirect === globalThis.eval ? 2 : 0) + " +
        "(eval === globalThis.eval ? 4 : 0)",
      globalObject,
      undefined,
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      false,
      [],
    );
    expect(result).toBe(7);
    expect(globalObject.eval).toBeDefined();
  });

  it("falls back to an ordinary call when syntactic eval resolves to a shadow", () => {
    const result = executeDirectEval(
      parser,
      "var eval = function (value) { return value + 1; }; eval(2)",
      {},
      undefined,
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      false,
      [],
    );
    expect(result).toBe(3);
  });
});
