// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7346 — a script `var` on the string home is an ordinary string value where
// `module-binding-string.ts` proves its read sees a written string; the
// expression arms then judge it like a local string. Step A refuses at select
// the string uses from-ast cannot lower (`select-string-uses.ts`), for local
// and module strings alike. The JS environment keeps main's routing.
import { afterAll, describe, expect, it, vi } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

const previousEnv = vi.hoisted(() => {
  const names = ["JS2WASM_IR_SHAPE_DIAG", "JS2WASM_IR_MODULE_INIT_ALL_REJECTS"] as const;
  const previous = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) process.env[name] = "1";
  return previous;
});
afterAll(() => {
  for (const [name, value] of previousEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

type Verdict = "ok" | "threw" | "trap";

async function build(source: string, target: "standalone" | "gc", experimentalIR = true): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-7346.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal: true,
    deferTopLevelInit: true,
    trackIrOutcomes: true,
    experimentalIR,
    ...(target === "standalone" ? { target: "standalone" } : {}),
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function run(result: CompileResult): Promise<Verdict> {
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as () => void)();
    return "ok";
  } catch (error) {
    return error instanceof WebAssembly.RuntimeError ? "trap" : "threw";
  }
}

function node(source: string): Verdict {
  try {
    new Function(source)();
    return "ok";
  } catch {
    return "threw";
  }
}

const outcome = (result: CompileResult, name: string) =>
  (result.irOutcomes ?? []).find((row) => row.displayName === name);

/** Every unit is IR and the script passes exactly when the string behaves as JS says. */
const CLAIMED: Record<string, string> = {
  typeof: `var s = String(1); if (typeof s !== "string") { throw "t"; }`,
  "strict compare": `var s = String(1); if (s !== "1") { throw "n"; }`,
  ".length": `var s = String(1); if (s.length !== 1) { throw "l"; }`,
  concatenation: `var s = String(1); var t = " " + s + " "; if (t !== " 1 ") { throw "c"; }`,
  charAt: `var s = "ab"; if (s.charAt(1) !== "b") { throw "c"; }`,
  relational: `var s = "ab"; var u = "b"; if (!(s < u)) { throw "r"; }`,
  switch: `var s = "b"; var r = 0; switch (s) { case "a": r = 1; break; case "b": r = 2; break; } if (r !== 2) { throw "s"; }`,
  "a literal index below the literal's length": `var s = "ab"; if (s[1] !== "b") { throw "e"; }`,
  "rewritten with strings, in a function too": `var s = "ab"; function w() { s = "zz"; } s = "cd"; w(); if (s !== "zz") { throw "w"; }`,
  "a typeof in the branch typeof excludes": `var s = "ab"; if (typeof s !== "string") { throw "x" + typeof s; }`,
  "a key of an open object": `var o = {}; Object.defineProperty(o, "p", { value: 1 }); var k = "p"; if (o[k] !== 1) { throw "k"; }`,
};

/** The read keeps the opaque-reference discipline (or a step A rule): refused at select, never withdrawn. */
const REFUSED: Record<string, { readonly source: string; readonly unit: string; readonly detail: string }> = {
  "a read inside a function": {
    source: `var s = "ab"; function f() { return s.length; } if (f() !== 2) { throw "f"; }`,
    unit: "f",
    detail: "expr-module-extern-consumer",
  },
  "no initializer": {
    source: `var s; s = "ab"; var t = s + "c"; if (t.length !== 3) { throw "t"; }`,
    unit: "<module-init>",
    detail: "expr-module-extern-consumer",
  },
  "a write that reads a dynamic var": {
    source: `var d; d = "ab"; var r = " " + d + " "; if (r !== " ab ") { throw "r"; }`,
    unit: "<module-init>",
    detail: "expr-module-extern-consumer",
  },
  "a read narrowed away by typeof": {
    source: `var s = "ab"; if (typeof s !== "string") { throw "x" + s; }`,
    unit: "<module-init>",
    detail: "expr-module-extern-consumer",
  },
  // Step A: string uses from-ast does not lower.
  ".constructor": {
    source: `var s = "ab"; if (s.constructor !== String) { throw "c"; }`,
    unit: "<module-init>",
    detail: "expr-string-member-read",
  },
  "== null": {
    source: `var s = "ab"; if (s == null) { throw "n"; }`,
    unit: "<module-init>",
    detail: "expr-string-null-compare",
  },
  "an index the literal length does not prove": {
    source: `var s = ""; if (s[0] !== undefined) { throw "e"; }`,
    unit: "<module-init>",
    detail: "expr-string-element-read",
  },
  "a local string's member read": {
    source: `function g() { var a = "".toLowerCase(); var b = ""; if (a.index !== b.index) throw "g"; } g();`,
    unit: "g",
    detail: "expr-string-member-read",
  },
};

describe("#7346 — a string module binding is an ordinary string value at its uses", () => {
  for (const [name, source] of Object.entries(CLAIMED)) {
    it(`claims every unit and runs as JS: ${name}`, async () => {
      expect(node(source)).toBe("ok");
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      for (const row of ir.irOutcomes ?? []) {
        if (row.kind !== "non-executable") expect(row.irBodyEmitted, JSON.stringify(row)).toBe(true);
      }
      expect(await run(ir)).toBe("ok");
    });
  }

  for (const [name, { source, unit, detail }] of Object.entries(REFUSED)) {
    it(`refuses at select and matches legacy: ${name}`, async () => {
      const ir = await build(source, "standalone");
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      const row = outcome(ir, unit);
      expect(row).toMatchObject({ stage: "select", irBodyEmitted: false });
      expect(row?.detail).toContain(detail);
      expect(await run(ir)).toBe(await run(await build(source, "standalone", false)));
    });
  }

  it("keeps the JS environment's routing: the module string stays an opaque reference there", async () => {
    const ir = await build(CLAIMED.typeof!, "gc");
    expect(outcome(ir, "<module-init>")).toMatchObject({ stage: "select", irBodyEmitted: false });
    expect(outcome(ir, "<module-init>")?.detail).toContain("expr-module-extern-consumer");
  });
});
