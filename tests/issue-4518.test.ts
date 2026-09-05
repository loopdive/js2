// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4518 — the reflective `String.prototype.<m>` bodies' shared `? ToString(x)`
 * (`emitStringProtoToStringFlat`) and the nullish half of §7.1.17.
 *
 * The shared helper's terminal is `$__any_to_string`, whose residual arm
 * `ref.test`s the boxed-primitive structs and, on a miss, answers the literal
 * `"[object Object]"`. A NULL externref matches none of them, so §7.1.17 step 3
 * — `ToString(null)` is `"null"` — was simply absent: measured on this tree
 * before the fix, `String.prototype.replace.call("axb", "x", null)` rendered
 * `"a[object Object]b"` while the DIRECT `"axb".replace("x", null)` rendered
 * `"anullb"`. The two paths disagreed about one of §7.1.17's seven cases.
 *
 * **The `undefined` half of this issue was already closed when the fix was
 * written, and these pins exist so it stays closed.** #4518 was filed against a
 * 2026-08-16 tree where the tag-1 `$undefined` singleton ALSO rendered
 * `"[object Object]"` here; commit `0ce3c8f0` (#2875, "an absent toString is
 * not '[object Object]'") fixed that as collateral — it names `undefined`
 * explicitly among the carriers it un-stomped. Nothing in that family was
 * pinned, so the `undefined`/absent-argument group below is regression
 * protection for a win this issue did not earn but does depend on.
 *
 * **Why the null arm answers `"null"` and not `"undefined"`.** The reflective
 * ABI also uses `ref.null.extern` as its omitted-argument pad
 * (`closures/transferred-native-proto.ts`), whose spec answer would be
 * `"undefined"` — so in principle the value is ambiguous here. It is not in
 * practice: building the arm with a distinctive sentinel literal and re-running
 * every shape showed that ONLY an explicit `null` on the `.call` path reaches
 * it. Omitted arguments bypass it entirely, because `.call` pads them with the
 * #2106 `$undefined` singleton (`expressions/calls.ts`, `undefinedSingletonPad`)
 * rather than with null — which is exactly what the absent-argument cases below
 * pin, from the other side.
 *
 * Harness note, inherited from the #4439/#4465 suites: compile as JAVASCRIPT
 * (`allowJs` + a `.js` fileName), because the borrowed/reflective shapes lower
 * differently in the TypeScript lane. `runStandalone` asserts the module has
 * ZERO imports, which is what makes "standalone" a claim rather than a flag.
 *
 * The `it.fails` block pins four residuals this issue measured and deliberately
 * did not fix — see `## Residuals` in
 * plan/issues/4518-reflective-string-arm-undefined-render.md. They are
 * executable, so each pin FAILS the day its cause is fixed.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, fn = "f"): Promise<unknown> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-4518.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(mod, {});
  return (exports as Record<string, () => unknown>)[fn]!();
}

/** Wrap a statement body as the exported `f`, returning 1 on success. */
function prog(body: string): string {
  return `/** @returns {number} */\nexport function f() {\n${body}\n}`;
}

describe('#4518 — ToString(null) through the shared reflective arm is "null"', () => {
  it.each([
    // The replacement VALUE renders verbatim into the result, so it is the
    // cleanest read-out of the shared helper. Before the fix: "a[object Object]b".
    ["replace replaceValue", `return String.prototype.replace.call("axb", "x", null) === "anullb" ? 1 : 0;`],
    // The SEARCH value goes through the same helper. Before the fix it
    // stringified to "[object Object]", matched nothing, and the subject came
    // back unchanged.
    ["replace searchValue", `return String.prototype.replace.call("anullb", null, "Z") === "aZb" ? 1 : 0;`],
    // A different reflective family (the numeric-search bodies in
    // array-object-proto.ts) — one member per family is what pins that the arm
    // lives in the SHARED helper rather than in one body.
    ["indexOf searchString", `return String.prototype.indexOf.call("anullb", null) === 1 ? 1 : 0;`],
    ["lastIndexOf searchString", `return String.prototype.lastIndexOf.call("anullnullb", null) === 5 ? 1 : 0;`],
    // The property that actually matters: the reflective and DIRECT paths must
    // not disagree about §7.1.17. This asserts agreement rather than a literal,
    // so it keeps holding if the shared rendering ever legitimately changes.
    [
      "reflective agrees with the direct path",
      `return String.prototype.replace.call("axb", "x", null) === "axb".replace("x", null) ? 1 : 0;`,
    ],
  ])("%s", async (_label, body) => {
    expect(await runStandalone(prog(body))).toBe(1);
  });
});

describe("#4518 — the undefined half stays fixed (regression pins for #2875/0ce3c8f0)", () => {
  it.each([
    [
      "explicit undefined argument",
      `return String.prototype.replace.call("axb", "x", undefined) === "aundefinedb" ? 1 : 0;`,
    ],
    // A module-scope `var` read before assignment — the #4489 seed's value.
    [
      "module-var undefined (the #4489 tag-1 singleton)",
      `return String.prototype.replace.call("axb", "x", mv) === "aundefinedb" ? 1 : 0;`,
    ],
    [
      "undefined through the search family",
      `return String.prototype.indexOf.call("aundefinedb", undefined) === 1 ? 1 : 0;`,
    ],
    // A RECEIVER whose ToString is "undefined": toString is not callable, so
    // OrdinaryToPrimitive falls to valueOf, which returns undefined.
    [
      'receiver that stringifies to "undefined"',
      `var o = { valueOf: function () { return undefined; }, toString: undefined };
       return String.prototype.slice.call(new String(o), 0) === "undefined" ? 1 : 0;`,
    ],
  ])("%s", async (_label, body) => {
    expect(await runStandalone(`var mv;\n${prog(body)}`)).toBe(1);
  });
});

