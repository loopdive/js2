// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice Fa — function values on the Prepared whole-program path, creation and storage. On the native
// standalone lane an unannotated function expression is a closure with the all-dynamic signature (every parameter
// and the result the dynamic value); it is the existing closure struct, typed `closure<sig>` while the callee is
// known statically and the externref carrier once it reaches a dynamic slot. A never-rewritten top-level
// `var f = function …` read later in module-init is that closure, so a call through it is its direct call.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ts } from "../src/ts-api.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { programDynamicContracts } from "../src/ir/source-dynamic-contracts.js";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import type { IrFunction, IrInstr } from "../src/ir/core/nodes.js";
import { legalizeDynamicAllocations, legalizeDynamicValues } from "../src/ir/program/dynamic-value-legalization.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import { irRuntimeFuncRef, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { IR_DYN_CALL_BOX_FN } from "../src/shared/contracts/dynamic-call-helpers.js";
import type { IrUnitId } from "../src/shared/contracts/ir-identity.js";

const options = (target: "standalone" | "gc" = "standalone"): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target,
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);
/**
 * The script's own `var print` collides with lib.dom's `declare function print` (#7287): the checker reports the
 * duplicate and types the calls by the lib declaration. Those diagnostics do not stop the compile.
 */
const LIB_PRINT =
  /^(Duplicate identifier 'print'\.|Expected 0 arguments, but got 1\.|This comparison appears to be unintentional because the types 'void' and 'number' have no overlap\.)$/;

/** A closure pulls in the native realm, whose emission takes tens of seconds on a loaded box. */
const SLOW = 240_000;

