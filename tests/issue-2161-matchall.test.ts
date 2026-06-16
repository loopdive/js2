// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2161 — standalone `String.prototype.matchAll(/re/g)`.
 *
 * matchAll was blanket-refused in `--target standalone` (string-ops.ts) even
 * though the native RegExp engine already builds per-match capture arrays for
 * `exec` / non-global `match`. This slice wires the global form to a new native
 * helper (`__regex_match_all_arrays`) that drives the eager AdvanceStringIndex
 * loop collecting capture-ARRAYS into an iterable vec — consumed by the native
 * for-of path (#2169) with NO JS host.
 *
 * Each test instantiates with an EMPTY import object (proves no host) and reads
 * results back as plain numbers.
 *
 * Narrowed slice (deferred, by design — these stay refused, not silently wrong):
 *   - non-global matchAll (a runtime TypeError per §22.1.3.13);
 *   - string-arg coercion (`s.matchAll("x")` → new RegExp);
 *   - `[...s.matchAll(re)]` spread INTO an array literal (a generic
 *     native-vec-of-refs → externref-array coercion gap, not matchAll-specific).
 */
async function standaloneExports(source: string) {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No JS-host string-coercion / regex import may leak in standalone.
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  for (const re of [/^env::__extern_toString$/, /^wasm:js-string::/]) {
    expect(
      labels.filter((l) => re.test(l)),
      `leaked ${re}`,
    ).toEqual([]);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, (...a: unknown[]) => number>;
}

describe("#2161 — standalone String.prototype.matchAll(/re/g)", () => {
  it("iterates every match (count)", async () => {
    const ex = await standaloneExports(`
      export function countX(): number {
        let n = 0;
        for (const m of "aXbXc".matchAll(/X/g)) { n = n + 1; }
        return n;
      }
    `);
    expect(ex.countX()).toBe(2);
  });

  it("exposes capture groups (m[1]) for every match", async () => {
    const ex = await standaloneExports(`
      export function sumDigits(): number {
        let sum = 0;
        for (const m of "a1b2c3".matchAll(/(\\d)/g)) { sum = sum + Number(m[1]); }
        return sum;
      }
    `);
    expect(ex.sumDigits()).toBe(6); // 1 + 2 + 3
  });

  it("exposes the full match m[0]", async () => {
    const ex = await standaloneExports(`
      export function firstLen(): number {
        for (const m of "zzKKzz".matchAll(/K+/g)) { return m[0].length; }
        return -1;
      }
    `);
    expect(ex.firstLen()).toBe(2);
  });

  it("exposes m.index", async () => {
    const ex = await standaloneExports(`
      export function firstIndex(): number {
        for (const m of "..K".matchAll(/K/g)) { return m.index; }
        return -1;
      }
    `);
    expect(ex.firstIndex()).toBe(2);
  });

  it("yields an empty iterator (not null) when there are no matches", async () => {
    const ex = await standaloneExports(`
      export function noMatch(): number {
        let n = 0;
        for (const m of "abc".matchAll(/Z/g)) { n = n + 1; }
        return n;
      }
    `);
    expect(ex.noMatch()).toBe(0);
  });

  it("advances past empty matches without looping forever", async () => {
    const ex = await standaloneExports(`
      export function emptyMatches(): number {
        let n = 0;
        for (const m of "abc".matchAll(/x*/g)) { n = n + 1; }
        return n;
      }
    `);
    // /x*/g matches the empty string at positions 0,1,2 and at end (4 total).
    expect(ex.emptyMatches()).toBe(4);
  });

  it("refuses a non-global matchAll in standalone (narrowed, not silently wrong)", async () => {
    const r = await compile(
      `export function f(): number { let n = 0; for (const m of "aXb".matchAll(/X/)) n++; return n; }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
  });
});
