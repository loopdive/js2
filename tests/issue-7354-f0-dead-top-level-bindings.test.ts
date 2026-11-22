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
import { detectEarlyErrors } from "../src/compiler/early-errors/index.js";
import { elideDeadTopLevelBindings } from "../src/deadcode-elide.js";
import { compile as ordinaryCompile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";
import { ts } from "../src/ts-api.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  compileMulti,
  requiredPreparedEmission,
  requiredPreparedFrontendFailure,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import { yieldToRpc } from "./helpers/prepared-node-agreement.js";

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
  await yieldToRpc();
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
  await yieldToRpc();
  const result = await compile(source, options(target));
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

// A dead binding whose initializer refuses when it is kept: the closure reads `new.target` ((#7354 C2) it read `this`,
// which binds now). (#7354 F1) A function expression is a value now, so the closure's body, not its shape, is what
// refuses.
const DEAD = "var o = { m: function () { return new.target; } };";
const CLOSURE = "unsupported expression kind MetaProperty";
// (#7354 F1) `-` of an object or function value is not lowered yet.
const MINUS = "unary '-' expects number";
const SHIM = readFileSync(new URL("../scripts/test262-fyi-runtime.js", import.meta.url), "utf8");

// Programs beside a dropped binding; `@` is the asserted value (1 right, 2 wrong). (#7354 F1) Each dropped closure
// reads `new.target`, so the unelided program (the verdict test below) still refuses fast instead of lowering a realm.
const RUNS = [
  ["an unused object with a function-valued property", `${DEAD} var r = 1; if (r !== @) throw 1;`],
  ["an unused function expression", "var g = function (v) { return new.target; }; var r = 1; if (r !== @) throw 1;"],
  ["the test262 runtime shim", `${SHIM}var r = 1; if (r !== @) throw 1;`],
  [
    "two unused bindings that name each other",
    "var a = { f: function () { return (b, new.target); } }; var b = { g: function () { return (a, new.target); } }; var r = 1; if (r !== @) throw 1;",
  ],
  [
    "a statement whose declarators are all unused",
    `var o = { m: function () { return new.target; } }, k = 2; var r = 1; if (r !== @) throw 1;`,
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
] as const;

// Programs whose dead-looking binding is kept, so it reaches the refusal its initializer causes.
const KEPT = [
  ["it is used", `${DEAD} if (o.m() !== 1) throw 1;`, CLOSURE],
  ["it is read by `typeof`", `${DEAD} if (typeof o !== "object") throw 1;`, CLOSURE],
  ["a parameter of the same name shadows it", `${DEAD} function f(o) { return o; } var r = f(1);`, CLOSURE],
  ["a local of the same name shadows it", `${DEAD} function f() { var o = 1; return o; } var r = f();`, CLOSURE],
  ["only a nested closure names it", `${DEAD} function f() { return function () { return o; }; } var r = 1;`, CLOSURE],
  [
    "only an unused function names it",
    `${DEAD} function unused() { return o.m(); } var r = 1;`,
    CLOSURE, // (#7354 F2) the method call lowers; the kept closure reads `new.target`
  ],
  [
    "a sibling declarator has an effect (`var a = …, b = f();`)",
    "function boom(v) { if (v) throw 7; return 0; } var a = { m: function () { return new.target; } }, b = boom(1);",
    CLOSURE,
  ],
  // `-{ valueOf }` calls valueOf (node throws): dropping it would return.
  ["its `-` runs a user valueOf", "var x = -({ valueOf: function () { throw 1; } });", MINUS],
  ["its `+` converts an array", `var x = +[]; var r = 1;`, "empty array literal needs a vec-typed hint"],
  ["its `-` converts a function", "var x = -function () { return 1; }; var r = 1;", MINUS],
  [
    "its `+` converts an arrow function",
    "var x = +(() => 1); var r = 1;",
    "closure must have a return type annotation",
  ],
  ["its `+` converts a RegExp", "var x = +/a/; var r = 1;", "RegExp literal has no provider"],
  // A script `var valueOf = …` would make it a call.
  ["its `+` converts the global object", "var x = +globalThis; var r = 1;", 'identifier "globalThis"'],
  ["literal eval source names it", `${DEAD} eval("o");`, CLOSURE],
  ['a string literal spells it (`globalThis["o"]`)', `${DEAD} var s = "o"; if (s !== "o") throw 1;`, CLOSURE],
  [
    "a property name spells it",
    "var m = { f: function () { return new.target; } }; var p = { m: 1 }; if (p.m !== 1) throw 1;",
    CLOSURE,
  ],
  ["the test262 shim's `print` is called", `${SHIM}print("x");`, 'identifier "console" is not in scope'],
] as const;

// Global-object reflection the pass cannot see; the Prepared path refuses each.
const REFLECTS = [
  ["a computed global key", `${DEAD} var k = "p" + "q"; var v = globalThis[k];`, 'identifier "globalThis"'],
  ["for-in over the global object", `${DEAD} var c = 0; for (var k in this) { c = c + 1; }`, "nested var declaration"],
  ["Object.keys of the global object", `${DEAD} var c = Object.keys(globalThis).length;`, 'identifier "Object"'],
] as const;

// Programs node rejects whose only evidence is in a dead statement (review rounds 1-2).
const THROWS = [
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
  // `let undefined = 1;`, `const NaN = 1;` (the reviewer's) and `const undefined = 1;` are kept, never elided
  // (see the unit rows below), but the Prepared path then compiles and returns on main and here alike, a
  // GlobalDeclarationInstantiation error it does not model yet (#7445).
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
  ["`delete` of a name in strict code", 'var g = function () { "use strict"; var v; delete v; };'],
  ["an assignment to `arguments` in strict code", 'var g = function () { "use strict"; arguments = 1; };'],
  ["`let` and `var` of one name in a function", "var g = function () { let x; var x; };"],
] as const;

describe("#7354 F0 — dead top-level bindings are dropped before the Prepared path lowers", () => {
  // `@` is the asserted value: 1 is the right answer (returns), 2 the wrong one (throws), both as node.
  it.each(RUNS)("runs a program beside %s", async (_name, template) => {
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
  it.each(KEPT)("keeps a binding when %s", async (_name, source, message) => {
    expect(await refusal(source)).toContain(message);
  });

  // The pass sees names, not computed lookups on the global object: these programs could observe a dropped `var`
  // through enumeration or a computed key. The Prepared path refuses each of them, so no answer is wrong today.
  it.each(REFLECTS)("refuses %s", async (_name, source, message) => {
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
  it.each(THROWS)("refuses or throws as node does: %s", async (_name, source) => {
    expect(node(source)).toBe("threw");
    const result = await compile(source, options());
    if (!result.success) return;
    expect(requiredPreparedEmission(result)).toBeDefined();
    // An empty program has no `__module_init`: it returns, which is the wrong answer.
    const init = instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined;
    expect(() => init?.()).toThrow(WebAssembly.Exception);
  });
});

// test262 `language/global-code/decl-lex-restricted-global.js` is `negative: phase: runtime`: `let undefined;`
// throws its SyntaxError when the Script starts, so it is not an early error. With the runner's Script goal the
// ordinary compile must still compile it and throw at run time (review round 2: a detector rule made it a
// compile error, which scores compile_error).
it("#7354 F0 leaves `let undefined;` a run-time SyntaxError of the ordinary compile", async () => {
  const result = await ordinaryCompile("let undefined;", {
    allowJs: true,
    fileName: "test.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal: true,
  });
  expect(messages(result).filter((message) => message.includes("undefined"))).toEqual([]);
  expect(result.success).toBe(true);
  // Without `deferTopLevelInit` the top-level code is the start function, so instantiation throws.
  await expect(instantiateWithRuntime(result)).rejects.toThrow();
});

// A caller that does not state the goal: `import.meta` is an early error only in a Script, so the statement is
// kept rather than bet on the Module reading (it then refuses where the binding lowers).
it("#7354 F0 keeps a goal-dependent early error when the goal is unstated", async () => {
  const { inferModuleStrictArguments: _m, scriptGoal: _s, ...unstated } = options() as Record<string, unknown>;
  const result = await compile("var g = function () { return import.meta; };", unstated as Test262CompileOptions);
  expect(messages(result).join("\n")).toContain("module binding g has no exact typed storage");
});

// Review round 3: the early errors that pin a dead binding are walked under the Script and the Module goal
// whatever the options state. Each program's only statement is a dead binding: the legal one is dropped and
// compiles; an illegal one is kept (and refused where it lowers) in every option set whose goal could be the one
// that rejects it. `await 0` in a plain function is rejected under both goals.
const SCRIPT_ONLY = "var g = function () { return import.meta; };";
const MODULE_ONLY = "var g = function () { var await; };";
const BOTH = "var g = function () { await 0; };";
const LEGAL = "var g = function () { return new.target; };";
/** The runner's options with the goal flags replaced (`undefined` leaves one unstated). */
const goalOptions = (scriptGoal: boolean | undefined, inferModule: boolean | undefined) => {
  const { scriptGoal: _s, inferModuleStrictArguments: _m, ...rest } = options() as Record<string, unknown>;
  return {
    ...rest,
    ...(scriptGoal === undefined ? {} : { scriptGoal }),
    ...(inferModule === undefined ? {} : { inferModuleStrictArguments: inferModule }),
  } as Test262CompileOptions;
};

describe("#7354 F0 — goal-dependent early errors inside a dead binding", () => {
  const combinations = [true, undefined].flatMap((scriptGoal) =>
    [true, false, undefined].map((inferModule) => [scriptGoal, inferModule] as const),
  );

  it.each(combinations)("scriptGoal=%s inferModuleStrictArguments=%s", async (scriptGoal, inferModule) => {
    const compileWith = (source: string) => compile(source, goalOptions(scriptGoal, inferModule));
    // A Script is possible unless only the Module goal is stated; a Module unless the Script goal is.
    const scriptPossible = !(inferModule === true && scriptGoal !== true);
    const modulePossible = scriptGoal !== true;
    expect(node(SCRIPT_ONLY)).toBe("threw");
    if (scriptPossible) expect((await compileWith(SCRIPT_ONLY)).success).toBe(false);
    if (modulePossible) expect((await compileWith(MODULE_ONLY)).success).toBe(false);
    expect((await compileWith(BOTH)).success).toBe(false);
    expect(messages(await compileWith(LEGAL))).toEqual([]);
  });

  // The reviewer's program: `inferModuleStrictArguments: false` alone marks only a Script top level, and the
  // Script-only rules key on `scriptGoal`, so a walk under the given options alone dropped it.
  it.each([true, false])(
    "keeps import.meta under inferModuleStrictArguments:false alone (skipSemantic %s)",
    async (skip) => {
      const result = await compile(SCRIPT_ONLY, {
        ...goalOptions(undefined, false),
        skipSemanticDiagnostics: skip,
      } as Test262CompileOptions);
      expect(result.success).toBe(false);
    },
  );
});

// Review round 4: the elision's detector walks once ran on the real gate's SourceFile, and a Script walk left
// strict-mode answers that the Module-goal gate then read. Under the Module goal (strict) node rejects each.
const MODULE_STRICT = [
  "var l = 010; if (l !== 8) throw 1;",
  "function f(a, a) { return a; } if (f(1, 2) !== 2) throw 1;",
  "var d = '\\07';",
  "var d = function (a, a) { return a; };",
] as const;

describe("#7354 F0 — the elision cannot change the real gate's verdict", () => {
  it.each(MODULE_STRICT.flatMap((source) => [true, false].map((skip) => [source, skip] as const)))(
    "refuses %s under the Module goal (skipSemantic %s)",
    async (source, skip) => {
      const result = await compile(source, {
        ...goalOptions(undefined, true),
        skipSemanticDiagnostics: skip,
      } as Test262CompileOptions);
      expect(result.success).toBe(false);
      expect(requiredPreparedFrontendFailure(result)?.phase).toBeDefined();
    },
  );

  // For every program of this file and every option set, the gate's verdict with the elision equals its verdict
  // without it (the identity in the entry's test seam), except in the intended case: a program the backend refused
  // only because it lowered a dead binding. A frontend verdict (a syntax or early error, or a TypeScript error the
  // presentation refuses) and a success must never change.
  const PROGRAMS = [
    ...RUNS.map(([, template]) => template.replace("@", "1")),
    ...KEPT.map(([, source]) => source),
    ...REFLECTS.map(([, source]) => source),
    ...THROWS.map(([, source]) => source),
    "let a = 1; let a = 2;",
    "var a = 1; let a = 2;",
    "let a = 1, a = 2;",
    SCRIPT_ONLY,
    MODULE_ONLY,
    BOTH,
    LEGAL,
    ...MODULE_STRICT,
  ];
  // The third field: node runs the program as a Script under these options (the Module set is not run by node).
  const OPTION_SETS: readonly (readonly [string, Test262CompileOptions, boolean])[] = [
    ["runner (Script, semantic skipped)", options(), true],
    ["unstated goal", goalOptions(undefined, undefined), true],
    ["inferModuleStrictArguments:false alone", goalOptions(undefined, false), true],
    ["Module goal", goalOptions(undefined, true), false],
    ["Script goal, semantic checked", { ...options(), skipSemanticDiagnostics: false } as Test262CompileOptions, true],
  ];
  const identity = ((files: Record<string, string>) => files) as Parameters<typeof compile>[2];
  const frontendRefused = (result: Awaited<ReturnType<typeof compile>>) =>
    requiredPreparedFrontendFailure(result) !== undefined ||
    messages(result).some((message) => message.includes("analyzed frontend errors cannot become prepared artifacts"));

  it.each(OPTION_SETS)(
    "%s",
    async (_name, set, script) => {
      for (const source of PROGRAMS) {
        await yieldToRpc();
        const elided = await compile(source, set);
        const bypassed = await compile(source, set, identity);
        const same =
          elided.success === bypassed.success && messages(elided).join("\n") === messages(bypassed).join("\n");
        if (same) continue;
        const intended = !bypassed.success && !frontendRefused(bypassed) && !frontendRefused(elided);
        expect({ source, elided: messages(elided), bypassed: messages(bypassed), intended }).toMatchObject({
          intended: true,
        });
        // A program the elision lets compile must then answer as node does (round 3: the gate itself never saw
        // the Script-only error, so only node can tell).
        if (!elided.success || !script) continue;
        const init = instantiatePreparedArtifact(elided).instance.exports.__module_init as (() => void) | undefined;
        let ran: "returned" | "threw" = "returned";
        try {
          init?.();
        } catch {
          ran = "threw";
        }
        expect({ source, ran }).toEqual({ source, ran: node(source) });
      }
    },
    300_000,
  );
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

  // The elision's pins come from this detector in runner mode: a function body, also one inside a class static
  // block, is a StatementList whose labels restart.
  it.each([
    ["a function", "var g = function () { l: l: ; };"],
    ["a function in a class static block", "var c = class { static { function f() { l: l: ; } } };"],
  ])("reports a duplicate label inside %s as an early error", (_name, source) => {
    const sf = ts.createSourceFile("test.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    expect(detectEarlyErrors(sf).map((error) => error.message)).toContain("Duplicate label 'l'");
  });

  it("never drops a statement holding a pinned offset", () => {
    const src = "var a = 1;\nvar b = 2;\n";
    expect(elideDeadTopLevelBindings(src, ts.ScriptKind.JS, [src.indexOf("b")]).elided).toEqual(["a"]);
  });
});
