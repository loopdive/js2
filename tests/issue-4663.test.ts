// #4663 — `"" + a` must consult a USER-installed `Array.prototype.toString`.
//
// `__array_to_primitive_string` (array-to-primitive.ts) is the body behind
// `__to_primitive`'s vec arm, and it was a hard-coded `join(",")` with no
// prototype consult. Measured on the campaign tip 2026-08-24, one module each,
// with `Array.prototype.toString` overridden:
//
//   | spelling        | before | after |
//   | `String(a)`     | ✓      | ✓     |
//   | `a.toString()`  | ✓      | ✓     |
//   | `"" + a`        | ✗      | ✓     |
//   | `a + ""`        | ✗      | ✓     |
//   | `a == "OV"`     | ✗      | ✓     |
//   | `+a` / `a - 1`  | ✗      | ✓     |
//   | `` `${a}` ``    | ✗      | ✗     | (a different dispatcher — residual)
//
// Only the middle group reaches the vec arm; the first two are claimed by
// compile-time lowerings that already consulted the override.
//
// THE SHAPE OF THE GUARD IS WHAT THIS SUITE PINS. The consult is armed by a
// COARSE compile-time gate (`protoNamedWrittenMembers` records the bare member
// name — `Object.prototype.toString = f` arms it too) and made safe by a
// PRECISE runtime probe (the #4176 Array brand companion, with no
// `Object.prototype` tail). So the two controls below are not decoration:
// without the precise probe, an `Object.prototype.toString` override would
// hijack `"" + [1,2]`, which `Array.prototype.toString` shadows per §23.1.3.32.
//
// Every pin EXECUTES the coercion and reads the result, and every expected
// string is built by a LOOP so no compile-time fold can answer the comparison
// without running the coercion under test.
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

async function runStandalone(body: string): Promise<number> {
  const result: any = await compile(`export function test(): any { ${body} }`, OPTS as any);
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports as any).test();
}

function loopBuilt(name: string, text: string): string {
  const chars = [...text].map((c) => JSON.stringify(c)).join(", ");
  return `var ${name} = ""; var ${name}__c = [${chars}]; for (var ${name}__i = 0; ${name}__i < ${name}__c.length; ${name}__i++) { ${name} = ${name} + ${name}__c[${name}__i]; }`;
}

/** `Array.prototype.toString = function () { return <expr>; };` */
const arrayOverride = (returns: string): string => ` Array.prototype.toString = function () { return ${returns}; };`;

