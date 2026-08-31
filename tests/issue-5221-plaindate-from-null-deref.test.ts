import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * (#5221) `Temporal.PlainDate.from(…)` traps with "dereferencing a null
 * pointer".
 *
 * The trap is not one bug. Reducing it inside the compiled
 * `@js-temporal/polyfill` (single module, no provider, no linking — the shape
 * #4628's harness measures) turned up FIVE independent codegen defects stacked
 * on the same call path, each of which has a repro of its own below. Every row
 * here fails on this branch's parent; the polyfill only completes when all five
 * are fixed, which is why they land together.
 *
 *  1. ABSENT PROPERTY IN AN OBJECT PATTERN BOUND `null`, NOT `undefined`.
 *     `destructureParamObject`'s struct fast path maps each pattern property to
 *     a `struct.get`; on a miss it did nothing and left the binding local at its
 *     wasm zero, which for an `any`/externref slot reads back as JS **null**.
 *     `void 0 === t` answered false, `{ t = d }` never defaulted, `typeof t`
 *     said `"object"`. The polyfill's `GetTemporalCalendarSlotValueWithISODefault`
 *     is exactly `const { calendar: t } = e; return void 0 === t ? "iso8601" :
 *     …`, so it handed `null` to the `%calendarImpl%` intrinsic.
 *
 *  2. A BLOCK-SCOPED `let`/`const` LEAKED ITS SLOT — *AND ITS WASM TYPE*.
 *     `saveBlockScopedShadows` only saved names that ALREADY had a local, so a
 *     binding a nested block introduced fresh stayed in `localMap` after the
 *     block closed. A later same-named declaration in the enclosing scope reused
 *     that slot, so a string stored into a struct-typed slot became `null`
 *     through the `ref.test`/`else ref.null` coercion — while `typeof` still
 *     reported the static type. This is the `ToTemporalDate` shape.
 *
 *  3. THE SAME COLLISION, ONE PHASE EARLIER, AS AN UNCONDITIONAL TRAP.
 *     `hoistLetConstWithTdz` claims one slot per NAME and recurses into nested
 *     blocks, so whichever declaration it reached first fixed the type. In
 *     `ToTemporalDate` a nested block's `const n = <record>` came first and the
 *     function-level `let { year: n } = parse(…)` inherited its struct slot;
 *     binding a number into it lowered to `ref.null $Anon; ref.as_non_null` —
 *     a trap on every string-argument call. That IS the reported null deref.
 *
 *  4. AN OMITTED ARGUMENT WAS PADDED WITH `null`, NOT `undefined`.
 *     `tryExternClassMethodOnAny` binds an `any` receiver to the first extern
 *     class declaring the name and pads that class's fixed arity with
 *     `ref.null.extern`. `a.sort()` first-matches `Uint8ClampedArray_sort(self,
 *     comparator)`, so native `Array.prototype.sort` got an EXPLICIT `null`
 *     comparator and threw (§23.1.3.30 accepts `undefined`, not `null`).
 *
 *  5. A PARAMETER WHOSE ONLY TYPE EVIDENCE IS AN `undefined` DEFAULT.
 *     `function f(item, options = void 0)` types `options` as `undefined`,
 *     which lowers to the void/undefined scalar — an ABI that carries neither a
 *     caller's value nor `undefined` (it reads back as the number 0).
 *     `Temporal.PlainDate.from(item, opts)` reached `GetOptionsObject` as `0`,
 *     both when options were omitted and when a real object was passed.
 *
 * A sixth fix is not given its own row because #2 and #3 already cover the
 * mechanism: the call-site parameter inference's `__anon_*` withdrawal was
 * gated on `ctx.standalone`, but host-lane the mismatch is coerced with
 * `ref.test` + `else ref.null` — silently `null`, several frames from the
 * fault. The polyfill's `CreateTemporalDate` forwarding chain is the witness;
 * see `plan/issues/5221-*.md`.
 *
 * These are UNIT repros. The end-to-end proof that
 * `Temporal.PlainDate.from("2020-03-04")` and `.from({year, month, day})`
 * return working objects is the dogfood harness
 * (`tests/dogfood/temporal-polyfill-harness.mjs` /
 * `temporal-global-harness.mjs`) — a ~30 s whole-bundle compile, deliberately
 * out of the vitest lane.
 */

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<unknown> {
  const result = await compile(source, {
    fileName: "issue-5221.ts",
    // The defects are all in UNTYPED JavaScript shapes (`t = void 0` types the
    // parameter `undefined`, so passing a real options object is a TS error the
    // polyfill lane never sees). Compile with the same diagnostics posture the
    // test262 runner and the #4628 dogfood harness use, or these rows measure
    // TypeScript's opinion instead of the compiler's lowering.
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>).test!();
}

// ---------------------------------------------------------------------------
// 1. An absent property in an object binding pattern is `undefined`.
// ---------------------------------------------------------------------------
describe("#5221 · absent object-pattern property binds undefined, not null", () => {
  const SRC = `const o = { year: 2020, month: 3, day: 4 };`;

  const rows: ReadonlyArray<readonly [string, string, unknown]> = [
    [
      "typeof is 'undefined'",
      `${SRC}\nexport function test(): string { const { calendar: t } = o; return typeof t; }`,
      "undefined",
    ],
    [
      "void 0 === t",
      `${SRC}\nexport function test(): string { const { calendar: t } = o; return String(void 0 === t); }`,
      "true",
    ],
    [
      "t === null is false",
      `${SRC}\nexport function test(): string { const { calendar: t } = o; return String(t === null); }`,
      "false",
    ],
    [
      "a binding default FIRES (undefined triggers it, null would not)",
      `${SRC}\nexport function test(): string { const { calendar: t = "iso8601" } = o; return String(t); }`,
      "iso8601",
    ],
    [
      "present siblings are unaffected",
      `${SRC}\nexport function test(): string { const { year: y, calendar: t } = o; return String(y) + "/" + typeof t; }`,
      "2020/undefined",
    ],
    [
      "the polyfill's own shape: GetTemporalCalendarSlotValueWithISODefault",
      `${SRC}
       function calendarOf(e: any): string { const { calendar: t } = e; return void 0 === t ? "iso8601" : String(t); }
       export function test(): string { return calendarOf(o); }`,
      "iso8601",
    ],
  ];

  for (const [title, source, expected] of rows) {
    it(`host · ${title}`, async () => {
      expect(await run(source, "host")).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. A nested block's let/const must not capture the enclosing scope's slot.
// ---------------------------------------------------------------------------
describe("#5221 · a block-scoped binding does not leak its slot or its type", () => {
  // The inner `n` holds an OBJECT, the outer `n` a STRING. Type divergence is
  // what makes the leak observable: the string is stored into the struct slot
  // through `ref.test` + `else ref.null` and reads back as null.
  //
  // `obj()` and `str()` are DELIBERATELY unannotated. Annotating them `: any`
  // lowers both to `externref`, the two `n` declarations then agree on a kind,
  // and the leak becomes invisible — the row passes on base and pins nothing.
  const SHAPE = `function obj() { return { isoDate: 1, time: 2 }; }
    function str() { return "iso8601"; }
    function pick(e: any): string {
      if (e) {
        if (e === 2) { const n = obj(); return "inner" + n.isoDate; }
        const n = str();
        return "n=" + String(n) + " typeof=" + typeof n;
      }
      return "no";
    }`;

  it("host · the outer binding keeps its own value", async () => {
    expect(await run(`${SHAPE}\nexport function test(): string { return pick(1); }`, "host")).toBe(
      "n=iso8601 typeof=string",
    );
  });

  it("host · the inner binding still works when its branch runs", async () => {
    expect(await run(`${SHAPE}\nexport function test(): string { return pick(2); }`, "host")).toBe("inner1");
  });

  // The standalone lane returns a NativeString struct, not a JS string, so the
  // guard asserts on a number instead of comparing text across the boundary.
  it("standalone · the outer binding keeps its own value", async () => {
    const src = `${SHAPE}\nexport function test(): number { return pick(1) === "n=iso8601 typeof=string" ? 1 : 0; }`;
    expect(await run(src, "standalone")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The hoist pre-pass must not give a nested block's declaration the
//    function-level slot. On base this row TRAPS, it does not merely misread.
// ---------------------------------------------------------------------------
describe("#5221 · outermost let/const claims the function-level slot", () => {
  // `ToTemporalDate` in miniature: a nested block declares `const n = <record>`
  // BEFORE the function-level `let { year: n } = <parsed>` binds a number.
  const SRC = `function record() { return { isoDate: 1, time: 2 }; }
    function parsed() { return { year: 2020, month: 3, day: 4 }; }
    function toDate(e: any): string {
      if (typeof e === "object" && e !== null) {
        if (e.wall) { const n = record(); return "wall" + n.isoDate; }
        return "object";
      }
      let { year: n, month: r, day: o } = parsed();
      return String(n) + "-" + String(r) + "-" + String(o);
    }
    export function test(): string { return toDate("2020-03-04"); }`;

  it("host · the string arm binds numbers, not a trapping struct slot", async () => {
    expect(await run(SRC, "host")).toBe("2020-3-4");
  });

  // Standalone: assert on NUMBERS, not on text. The trap this row pins is the
  // `ref.null; ref.as_non_null` binding of `n`, which is independent of string
  // formatting — and standalone's string concatenation of numbers has its own
  // (unrelated, pre-existing) differences that would make a text compare
  // measure the wrong thing.
  const NUMERIC = `function record() { return { isoDate: 1, time: 2 }; }
    function parsed() { return { year: 2020, month: 3, day: 4 }; }
    function toDate(e: any): number {
      if (typeof e === "object" && e !== null) {
        if (e.wall) { const n = record(); return n.isoDate; }
        return -1;
      }
      let { year: n, month: r, day: o } = parsed();
      return n * 10000 + r * 100 + o;
    }
    export function test(): number { return toDate("2020-03-04"); }`;

  // NO standalone row for this shape, and the reason is a SEPARATE defect, not
  // a limitation of the fix: on the standalone lane
  // `const { year: n } = f()` — where `f` returns `any` — answers 0 for ANY
  // shape, with no shadowing anywhere in the program (measured 2026-08-30,
  // `.tmp/t16.ts`: a three-line file with one destructure). Asserting here
  // would pin that unrelated gap to this issue. Reported, not fixed.
  it("host · numeric form (same shape, no string formatting in the way)", async () => {
    expect(await run(NUMERIC, "host")).toBe(20200304);
  });

  it("host · the object arm is unaffected", async () => {
    expect(await run(SRC.replace('toDate("2020-03-04")', "toDate({ wall: 0 })"), "host")).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// 4. An omitted argument to a first-matched extern-class method is `undefined`.
// ---------------------------------------------------------------------------
describe("#5221 · omitted extern-class argument pads undefined, not null", () => {
  // `const _re = /x/;` registers the TypedArray extern classes — without it the
  // call never first-matches `Uint8ClampedArray_sort` and the defect is
  // invisible. Same load-bearing detail as #5211's suite.
  const SRC = `const _re = /x/;
    function sortIt(n: any, r: any, i: any): string {
      const a = n.concat(r, i);
      a.sort();
      return a.join("|");
    }
    function open(x: any): any { return x; }
    export function test(): string { return sortIt(open(["year", "day"]), open([]), open(["month"])); }`;

  it("host · a bare .sort() does not pass an explicit null comparator", async () => {
    expect(await run(SRC, "host")).toBe("day|month|year");
  });
});

// ---------------------------------------------------------------------------
// 5. A parameter whose only type evidence is an `undefined` default.
// ---------------------------------------------------------------------------
describe("#5221 · undefined-only parameter type keeps the dynamic carrier", () => {
  const OPTS = `function describeOpts(e: any): string {
      if (e === undefined) return "undefined";
      if (typeof e === "object" && e !== null) return "object";
      return "BAD:" + typeof e + ":" + String(e);
    }`;

  const rows: ReadonlyArray<readonly [string, string, unknown]> = [
    [
      "function declaration · omitted",
      `${OPTS}\nfunction f(item: any, t = void 0): string { return describeOpts(t); }
       export function test(): string { return f("x"); }`,
      "undefined",
    ],
    [
      "function declaration · a real object survives the boundary",
      `${OPTS}\nfunction f(item: any, t = void 0): string { return describeOpts(t); }
       export function test(): string { return f("x", { overflow: "constrain" }); }`,
      "object",
    ],
    [
      "static class method · omitted (Temporal.PlainDate.from's own shape)",
      `${OPTS}\nclass K { static from(item: any, t = void 0): string { return describeOpts(t); } }
       export function test(): string { return K.from("2020-03-04"); }`,
      "undefined",
    ],
    [
      "static class method · a real object survives the boundary",
      `${OPTS}\nclass K { static from(item: any, t = void 0): string { return describeOpts(t); } }
       export function test(): string { return K.from("2020-03-04", { overflow: "reject" }); }`,
      "object",
    ],
    [
      "instance method · omitted",
      `${OPTS}\nclass K { m(item: any, t = void 0): string { return describeOpts(t); } }
       export function test(): string { return new K().m("x"); }`,
      "undefined",
    ],
    [
      "control: a NON-undefined default keeps its scalar lowering",
      `function g(item: any, t = 5): string { return typeof t; }
       export function test(): string { return g("x"); }`,
      "number",
    ],
  ];

  for (const [title, source, expected] of rows) {
    it(`host · ${title}`, async () => {
      expect(await run(source, "host")).toBe(expected);
    });
  }
});
