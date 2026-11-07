// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7243 — `new F(…)` / `x instanceof F` of a self-guarded top-level function
// constructor (the harness `Test262Error` shape) inside a class method.
//
// #7242 refused the S3c construct inside class bodies: a class member is
// always sealed as a prepared component, and that component cannot execute a
// legacy F's function-value accessor (`foreign-source-unit`) nor name the
// dynamic carrier ops (`late-preparation-unsupported`). A free function with the
// same body is withdrawn from the sealed population (`function-value-reference`)
// and compiles on the post-direct overlay. The member now gets the same route:
// the planner mints its S3c value plan and the member stays on the overlay.
//
// Each case asserts the IR route (`trackIrOutcomes`) and the result on all
// three lanes against the JS evaluation of the same source. (#6979 S7-c) WASI
// lowers with the native semantic regime, so it takes the IR body like
// standalone and gives the JS answer; the pre-flip `wasiValue` pins recorded
// WASI's old legacy divergence and are no longer consulted.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions; ir: boolean }[] = [
  { name: "standalone", options: { target: "standalone" }, ir: true },
  { name: "wasi", options: { target: "wasi" }, ir: true },
  { name: "gc (default)", options: {}, ir: true },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

/**
 * The harness shape, kept on the legacy body: the trailing `for…in` is a tail
 * the IR rejects, so `MyErr` itself always takes the direct backend and the
 * methods below really construct a legacy-compiled `F` (asserted per case).
 * It sits after the guard because the self-guarded-constructor recogniser
 * needs the guard as the first statement.
 */
const F = `
function MyErr(message) {
  if (!(this instanceof MyErr)) return new MyErr(message);
  this.message = message || "";
  for (var k in { a: 1 }) {}
}
MyErr.prototype.toString = function () { return "MyErr: " + this.message; };
`;

async function compileAndRun(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7243.js", trackIrOutcomes: true, ...options });
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
  /** Units that must take the IR body on every lane. */
  readonly irUnits: readonly string[];
}

const CASES: Record<string, Case> = {
  "instance method: throw new F()": {
    source: `
class C { m(x) { if (x) throw new MyErr("cm"); return 1; } }
export function test() {
  try { new C().m(1); return 0; } catch (e) { return (e instanceof MyErr ? 1 : 2) + (e.message === "cm" ? 10 : 0) + (String(e) === "MyErr: cm" ? 100 : 0); }
}`,
    irUnits: ["C_m"],
  },
  "instance method: return new F()": {
    source: `
class C {
  /** @returns {any} */
  m() { return new MyErr("r"); }
}
export function test() { var e = new C().m(); return (e instanceof MyErr ? 1 : 0) + (e.message === "r" ? 10 : 0) + (e.constructor === MyErr ? 100 : 0); }`,
    irUnits: ["C_m"],
  },
  "instance method: x instanceof F": {
    source: `
class C {
  /** @param {any} x @returns {number} */
  k(x) { return x instanceof MyErr ? 1 : 0; }
}
export function test() { var c = new C(); return c.k(new MyErr("i")) + c.k({}) * 10 + c.k(MyErr("j")) * 100; }`,
    irUnits: ["C_k"],
  },
  "static method: throw new F()": {
    source: `
class C { static s() { throw new MyErr("s"); } }
export function test() { try { C.s(); return 0; } catch (e) { return e instanceof MyErr && e.message === "s" ? 1 : 2; } }`,
    irUnits: ["C_s"],
  },
  "beside a getter and an async sibling, and a sibling that calls it": {
    source: `
class C {
  get g() { return 5; }
  async am() { return 1; }
  m() { throw new MyErr("x"); }
  n() { return this.g + 1; }
  o() { try { this.m(); } catch (e) { return this.n() + (e instanceof MyErr ? 10 : 20); } return 0; }
}
export function test() { return new C().o(); }`,
    irUnits: ["C_m"],
  },
  "a subclass method": {
    source: `
class P { p() { return 1; } }
class D extends P { m() { throw new MyErr("d"); } }
export function test() { try { new D().m(); return 0; } catch (e) { return e instanceof MyErr ? 1 + new D().p() : 2; } }`,
    irUnits: ["D_m"],
  },
};

describe("#7243 class methods construct a self-guarded function constructor", () => {
  for (const [title, c] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${title} [${lane.name}]`, async () => {
        const source = F + c.source;
        const { result, exports } = await compileAndRun(source, lane.options);
        const outcomes = result.irOutcomes ?? [];
        expect(outcomes.find((o) => o.displayName === "MyErr")?.kind, "MyErr stays legacy").not.toBe("emitted");
        for (const unit of c.irUnits) {
          const kind = outcomes.find((o) => o.displayName === unit)?.kind;
          expect(kind, `${unit} route`).toBe(lane.ir ? "emitted" : "unsupported");
        }
        expect(outcomes.some((o) => o.kind === "unsupported" && o.code === "late-preparation-unsupported")).toBe(false);
        const expected = evaluateAsJs(source).test!();
        expect(exports.test!()).toBe(expected);
      });
    }
  }
});