describe("#4663 — the `+` / ToPrimitive path honours an overridden Array.prototype.toString", () => {
  it('`"" + a` uses the override (the issue\'s row)', async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "__ARRAY__")}${arrayOverride('"__ARRAY__"')}` +
          ` var a = new Array; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it('`"" + a` on a NON-empty array uses it too (not an empty-vec special case)', async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "OV")}${arrayOverride('"OV"')} var a = [1, 2]; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it('`a + ""` — the other operand order', async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "OV")}${arrayOverride('"OV"')} var a = [1, 2]; return (a + "") === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("loose equality against a string reduces through the override", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "OV")}${arrayOverride('"OV"')} var a = [1, 2]; return (a == want) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("the NUMBER hint reaches it as well (`+a`, `a - 1`, `a * 2`)", async () => {
    // The vec arm is hint-independent, so one override drives all three. Values
    // differ per operator, which is what makes this a coercion test rather than
    // a "did it return a number" test.
    expect(await runStandalone(`${arrayOverride('"7"')} var a = [1, 2]; return +a;`)).toBe(7);
    expect(await runStandalone(`${arrayOverride('"7"')} var a = [1, 2]; return a - 1;`)).toBe(6);
    expect(await runStandalone(`${arrayOverride('"7"')} var a = [1, 2]; return a * 2;`)).toBe(14);
  });

  it("`1 + a` concatenates the override's value, not the join", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "1OV")}${arrayOverride('"OV"')} var a = [1, 2]; return (1 + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("the override sees the array as `this`", async () => {
    // Rules out an arm that calls the closure with a wrong/absent receiver — it
    // would answer "Lundefined" and still be a string.
    expect(
      await runStandalone(
        `${loopBuilt("want", "L2")} Array.prototype.toString = function () { return "L" + this.length; };` +
          ` var a = [1, 2]; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("a NON-string primitive is returned RAW, not stringified", async () => {
    // ToPrimitive's contract, and the reason the arm does not run its result
    // through ToString: `1 + a` must be 8, not "17".
    expect(await runStandalone(`${arrayOverride("7")} var a = [1]; return 1 + a;`)).toBe(8);
    expect(await runStandalone(`${arrayOverride("7")} var a = [1]; return a - 1;`)).toBe(6);
  });
});

describe("#4663 — CONTROLS: the arm must not fire where the builtin still wins", () => {
  it('POSITIVE CONTROL — no override anywhere still renders `join(",")`', async () => {
    expect(await runStandalone(`${loopBuilt("want", "1,2")} var a = [1, 2]; return ("" + a) === want ? 1 : 0;`)).toBe(
      1,
    );
    expect(await runStandalone(`var a = []; return ("" + a) === "" ? 1 : 0;`)).toBe(1);
  });

  it("POSITIVE CONTROL — holes and the numeric hint keep the join's semantics", async () => {
    expect(
      await runStandalone(`${loopBuilt("want", "1,,3")} var a = [1, , 3]; return ("" + a) === want ? 1 : 0;`),
    ).toBe(1);
    expect(await runStandalone(`var a = [7]; return a - 1;`)).toBe(6);
  });

  it("NEGATIVE CONTROL — an `Object.prototype.toString` override must NOT hijack it", async () => {
    // §23.1.3.32: `Array.prototype.toString` is a real builtin and SHADOWS
    // `Object.prototype`'s. The compile-time gate cannot tell the two writes
    // apart (member NAME only), so this is what the Array-companion-only
    // runtime probe exists for. With a plain `__protoidx_has_r` — whose walk
    // falls through to Object's companion — this answers "__OBJ__".
    expect(
      await runStandalone(
        `${loopBuilt("want", "1,2")} Object.prototype.toString = function () { return "__OBJ__"; };` +
          ` var a = [1, 2]; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("NEGATIVE CONTROL — an override on String/Function.prototype does not arm it either", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "1,2")} String.prototype.toString = function () { return "S"; };` +
          ` var a = [1, 2]; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
    expect(
      await runStandalone(
        `${loopBuilt("want", "1,2")} Function.prototype.toString = function () { return "F"; };` +
          ` var a = [1, 2]; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("NEGATIVE CONTROL — overriding a DIFFERENT Array member does not arm it", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "1,2")} Array.prototype.join = function () { return "J"; };` +
          ` var a = [1, 2]; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("NEGATIVE CONTROL — reading `Array.prototype` as a VALUE disarms the consult", async () => {
    // `protoMemberDirty` arms `ensureNativeProtoCompanionSeeder`, which fills
    // the Array brand companion with the GLUE's own members — `toString` among
    // them. The companion predicate then cannot tell a user override from the
    // builtin, so the arm declines entirely. Measured: without this gate these
    // three modules trapped with a `WebAssembly.Exception` where the base
    // answered `"1,2"` (#4655's recursion hazard, arriving by the seeder door).
    const objOv = ` Object.prototype.toString = function () { return "__OBJ__"; };`;
    for (const reflect of [` var p = Array.prototype;`, ` var p = Object.getPrototypeOf([]);`]) {
      expect(
        await runStandalone(
          `${loopBuilt("want", "1,2")}${objOv}${reflect} var a = [1, 2]; return ("" + a) === want ? 1 : 0;`,
        ),
      ).toBe(1);
    }
  });
});

describe("#4663 — absent-not-wrong: every undecidable override falls back to the join", () => {
  it("an OBJECT-returning override falls through (§7.1.1.1 step 2.b.iii)", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "1,2")}${arrayOverride("{}")} var a = [1, 2]; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("a NON-callable override falls through", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "1,2")} Array.prototype.toString = 5; var a = [1, 2];` +
          ` return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("a `null`-returning override falls through (null and undefined share one externref)", async () => {
    // `ordinary-to-primitive-probe.ts` declines a null result on purpose — the
    // module carries both renderings of that one value and picking one would
    // make this walk disagree with the other for a value it cannot tell apart.
    expect(
      await runStandalone(
        `${loopBuilt("want", "1")}${arrayOverride("null")} var a = [1]; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("an override installed on a branch that does NOT run keeps the join", async () => {
    // The compile-time gate is syntactic, so the arm IS built; the runtime
    // companion probe is what answers correctly. Written unfoldable (the
    // condition is loop-carried) so no fold can decide it.
    expect(
      await runStandalone(
        `${loopBuilt("want", "1,2")} var n = 0; for (var i = 0; i < 1; i++) { n = n + 1; }` +
          ` if (n > 5) { Array.prototype.toString = function () { return "__ARRAY__"; }; }` +
          ` var a = [1, 2]; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("an override installed on a branch that DOES run is honoured", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "__ARRAY__")} var n = 0; for (var i = 0; i < 1; i++) { n = n + 1; }` +
          ` if (n > 0) { Array.prototype.toString = function () { return "__ARRAY__"; }; }` +
          ` var a = [1, 2]; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it('an `undefined`-returning override now answers `"undefined"`, not the join', async () => {
    // A deliberate behaviour change, and the SPEC one: `undefined` is a
    // primitive, so §7.1.1.1 stops there. Base rendered the join instead.
    expect(
      await runStandalone(
        `${loopBuilt("want", "undefined")}${arrayOverride("undefined")} var a = [1];` +
          ` return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});

describe("#4663 — measured RESIDUALS (not fixed here)", () => {
  it.fails("a template substitution `` `${a}` `` still ignores the override", async () => {
    // Measured both arms: 0. A different dispatcher claims the substitution
    // before `__to_primitive` is reached — the same carrier-selection axis as
    // #4492's inline-receiver residual (R1) and #4655's R3/R4. Belongs with the
    // value-rep carrier work (#4641 / #3580), not here.
    expect(
      await runStandalone(
        `${loopBuilt("want", "OV")}${arrayOverride('"OV"')} var a = [1, 2]; return (\`\${a}\`) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it.fails('`Object.defineProperty(Array.prototype, "toString", …)` alone does not arm it', async () => {
    // MEASURED FROM THE EMITTED ARM, not a JS probe: this module compiles
    // BYTE-IDENTICALLY to base (wasm_sha b37f7e0e0971aeb4 both arms), so the
    // arm is not merely dead — it is never built. `isProtoNamedWrite`
    // (array-holes.ts:690) excludes `Array.prototype` from its `defineProperty`
    // arm, so no member name is recorded and the compile-time gate declines.
    //
    // The companion itself IS correct: add ANY other `X.prototype.toString =`
    // write to the same module and this shape passes (measured — `.tmp/p2.mts`
    // row G1 flips 0 → 1). So the gap is purely the pre-scan's member-name
    // recording. Widening `isProtoNamedWrite` is deliberately NOT done here:
    // its Array exclusion is load-bearing for `protoIndexDirty` and is its own
    // blast radius.
    expect(
      await runStandalone(
        `${loopBuilt("want", "__ARRAY__")}` +
          ` Object.defineProperty(Array.prototype, "toString",` +
          ` { value: function () { return "__ARRAY__"; }, writable: true, configurable: true });` +
          ` var a = new Array; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it.fails("`Number(a)` traps when the override returns a NUMBER", async () => {
    // PRE-EXISTING and unchanged by this work — measured identical on both arms
    // ("illegal cast"), and `Number(a)` does not reach the vec arm at all here
    // (with a STRING-returning override it already answered 7 on base). Recorded
    // so the trap is not mistaken for a consequence of the raw-primitive return.
    expect(await runStandalone(`${arrayOverride("7")} var a = [1]; return Number(a);`)).toBe(7);
  });
});
