// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B3) The DIRECT spelling `re[Symbol.search](s)` /
 * `re[Symbol.match](s)` routes through the reified `RegExp.prototype[@@x]`
 * value, and `@@match`'s global arm is §22.2.6.8 step 6 in full.
 *
 * The acceptance rows are listed one by one because each pins a different
 * observable, and a route that loses any single one still looks green on the
 * others:
 *
 * - `@@match/exec-{err,invocation,return-type-invalid,return-type-valid}` — the
 *   direct spelling now consults `exec`: it is called with the regexp as `this`
 *   and exactly one (already-`ToString`ed) argument, its abrupt completion
 *   propagates, a primitive result is a TypeError, and an Object/Null result
 *   comes back by identity.
 * - `@@match/{coerce-arg-err,get-exec-err,g-match-no-set-lastindex}` — the same
 *   route, reached by three other observables (the argument's `toString`, a
 *   poisoned `exec` getter, and the global arm's lastIndex discipline).
 * - `@@search/{coerce-string,set-lastindex-init-samevalue,
 *   set-lastindex-restore-samevalue}` — §22.2.6.12 steps 3/5/8 on the direct
 *   spelling, including SameValue-vs-SameValueZero on `-0`.
 *
 * The source-level controls pin what a routing change loses SILENTLY: a file
 * that never mentions `exec` / `RegExp.prototype` must keep the static native
 * core (byte-identical, asserted by compiling the same program twice through
 * the two gate answers), and the `String.prototype` fast lane must be
 * untouched. The last control is the §22.2.6.8 step-6 collect loop itself over
 * an object receiver — the one shape in which it is reachable today (see the
 * `Get(rx, "flags")` residual in the issue).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "built-ins/RegExp/prototype/Symbol.match/coerce-arg-err.js",
  "built-ins/RegExp/prototype/Symbol.match/exec-err.js",
  "built-ins/RegExp/prototype/Symbol.match/exec-invocation.js",
  "built-ins/RegExp/prototype/Symbol.match/exec-return-type-invalid.js",
  "built-ins/RegExp/prototype/Symbol.match/exec-return-type-valid.js",
  "built-ins/RegExp/prototype/Symbol.match/g-match-no-set-lastindex.js",
  "built-ins/RegExp/prototype/Symbol.match/get-exec-err.js",
  "built-ins/RegExp/prototype/Symbol.search/coerce-string.js",
  "built-ins/RegExp/prototype/Symbol.search/set-lastindex-init-samevalue.js",
  "built-ins/RegExp/prototype/Symbol.search/set-lastindex-restore-samevalue.js",
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  EXACT_ROWS.every((relativePath) => existsSync(join(TEST262_ROOT, "test", relativePath)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

async function runExactRow(relativePath: (typeof EXACT_ROWS)[number]) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-6651-cluster-b3",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

/** Compile standalone, assert no host import leaked, and run the `test` export. */
async function runStandalone(source: string, fileName: string): Promise<number> {
  const result = await compile(source, { fileName, target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function compiledBytes(source: string, fileName: string): Promise<Uint8Array> {
  const result = await compile(source, { fileName, target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result.binary;
}

describe("#6651 B3 — the direct @@match/@@search spelling + the global collect loop", () => {
  for (const relativePath of EXACT_ROWS) {
    itWithTest262(
      `test262 standalone: ${relativePath}`,
      async () => {
        const result = await runExactRow(relativePath);
        expect(`${relativePath}: ${result.status}`).toBe(`${relativePath}: pass`);
      },
      200_000,
    );
  }

  it("control — an exec-free file keeps the STATIC core for the direct spelling", async () => {
    // Same program twice, the second with the one token that flips the
    // whole-file gate. The binaries must differ (the route changed) AND the
    // gate-off binary must be identical to the pre-B3 shape — which is what
    // "byte-identical for an exec-free file" means operationally: nothing in
    // this program can reach the new lowering.
    const staticLane = `
export function test(): number {
  const re = /b/;
  return re[Symbol.search]("abc");
}
`;
    const observedLane = `
export function test(): number {
  const re = /b/;
  const seen: any = RegExp.prototype;
  if (seen === null) return -2;
  return re[Symbol.search]("abc");
}
`;
    const a = await compiledBytes(staticLane, "b3-static-lane.ts");
    const b = await compiledBytes(staticLane, "b3-static-lane.ts");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const c = await compiledBytes(observedLane, "b3-observed-lane.ts");
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
    expect(await runStandalone(staticLane, "b3-static-lane.ts")).toBe(1);
  }, 200_000);

  it("control — the static String.prototype.search fast lane is unchanged", async () => {
    const source = `
export function test(): number {
  return "a string".search(/string/);
}
`;
    expect(await runStandalone(source, "b3-string-search-control.ts")).toBe(2);
  }, 200_000);

  it("§22.2.6.8 step 6 — the global collect loop over an object receiver", async () => {
    // The one receiver shape in which the global arm is reachable today: a
    // plain object whose `flags` is an ordinary property. On a real RegExp
    // carrier `Get(rx, "flags")` answers the raw bitfield (see the residual in
    // #6651), so the arm is correct but dormant there.
    const source = `
export function test(): number {
  const m: any = (RegExp.prototype as any)[Symbol.match];
  let calls = 0;
  const rx: any = {
    flags: "g",
    lastIndex: 0,
    exec: function (): any {
      calls += 1;
      if (calls === 1) return { 0: "ab" };
      if (calls === 2) return { 0: "cd" };
      return null;
    },
  };
  const res: any = m.call(rx, "abcd");
  if (res === null) return -1;
  if (res.length !== 2) return -2;
  if (res[0] !== "ab" || res[1] !== "cd") return -3;
  if (calls !== 3) return -4;
  const rx2: any = { flags: "g", lastIndex: 0, exec: function (): any { return null; } };
  if (m.call(rx2, "ab") !== null) return -5;
  return 1;
}
`;
    expect(await runStandalone(source, "b3-global-collect-loop.ts")).toBe(1);
  }, 200_000);
});
