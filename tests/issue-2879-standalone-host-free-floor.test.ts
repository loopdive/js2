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
  hostFreeFromReport,
  officialHostFreeFromReport,
  markHostFree,
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
  // (#3726) These two cases originally asserted `pass < 20000` — the band that
  // separated the honest host-free count (~12.9k at the time) from the leaky raw
  // one (~26k). That ceiling was a SNAPSHOT of a deliberately RATCHETING metric,
  // so every legitimate improvement walked toward it, and #3592's measured
  // post-de-vacuification re-raise to 22,626 crossed it — failing this suite on
  // `main` itself, where it sat red because these cases are not in a required
  // check.
  //
  // The ceiling is not what actually distinguishes honest from leaky, and never
  // was: the real guarantee is #2889's self-describing `host_free_pass` field,
  // which the WRITE side refuses to synthesize from a leaky `pass` (asserted by
  // `hostFreeFromReport returns null when host_free_pass is ABSENT` below). So
  // assert the properties that stay true as the floor ratchets — the field is
  // present, it agrees with `pass`, and the mark is bounded by the corpus rather
  // than by a number someone wrote down in July — and drop the magnitude
  // ceiling that only ever encoded "today's value".
  it("the committed mark is an honest host-free count, not the leaky raw pass", () => {
    const mark = JSON.parse(readFileSync(HIGHWATER_PATH, "utf-8"));
    expect(Number.isInteger(mark.pass)).toBe(true);
    // Lower bound only: the floor ratchets UP, so a floor never goes stale.
    expect(mark.pass).toBeGreaterThan(10000);
    // Structural ceiling: a mark above the corpus size is nonsense by
    // construction, and this bound moves with the corpus instead of rotting.
    expect(mark.pass).toBeLessThanOrEqual(mark.official_total);
    expect(mark.tolerance).toBe(50);
  });

  it("(#2889) the committed mark carries an explicit host_free_pass field == pass", () => {
    const mark = JSON.parse(readFileSync(HIGHWATER_PATH, "utf-8"));
    // The self-describing field is what makes a future leaky clobber impossible.
    expect(Number.isInteger(mark.host_free_pass)).toBe(true);
    expect(mark.host_free_pass).toBe(mark.pass);
    expect(mark.host_free_pass).toBeGreaterThan(10000);
    expect(mark.host_free_pass).toBeLessThanOrEqual(mark.official_total);
  });
});

describe("#2889 — the WRITE side keys on host_free_pass and refuses to clobber", () => {
  it("hostFreeFromReport reads full_summary.host_free_pass (the ratchet value)", () => {
    const tmp = writeReport("w-hf", { full_summary: { pass: 26039, host_free_pass: 12883 } });
    expect(hostFreeFromReport(tmp)).toBe(12883);
  });

  it("hostFreeFromReport returns null when host_free_pass is ABSENT (no leaky fallback)", () => {
    // A pre-#2879-§1 / leak-less report shape: only a leaky `pass`. The WRITE
    // reader must NOT fall back to it — returning null tells --update to refuse
    // to raise, so the leaky 26k can never inflate the honest mark (d4bc147d3).
    const tmp = writeReport("w-legacy", { full_summary: { pass: 26039 } });
    expect(hostFreeFromReport(tmp)).toBeNull();
  });

  it("officialHostFreeFromReport reads official_summary.host_free_pass strictly", () => {
    const tmp = writeReport("w-off", {
      official_summary: { pass: 24899, host_free_pass: 12551, total: 43136 },
    });
    expect(officialHostFreeFromReport(tmp)).toEqual({ pass: 12551, total: 43136 });
  });

  it("officialHostFreeFromReport returns null when official host_free_pass is absent", () => {
    const tmp = writeReport("w-off-legacy", { official_summary: { pass: 24899, total: 43136 } });
    expect(officialHostFreeFromReport(tmp)).toBeNull();
  });

  it("markHostFree prefers host_free_pass, falls back to pass for pre-#2889 marks", () => {
    expect(markHostFree({ host_free_pass: 12883, pass: 12883 })).toBe(12883);
    // A mark written before the field existed (§2 stored host-free in `pass`).
    expect(markHostFree({ pass: 12883 })).toBe(12883);
    expect(markHostFree(null)).toBe(0);
  });

  it("evaluate keys on the mark's host_free_pass when present", () => {
    const mark = { pass: 12883, host_free_pass: 12883, tolerance: 50 };
    expect(evaluate(12883, mark, 50).ok).toBe(true);
    expect(evaluate(12832, mark, 50).ok).toBe(false); // below floor 12833
    expect(evaluate(12833, mark, 50).ok).toBe(true);
  });
});
