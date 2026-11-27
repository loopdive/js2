// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7164 — the "never worse than origin/main" sweeps over a switched binding's
// escapes (the issue's story is in issue-7164-externref-vec-length-growth.test.ts;
// #7565 split the rows across three files so the equivalence shards run them in
// parallel).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateAsJs } from "./helpers.js";
import { FULL_SWEEP, headSummary, LANES, type Lane, pinLane, readSummary } from "./issue-7164-harness.js";
import { callbackRows, callbackSource, TARGET_FORMS, targetSource } from "./issue-7164-length-update-sweep-cases.js";

// (#7164 r9) Callback-array escape sweep: a switched binding behind every
// receiver shape (`(g)`, `g!`, `as`, `satisfies`, `.reverse()` / `.fill()` /
// `.copyWithin()`, `?:`, `||`, `??`, `&&`, comma, `h = g`, `g['m']`) and every
// wrapper on the method reference (`(g.m)(cb)`, `(0, g.m)(cb)`, …), handed to
// every callback method whose callback updates `length` through its array
// parameter (behind any of those shapes the binding is not switched, so the
// store through the parameter is origin/main's). None of these may trap where
// origin/main does not. Same contract as the
// length-update sweep; origin/main's outcomes are in
// issue-7164-callback-sweep-base.json (scripts/record-7164-bases.mts). By
// default every 41st row runs (53 of 2,160, every shape, method and form);
// JS2WASM_FULL_SWEEP=1 runs all.
const CALLBACK_BASE = JSON.parse(
  readFileSync(new URL("./issue-7164-callback-sweep-base.json", import.meta.url), "utf8"),
) as Record<string, Partial<Record<Lane, "wrong" | "trap">>>;
describe("#7164 callback-array escape sweep: never worse than origin/main", () => {
  const rows = callbackRows().filter((_, i) => FULL_SWEEP || i % 41 === 0);
  for (const row of rows) {
    const src = callbackSource(row.wrapper, row.method, row.form);
    for (const { lane, options } of LANES) {
      it(`${row.key} / ${lane}`, async () => {
        let node: string;
        try {
          node = readSummary(evaluateAsJs(src).at as (i: number) => number);
        } catch {
          node = "JSERR"; // `(0, g.forEach)(cb)` loses `this` in JS
        }
        const head = await headSummary(src, options);
        const base = CALLBACK_BASE[row.key]?.[pinLane(lane)] ?? "ok";
        if (base === "ok") expect(head, `${row.key}/${lane}`).toBe(node);
        else if (base === "wrong") expect(head, `${row.key}/${lane}`).not.toMatch(/^(TRAP|CE) /);
      }, 120_000);
    }
  }
});

// (#7164 r11) Assignment-target sweep: an element or `length` of a switched
// binding as a for-of / for-in target, in a destructuring pattern, behind a
// wrapper or a receiver-returning call. Head may trap only where origin/main
// traps and fail to compile only where it does (issue-7164-target-sweep-base.json).
const TARGET_BASE = JSON.parse(
  readFileSync(new URL("./issue-7164-target-sweep-base.json", import.meta.url), "utf8"),
) as Record<string, Partial<Record<Lane, "wrong" | "trap" | "ce">>>;
describe("#7164 assignment-target sweep: never worse than origin/main", () => {
  for (const form of Object.keys(TARGET_FORMS)) {
    const src = targetSource(form);
    for (const { lane, options } of LANES) {
      it(`${form} / ${lane}`, async () => {
        const node = readSummary(evaluateAsJs(src).at as (i: number) => number);
        const head = await headSummary(src, options);
        const base = TARGET_BASE[form]?.[pinLane(lane)] ?? "ok";
        if (base === "ok") expect(head, `${form}/${lane}`).toBe(node);
        if (base !== "trap") expect(head, `${form}/${lane}`).not.toMatch(/^TRAP /);
        if (base !== "ce") expect(head, `${form}/${lane}`).not.toMatch(/^CE /);
      }, 120_000);
    }
  }
});
