// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3474 — done-status integrity gate. A 2026-07-20 harvest found issues marked
// `status: done` whose cited test262 tests still fail. This gate keys on code
// state (the baseline JSONL) rather than a commit-message grep, so it catches
// drift even when a fix lands without citing the issue. These tests lock in the
// three pure pieces:
//   • extractIssueCites — robust cite extraction (both parenthesized and bare
//     forms; Wasm function-index noise excluded; real-issue cross-reference),
//   • parseIssueFrontmatter — status / done_cited_ok / title, and
//   • classifyDoneCites — the verdict (over-threshold+non-exempt = violation;
//     exempt = exempted; under-threshold = neither).
import { describe, it, expect } from "vitest";
import {
  extractIssueCites,
  parseIssueFrontmatter,
  classifyDoneCites,
} from "../scripts/check-done-status-integrity.mjs";

// A permissive existence predicate for the extractor tests, except where a
// specific set is needed to exercise the cross-reference filter.
const anyIssue = () => true;

describe("#3474 extractIssueCites — robust cite extraction", () => {
  it("extracts a parenthesized cite", () => {
    const s = "This is the late-import index-shift class (#2043): ...";
    expect([...extractIssueCites(s, anyIssue)]).toEqual(["2043"]);
  });

  it("extracts bare forms (colon and prose) that parenthesized-only would miss", () => {
    expect([...extractIssueCites("L26:5 #1387: with statement is deferred", anyIssue)]).toEqual(["1387"]);
    expect([...extractIssueCites("Dynamic fallback is deferred to #1472.", anyIssue)]).toEqual(["1472"]);
  });

  it('excludes Wasm function-index noise (function #N and #N:"name")', () => {
    const s = 'Compiling function #104:"__closure_26" failed';
    expect([...extractIssueCites(s, anyIssue)]).toEqual([]); // #104 is both `function #` AND `#N:"`
  });

  it("keeps a real cite even when a function-index with the same-shape number is present", () => {
    const s = 'function #2025:"__x" — this is the (#2043) class';
    expect([...extractIssueCites(s, anyIssue)].sort()).toEqual(["2043"]);
  });

  it("drops ids that are not real issues (cross-reference filter)", () => {
    const s = "saw #104 and #2043 here";
    const exists = (id: string) => id === "2043"; // only #2043 is a real issue
    expect([...extractIssueCites(s, exists)]).toEqual(["2043"]);
  });

  it("returns empty for empty / undefined error text", () => {
    expect(extractIssueCites("", anyIssue).size).toBe(0);
    expect(extractIssueCites(undefined as unknown as string, anyIssue).size).toBe(0);
  });
});

describe("#3474 parseIssueFrontmatter", () => {
  it("reads status, title, and the done_cited_ok exemption flag", () => {
    const md = ["---", "id: 2961", "status: done", "done_cited_ok: true", 'title: "Leak guard"', "---", "# body"].join(
      "\n",
    );
    const fm = parseIssueFrontmatter(md);
    expect(fm.status).toBe("done");
    expect(fm.doneCitedOk).toBe(true);
    expect(fm.title).toBe("Leak guard");
  });

  it("defaults doneCitedOk to false when absent", () => {
    const fm = parseIssueFrontmatter("---\nid: 1\nstatus: ready\n---\n");
    expect(fm.status).toBe("ready");
    expect(fm.doneCitedOk).toBe(false);
  });
});

describe("#3474 classifyDoneCites — verdict", () => {
  const candidates = new Map([
    ["2043", { status: "done", doneCitedOk: false, title: "late-import class" }],
    ["2961", { status: "done", doneCitedOk: true, title: "leak guard (detector)" }],
    ["9999", { status: "done", doneCitedOk: false, title: "few cites" }],
  ]);
  const counts = new Map([
    ["2043", 42],
    ["2961", 3646],
    ["9999", 3],
  ]);

  it("flags an over-threshold, non-exempt done issue as a violation", () => {
    const { violations } = classifyDoneCites(candidates, counts, 15);
    expect(violations.map((v) => v.id)).toEqual(["2043"]);
    expect(violations[0].cites).toBe(42);
  });

  it("routes an over-threshold EXEMPT issue to exempted, not violations", () => {
    const { violations, exempted } = classifyDoneCites(candidates, counts, 15);
    expect(violations.map((v) => v.id)).not.toContain("2961");
    expect(exempted.map((e) => e.id)).toContain("2961");
  });

  it("ignores an under-threshold issue entirely", () => {
    const { violations, exempted } = classifyDoneCites(candidates, counts, 15);
    expect(violations.map((v) => v.id)).not.toContain("9999");
    expect(exempted.map((e) => e.id)).not.toContain("9999");
  });
});
