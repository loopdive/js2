// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The self-hosted `number_toString_radix` (src/stdlib/number-format.ts) used to
// allocate and zero a 256-unit scratch buffer, emit digits LSB-first, reverse
// them in place and copy into a tight string — for every `"" + i` / `i.toString(r)`
// on an integer. Integers now take an exact-size path (count digits, fill
// right-to-left, one buffer). This pins the observable output against the JS
// engine across radices, signs and the safe-integer boundary.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

const VALUES = [
  "0",
  "-0",
  "1",
  "-1",
  "7",
  "9",
  "10",
  "-10",
  "99",
  "100",
  "255",
  "256",
  "1234567",
  "2147483647",
  "-2147483648",
  "2147483648",
  "4294967295",
  "4294967296",
  "9007199254740991",
  "-9007199254740991",
  "0.5",
  "-12.25",
  "NaN",
  "Infinity",
  "-Infinity",
];
// (Integers above MAX_SAFE_INTEGER still trap in toString(radix) — the
// pre-existing #1335 Phase 2 gap the self-hosted body keeps parity with.)
const RADICES = [2, 8, 10, 16, 36];

it.each(RADICES)("integer toString(%i) matches the engine", async (radix) => {
  const source = `
    const VALUES = [${VALUES.join(", ")}];
    /** @param {number} i @returns {string} */
    export function at(i) { return VALUES[i].toString(${radix}); }
    /** @param {number} i @returns {string} */
    export function concat(i) { return "v=" + VALUES[i]; }
  `;
  const result = await compile(source, {
    fileName: "tostring.mjs",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    runtimeEvalProvider: false,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  // Standalone strings cross the boundary as opaque refs; compare through
  // the module's own length + charCodeAt-free path: re-compile a checksum.
  const checksum = await compile(
    `${source}
    /** @param {number} i @returns {number} */
    export function digest(i) {
      const s = at(i) + "|" + concat(i);
      let h = s.length;
      for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) % 1000000007;
      return h;
    }`,
    {
      fileName: "tostring-digest.mjs",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
      runtimeEvalProvider: false,
    },
  );
  expect(checksum.success, checksum.errors.map((e) => e.message).join("\n")).toBe(true);
  const digestModule = await WebAssembly.instantiate(checksum.binary, {});
  const digest = digestModule.instance.exports.digest as (i: number) => number;
  expect(instance).toBeDefined();
  VALUES.forEach((literal, i) => {
    const value = Number(literal);
    const s = value.toString(radix) + "|" + ("v=" + value);
    let h = s.length;
    for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) % 1000000007;
    expect(digest(i), `${literal}.toString(${radix})`).toBe(h);
  });
});
