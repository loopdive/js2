// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 item 1 — the three selector blockers on assert.js's `compareArray(a, b)`:
// a dynamic member equality (`b.length !== a.length`) in a function that is
// only a member HOST (`compareArray.format = …`, not a callback value); an
// indexed read with a proven-number loop index (`b[i]`); and a member call on
// a stable top-level function object (`assert._isSameValue(b[i], a[i])`) whose
// dynamic result feeds `!`. The function-object arm requires the planner's
// type evidence (annotations) so an untyped legacy-owned function object stays
// refused before claim.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  target: "standalone",
  trackIrOutcomes: true,
} as const;

const TYPED_ASSERT = `
  /** @param {boolean} c @param {string} m @returns {void} */
  function assert(c, m) { if (!c) { throw new Error(m); } }
  assert._isSameValue = function (a, b) {
    if (a === b) { return a !== 0 || 1 / a === 1 / b; }
    return a !== a && b !== b;
  };
`;

const COMPARE_ARRAY = `
  /** @param {object} a @param {object} b */
  function compareArray(a, b) {
    if (b.length !== a.length) { return false; }
    for (var i = 0; i < a.length; i++) {
      if (!assert._isSameValue(b[i], a[i])) { return false; }
    }
    return true;
  }
  compareArray.format = function (x) { return "[" + x + "]"; };
  export function ok() {
    var n = 0;
    if (compareArray([1, 2], [1, 2]) === true) n += 1;
    if (compareArray([1], [1, 2]) === false) n += 2;
    if (compareArray([1], [2]) === false) n += 4;
    if (compareArray([0], [-0]) === false) n += 8;
    if (compareArray([NaN], [NaN]) === true) n += 16;
    return n;
  }
`;

async function call(binary: Uint8Array, name: string): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports[name] as () => number)();
}

function outcome(result: Awaited<ReturnType<typeof compile>>, name: string) {
  return (result.irOutcomes ?? []).find((o) => o.displayName === name);
}

describe("#7106 item 1 — compareArray's selector blockers", () => {
  it("claims compareArray with a typed function-object `assert` and matches legacy", async () => {
    const result = await compile(TYPED_ASSERT + COMPARE_ARRAY, { ...OPTIONS, fileName: "issue-7106-compare-array.js" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(result, "compareArray")?.irBodyEmitted).toBe(true);
    expect(await call(result.binary, "ok")).toBe(31);
  });

  // (#7106 census arm 4) A receiver-only use needs no signature evidence: the
  // planner mints the boxed receiver plan with an opaque signature, so the
  // member call on an UNTYPED function object is claimed and runs.
  it("claims the member call on an UNTYPED function object (receiver-only use)", async () => {
    const untyped = `
      function assert(c, m) { if (!c) { throw new Error(m); } }
      assert._isSameValue = function (a, b) { return a === b; };
    `;
    const result = await compile(untyped + COMPARE_ARRAY, {
      ...OPTIONS,
      fileName: "issue-7106-compare-array-untyped.js",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const o = outcome(result, "compareArray");
    expect(o?.irBodyEmitted).toBe(true);
    expect((result.irPostClaimErrors ?? []).filter((e) => e.func === "compareArray")).toEqual([]);
    // plain `===`: -0 equals 0 and NaN differs from NaN, so only the first three bits.
    expect(await call(result.binary, "ok")).toBe(7);
  });

  it("keeps a function passed as a callback value out of the member-equality set", async () => {
    // `pick` is handed to a legacy array method as a value: its dynamic member
    // equality stays refused (callback-boundary carrier concern), while the
    // member-host-only `compareArray` above is admitted.
    const result = await compile(
      `
        /** @param {object} a @param {object} b */
        function pick(a, b) { return b.length !== a.length; }
        export function ok() { var r = [[1], [2, 3]].map(pick); return r.length === 2 ? 1 : 0; }
      `,
      { ...OPTIONS, fileName: "issue-7106-compare-array-callback.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(outcome(result, "pick")?.irBodyEmitted).not.toBe(true);
    expect((result.irPostClaimErrors ?? []).filter((e) => e.func === "pick")).toEqual([]);
  });
});
