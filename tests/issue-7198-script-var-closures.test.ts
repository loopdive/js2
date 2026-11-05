// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7198 — a script `var f = function () {}` at the top level of a standalone
// `<module-init>` (test262's `var print = function …` prelude) is planned as a
// member closure and stored into the binding's dynamic home, boxed into the
// carrier by the function-object producer. Every reference to the binding
// must pass it on as a value. Before, the selector refused every
// non-`const` closure initializer (`vardecl-let-closure`), so the whole
// `<module-init>` fell back to legacy. Shapes the planner does not prove stay
// refused at select: nothing is claimed and then withdrawn.

import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

const OPTIONS = {
  target: "standalone",
  allowJs: true,
  fileName: "test.js",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

const HARNESS = `/** @returns {void} */ function assert(mustBeTrue, message) { if (mustBeTrue === true) return; throw message; }
assert.throws = function (expected, func, message) { try { func(); } catch (thrown) { if (thrown !== expected) throw "wrong"; return; } throw "no throw"; };
`;

function initRow(result: CompileResult) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === "<module-init>");
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function observe(result: CompileResult): Promise<"ok" | "threw"> {
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  try {
    (instance.exports.__module_init as () => void)();
    return "ok";
  } catch (error) {
    // A trap is a miscompile, never a JS throw.
    expect(error).toBeInstanceOf(WebAssembly.Exception);
    return "threw";
  }
}

function node(source: string): "ok" | "threw" {
  try {
    new Function(source)();
    return "ok";
  } catch {
    return "threw";
  }
}

const CLAIMED: readonly [name: string, body: string][] = [
  ["the closure passed as a callback", `var f = function () { throw "x"; };\nassert.throws("x", f);`],
  [
    "a read of the hoisted binding before its store",
    `assert(typeof f === "undefined", "u");\nvar f = function () { throw "x"; };\nassert.throws("x", f);`,
  ],
  ["a callback that does not throw", `var f = function () { void 0; };\nassert.throws("x", f);`],
];

const REFUSED: readonly [name: string, body: string][] = [
  // The boxed carrier is not legacy's function object: a member read or write
  // on the binding would see a different object (#7198 review).
  ["a `name` read on the binding", `var f = function () { throw "x"; };\nassert(f.name === "f", "name");`],
  ["a property write on the binding", `var f = function () { throw "x"; };\nf.p = 1;\nassert(f.p === 1, "p");`],
  [
    "a direct call from a nested closure",
    `var f = function () { throw "x"; };\nassert.throws("x", function () { f(); });`,
  ],
  ["a top-level direct call", `var f = function () { throw "x"; };\nf();`],
  [
    "a reassigned binding",
    `var f = function () { throw "x"; };\nf = function () { throw "y"; };\nassert.throws("y", f);`,
  ],
];

describe("#7198 — script var closures in the dynamic home", () => {
  it.each(CLAIMED)(
    "claims %s, matching node and legacy",
    async (_name, body) => {
      const source = HARNESS + body + "\n";
      const expected = node(source);
      const ir = await compile(source, OPTIONS);
      expect(initRow(ir)).toMatchObject({ irBodyEmitted: true, kind: "emitted" });
      expect(await observe(ir)).toBe(expected);
      const legacy = await compile(source, { ...OPTIONS, experimentalIR: false });
      expect(await observe(legacy)).toBe(expected);
    },
    60_000,
  );

  it.each(REFUSED)(
    "keeps %s refused at select",
    async (_name, body) => {
      const source = HARNESS + body + "\n";
      const result = await compile(source, OPTIONS);
      expect(initRow(result)).toMatchObject({ irBodyEmitted: false, stage: "select" });
      expect(await observe(result)).toBe(node(source));
    },
    60_000,
  );
});