describe("#4518 — every other carrier through the shared arm is unmoved", () => {
  it.each([
    ["number", `return String.prototype.indexOf.call("a42b", 42) === 1 ? 1 : 0;`],
    ["boolean", `return String.prototype.indexOf.call("atrueb", true) === 1 ? 1 : 0;`],
    [
      "object with a user toString",
      `var o = { toString: function () { return "T"; } };
       return String.prototype.indexOf.call("aTb", o) === 1 ? 1 : 0;`,
    ],
    ["array", `return String.prototype.indexOf.call("a1,2b", [1, 2]) === 1 ? 1 : 0;`],
    [
      "plain object still renders [object Object]",
      `return String.prototype.replace.call("axb", "x", { a: 1 }) === "a[object Object]b" ? 1 : 0;`,
    ],
    // The #4465 RegExp-receiver arm shares this splice point — the null arm
    // wraps it, so this pins that wrapping did not shadow it.
    [
      "RegExp receiver still renders /src/flags (#4465 arm)",
      `var r = new RegExp("ab"); r.indexOf = String.prototype.indexOf;
       return r.indexOf("b") === 2 ? 1 : 0;`,
    ],
    // RequireObjectCoercible runs BEFORE ToString, so a null receiver must
    // still throw rather than reach the new arm and render "null".
    [
      "null receiver still throws a catchable TypeError",
      `try { String.prototype.slice.call(null, 0); return 0; }
       catch (e) { return e instanceof TypeError ? 1 : 0; }`,
    ],
    [
      "undefined receiver still throws a catchable TypeError",
      `try { String.prototype.slice.call(undefined, 0); return 0; }
       catch (e) { return e instanceof TypeError ? 1 : 0; }`,
    ],
  ])("%s", async (_label, body) => {
    expect(await runStandalone(prog(body))).toBe(1);
  });
});

describe("#4518 residuals — measured, deliberately not fixed here", () => {
  // R1. `string-proto-html.ts` maps a `ref.is_null` attribute slot to the
  // literal "undefined" BEFORE the shared helper runs (CreateHTML step 4.b
  // coerces an absent value regardless), so an explicit `null` name is caught
  // by that arm and never reaches the §7.1.17 step-3 rendering.
  it.fails('anchor(null) renders the name as "null"', async () => {
    expect(
      await runStandalone(prog(`return String.prototype.anchor.call("R", null) === '<a name="null">R</a>' ? 1 : 0;`)),
    ).toBe(1);
  });

  // R2. `split` short-circuits a nullish separator to "no separator" before the
  // shared ToString, so the subject comes back as one part. The DIRECT
  // `"anullb".split(null)` correctly yields two.
  it.fails('split(null) splits on "null"', async () => {
    expect(await runStandalone(prog(`return String.prototype.split.call("anullb", null).length === 2 ? 1 : 0;`))).toBe(
      1,
    );
  });

  // R3. `string-proto-concat.ts` step 3 tests `ref.is_null` on each padded arg
  // slot to mean "argument not passed" and SKIPS it — so a genuine `null`
  // argument is dropped instead of appended. The real fix is unifying the
  // omitted-arg pad onto the #2106 singleton, which changes every
  // `ref.is_null`-means-absent member body and is its own blast radius.
  it.fails('concat(null) appends "null"', async () => {
    expect(await runStandalone(prog(`return String.prototype.concat.call("x", null) === "xnull" ? 1 : 0;`))).toBe(1);
  });

  // R4. THE COST OF THIS ISSUE'S CHOICE, pinned so it is visible rather than
  // buried in a commit message. An OMITTED trailing argument reaches the shared
  // helper as the same `ref.null.extern` an explicit `null` does — in the JS
  // lane, which is the lane test262 compiles in — so the arm cannot tell them
  // apart, and answering §7.1.17's `"null"` makes an omitted argument render
  // `"null"` where the spec says `"undefined"`.
  //
  // This is wrong → differently-wrong, not right → wrong: before the arm the
  // same call rendered `"a[object Object]b"` (measured on this tree, JS lane,
  // both sides of the base-copy A/B). It is pinned rather than hidden because
  // the fix is NOT in this file — it is unifying the omitted-arg pad onto the
  // #2106 `$undefined` singleton in the callable-value dispatch
  // (`expressions/calls.ts`; the TS lane already pads that way, which is why
  // the TS-lane spelling of this case passes). That dispatch is #4619's
  // territory and carries every `ref.is_null`-means-absent member body with it.
  it.fails('an omitted trailing argument renders "undefined", not "null"', async () => {
    expect(
      await runStandalone(prog(`return String.prototype.replace.call("axb", "x") === "aundefinedb" ? 1 : 0;`)),
    ).toBe(1);
  });
});
