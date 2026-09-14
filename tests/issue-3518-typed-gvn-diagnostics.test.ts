// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { asBlockId } from "../src/ir/nodes.js";
import { createGvnCounters, gvnCore } from "../src/ir/passes/gvn-core.js";
import { runHygienePassesIr } from "../src/ir/program-middleend-ir.js";
import {
  duplicateFunction,
  evaluateNumeric,
  identityFunction,
  throwingDuplicate,
} from "./helpers/typed-middleend-fixtures.js";

const root = resolve(import.meta.dirname, "..");
function child(script: string, debug: string) {
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=2048", "--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, JS2WASM_IR_GVN_DEBUG: debug, JS2WASM_IR_GVN: "off" },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result;
}
const prelude = `
  import assert from 'node:assert/strict';
  import { duplicateFunction, throwingDuplicate } from './tests/helpers/typed-middleend-fixtures.ts';
  import { createGvnCounters, gvnCore } from './src/ir/passes/gvn-core.ts';
`;

describe("typed GVN transaction diagnostics", () => {
  it("creates fresh sealed null-prototype counters with exactly three writable data fields", () => {
    const first = createGvnCounters(),
      second = createGvnCounters();
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(Object.isSealed(first)).toBe(true);
    expect(Reflect.ownKeys(first)).toEqual(["functions", "merged", "poisoned"]);
    for (const name of Reflect.ownKeys(first))
      expect(Object.getOwnPropertyDescriptor(first, name)).toEqual({
        value: 0,
        writable: true,
        enumerable: true,
        configurable: false,
      });
    first.merged++;
    expect(second).toEqual({ functions: 0, merged: 0, poisoned: 0 });
    expect(first).not.toBe(second);
  });

  it.each([false, true])("records real algorithmic merges with poison=%s and observable fixture values", (poison) => {
    const counters = createGvnCounters();
    const fn = duplicateFunction();
    const result = gvnCore(fn, { poison }, counters);
    expect(result).not.toBe(fn);
    expect(counters).toEqual({ functions: 1, merged: poison ? 0 : 1, poisoned: poison ? 1 : 0 });
    expect(evaluateNumeric(fn)).toBe(10);
    expect(evaluateNumeric(result)).toBe(poison ? 424247 : 10);
  });

  it("preserves unchanged-function identity and counts its completed walk", () => {
    const fn = identityFunction(),
      counters = createGvnCounters();
    expect(gvnCore(fn, {}, counters)).toBe(fn);
    expect(counters).toEqual({ functions: 1, merged: 0, poisoned: 0 });
  });

  it.each(["empty", "dominance-refusal"])("does not count a %s before the original increment site", (kind) => {
    const fn = identityFunction();
    const invalid = { ...fn, blocks: kind === "empty" ? [] : [{ ...fn.blocks[0]!, id: asBlockId(4) }] };
    const counters = createGvnCounters();
    expect(gvnCore(invalid, {}, counters)).toBe(invalid);
    expect(counters).toEqual({ functions: 0, merged: 0, poisoned: 0 });
  });

  it("GVN off skips the core and repeated hygiene rounds share exact counters", () => {
    const off = createGvnCounters();
    expect(evaluateNumeric(runHygienePassesIr(duplicateFunction(), undefined, "off", off))).toBe(10);
    expect(off).toEqual({ functions: 0, merged: 0, poisoned: 0 });
    const on = createGvnCounters();
    const optimized = runHygienePassesIr(duplicateFunction(), undefined, "on", on);
    expect(evaluateNumeric(optimized)).toBe(10);
    expect(on).toEqual({ functions: 2, merged: 1, poisoned: 0 });
    expect(runHygienePassesIr(optimized, undefined, "on", on)).toBe(optimized);
    expect(on).toEqual({ functions: 3, merged: 1, poisoned: 0 });
  });

  it.each([false, true])("retains partial counts and the exact escaping sentinel with poison=%s", (poison) => {
    const sentinel = Object.freeze({ marker: "after-real-merge" });
    const counters = createGvnCounters();
    let caught: unknown;
    try {
      gvnCore(throwingDuplicate(sentinel), { poison }, counters);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    expect(counters).toEqual({ functions: 0, merged: poison ? 0 : 1, poisoned: poison ? 1 : 0 });
  });

  it("records factory counters once, while distinct transactions aggregate separately", () => {
    const result = child(
      prelude +
        `
      const { recordLegacyGvnCountersOnce } = await import('./src/ir/passes/gvn.ts');
      const first = createGvnCounters(), second = createGvnCounters();
      gvnCore(duplicateFunction(), {}, first);
      gvnCore(duplicateFunction(), { poison: true }, second);
      recordLegacyGvnCountersOnce(first); recordLegacyGvnCountersOnce(first);
      recordLegacyGvnCountersOnce(second); recordLegacyGvnCountersOnce(second);
    `,
      "1",
    );
    expect(result.stderr).toBe("[ir-gvn] functions=2 merged=1 poisoned=1\n");
  });

  it("legacy finally accounting preserves partial statistics and the thrown object", () => {
    const result = child(
      prelude +
        `
      const { gvn } = await import('./src/ir/passes/gvn.ts');
      const sentinel = Object.freeze({ failure: 'original' });
      let caught; try { gvn(throwingDuplicate(sentinel)); } catch (error) { caught = error; }
      assert.equal(caught, sentinel);
    `,
      "1",
    );
    expect(result.stderr).toBe("[ir-gvn] functions=0 merged=1 poisoned=0\n");
  });

  it.each(["1", "off"])("retains legacy import-time debug=%s despite later environment reversal", (debug) => {
    const result = child(
      prelude +
        `
      const { gvn } = await import('./src/ir/passes/gvn.ts');
      process.env.JS2WASM_IR_GVN_DEBUG = ${JSON.stringify(debug === "1" ? "off" : "1")};
      gvn(duplicateFunction());
    `,
      debug,
    );
    expect(result.stderr).toBe(debug === "1" ? "[ir-gvn] functions=1 merged=1 poisoned=0\n" : "");
  });

  it("does not print historical debug output when only unmerged functions ran", () => {
    const result = child(
      `
      import { identityFunction } from './tests/helpers/typed-middleend-fixtures.ts';
      const { gvn } = await import('./src/ir/passes/gvn.ts');
      gvn(identityFunction());
    `,
      "1",
    );
    expect(result.stderr).toBe("");
  });

  it("resolved imports and execution install no exit handler and never load legacy GVN", () => {
    const result = child(
      `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      const before = process.listenerCount('exit');
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (result.url.endsWith('/src/ir/passes/gvn.ts')) throw Error('blocked legacy GVN');
        return result;
      }});
      const { duplicateFunction } = await import('./tests/helpers/typed-middleend-fixtures.ts');
      const { createGvnCounters } = await import('./src/ir/passes/gvn-core.ts');
      const { runHygienePassesIr } = await import('./src/ir/program-middleend-ir.ts');
      const counters = createGvnCounters();
      runHygienePassesIr(duplicateFunction(), undefined, 'on', counters);
      assert.equal(counters.merged, 1);
      assert.equal(process.listenerCount('exit'), before);
      await assert.rejects(import('./src/ir/passes/gvn.ts'), /blocked legacy GVN/);
    `,
      "1",
    );
    expect(result.stderr).toBe("");
  });
});
