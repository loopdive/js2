// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The dashboard must not present ONE measurement time over a corpus whose
 * packages were measured at different moments.
 *
 * WHY: until 2026-08-23 every package was measured in one run, so the
 * artifact's `generatedAt` really was when every number on the page was taken,
 * and the header rendered it directly. The per-package split (#4796) ended
 * that: packages now measure in independent CI rows, the fast 22 promote about
 * 12 minutes after a merge, and react-dom (3-4 h) and lit (~40 min) promote on
 * their own cadence. On the day of the split the page said "measured
 * 2026-08-23 15:27 UTC" above react-dom figures from 2026-08-20 — a 3-day skew
 * presented as a single moment.
 *
 * These assertions pin the two halves of the fix: the header describes the
 * SPREAD and names who is behind, and every card carries its own timestamp so
 * freshness reads as a per-package property rather than an exception.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const component = readFileSync(resolve(ROOT, "website/components/npm-compat-chart.js"), "utf8");

/**
 * Exercise the real `_measuredSummary` without a DOM: pull the method off the
 * component source and call it with the escaping/formatting helpers it needs.
 * A raw-text pin would pass on a header that renders the right words in the
 * wrong order; this runs the actual string the reader sees.
 */
function measuredSummary(data: unknown): string {
  const body = component.slice(
    component.indexOf("  _measuredSummary(data) {"),
    component.indexOf("  // ratio = nodeUs / wasmUs"),
  );
  expect(body).not.toBe("");
  const host = {
    _fmtDate(iso: string) {
      if (!iso) return "";
      const d = new Date(iso);
      return Number.isNaN(d.valueOf()) ? "" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    },
  };
  // eslint-disable-next-line no-new-func
  const holder = new Function(`return ({ ${body} });`)();
  return holder._measuredSummary.call(host, data);
}

describe("npm-compat page header describes the measurement SPREAD", () => {
  it("shows a single timestamp when every package was measured in the same run", () => {
    const text = measuredSummary({
      generatedAt: "2026-08-23T15:27:53.000Z",
      measuredRange: {
        oldest: "2026-08-23T15:20:00.000Z",
        newest: "2026-08-23T15:27:53.000Z",
      },
      refresh: {
        status: "complete",
        stalePackages: [],
        freshCount: 24,
        totalCount: 24,
      },
    });

    expect(text).toBe("2026-08-23 15:27 UTC");
  });

  it("names the packages left behind and how old they are", () => {
    const text = measuredSummary({
      generatedAt: "2026-08-23T15:27:53.000Z",
      measuredRange: {
        oldest: "2026-08-20T18:44:18.000Z",
        newest: "2026-08-23T15:27:53.000Z",
      },
      refresh: {
        status: "partial",
        stalePackages: ["lit", "react-dom"],
        freshCount: 22,
        totalCount: 24,
      },
    });

    expect(text).toContain("2026-08-23 15:27 UTC");
    expect(text).toContain("22 of 24 packages");
    expect(text).toContain("lit, react-dom");
    expect(text).toContain("2026-08-20 18:44 UTC");
  });

  it("falls back to generatedAt for an artifact written before measuredRange existed", () => {
    const text = measuredSummary({ generatedAt: "2026-08-20T18:44:18.000Z" });
    expect(text).toBe("2026-08-20 18:44 UTC");
  });

  it("never renders the bare assembly time when packages are out of sync", () => {
    // The specific regression: `textContent = this._fmtDate(data.generatedAt)`.
    expect(component).not.toContain("measuredDate.textContent = this._fmtDate(data.generatedAt)");
    expect(component).toContain("this._measuredSummary(data)");
  });
});

describe("every npm-compat card carries its own measurement time", () => {
  it("renders a measured row from the package's own stamp, not only for stale rows", () => {
    const card = component.slice(component.indexOf("const measuredAt = pkg.measuredAt"));
    expect(card).toContain("pkg.measuredAt ?? pkg.refresh?.lastMeasuredAt");
    // The stale case still says so, but it is no longer the ONLY case that
    // gets a date.
    expect(card).toContain("not re-measured in this run");
    expect(card).toMatch(/this\._row\(\s*"measured"/);
  });
});
