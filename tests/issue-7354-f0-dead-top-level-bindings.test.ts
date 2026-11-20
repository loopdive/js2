// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 F0 — the strict Prepared front door applies the ordinary compile's #3418 dead-binding elision
// (`elideDeadTopLevelBindings`) to a one-source graph. A top-level `var` whose initializer has no effect and whose
// name is mentioned nowhere else no longer has to lower: the test262 runtime shim (`var print = …`,
// `var $262 = {…}`) stops refusing every row. A binding that is named anywhere, an initializer that can run code,
// and a graph of several sources keep every statement, so the program refuses exactly as before or runs as node.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { elideDeadTopLevelBindings } from "../src/deadcode-elide.js";
import { ts } from "../src/ts-api.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  compileMulti,
  requiredPreparedEmission,
  requiredPreparedFrontendFailure,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

// The runner's options for a Script test (scripts/test262-worker.mjs): semantic diagnostics skipped, goal stated.
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
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal: true,
  }) as Test262CompileOptions;

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** Compile through the strict Prepared entry, run the top-level code and report whether it threw. */
async function run(source: string): Promise<"returned" | "threw"> {
  const result = await compile(source, options());
  expect(messages(result)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

/** What node does with the same Script in a fresh realm. */
function node(source: string): "returned" | "threw" {
  try {
    vm.runInNewContext(source, {});
    return "returned";
  } catch {
    return "threw";
  }
}

async function refusal(source: string, target: "standalone" | "gc" = "standalone"): Promise<string> {
  const result = await compile(source, options(target));
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

// A dead binding whose initializer refuses on this base: the module-init closure has no return annotation.
const DEAD = "var o = { m: function () { return 1; } };";
const CLOSURE = "closure must have a return type annotation (<module-init>)";
const SHIM = readFileSync(new URL("../scripts/test262-fyi-runtime.js", import.meta.url), "utf8");

describe("#7354 F0 — dead top-level bindings are dropped before the Prepared path lowers", () => {
  // `@` is the asserted value: 1 is the right answer (returns), 2 the wrong one (throws), both as node.
  it.each([
    ["an unused object with a function-valued property", `${DEAD} var r = 1; if (r !== @) throw 1;`],
    ["an unused function expression", "var g = function (v) { return v; }; var r = 1; if (r !== @) throw 1;"],
    ["the test262 runtime shim", `${SHIM}var r = 1; if (r !== @) throw 1;`],
    [
      "two unused bindings that name each other",
      "var a = { f: function () { return b; } }; var b = { g: function () { return a; } }; var r = 1; if (r !== @) throw 1;",
    ],
    [
      "a statement whose declarators are all unused",
      `var o = { m: function () { return 1; } }, k = 2; var r = 1; if (r !== @) throw 1;`,
    ],
    ["a hoisted function used before its declaration", `if (f() !== @) throw 1; function f() { return 1; } ${DEAD}`],
    ["a unary operator on a primitive literal", `var x = +"3"; ${DEAD} var r = 1; if (r !== @) throw 1;`],
    [
      "`!` of an object (ToBoolean runs no code)",
      `var x = !{ m: function () { return 1; } }; var r = 1; if (r !== @) throw 1;`,
    ],
    [
      "a later effectful initializer (its call still runs, once, before the read)",
      `${DEAD} var n = 0; function f() { n = n + 1; return 1; } var x = f(); if (n !== @) throw 1;`,
    ],
  ] as const)("runs a program beside %s", async (_name, template) => {
    for (const [value, expected] of [
      ["1", "returned"],
      ["2", "threw"],
    ] as const) {
      const source = template.replace("@", value);
      expect(node(source)).toBe(expected);
      expect(await run(source)).toBe(expected);
    }
  });

  it("keeps an effectful initializer's throw after a dropped binding", async () => {
    const boom = "function boom(v) { if (v) throw 7; return 0; }";
    for (const [arg, expected] of [
      ["0", "returned"],
      ["1", "threw"],
    ] as const) {
      const source = `${DEAD} ${boom} var x = boom(${arg});`;
      expect(node(source)).toBe(expected);
      expect(await run(source)).toBe(expected);
    }
  });

  // The gc target stops later, at its number boundary, not at the dropped closure.
  it("drops the binding on the gc target too (the same gate as the ordinary compile)", async () => {
    const message = await refusal(`${DEAD} var r = 1; if (r !== 1) throw 1;`, "gc");
    expect(message).toContain("js.number.box is unavailable");
    expect(message).not.toContain(CLOSURE);
  });

  // Each row keeps the dead-looking binding, so it still reaches the refusal its initializer causes.
  it.each([
    ["it is used", `${DEAD} if (o.m() !== 1) throw 1;`, CLOSURE],
    ["it is read by `typeof`", `${DEAD} if (typeof o !== "object") throw 1;`, CLOSURE],
    ["a parameter of the same name shadows it", `${DEAD} function f(o) { return o; } var r = f(1);`, CLOSURE],
    ["a local of the same name shadows it", `${DEAD} function f() { var o = 1; return o; } var r = f();`, CLOSURE],
    ["only a nested closure names it", `${DEAD} function f() { return function () { return o; }; } var r = 1;`, "(f)"],
    [
      "only an unused function names it",
      `${DEAD} function unused() { return o.m(); } var r = 1;`,
      "dynamic operation __ir_dyn_method_call_0 has no Prepared intrinsic",
    ],
    [
      "a sibling declarator has an effect (`var a = …, b = f();`)",
      "function boom(v) { if (v) throw 7; return 0; } var a = { m: function () { return 1; } }, b = boom(1);",
      CLOSURE,
    ],
    // `-{ valueOf }` calls valueOf (node throws): dropping it would return.
    ["its `-` runs a user valueOf", "var x = -({ valueOf: function () { throw 1; } });", CLOSURE],
    ["its `+` converts an array", `var x = +[]; var r = 1;`, "empty array literal needs a vec-typed hint"],
    ["its `-` converts a function", "var x = -function () { return 1; }; var r = 1;", CLOSURE],
    ["its `+` converts an arrow function", "var x = +(() => 1); var r = 1;", CLOSURE],
    ["its `+` converts a RegExp", "var x = +/a/; var r = 1;", "RegExp literal has no provider"],
    // A script `var valueOf = …` would make it a call.
    ["its `+` converts the global object", "var x = +globalThis; var r = 1;", 'identifier "globalThis"'],
    ["literal eval source names it", `${DEAD} eval("o");`, CLOSURE],
    ['a string literal spells it (`globalThis["o"]`)', `${DEAD} var s = "o"; if (s !== "o") throw 1;`, CLOSURE],
    [
      "a property name spells it",
      "var m = { f: function () { return 1; } }; var p = { m: 1 }; if (p.m !== 1) throw 1;",
      CLOSURE,
    ],
    ["the test262 shim's `print` is called", `${SHIM}print("x");`, "module-level closure binding 'print'"],
  ] as const)("keeps a binding when %s", async (_name, source, message) => {
    expect(await refusal(source)).toContain(message);
  });

  // The pass sees names, not computed lookups on the global object: these programs could observe a dropped `var`
  // through enumeration or a computed key. The Prepared path refuses each of them, so no answer is wrong today.
  it.each([
    ["a computed global key", `${DEAD} var k = "p" + "q"; var v = globalThis[k];`, 'identifier "globalThis"'],
    [
      "for-in over the global object",
      `${DEAD} var c = 0; for (var k in this) { c = c + 1; }`,
      "nested var declaration",
    ],
    ["Object.keys of the global object", `${DEAD} var c = Object.keys(globalThis).length;`, 'identifier "Object"'],
  ] as const)("refuses %s", async (_name, source, message) => {
    expect(await refusal(source)).toContain(message);
  });

  // The linear backend's JavaScript environment is outside the ordinary compile's elision gate, and so here.
  it("keeps the binding on the linear target", async () => {
    const result = await compile(`${DEAD} var r = 1; if (r !== 1) throw 1;`, {
      ...options(),
      backend: "linear",
      target: "linear",
    } as Test262CompileOptions);
    expect(messages(result).join("\n")).toContain("module binding o has no exact typed storage");
  });

  // The runner matches the observed frontend sources against the job's text, so they are the supplied text.
  it("reports the supplied text, not the elided one, in a frontend failure", async () => {
    const source = `${DEAD} var r = 1; function f(a, a) { "use strict"; }`;
    const result = await compile(source, options());
    expect(messages(result).join("\n")).toContain("Duplicate parameter name 'a' not allowed");
    expect(requiredPreparedFrontendFailure(result)?.sources.map((entry) => entry.text)).toEqual([source]);
  });

  // Both declarations are dead and pure; dropping the pair would compile a program node rejects.
  it.each([["let a = 1; let a = 2;"], ["var a = 1; let a = 2;"], ["let a = 1, a = 2;"]])(
    "keeps the early error of a duplicate lexical declaration: %s",
    async (source) => {
      expect(() => new Function(source)).toThrow(SyntaxError);
      const result = await compile(source, options());
      expect(result.success).toBe(false);
      expect(requiredPreparedFrontendFailure(result)?.phase).toBe("early");
    },
  );

  it("keeps every binding of a graph of several sources (a Script var of one is visible to another)", async () => {
    const result = await compileMulti(
      { "a.js": DEAD, "test.js": "var r = 1; if (r !== 1) throw 1;" },
      "test.js",
      options(),
    );
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain("module binding o has no exact typed storage");
  });

  // Review round 1: dropping a statement must not drop the only evidence of an error. Each program's dead
  // statement carries an early error, a declaration-time error or a ToNumber TypeError; node throws, and the
  // Prepared path refuses or throws too. The first twelve are the reviewer's.
  it.each([
    // Early errors inside the dropped statement (pinned by the unelided program's frontend errors).
    ["a duplicate label", "var g = function () { l: l: ; };"],
    ["a nested duplicate label", "var g = function () { l: { l: ; } };"],
    ["a duplicate constructor", "var g = function () { class C { constructor() {} constructor() {} } };"],
    ["import.meta in a Script", "var g = function () { return import.meta; };"],
    // `+` on a BigInt throws a TypeError (ToNumber).
    ["`+` on a BigInt", "var x = +1n;"],
    ["`+` on a negated BigInt", "var x = +(-1n);"],
    ["`+` on a parenthesized BigInt", "var x = +((1n));"],
    // Declarations of the global object's non-configurable properties.
    ["a strict `var NaN`", '"use strict"; var NaN = 1;'],
    ["a strict `var undefined`", '"use strict"; var undefined = 2;'],
    ["`let undefined`", "let undefined = 1;"],
    ["`const NaN`", "const NaN = 1;"],
    ["`let Infinity`", "let Infinity;"],
    // Ten more of the same two families.
    ["duplicate parameters in strict code", 'var g = function (a, a) { "use strict"; };'],
    ["`yield` as a binding in a generator", "var g = function* () { var yield; };"],
    ["`await` as a binding in an async function", "var g = async function () { var await; };"],
    ["an invalid assignment target", "var g = function () { 1 = 2; };"],
    ["`super` outside a method", "var g = function () { super.x; };"],
    ["`new.target` outside a function", "var g = () => new.target;"],
    ["an octal escape in a strict string", '"use strict"; var g = function () { return "\\07"; };'],
    ["`break` outside a loop", "var g = function () { break; };"],
    ["a strict `var Infinity`", '"use strict"; var Infinity = 1;'],
    ["`const undefined`", "const undefined = 1;"],
  ])("refuses or throws as node does: %s", async (_name, source) => {
    expect(node(source)).toBe("threw");
    const result = await compile(source, options());
    if (!result.success) return;
    expect(requiredPreparedEmission(result)).toBeDefined();
    // An empty program has no `__module_init`: it returns, which is the wrong answer.
    const init = instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined;
    expect(() => init?.()).toThrow(WebAssembly.Exception);
  });
});

// A caller that does not state the goal: `import.meta` is an early error only in a Script, so the statement is
// kept rather than bet on the Module reading (it then refuses where the binding lowers).
it("#7354 F0 keeps a goal-dependent early error when the goal is unstated", async () => {
  const { inferModuleStrictArguments: _m, scriptGoal: _s, ...unstated } = options() as Record<string, unknown>;
  const result = await compile("var g = function () { return import.meta; };", unstated as Test262CompileOptions);
  expect(messages(result).join("\n")).toContain("module binding g has no exact typed storage");
});

// The shared pass's own rules (both callers), moved here from tests/issue-3418.test.ts.
describe("#7354 F0 — elideDeadTopLevelBindings purity and declaration rules", () => {
  const elide = (src: string) => elideDeadTopLevelBindings(src, ts.ScriptKind.JS).elided;

  // ToNumeric of an object runs its valueOf/toString and `+` of a BigInt throws; `!` and `void` never run code.
  it("treats `-`/`+`/`~` as pure only on a primitive operand, and `+` not on a BigInt", () => {
    for (const init of ["-{ valueOf: function () { throw 1; } }", "+[]", "~(function () {})", "+globalThis", "-/a/"])
      expect(elide(`var x = ${init};\n`)).toEqual([]);
    for (const init of ["+1n", "+(-1n)", "+((1n))", "+~1n"]) expect(elide(`var x = ${init};\n`)).toEqual([]);
    for (const init of ['+"3"', "-(1)", "~~2", "-undefined", "-1n", "~1n", "+-1", "!{ a: function () {} }", "void {}"])
      expect(elide(`var x = ${init};\n`)).toEqual(["x"]);
  });

  // A duplicate lexical declaration is a SyntaxError that dropping both statements would hide.
  it("keeps a name declared twice at top level when either declaration is let/const", () => {
    for (const src of [
      "let a = 1; let a = 2;\n",
      "var a = 1; let a = 2;\n",
      "const a = 1; var a = 2;\n",
      "let a, a;\n",
    ])
      expect(elide(src)).toEqual([]);
    expect(elide("var a = 1; var a = 2;\n")).toEqual(["a", "a"]);
  });

  it("never drops a declaration of a non-configurable global", () => {
    for (const src of ["var undefined = 1;\n", "var NaN;\n", "let Infinity;\n", "const undefined = 1;\n"])
      expect(elide(src)).toEqual([]);
  });

  it("never drops a statement holding a pinned offset", () => {
    const src = "var a = 1;\nvar b = 2;\n";
    expect(elideDeadTopLevelBindings(src, ts.ScriptKind.JS, [src.indexOf("b")]).elided).toEqual(["a"]);
  });
});
