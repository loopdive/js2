// #4668 — a property read on a `number`/`boolean` PRIMITIVE must walk the
// wrapper prototype chain.
//
// On the campaign tip (2026-08-24) `(5).x` did not merely answer the wrong
// value: it emitted `finalizeStructAndDynamicMemberGet`'s terminal
// `ref.null.extern` WITHOUT compiling the receiver at all, so an accessor on
// `Object.prototype` was never invoked. Measured, one module per row:
//
//   | probe                                        | receiver type | before | after |
//   | `(5).x` with a getter on Object.prototype    | `number`      | null, getter NOT run | getter runs |
//   | `Object.prototype.z = 7; (5).z`              | `number`      | null   | 7     |
//   | `function f(v){return v.x}; f(5)`            | `any`         | 42     | 42    |
//   | `({}).x`                                     | object        | 42     | 42    |
//
// The `any`-typed row is why the fix is a DISPATCH arm and not a runtime
// change: `__extern_get` already serviced a boxed-primitive receiver correctly
// on the unmodified base.
//
// Every test here EXECUTES the read whose behaviour it guards (a getter that
// increments a counter, or a value that is read and compared), and the
// receiver in the loop test is loop-carried so no compile-time fold can answer
// without performing the read. The three CONTROL tests pin shapes the arm must
// NOT take over — they pass on both arms by construction, and their job is to
// fail if the arm's gates ever widen.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const OPTS = {
  target: "standalone",
  allowJs: true,
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
  hostBridge: "always",
  fileName: "test.ts",
} as const;

async function runStandalone(body: string, extra: Record<string, unknown> = {}): Promise<number> {
  const result: any = await compile(`export function test(): any { ${body} }`, { ...OPTS, ...extra } as any);
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports as any).test();
}

// The harness's `export function test()` makes TypeScript call every module
// here a MODULE, and module code is strict — which is the branch that hands the
// accessor the raw primitive. `inferModuleStrictArguments: false` is the same
// flag `tests/test262-runner.ts` passes for a `noStrict` script test; it is what
// lets these pins reach the SLOPPY branch at all.
const SLOPPY = { inferModuleStrictArguments: false } as const;

describe("#4668 — number/boolean primitive receivers walk the wrapper prototype chain", () => {
  it("an Object.prototype ACCESSOR is actually invoked for a primitive receiver", async () => {
    // `ran` is the discriminator the whole issue turned on: the base answered
    // `null` with the getter never entered, so a value-only assertion could not
    // tell "wrong value" from "never ran".
    expect(
      await runStandalone(
        `var ran = 0;` +
          ` Object.defineProperty(Object.prototype, "x", { get: function () { ran++; return 42; } });` +
          ` var n = 5; var v = n.x;` +
          ` return ran * 10 + (v === 42 ? 1 : 0);`,
      ),
    ).toBe(11);
  });

  it("§10.4.3 STRICT — the accessor receives the raw primitive", async () => {
    // `10.4.3-1-104` / `-106`.
    expect(
      await runStandalone(
        `Object.defineProperty(Object.prototype, "x", { get: function () { return this; } });` +
          ` var n = 5; return (n.x === 5 && typeof n.x === "number") ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("§10.4.3 SLOPPY — the accessor receives the WRAPPER object, not the primitive", async () => {
    // `10.4.3-1-105`, which was passing on the base for the wrong reason: it
    // asserts `=== 5` is false and `typeof` is "object", and the base's `null`
    // satisfied both. A first cut of this arm that always passed the primitive
    // flipped three rows and regressed this one.
    expect(
      await runStandalone(
        `Object.defineProperty(Object.prototype, "x", { get: function () { return this; } });` +
          ` var n = 5;` +
          ` return (n.x === 5 ? 0 : 1) * (typeof n.x === "object" ? 1 : 0) * (n.x == 5 ? 1 : 0);`,
        SLOPPY,
      ),
    ).toBe(1);
  });

  it("§10.4.3 SLOPPY — a boolean receiver boxes to a Boolean wrapper", async () => {
    expect(
      await runStandalone(
        `Object.defineProperty(Object.prototype, "x", { get: function () { return this; } });` +
          ` var b = true;` +
          ` return (b.x === true ? 0 : 1) * (typeof b.x === "object" ? 1 : 0) * (b.x == true ? 1 : 0);`,
        SLOPPY,
      ),
    ).toBe(1);
  });

  it("a DATA property on Object.prototype is visible on a number primitive", async () => {
    expect(await runStandalone(`Object.prototype.z = 7; var n = 5; return n.z === 7 ? 1 : 0;`)).toBe(1);
  });

  it("a DATA property on Number.prototype is visible on a number primitive", async () => {
    expect(await runStandalone(`Number.prototype.q = 9; var n = 5; return n.q === 9 ? 1 : 0;`)).toBe(1);
  });

  it("a DATA property on Boolean.prototype is visible on a boolean primitive (__box_boolean arm)", async () => {
    // Distinct from the number arm: the receiver must box as a Boolean, or the
    // walk starts at the wrong brand and misses.
    expect(await runStandalone(`Boolean.prototype.bq = 11; var b = true; return b.bq === 11 ? 1 : 0;`)).toBe(1);
  });

  it("the receiver may be loop-carried — nothing here is compile-time foldable", async () => {
    expect(
      await runStandalone(
        `Object.prototype.z = 7; var s = 0;` +
          ` for (var i = 0; i < 3; i++) { s = s + i.z; }` +
          ` return s === 21 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("an ABSENT property still answers undefined once the module arms the gate", async () => {
    // #4483's constant fold DECLINES in a module that writes to a primitive
    // prototype; before this arm existed the read then reached the terminal
    // `ref.null.extern` and `typeof` answered "object".
    expect(
      await runStandalone(`Object.prototype.z = 7; var n = 5; return typeof n.nothere === "undefined" ? 1 : 0;`),
    ).toBe(1);
  });

  // ── controls: shapes this arm must NOT take over ────────────────────────

  it("CONTROL — a wrapper-chain member keeps its existing lowering", async () => {
    expect(await runStandalone(`Object.prototype.z = 7; var n = 5.5; return n.toFixed(1) === "5.5" ? 1 : 0;`)).toBe(1);
  });

  it("CONTROL — an object receiver is unaffected", async () => {
    expect(
      await runStandalone(
        `Object.defineProperty(Object.prototype, "x", { get: function () { return 42; } });` +
          ` var o = {}; return o.x === 42 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("CONTROL — a CALL on a primitive receiver keeps the call lowering's this-binding", async () => {
    // The arm declines for a call callee precisely so this stays as it is: the
    // call path boxes, so a non-strict method sees an object.
    expect(
      await runStandalone(
        `Number.prototype.m = function () { return typeof this; }; var n = 5; return n.m() === "object" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("CONTROL — a module that touches no primitive prototype keeps #4483's fold", async () => {
    expect(await runStandalone(`var n = 5; return typeof n.nothere === "undefined" ? 1 : 0;`)).toBe(1);
  });
});