async function run(source: string): Promise<"returned" | "threw"> {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  const result = await compile(source, options());
  expect(messages(result).filter((message) => !LIB_PRINT.test(message))).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    const exports = instantiatePreparedArtifact(result).instance.exports;
    (exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}

async function refusal(source: string, target: "standalone" | "gc" = "standalone") {
  const result = await compile(source, options(target));
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

describe("#7354 Fa — function values on the Prepared path", () => {
  // Each program runs twice: with node's answer (returns) and with a wrong one (throws), so a pass cannot come
  // from a check that never ran. Node agrees with the first.
  it.each([
    [
      "the prelude's print, called after its declaration",
      "var print = function (v) { return v; };",
      "print(1) !== 1",
      "print(1) !== 2",
    ],
    [
      "two parameters, and a body that runs off its end",
      "var f = function (a, b) { if (a) return b; };",
      "f(1, 2) !== 2 || f(0, 2) !== undefined",
      "f(0, 2) !== 2",
    ],
    [
      "in a function's local, reading the function's parameter",
      "function g(x) { var f = function (v) { return v === 1 ? x : v; }; return f(1); }",
      "g(5) !== 5",
      "g(5) !== 1",
    ],
    [
      "kept by identity through the dynamic home, a copy, a call result and ToBoolean",
      "var f = function (a) { return a; }; var g = f; function h() { return f; }",
      "g !== f || h() !== f || f(f) !== f || !f",
      "g === f",
    ],
    [
      "passed to an untyped parameter",
      "function t(fn) { return fn; } var k = function (x) { return x; };",
      "t(k) !== k || t(function (y) { return y; }) === k",
      "t(k) === k",
    ],
    [
      "writing a script var on each call",
      "var n = 0; var f = function () { n = n + 1; return n; }; f();",
      "f() !== 2 || n !== 2",
      "f() !== 3",
    ],
    [
      "of the function kind: ToBoolean true, strict equality by reference",
      "var f = function () {}; var g = function () {};",
      "!f || f !== f || f === g || g === f",
      "f !== g",
    ],
    [
      "thrown and caught",
      "var f = function () {}; var c; try { throw f; } catch (e) { c = e; }",
      "c !== f || !c",
      "c === f",
    ],
  ])(
    "runs a function expression %s",
    async (_, program, holds, fails) => {
      const right = `${program} if (${holds}) throw 1;`;
      expect(node(right)).toBe("returned");
      expect(await run(right)).toBe("returned");
      expect(await run(`${program} if (${fails}) throw 1;`)).toBe("threw");
    },
    SLOW,
  );

  // What the slice leaves to its neighbours, each pinned by its name so the slice that admits it updates this list.
  it.each([
    // A call through a value whose callee is not known statically is a dynamic call (slice Fb).
    [
      "a call from another function",
      "var f = function (a) { return a; }; function h() { return f(1); } h();",
      'direct call to "f" has no exact AST-site plan in h',
    ],
    [
      "a call before the declaration",
      "if (f(1) !== 1) throw 1; var f = function (a) { return a; };",
      'direct call to "f" has no exact AST-site plan in <module-init>',
    ],
    [
      "a second store into the binding",
      "var f = function (a) { return a; }; f = function (a) { return 2; }; f(1);",
      'assignment to module binding "f" (dynamic) got closure(dynamic)->dynamic',
    ],
    // JavaScript pads a missing argument with `undefined` and drops an extra one; the static call does neither yet.
    ["a call with a missing argument", "var f = function (a) { return a; }; f();", "closure call arity mismatch"],
    // Function objects: `this`, `arguments` and properties (slice C).
    [
      "`this` in the body",
      "var f = function () { return this; }; f();",
      "'this' reference outside an instance method body",
    ],
    [
      "`arguments` in the body",
      "var f = function () { return arguments.length; }; f();",
      "arguments.length outside its function's entry prologue",
    ],
    // Literals without the all-dynamic contract keep the annotated-closure rule.
    [
      "a parameter with a default",
      "var f = function (a = 1) { return a; };",
      "module-level closure binding 'f' not in module-init Slice 2 scope",
    ],
    ["an arrow function", "var f = (a) => a;", "module-level closure binding 'f' not in module-init Slice 2 scope"],
    // A closure returned as a dynamic result, and a mutable capture, have no carrier arm yet.
    [
      "a closure returned from a closure",
      "var f = function (a) { return function () { return a; }; }; f(1);",
      "concrete return needs a dynamic box",
    ],
    [
      "a captured local written after the closure is created",
      "function g() { var x = 1; var f = function () { return x; }; x = 2; return f(); } g();",
      'captures non-local binding "x"',
    ],
    // (#7354 C) ToString and `+` of a function value are ToPrimitive's, and a test for the function kind is the
    // realm's IsCallable: none is served yet. A declaration read as a value is not built yet.
    ["`+` with a string", 'var f = function () {}; var s = f + "";', "dynamic operation + on a function value"],
    ["`String(f)`", "var f = function () {}; var s = String(f);", "dynamic operation ToString of a function value"],
    [
      'a `typeof` comparison with "function"',
      'var f = function () {}; var b = typeof f === "function";',
      "dynamic operation kind test of a function value",
    ],
    [
      "a function declaration read as a value",
      "function id(v) { return v; } var g = id;",
      'identifier "id" is not in scope',
    ],
  ])("refuses %s by name", async (_, program, message) => {
    expect(await refusal(program)).toContain(message);
  });

  it("gives the gc target no all-dynamic closure (no carrier, so no dynamic home)", async () => {
    expect(await refusal("var f = function (a) { return a; };", "gc")).toContain(
      "module binding f has no exact typed storage: not-direct",
    );
    expect(await refusal("function g() { var f = function (a) { return a; }; f(1); return 1; } g();", "gc")).toContain(
      "closure params must have annotations",
    );
  });
});

describe("#7354 Fa — the legalization arms", () => {
  const dynamic = { kind: "dynamic" } as const;
  const externref = { kind: "val", val: { kind: "externref" } } as const;
  const logical = { params: [dynamic], returnType: dynamic };
  const carrier = { params: [externref], returnType: externref };
  const unit = "ir-unit:v1:fa:lifted" as IrUnitId;
  const fn = (instrs: readonly object[], closureSubtype?: object): IrFunction =>
    ({
      unitId: unit,
      name: "lifted",
      params: [{ value: 0, type: { kind: "closure", signature: logical }, name: "__self" }],
      resultTypes: [dynamic],
      blocks: [{ id: 0, blockArgs: [], blockArgTypes: [], instrs, terminator: { kind: "return", values: [1] } }],
      exported: false,
      valueCount: 4,
      ...(closureSubtype ? { closureSubtype } : {}),
    }) as unknown as IrFunction;
  const closureNew = {
    kind: "closure.new",
    liftedFunc: irUnitFuncRef({ unitId: unit, name: "lifted" } as never),
    signature: logical,
    captureFieldTypes: [dynamic],
    captures: [1],
    result: 2,
    resultType: { kind: "closure", signature: logical },
    alloc: 7,
  };
  const pack = {
    kind: "coerce.to_externref",
    value: 2,
    result: 3,
    resultType: { kind: "callable", signature: logical },
  };
  const box = { kind: "call", target: irRuntimeFuncRef(IR_DYN_CALL_BOX_FN), args: [3], result: 1, resultType: dynamic };

  it("gives a closure, its packed callable and its lifted body the carrier signature", () => {
    const out = legalizeDynamicValues(
      fn([closureNew, pack], { signature: logical, captureFieldTypes: [dynamic] }),
      new AllocSiteRegistry(),
      { functions: true },
    );
    const [allocated, packed] = out.blocks[0]!.instrs as IrInstr[];
    expect(allocated).toMatchObject({
      signature: carrier,
      captureFieldTypes: [externref],
      resultType: { kind: "closure", signature: carrier },
    });
    expect(packed!.resultType).toEqual({ kind: "callable", signature: carrier });
    expect(out.params[0]!.type).toEqual({ kind: "closure", signature: carrier });
    expect(out.resultTypes).toEqual([externref]);
    expect(out.closureSubtype).toMatchObject({ signature: carrier, captureFieldTypes: [externref] });
  });

  it("expresses the function-value box of a packed callable as the carrier itself", () => {
    const [, , boxed] = legalizeDynamicValues(fn([closureNew, pack, box]), new AllocSiteRegistry(), { functions: true })
      .blocks[0]!.instrs as IrInstr[];
    expect(boxed).toEqual({ kind: "coerce.to_externref", value: 3, result: 1, resultType: externref });
  });

  it("leaves the function-value box of anything but a packed callable to the helper refusal", () => {
    const helper = { ...box, args: [0] };
    expect(() => legalizeDynamicValues(fn([helper]), new AllocSiteRegistry(), { functions: true })).toThrow(
      "__ir_dyn_call_box",
    );
  });

  it("re-types each closure allocation site to its legalized type", () => {
    const retyped: [number, unknown][] = [];
    legalizeDynamicAllocations(
      [legalizeDynamicValues(fn([closureNew]), new AllocSiteRegistry(), { functions: true })],
      {
        retype: (id, type) => retyped.push([id, type]),
      },
    );
    expect(retyped).toEqual([[7, { kind: "closure", signature: carrier }]]);
  });
});

/** The two contracts on their own, over sources the checker sees. */
describe("#7354 Fa — the closure contracts", () => {
  const STANDALONE = { backend: "wasmgc", target: "standalone" } as const;
  function contractsOf(
    sources: readonly string[],
    policy: { backend: "wasmgc"; target: "standalone" | "host" } = STANDALONE,
  ) {
    const names = sources.map((_, index) => `/probe${index}.js`);
    const host = ts.createCompilerHost({ noLib: true, allowJs: true });
    const read = host.getSourceFile;
    host.getSourceFile = (file, ...rest) => {
      const index = names.indexOf(file);
      return index >= 0
        ? ts.createSourceFile(file, sources[index]!, ts.ScriptTarget.ES2020, true)
        : read(file, ...rest);
    };
    const program = ts.createProgram(names, { noLib: true, allowJs: true }, host);
    const files = names.map((name) => program.getSourceFile(name)!);
    const contracts = programDynamicContracts(program.getTypeChecker(), policy, files, new AllocSiteRegistry());
    const declarations: ts.VariableDeclaration[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isFunctionExpression(node.initializer))
        declarations.push(node);
      ts.forEachChild(node, visit);
    };
    files.forEach(visit);
    return { resolver: contracts.resolver, f: declarations[0]! };
  }

  it("gives an unannotated function expression the all-dynamic signature on the native lane only", () => {
    const dynamic = { kind: "dynamic" };
    const { resolver, f } = contractsOf(["var f = function (a, b) { return a; };"]);
    expect(resolver.dynamicClosureSignature!(f.initializer as ts.FunctionExpression)).toEqual({
      params: [dynamic, dynamic],
      returnType: dynamic,
    });
    expect(
      contractsOf(["var f = function (a) {};"], { backend: "wasmgc", target: "host" }).resolver.dynamicClosureSignature,
    ).toBeUndefined();
  });

  it.each([
    ["a parameter default", "var f = function (a = 1) {};"],
    ["a rest parameter", "var f = function (...a) {};"],
    ["a pattern parameter", "var f = function ({ a }) {};"],
    ["a generator", "var f = function* () {};"],
    ["an async function", "var f = async function () {};"],
  ])("gives %s no all-dynamic signature", (_, source) => {
    const { resolver, f } = contractsOf([source]);
    expect(resolver.dynamicClosureSignature!(f.initializer as ts.FunctionExpression)).toBeUndefined();
  });

  it("knows a top-level var written only by its declaration holds its closure", () => {
    const { resolver, f } = contractsOf(["var f = function (a) { return a; }; f(1);"]);
    expect(resolver.staticFunctionValue!(f)).toBe(true);
  });

  it.each([
    ["written in a function", ["var f = function (a) { return a; }; function w() { f = undefined; }"]],
    ["written at top level", ["var f = function (a) { return a; }; f = undefined;"]],
    ["declared in a block", ["{ var f = function (a) { return a; }; }"]],
    ["in a source that lets the global object escape", ["var f = function (a) { return a; }; var g = globalThis;"]],
    ["in a source that runs dynamic code", ['var f = function (a) { return a; }; eval("");']],
    ["in a program of two scripts", ["var f = function (a) { return a; };", "var k = 1;"]],
    ["initialized with a literal without the contract", ["var f = function (a = 1) { return a; };"]],
  ])("refuses a static closure to a var %s", (_, sources) => {
    const { resolver, f } = contractsOf(sources);
    expect(resolver.staticFunctionValue!(f)).toBe(false);
  });
});
