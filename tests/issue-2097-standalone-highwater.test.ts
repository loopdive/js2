// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2097 — absolute standalone pass-count high-water floor.
 *
 * The #1897 standalone regression gate is a MOVING floor (re-seeded from the
 * new baseline on every push to main), so a sequence of small net-negative PRs
 * — each within the per-PR tolerance — compounds undetected. The high-water
 * mark is an ABSOLUTE reference that only ever ratchets UP, so a compounding
 * slide eventually breaches `mark − tolerance` and fails loudly.
 *
 * This pins the pure decision logic of `scripts/check-standalone-highwater.mjs`
 * (the CI step is exercised by the workflow itself) plus the committed mark's
 * shape.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, passFromReport, loadHighwater, HIGHWATER_PATH } from "../scripts/check-standalone-highwater.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

describe("#2097 — high-water evaluate()", () => {
  const mark = { pass: 21184, tolerance: 50 };

  it("passes when current pass is at the mark", () => {
    const r = evaluate(21184, mark, 50);
    expect(r.ok).toBe(true);
    expect(r.floor).toBe(21134);
    expect(r.delta).toBe(0);
  });

  it("passes when within tolerance below the mark", () => {
    expect(evaluate(21140, mark, 50).ok).toBe(true); // 21140 >= 21134
    expect(evaluate(21134, mark, 50).ok).toBe(true); // exactly the floor
  });

  it("fails when below mark − tolerance (a compounding slide)", () => {
    const r = evaluate(21133, mark, 50);
    expect(r.ok).toBe(false);
    expect(r.delta).toBe(-51);
  });

  it("passes (no breach) when no committed mark exists yet — the --update path seeds it", () => {
    expect(evaluate(12345, null, 50).ok).toBe(true);
  });

  it("honors a per-mark tolerance over the CLI default", () => {
    // mark carries tolerance:10 → floor is 21174, so 21150 breaches even though
    // it would pass under the default-50 floor (21134).
    expect(evaluate(21150, { pass: 21184, tolerance: 10 }, 50).ok).toBe(false);
  });
});

describe("#2097 — passFromReport() reads full_summary.pass", () => {
  it("prefers full_summary.pass", () => {
    const tmp = resolve(ROOT, ".test262-cache/issue-2097-probe-report.json");
    // Reuse the cache dir (gitignored). Write a minimal report shape.
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(dirname(tmp), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ full_summary: { pass: 4242 }, summary: { pass: 1 } }));
    expect(passFromReport(tmp)).toBe(4242);
  });
});

describe("#2097 — committed high-water file is well-formed", () => {
  it("has an integer pass count and a numeric tolerance", () => {
    const raw = readFileSync(HIGHWATER_PATH, "utf-8");
    const mark = JSON.parse(raw);
    expect(Number.isInteger(mark.pass)).toBe(true);
    expect(mark.pass).toBeGreaterThan(1000); // never a corrupt/empty seed
    expect(typeof mark.tolerance).toBe("number");
    // loadHighwater() returns the same object.
    expect(loadHighwater()?.pass).toBe(mark.pass);
  });
});
