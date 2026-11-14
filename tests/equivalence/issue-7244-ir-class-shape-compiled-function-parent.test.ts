// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7244 — `class X extends F` where `F` is a compiled top-level function
// constructor (the test262 harness `Iterator` shim, `function Iterator() {}`
// with `.prototype = %IteratorPrototype%`). Legacy lays such a class out as a
// ROOT struct (the #3123 fnctor arm), so `buildIrClassShapes` now projects it
// flat, like the #7241 lib-interface case, and the selector may claim its own
// `super`-free instance methods. The constructor (it calls `super()` into F),
// accessors and `super`-using methods stay legacy.
//
// Each case asserts the route (`trackIrOutcomes`) per lane and the result on
// all three lanes against the JS evaluation of the same source.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions; ir: boolean }[] = [
  { name: "standalone", options: { target: "standalone" }, ir: true },
  // WASI keeps `new MyErr()` itself on legacy (no S3c value plan), so the
  // method stays legacy there; base gives the same.
  // (#6979 S7-c) WASI lowers with the native semantic regime and takes the IR body.
  { name: "wasi", options: { target: "wasi" }, ir: true },
  { name: "gc (default)", options: {}, ir: true },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

/** The harness `Iterator` shim and a self-guarded `Test262Error`-shaped constructor. */
const PRELUDE = `
function Iterator() {}
Iterator.prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
function MyErr(message) {
  if (!(this instanceof MyErr)) return new MyErr(message);
  this.message = message || "";
}
`;

async function compileAndRun(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7244.js", trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance =
    options.target === "standalone"
      ? (await WebAssembly.instantiate(result.binary, {})).instance
      : options.target === "wasi"
        ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
        : await instantiateWithRuntime(result);
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return { result, exports };
}

interface Case {
  readonly source: string;
  /** Units that take the IR body on the lanes marked `ir`. */
  readonly irUnits: readonly string[];
  /** Units that never take the IR body (an implicit constructor reports no unit at all). */
  readonly legacyUnits: readonly string[];
}

const CASES: Record<string, Case> = {
  "a `throw new F()` method of a class extending the harness Iterator": {
    source: `
class X extends Iterator {
  next() { throw new MyErr("n"); }
}
export function test() {
  try { new X().next(); return 0; } catch (e) { return (e instanceof MyErr ? 1 : 2) + (e.message === "n" ? 10 : 0); }
}`,
    irUnits: ["X_next"],
    legacyUnits: ["X_new"],
  },
  "an explicit constructor, a `get next` accessor and a `super` user stay legacy": {
    source: `
class X extends Iterator {
  constructor() { super(); }
  get next() { throw new MyErr("g"); }
  return() { throw new MyErr("r"); }
  s() { return super.constructor === Iterator ? 1 : 2; }
}
export function test() {
  var r = 0;
  var x = new X();
  try { x.next; } catch (e) { r += e.message === "g" ? 1 : 2; }
  try { x.return(); } catch (e) { r += e instanceof MyErr && e.message === "r" ? 10 : 20; }
  return r + x.s() * 100;
}`,
    irUnits: ["X_return"],
    legacyUnits: ["X_new", "X_get_next", "X_s"],
  },
  "a user-declared function parent without a prototype assignment": {
    source: `
function F() {}
class X extends F { m() { throw new MyErr("f"); } }
export function test() { try { new X().m(); return 0; } catch (e) { return e instanceof MyErr && e.message === "f" ? 1 : 2; } }`,
    irUnits: ["X_m"],
    legacyUnits: ["X_new"],
  },
};

describe("#7244 IR class shape for a compiled-function-constructor parent", () => {
  for (const [title, c] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${title} [${lane.name}]`, async () => {
        const source = PRELUDE + c.source;
        const { result, exports } = await compileAndRun(source, lane.options);
        const outcomes = result.irOutcomes ?? [];
        const kindOf = (unit: string) => outcomes.find((o) => o.displayName === unit)?.kind;
        for (const unit of c.irUnits) {
          expect(kindOf(unit), `${unit} route`).toBe(lane.ir ? "emitted" : "unsupported");
        }
        for (const unit of c.legacyUnits) expect(kindOf(unit), `${unit} route`).not.toBe("emitted");
        expect(outcomes.some((o) => o.kind === "invariant")).toBe(false);
        expect(exports.test!()).toBe(evaluateAsJs(source).test!());
      });
    }
  }
});
