// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2879 §2/§4 — the standalone high-water floor measures HOST-FREE-ness.
//
// §2: `passFromReport` keys on `full_summary.host_free_pass` (status==pass AND no
//     `env::` host import) rather than the leaky raw `pass`, and the committed
//     high-water file is re-baselined to the honest host-free number.
// §4: a mid-flight carrier migration that drops the raw `pass` (any-imports) but
//     holds `host_free_pass` does NOT breach the floor — the floor is keyed on
//     host_free_pass, so converting a host-satisfied leaky pass into an
//     in-progress native carrier is scored as progress, not a regression.
import { describe, it, expect } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  passFromReport,
  officialFromReport,
  evaluate,
  HIGHWATER_PATH,
} from "../scripts/check-standalone-highwater.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function writeReport(name: string, obj: unknown): string {
  const tmp = resolve(ROOT, ".test262-cache", `issue-2879-${name}.json`);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, JSON.stringify(obj));
  return tmp;
}

describe("#2879 §2 — passFromReport keys on host_free_pass", () => {
  it("prefers full_summary.host_free_pass over the leaky pass", () => {
    const tmp = writeReport("hostfree", { full_summary: { pass: 26039, host_free_pass: 12883 } });
    expect(passFromReport(tmp)).toBe(12883);
  });

  it("falls back to full_summary.pass when host_free_pass is absent (older report shape)", () => {
    const tmp = writeReport("legacy", { full_summary: { pass: 4242 }, summary: { pass: 1 } });
    expect(passFromReport(tmp)).toBe(4242);
  });

  it("officialFromReport prefers official_summary.host_free_pass", () => {
    const tmp = writeReport("official", {
      official_summary: { pass: 24899, host_free_pass: 12551, total: 43136 },
    });
    expect(officialFromReport(tmp)).toEqual({ pass: 12551, total: 43136 });
  });
});

describe("#2879 §4 — carrier-migration crediting (raw pass dip does not breach)", () => {
  const mark = { pass: 12883, tolerance: 50 };

  it("a mid-flight migration that only drops raw pass holds the host-free floor", () => {
    // The gate reads host_free_pass (12883), NOT the dropped raw pass (20000).
    const tmp = writeReport("s4", {
      full_summary: { pass: 20000, host_free_pass: 12883 },
    });
    const hostFree = passFromReport(tmp);
    expect(hostFree).toBe(12883);
    expect(evaluate(hostFree, mark, 50).ok).toBe(true);
  });

  it("a genuine host-free pass drop DOES breach", () => {
    const tmp = writeReport("breach", { full_summary: { pass: 26000, host_free_pass: 12000 } });
    expect(evaluate(passFromReport(tmp), mark, 50).ok).toBe(false);
  });

  it("a host-free improvement is scored as progress (delta > 0)", () => {
    const tmp = writeReport("improve", { full_summary: { pass: 26100, host_free_pass: 12950 } });
    expect(evaluate(passFromReport(tmp), mark, 50).delta).toBeGreaterThan(0);
  });
});

describe("#2879 §2 — the committed high-water file is re-baselined to the honest number", () => {
  it("the committed mark is the host-free count (~12.9k), not the leaky ~26k", () => {
    const mark = JSON.parse(readFileSync(HIGHWATER_PATH, "utf-8"));
    expect(Number.isInteger(mark.pass)).toBe(true);
    // Honest host-free count is roughly half the old leaky 26k — assert it is in
    // the honest band and well below the old inflated figure.
    expect(mark.pass).toBeGreaterThan(10000);
    expect(mark.pass).toBeLessThan(20000);
    expect(mark.tolerance).toBe(50);
  });
});
