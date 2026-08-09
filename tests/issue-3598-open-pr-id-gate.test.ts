// #3598 — PR-level issue-id collision gate must see OPEN PRs, not only main.
//
// Hermetic tests for the pure decision layer of the gate
// (scripts/lib/open-pr-issue-files.mjs). The network scan is NOT exercised —
// its result shape (`byPr: Map<prNumber, paths[]>`) is injected, so these
// tests replace the live synthetic-collision probe the gate was originally
// verified with (which added a fake issue file and needed API access; it was
// deliberately throwaway — see the issue's ## Handover).
//
// The three behaviours proven live during the original implementation:
//   1. different filename, same id, another PR  → COLLISION
//   2. same filename (both PRs touch one file)  → NOT a collision
//   3. the PR under validation is self-excluded → never collides with itself
// plus the top false-positive hazard: a PR whose UNdetected rename lists the
// old path as DELETED must not read as still claiming the old id.

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without type declarations
import { findOpenPrCollisions, issueFileId, liveIssuePaths } from "../scripts/lib/open-pr-issue-files.mjs";

const P = "plan/issues";

describe("#3598 issueFileId", () => {
  it("extracts the filename id, including sub-issue letter suffixes", () => {
    expect(issueFileId(`${P}/3597-auto-park-step-aware.md`)).toBe("3597");
    expect(issueFileId(`${P}/779a-sub-issue.md`)).toBe("779a");
    expect(issueFileId(`${P}/779B-sub-issue.md`)).toBe("779b"); // case-normalised
    expect(issueFileId("3597-bare-filename.md")).toBe("3597");
  });

  it("returns null for non-issue paths", () => {
    expect(issueFileId(`${P}/backlog.md`)).toBeNull();
    expect(issueFileId(`${P}/SCHEMA.md`)).toBeNull();
    expect(issueFileId("src/codegen/index.ts")).toBeNull();
  });
});

describe("#3598 findOpenPrCollisions", () => {
  const introduced3597 = [{ id: "3597", fname: "3597-issue-id-gate.md" }];

  it("flags SAME id under a DIFFERENT filename in another open PR, naming that PR", () => {
    const byPr = new Map([[3585, [`${P}/3597-auto-park-step-aware.md`]]]);
    const collisions = findOpenPrCollisions(introduced3597, byPr, { selfPr: 3589 });
    expect(collisions).toEqual([
      {
        id: "3597",
        fname: "3597-issue-id-gate.md",
        prNumber: 3585,
        otherPath: `${P}/3597-auto-park-step-aware.md`,
      },
    ]);
  });

  it("does NOT flag the same filename — two PRs modifying one issue file", () => {
    // An id-only comparison flagged five innocent PRs when first attempted.
    const byPr = new Map([[3585, [`${P}/3597-issue-id-gate.md`]]]);
    expect(findOpenPrCollisions(introduced3597, byPr, { selfPr: 3589 })).toEqual([]);
  });

  it("self-excludes the PR under validation (never collides with itself)", () => {
    // The scan sees the PR's own file under a different-slug path — without
    // self-exclusion every PR that adds an issue file would fail its own gate.
    const selfOnly = new Map([[3589, [`${P}/3597-completely-different-slug.md`]]]);
    expect(findOpenPrCollisions(introduced3597, selfOnly, { selfPr: 3589 })).toEqual([]);
    // string env value for selfPr (GATE_PR_NUMBER) must match the numeric key
    expect(findOpenPrCollisions(introduced3597, selfOnly, { selfPr: "3589" })).toEqual([]);
    // …and with no selfPr the same input IS a collision (proves the exclusion did the work)
    expect(findOpenPrCollisions(introduced3597, selfOnly, {})).toHaveLength(1);
  });

  it("treats sub-issue ids as distinct — 779a never collides with 779", () => {
    const introduced = [{ id: "779a", fname: "779a-sub-slice.md" }];
    const byPr = new Map([[100, [`${P}/779-parent.md`]]]);
    expect(findOpenPrCollisions(introduced, byPr, { selfPr: 1 })).toEqual([]);
    // …but 779a vs 779a under different slugs IS a collision
    const byPr2 = new Map([[100, [`${P}/779a-other-slice.md`]]]);
    expect(findOpenPrCollisions(introduced, byPr2, { selfPr: 1 })).toHaveLength(1);
  });

  it("reports every colliding PR, deterministically ordered", () => {
    const introduced = [
      { id: "3597", fname: "3597-issue-id-gate.md" },
      { id: "3584", fname: "3584-mine.md" },
    ];
    const byPr = new Map([
      [3585, [`${P}/3597-auto-park-step-aware.md`]],
      [3579, [`${P}/3584-theirs.md`]],
      [3577, [`${P}/3584-also-theirs.md`]],
    ]);
    const collisions = findOpenPrCollisions(introduced, byPr, { selfPr: 9999 });
    expect(collisions.map((c: any) => [c.id, c.prNumber])).toEqual([
      ["3584", 3577],
      ["3584", 3579],
      ["3597", 3585],
    ]);
  });

  it("passes cleanly when no open PR touches issue files", () => {
    expect(findOpenPrCollisions(introduced3597, new Map(), { selfPr: 1 })).toEqual([]);
  });
});

describe("#3598 liveIssuePaths (rename hazard)", () => {
  it("drops DELETED entries — an undetected rename must not claim the old id", () => {
    // PR renumbers 3584-x.md → 3591-x.md; below GitHub's similarity threshold
    // the file list shows ADDED-new + DELETED-old. The old id 3584 must NOT
    // read as claimed by this PR.
    const nodes = [
      { path: `${P}/3591-x.md`, changeType: "ADDED" },
      { path: `${P}/3584-x.md`, changeType: "DELETED" },
    ];
    expect(liveIssuePaths(nodes)).toEqual([`${P}/3591-x.md`]);
  });

  it("keeps ADDED / MODIFIED / RENAMED entries and ignores non-issue paths", () => {
    const nodes = [
      { path: `${P}/3600-a.md`, changeType: "ADDED" },
      { path: `${P}/3601-b.md`, changeType: "MODIFIED" },
      { path: `${P}/3602-c.md`, changeType: "RENAMED" },
      { path: "src/codegen/index.ts", changeType: "MODIFIED" },
      { path: `${P}/backlog.md`, changeType: "MODIFIED" },
    ];
    expect(liveIssuePaths(nodes)).toEqual([`${P}/3600-a.md`, `${P}/3601-b.md`, `${P}/3602-c.md`]);
  });

  it("tolerates missing/odd nodes (defensive against partial GraphQL data)", () => {
    expect(liveIssuePaths(undefined)).toEqual([]);
    expect(liveIssuePaths([{}, { path: "" }, { path: null }] as any)).toEqual([]);
  });
});
