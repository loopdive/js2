// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7340 S1 — `var w = new String("abc")` (and `Number`, `Boolean`) stored into a
// script var on the dynamic module home is a carrier value on the IR path.
//
// On main every such `<module-init>` refused at select (`expr-new-ctor-unknown`).
// Now the construction is claimed when every use of the var is one the dynamic
// arms answer correctly; any other use keeps the unit legacy, refused at select
// — never claimed and then withdrawn. Each row is checked against node.
//
// Programs compile bare, without the test262 harness: with the harness linked
// in, a wrong String-wrapper `.length` read answered correctly by accident
// (review of PR #7221), so a harnessed run is no evidence for a claimed row.
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";
import { storedWrapperConstruction, wrapperStoreRefusal } from "../src/ir/wrapper-construction.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

type Result = Awaited<ReturnType<typeof compile>>;

function scriptOptions(target: "standalone" | "wasi") {
  return {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    deferTopLevelInit: true,
    target,
  };
}

function harnessed(body: string): string {
  const source = `/*---\ndescription: 7340\n---*/\n${body}\n`;
  return assembleOriginalHarness(source, parseMeta(source) as never).primary.source;
}

async function compileScript(source: string, target: "standalone" | "wasi" = "standalone"): Promise<Result> {
  return compile(source, scriptOptions(target));
}

/**
 * The refusal arm is recorded in `detail` only under the shape diagnostics,
 * which the selector reads at module load: compile through a fresh import
 * with them set (as tests/issue-7106-lever-sr.test.ts does).
 */
async function compileWithArms(body: string): Promise<Result> {
  const flags = ["JS2WASM_IR_SHAPE_DIAG", "JS2WASM_IR_MODULE_INIT_ALL_REJECTS"];
  const previous = flags.map((flag) => process.env[flag]);
  for (const flag of flags) process.env[flag] = "1";
  vi.resetModules();
  try {
    const { compile: compileDiag } = await import("../src/index.js");
    return await compileDiag(body, scriptOptions("standalone"));
  } finally {
    flags.forEach((flag, i) => {
      if (previous[i] === undefined) Reflect.deleteProperty(process.env, flag);
      else process.env[flag] = previous[i];
    });
    vi.resetModules();
  }
}

function moduleInit(result: Result) {
  return (result.irOutcomes ?? []).find((outcome) => outcome.displayName === "<module-init>");
}

