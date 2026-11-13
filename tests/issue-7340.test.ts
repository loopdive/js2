// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7340 S1 — `var w = new String("abc")` (and `Number`, `Boolean`) stored into a
// script var on the dynamic module home is a carrier value on the IR path.
//
// On main every such `<module-init>` refused at select (`expr-new-ctor-unknown`).
// Now the construction is claimed when every use of the var is one the dynamic
// arms answer correctly; any other use keeps the unit legacy, refused at select
// — never claimed and then withdrawn. Each row is checked against node.
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

async function compileScript(body: string, target: "standalone" | "wasi" = "standalone"): Promise<Result> {
  return compile(harnessed(body), scriptOptions(target));
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
    return await compileDiag(harnessed(body), scriptOptions("standalone"));
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

/** node runs the same body against a throwing `Test262Error`. */
function nodeRunsClean(body: string): void {
  expect(() => new Function("Test262Error", body)(Error)).not.toThrow();
}

const ROWS: Record<string, { readonly make: string; readonly checks: string }> = {
  String: {
    make: 'new String("abc")',
    checks: `
      if (typeof w !== "object") throw new Test262Error("typeof " + typeof w);
      if (w !== w) throw new Test262Error("identity");
      if (w === "abc") throw new Test262Error("=== primitive");
      if (w != "abc") throw new Test262Error("!= " + w);
      if (!(w == "abc")) throw new Test262Error("==");
      if (w + "d" !== "abcd") throw new Test262Error("+ " + (w + "d"));
      if (w.length !== 3) throw new Test262Error("length");
      if (w.constructor !== String) throw new Test262Error("constructor");
      if (!w) throw new Test262Error("truthy");
      if (w - 1 === w - 1) throw new Test262Error("NaN");`,
  },
  Number: {
    make: "new Number(1)",
    checks: `
      if (typeof w !== "object") throw new Test262Error("typeof");
      if (w === 1) throw new Test262Error("=== primitive");
      if (w != 1) throw new Test262Error("!=");
      if (w + 1 !== 2) throw new Test262Error("+");
      if (w * 3 !== 3 || -w !== -1 || w % 2 !== 1 || (w & 3) !== 1) throw new Test262Error("arith");
      if (!(w < 2) || !(w >= 1)) throw new Test262Error("relational");
      if (w.constructor !== Number) throw new Test262Error("constructor");
      w++;
      if (w !== 2) throw new Test262Error("w++ is the number 2: " + w);`,
  },
  "Boolean(false)": {
    make: "new Boolean(false)",
    checks: `
      if (!w) throw new Test262Error("a Boolean(false) object is truthy");
      var r = 0; if (w) r = 1;
      if (r !== 1) throw new Test262Error("if");
      if (typeof w !== "object") throw new Test262Error("typeof");
      if (w != false) throw new Test262Error("!= false");
      if (w + 1 !== 1) throw new Test262Error("+");
      w--;
      if (w !== -1) throw new Test262Error("w-- " + w);`,
  },
};

describe("#7340 — a stored wrapper is claimed and answers as node", () => {
  for (const [name, { make, checks }] of Object.entries(ROWS)) {
    const body = `var w = ${make};${checks}`;
    it(`node agrees: ${name}`, () => nodeRunsClean(body));

    it(`standalone: ${name} stored in a script var lowers on the IR and passes`, async () => {
      const result = await compileScript(body);
      expect(moduleInit(result)?.irBodyEmitted).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      await runsClean(result);
    }, 60_000);
  }

  it("standalone: a plain `=` store after `var w;` lowers on the IR", async () => {
    const body = `var w; w = new Number(5); if (w - 5 !== 0) throw new Test262Error("x");`;
    nodeRunsClean(body);
    const result = await compileScript(body);
    expect(moduleInit(result)?.irBodyEmitted).toBe(true);
    await runsClean(result);
  }, 60_000);
});

describe("#7340 — every other position is refused at select, never withdrawn", () => {
  // Each row: the reason the store is refused with, and a body whose only
  // difference from an admitted one is that position. Each still passes (legacy).
  // `legacyAsNode: false`: legacy's own answer differs from node's, as on main (a
  // source `function String` is not the constructor legacy calls) — the row
  // pins only that the IR refuses.
  const rows: Record<string, { readonly reason: string; readonly body: string; readonly legacyAsNode?: boolean }> = {
    "element read (answers wrong for a String wrapper)": {
      reason: "expr-new-wrapper-use",
      body: `var w = new String("abc"); if (w[0] !== "a") throw new Test262Error("x");`,
    },
    "void operand (withdrawn: undefined compare on f64)": {
      reason: "expr-new-wrapper-use",
      body: `var w = new Boolean(true); if (void w !== undefined) throw new Test262Error("x");`,
    },
    "loose == null (withdrawn: bare null)": {
      reason: "expr-new-wrapper-use",
      body: `var w = new Number(1); if (w == null) throw new Test262Error("x");`,
    },
    "switch discriminant (withdrawn)": {
      reason: "expr-new-wrapper-use",
      body: `var w = new Number(1); switch (w) { case 1: throw new Test262Error("x"); }`,
    },
    "member value stored into a binding (withdrawn: typed global)": {
      reason: "expr-new-wrapper-use",
      body: `var w = new String("abc"); var n = w.length; if (n !== 3) throw new Test262Error("x");`,
    },
    "method call": {
      reason: "expr-new-wrapper-use",
      body: `var w = new Number(1); if (w.toString() !== "1") throw new Test262Error("x");`,
    },
    "call argument": {
      reason: "expr-new-wrapper-use",
      body: `function f(x) { return x + ""; } var w = new Number(1); if (f(w) !== "1") throw new Test262Error("x");`,
    },
    alias: {
      reason: "expr-new-wrapper-use",
      body: `var w = new Number(1); var t = w; if (t - 1 !== 0) throw new Test262Error("x");`,
    },
    "template substitution": {
      reason: "expr-new-wrapper-use",
      body: 'var w = new Number(1); if (`${w}` !== "1") throw new Test262Error("x");',
    },
    "for-in, in, instanceof, delete": {
      reason: "expr-new-wrapper-use",
      body: `var w = new String("ab"); var n = 0; for (var k in w) n++;
        if (n !== 2 || !("length" in w) || !(w instanceof String) || !delete w.x) throw new Test262Error("x");`,
    },
    "a user `function String` in the file": {
      reason: "expr-new-wrapper-realm",
      body: `var w = new String("abc"); if (w.v !== "abc") throw new Test262Error("x"); function String(v) { this.v = v; }`,
      legacyAsNode: false,
    },
    "`String` reassigned": {
      reason: "expr-new-wrapper-realm",
      body: `var keep = String; String = keep; var w = new String("abc"); if (w + "" !== "abc") throw new Test262Error("x");`,
    },
    "a parameter named `Number` anywhere in the file": {
      reason: "expr-new-wrapper-realm",
      body: `function g(Number) { return Number; } var w = new Number(1); if (w - 1 !== 0) throw new Test262Error("x");`,
    },
    "eval in the file": {
      reason: "expr-new-wrapper-realm",
      body: `eval("1"); var w = new Number(1); if (w - 1 !== 0) throw new Test262Error("x");`,
    },
    "an argument of another family (S2)": {
      reason: "expr-new-wrapper-argument",
      body: `var w = new String(1); if (w + "" !== "1") throw new Test262Error("x");`,
    },
    "two arguments": {
      reason: "expr-new-wrapper-argument",
      body: `var w = new Number(1, 2); if (w - 1 !== 0) throw new Test262Error("x");`,
    },
    "`new String(null)`": {
      reason: "expr-new-wrapper-argument",
      body: `var w = new String(null); if (w + "" !== "null") throw new Test262Error("x");`,
    },
    "a function-local var": {
      reason: "expr-new-wrapper-home",
      body: `function f() { var w = new Number(1); return w - 1; } if (f() !== 0) throw new Test262Error("x");`,
    },
  };

  // Not a store: the lever does not apply, and the selector keeps main's arm
  // (#7106 pins `expr-new-ctor-unknown` for an operand `new String()`).
  it("a construction outside store position keeps main's refusal", async () => {
    const body = `var r = [new Number(1)]; if (r[0] - 1 !== 0) throw new Test262Error("x");`;
    nodeRunsClean(body);
    const result = await compileWithArms(body);
    const details = (result.irOutcomes ?? []).map((o) => o.detail ?? "").join("\n");
    expect(details).not.toMatch(/expr-new-wrapper-/);
    expect(moduleInit(result)?.irBodyEmitted).not.toBe(true);
    await runsClean(result);
  }, 60_000);

  for (const [name, { reason, body, legacyAsNode = true }] of Object.entries(rows)) {
    it(`${name}: refused (${reason}) and still passes`, async () => {
      nodeRunsClean(body);
      const result = await compileWithArms(body);
      const refusals = (result.irOutcomes ?? []).filter((o) => !o.irBodyEmitted && o.stage === "select");
      expect(refusals.map((o) => o.detail).join("\n")).toMatch(new RegExp(`(^|@|\\n)${reason}:NewExpression`));
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      if (legacyAsNode) await runsClean(result);
    }, 60_000);
  }
});

describe("#7340 — the lane", () => {
  it("wasi: the store is refused at select (no dynamic-home carrier lane)", async () => {
    const result = await compileScript(`var w = new Number(1); if (w - 1 !== 0) throw new Test262Error("x");`, "wasi");
    const init = moduleInit(result);
    expect(init?.irBodyEmitted).not.toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  }, 60_000);

  it("a lane without native-dynamic-member-read refuses the store", () => {
    const file = ts.createSourceFile("t.js", "var w = new Number(1);", ts.ScriptTarget.ES2020, true);
    const statement = file.statements[0] as ts.VariableStatement;
    const expr = statement.declarationList.declarations[0]!.initializer as ts.NewExpression;
    const stored = storedWrapperConstruction(expr, { isAmbient: () => true, isAmbientString: () => true })!;
    const resolver = Object.assign(() => ({ valueKind: { kind: "dynamic" } }), { isLibOnlyBinding: () => true });
    const lane = (member: boolean) => ({
      dynamicHomeCarrierLane: true,
      supportsBackendCapability: (capability: string) =>
        capability === "primitive-wrapper-to-primitive" || (member && capability === "native-dynamic-member-read"),
    });
    const refusal = (member: boolean) => wrapperStoreRefusal(stored, lane(member) as never, resolver, () => "number");
    expect(refusal(false)).toBe("expr-new-wrapper-lane");
    expect(refusal(true)).toBeUndefined();
  });
});
