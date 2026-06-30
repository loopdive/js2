// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #2884 — test262 runner stubbed the `decimalToHexString.js` harness
 * incorrectly, causing ~37 false failures across the encode/decode-URI families
 * (built-ins/{decodeURI,decodeURIComponent,encodeURI,encodeURIComponent}) and
 * the harness self-test (harness/decimalToHexString.js).
 *
 * Root cause was in `tests/test262-runner.ts` `buildPreamble`: it injected only
 *
 *     function decimalToHexString(n: number): string { return "0"; }
 *
 * which (a) never defined `decimalToPercentHexString` — the function those
 * tests use to BUILD their percent-encoded input — and (b) returned a constant
 * "0" for `decimalToHexString`. With the input function missing, the wrapped
 * test fed garbage to `decodeURI`/`encodeURI`, the spec-required `URIError`
 * never fired, and the test recorded a false `#…`-coded failure.
 *
 * The fix replaces the stub with a faithful TS port of BOTH harness functions.
 * `decodeURI`/`encodeURI` themselves are already correct — see the runtime path
 * exercised below — so the cluster was purely a harness-shim artifact.
 *
 * This test guards the fix two ways:
 *   1. Drives the real runner path (`parseMeta` + `wrapTest`) on a synthetic
 *      test that `includes: [decimalToHexString.js]` and asserts the generated
 *      preamble now defines `decimalToPercentHexString` and a non-constant
 *      `decimalToHexString`.
 *   2. Compiles + runs the exact harness shim functions and the
 *      malformed-UTF-8 / unpaired-surrogate URIError loops, asserting the
 *      spec-required throws are observed through the wasm boundary.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

// The faithful harness shim, identical to what buildPreamble now injects.
const HARNESS_SHIM = `
function decimalToHexString(n: number): string {
  const hex = "0123456789ABCDEF";
  n = n >>> 0;
  let s = "";
  while (n) { s = hex[n & 0xf] + s; n = n >>> 4; }
  while (s.length < 4) { s = "0" + s; }
  return s;
}
function decimalToPercentHexString(n: number): string {
  const hex = "0123456789ABCDEF";
  return "%" + hex[(n >> 4) & 0xf] + hex[n & 0xf];
}
`;

describe("#2884 — runner harness shim: decimalToHexString.js", () => {
  it("wrapTest now defines decimalToPercentHexString and a non-constant decimalToHexString", () => {
    const source = `/*---
includes: [decimalToHexString.js]
---*/
var a = decimalToPercentHexString(0xC0);
var b = decimalToHexString(0xC0);
`;
    const meta = parseMeta(source);
    const { source: wrapped } = wrapTest(source, meta);
    // The missing function is now declared in the injected preamble.
    expect(wrapped).toContain("function decimalToPercentHexString");
    // And the constant "0" stub is gone.
    expect(wrapped).not.toContain('function decimalToHexString(n: number): string { return "0"; }');
    expect(wrapped).toContain("function decimalToHexString");
  });

  it("decimalToHexString matches harness self-test assertions", async () => {
    expect(
      await runWasm(`
        ${HARNESS_SHIM}
        export function test(): number {
          if (decimalToHexString(-1) !== "FFFFFFFF") return 0;
          if (decimalToHexString(0.5) !== "0000") return 0;
          if (decimalToHexString(1) !== "0001") return 0;
          if (decimalToHexString(100) !== "0064") return 0;
          if (decimalToHexString(65535) !== "FFFF") return 0;
          if (decimalToHexString(65536) !== "10000") return 0;
          return 1;
        }
      `),
    ).toBe(1);
  });

  it("decimalToPercentHexString builds correct percent escapes", async () => {
    expect(
      await runWasm(`
        ${HARNESS_SHIM}
        export function test(): number {
          if (decimalToPercentHexString(0xC0) !== "%C0") return 0;
          if (decimalToPercentHexString(0x00) !== "%00") return 0;
          if (decimalToPercentHexString(0x7F) !== "%7F") return 0;
          return 1;
        }
      `),
    ).toBe(1);
  });

  it("decodeURI throws URIError on malformed UTF-8 built via the harness (mirrors decodeURI A1.13)", async () => {
    // For every lead byte 0xC0..0xDF followed by a non-continuation byte
    // 0x00..0x7F, decodeURI must throw URIError. This is the exact loop the
    // false-failing A1.* tests run, now fed correct input by the shim.
    expect(
      await runWasm(`
        ${HARNESS_SHIM}
        export function test(): number {
          for (let indexB = 0xC0; indexB <= 0xDF; indexB++) {
            const hexB = decimalToPercentHexString(indexB);
            for (let indexC = 0x00; indexC <= 0x7F; indexC++) {
              const hexC = decimalToPercentHexString(indexC);
              let threw = 0;
              try { decodeURI(hexB + hexC); }
              catch (e) { if (e instanceof URIError) threw = 1; }
              if (threw === 0) return 0;
            }
          }
          return 1;
        }
      `),
    ).toBe(1);
  });

  it("encodeURI throws URIError on an unpaired surrogate (mirrors encodeURI A2.*)", async () => {
    // Build the lone high surrogate at runtime (String.fromCharCode) rather
    // than as a literal so the test does not depend on 16-bit string-constant
    // import wiring in the equivalence helper.
    expect(
      await runWasm(`
        export function test(): number {
          const lone: string = String.fromCharCode(0xD800);
          let threw = 0;
          try { encodeURI(lone); }
          catch (e) { if (e instanceof URIError) threw = 1; }
          return threw;
        }
      `),
    ).toBe(1);
  });
});
