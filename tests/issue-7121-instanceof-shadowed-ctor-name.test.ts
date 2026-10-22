// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7121) `v instanceof F` where `F` is a parameter / local that SHADOWS a
 * module-level function, class or builtin constructor name.
 *
 * The legacy dispatch keyed the RHS by name, so the shadowing binding was
 * answered as the top-level `F`: a wrong `false` for `probe([], Array)`, and
 * with the IR path on a compile error ("ABI draft … function-value-trampoline
 * … would mutate sealed prepared scope"). Every case is compared to node.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const LANES = [
  { target: "standalone", experimentalIR: false },
  { target: "standalone", experimentalIR: true },
  { target: undefined, experimentalIR: false },
  { target: undefined, experimentalIR: true },
] as const;

async function runLane(source: string, lane: (typeof LANES)[number]): Promise<number> {
  const result = await compile(source, {
    target: lane.target,
    experimentalIR: lane.experimentalIR,
    fileName: "issue-7121.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  const exports = instance.exports as { __module_init?: () => void; run: () => number };
  exports.__module_init?.();
  return exports.run();
}

function runNode(source: string): number {
  return new Function(`${source.replace(/^\s*export /gm, "")}\nreturn run();`)() as number;
}

const SCORE = `(a, b, c, d, e) => (a ? 1 : 0) + (b ? 10 : 0) + (c ? 100 : 0) + (d ? 1000 : 0) + (e ? 10000 : 0)`;

const CASES: Record<string, string> = {
  "parameter shadows a top-level function constructor (the #7121 repro)": `
    function F() {}
    function probe(v, F) { return v instanceof F; }
    export function run() {
      var score = ${SCORE};
      return score(probe(new F(), F), probe({}, F), probe([], Object), probe({}, Array), probe([], Array));
    }`,
  "parameter shadows a top-level class": `
    class A {}
    function probe(v, A) { return v instanceof A; }
    export function run() {
      var score = ${SCORE};
      // \`probe(new A(), A)\` is left out: a CLASS value reaching the generic
      // operator answers false on every lane even unshadowed (\`function
      // probe(v, C)\`) — a separate gap of the dynamic path, not of #7121.
      return score(probe(new A(), Object), probe({}, A), probe([], Object), probe({}, Array), probe([], Array));
    }`,
  "parameter shadows a builtin constructor name": `
    function F() {}
    function probe(v, Object) { return v instanceof Object; }
    export function run() {
      var score = ${SCORE};
      return score(probe(new F(), F), probe({}, F), probe([], Array), probe({}, Array), probe(new F(), Object));
    }`,
  "local var shadows a top-level function constructor": `
    function F() {}
    function G() {}
    function probe(v, which) { var F = which ? G : Array; return v instanceof F; }
    export function run() {
      var score = ${SCORE};
      return score(probe(new G(), true), probe(new F(), true), probe([], false), probe({}, false), probe(new G(), false));
    }`,
  "unshadowed top-level constructor keeps its static arm": `
    function F() {}
    function probe(v) { return v instanceof F; }
    export function run() {
      var score = ${SCORE};
      return score(probe(new F()), probe({}), probe([]), probe(Object.create(F.prototype)), probe(null));
    }`,
};

describe("#7121 — instanceof on a binding that shadows a constructor name", () => {
  for (const [name, source] of Object.entries(CASES)) {
    it(name, async () => {
      const expected = runNode(source);
      for (const lane of LANES) {
        expect(await runLane(source, lane), `${lane.target ?? "gc"} ir=${lane.experimentalIR}`).toBe(expected);
      }
    });
  }
});