async function runsClean(result: Result): Promise<void> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  (result.importObject as { __setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.__setInstance?.(instance);
  expect(() => (instance.exports.__module_init as () => void)()).not.toThrow();
}

/** node runs the body in a fresh realm: a row that patches a prototype must not leak into the next. */
function nodeRunsClean(body: string): void {
  expect(() => runInNewContext(body, {})).not.toThrow();
}

/** The post-claim errors of `<module-init>`, the unit this lever claims. */
function moduleInitPostClaimErrors(result: Result) {
  return (result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>");
}

const ROWS: Record<string, { readonly make: string; readonly checks: string }> = {
  String: {
    make: 'new String("abc")',
    checks: `
      if (typeof w !== "object") throw "typeof";
      if (w !== w) throw "identity";
      if (w === "abc") throw "=== primitive";
      if (w != "abc") throw "!=";
      if (!(w == "abc")) throw "==";
      if (w + "d" !== "abcd") throw "+";
      if (!w) throw "truthy";
      if (w - 1 === w - 1) throw "NaN";`,
  },
  Number: {
    make: "new Number(1)",
    checks: `
      if (typeof w !== "object") throw "typeof";
      if (w === 1) throw "=== primitive";
      if (w != 1) throw "!=";
      if (w + 1 !== 2) throw "+";
      if (w * 3 !== 3 || -w !== -1 || w % 2 !== 1 || (w & 3) !== 1) throw "arith";
      if (!(w < 2) || !(w >= 1)) throw "relational";
      w++;
      if (w !== 2) throw "w++ is the number 2";`,
  },
  "Boolean(false)": {
    make: "new Boolean(false)",
    checks: `
      if (!w) throw "a Boolean(false) object is truthy";
      var r = 0; if (w) r = 1;
      if (r !== 1) throw "if";
      if (typeof w !== "object") throw "typeof";
      if (w != false) throw "!= false";
      if (w + 1 !== 1) throw "+";
      w--;
      if (w !== -1) throw "w--";`,
  },
};

describe("#7340 — a stored wrapper is claimed and answers as node", () => {
  for (const [name, { make, checks }] of Object.entries(ROWS)) {
    const body = `var w = ${make};${checks}`;
    it(`node agrees: ${name}`, () => nodeRunsClean(body));

    for (const [shape, source] of [
      ["bare", body],
      ["harnessed", harnessed(body)],
    ] as const) {
      it(`standalone, ${shape}: ${name} stored in a script var lowers on the IR and passes`, async () => {
        const result = await compileScript(source);
        expect(moduleInit(result)?.irBodyEmitted).toBe(true);
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        await runsClean(result);
      }, 60_000);
    }
  }

  it("standalone: a plain `=` store after `var w;` lowers on the IR", async () => {
    const body = `var w; w = new Number(5); if (w - 5 !== 0) throw "x";`;
    nodeRunsClean(body);
    const result = await compileScript(body);
    expect(moduleInit(result)?.irBodyEmitted).toBe(true);
    await runsClean(result);
  }, 60_000);

  it("standalone: a top-level function reads the var through an operator", async () => {
    const body = `var w = new Number(2); function f() { return w * 3; } if (f() !== 6) throw "x";`;
    nodeRunsClean(body);
    const result = await compileScript(body);
    expect(moduleInit(result)?.irBodyEmitted).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    await runsClean(result);
  }, 60_000);
});

describe("#7340 — every other position is refused at select, never withdrawn", () => {
  // Each row: the reason the store is refused with, and a body whose only
  // difference from an admitted one is that position. Each still passes (legacy).
  // `runsClean: false`: the program fails the same way on main, so the row pins
  // only that this lever refuses `<module-init>`. Either legacy's own answer
  // differs from node's (a source `function String` is not the constructor
  // legacy calls), or a top-level function main already claims on its own
  // answers wrong (`f` reads the dynamic var; recorded in the issue).
  const rows: Record<string, { readonly reason: string; readonly body: string; readonly runsClean?: boolean }> = {
    "a String wrapper's own `length` (answered wrong)": {
      reason: "expr-new-wrapper-use",
      body: `var s = new String("abc"); if (s.length !== 3) throw "x";`,
    },
    "an inherited method read (answered wrong)": {
      reason: "expr-new-wrapper-use",
      body: `var s = new String("abc"); if (typeof s.valueOf !== "function") throw "x";`,
    },
    "an Object.prototype method read (answered wrong)": {
      reason: "expr-new-wrapper-use",
      body: `var b = new Boolean(true); if (typeof b.hasOwnProperty !== "function") throw "x";`,
    },
    "a missing member read": {
      reason: "expr-new-wrapper-use",
      body: `var n = new Number(1); if (n.zz !== undefined) throw "x";`,
    },
    "a Number wrapper's relational operand against a string (answered wrong)": {
      reason: "expr-new-wrapper-use",
      body: `var n = new Number(1); if (!(n < "9")) throw "x";`,
    },
    "a String wrapper's relational operand (compared numerically)": {
      reason: "expr-new-wrapper-use",
      body: `var s = new String("a"); if (!(s < "b")) throw "x";`,
    },
    "a String wrapper's relational operand, inside a function": {
      reason: "expr-new-wrapper-use",
      body: `var s = new String("10"); function f() { return s < "9"; } if (!f()) throw "x";`,
      runsClean: false,
    },
    "a use before the store (post-claim error)": {
      reason: "expr-new-wrapper-use",
      body: `var r = n + 1; var n = new Number(5); if (r === r) throw "x";`,
    },
    "a function returning a member value": {
      reason: "expr-new-wrapper-use",
      body: `var s = new String("abc"); function f() { return s.length; } if (f() !== 3) throw "x";`,
      runsClean: false,
    },
    "element read (answers wrong for a String wrapper)": {
      reason: "expr-new-wrapper-use",
      body: `var w = new String("abc"); if (w[0] !== "a") throw "x";`,
    },
    "void operand (withdrawn: undefined compare on f64)": {
      reason: "expr-new-wrapper-use",
      body: `var w = new Boolean(true); if (void w !== undefined) throw "x";`,
    },
    "loose == null (withdrawn: bare null)": {
      reason: "expr-new-wrapper-use",
      body: `var w = new Number(1); if (w == null) throw "x";`,
    },
    "switch discriminant (withdrawn)": {
      reason: "expr-new-wrapper-use",
      body: `var w = new Number(1); switch (w) { case 1: throw "x"; }`,
    },
    "method call": {
      reason: "expr-new-wrapper-use",
      body: `var w = new Number(1); if (w.toString() !== "1") throw "x";`,
    },
    "call argument": {
      reason: "expr-new-wrapper-use",
      body: `function f(x) { return x + ""; } var w = new Number(1); if (f(w) !== "1") throw "x";`,
    },
    alias: {
      reason: "expr-new-wrapper-use",
      body: `var w = new Number(1); var t = w; if (t - 1 !== 0) throw "x";`,
    },
    "template substitution": {
      reason: "expr-new-wrapper-use",
      body: 'var w = new Number(1); if (`${w}` !== "1") throw "x";',
    },
    "for-in, in, instanceof, delete": {
      reason: "expr-new-wrapper-use",
      body: `var w = new String("ab"); var n = 0; for (var k in w) n++;
        if (n !== 2 || !("length" in w) || !(w instanceof String) || !delete w.x) throw "x";`,
    },
    "a user `function String` in the file": {
      reason: "expr-new-wrapper-realm",
      body: `var w = new String("abc"); if (w.v !== "abc") throw "x"; function String(v) { this.v = v; }`,
      runsClean: false,
    },
    "`String` reassigned": {
      reason: "expr-new-wrapper-realm",
      body: `var keep = String; String = keep; var w = new String("abc"); if (w + "" !== "abc") throw "x";`,
    },
    "a parameter named `Number` anywhere in the file": {
      reason: "expr-new-wrapper-realm",
      body: `function g(Number) { return Number; } var w = new Number(1); if (w - 1 !== 0) throw "x";`,
    },
    "`Number.prototype.valueOf` patched": {
      reason: "expr-new-wrapper-realm",
      body: `Number.prototype.valueOf = function () { return 7; }; var w = new Number(1); if (w + 1 !== 8) throw "x";`,
    },
    "eval in the file": {
      reason: "expr-new-wrapper-realm",
      body: `eval("1"); var w = new Number(1); if (w - 1 !== 0) throw "x";`,
    },
    "an argument of another family (S2)": {
      reason: "expr-new-wrapper-argument",
      body: `var w = new String(1); if (w + "" !== "1") throw "x";`,
    },
    "two arguments": {
      reason: "expr-new-wrapper-argument",
      body: `var w = new Number(1, 2); if (w - 1 !== 0) throw "x";`,
    },
    "`new String(null)`": {
      reason: "expr-new-wrapper-argument",
      body: `var w = new String(null); if (w + "" !== "null") throw "x";`,
    },
    "a function-local var": {
      reason: "expr-new-wrapper-home",
      body: `function f() { var w = new Number(1); return w - 1; } if (f() !== 0) throw "x";`,
    },
  };

  // Not a store: the lever does not apply, and the selector keeps main's arm
  // (#7106 pins `expr-new-ctor-unknown` for an operand `new String()`).
  it("a construction outside store position keeps main's refusal", async () => {
    const body = `var r = [new Number(1)]; if (r[0] - 1 !== 0) throw "x";`;
    nodeRunsClean(body);
    const result = await compileWithArms(body);
    const details = (result.irOutcomes ?? []).map((o) => o.detail ?? "").join("\n");
    expect(details).not.toMatch(/expr-new-wrapper-/);
    expect(moduleInit(result)?.irBodyEmitted).not.toBe(true);
    await runsClean(result);
  }, 60_000);

  for (const [name, { reason, body, runsClean: clean = true }] of Object.entries(rows)) {
    it(`${name}: refused (${reason})`, async () => {
      if (clean) nodeRunsClean(body);
      const result = await compileWithArms(body);
      const refusals = (result.irOutcomes ?? []).filter((o) => !o.irBodyEmitted && o.stage === "select");
      expect(refusals.map((o) => o.detail).join("\n")).toMatch(new RegExp(`(^|@|\\n)${reason}:NewExpression`));
      expect(moduleInitPostClaimErrors(result)).toEqual([]);
      if (clean) await runsClean(result);
    }, 60_000);
  }
});

describe("#7340 — the lane", () => {
  it("wasi: the store is refused at select (no dynamic-home carrier lane)", async () => {
    const result = await compileScript(`var w = new Number(1); if (w - 1 !== 0) throw "x";`, "wasi");
    const init = moduleInit(result);
    expect(init?.irBodyEmitted).not.toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  }, 60_000);

  it("a lane without native-dynamic-member-read, or without the open-object option, refuses the store", () => {
    const file = ts.createSourceFile("t.js", "var w = new Number(1);", ts.ScriptTarget.ES2020, true);
    const statement = file.statements[0] as ts.VariableStatement;
    const expr = statement.declarationList.declarations[0]!.initializer as ts.NewExpression;
    const stored = storedWrapperConstruction(expr, { isAmbient: () => true, isAmbientString: () => true })!;
    const resolver = Object.assign(() => ({ valueKind: { kind: "dynamic" } }), { isLibOnlyBinding: () => true });
    const lane = (member: boolean, openObject: boolean) => ({
      ...(openObject ? { isOpenObjectBinding: () => true } : {}),
      supportsBackendCapability: (capability: string) =>
        capability === "primitive-wrapper-to-primitive" || (member && capability === "native-dynamic-member-read"),
    });
    const refusal = (member: boolean, openObject: boolean) =>
      wrapperStoreRefusal(stored, lane(member, openObject) as never, resolver, () => "number");
    expect(refusal(false, true)).toBe("expr-new-wrapper-lane");
    expect(refusal(true, false)).toBe("expr-new-wrapper-lane");
    expect(refusal(true, true)).toBeUndefined();
  });
});
