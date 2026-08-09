// #2975 — auto-enqueue must not re-add a PR in the ~5-16s race window between
// its merge_group failure and auto-park's `hold` label landing.
//
// auto-enqueue (primary enqueuer since #2786, grace 0) and auto-park (#2547)
// both react to the same failed merge_group run. GitHub removes the failed PR
// from the queue; auto-park adds `hold` a few seconds later. In that gap the
// sweep still sees the PR as CLEAN + green + un-`hold`-labelled and re-adds it,
// wasting a full doomed merge_group run. The park-race guard derives the park
// decision from the same FAILED-RUN signal auto-park uses (not the label), so it
// is race-free.
//
// These tests pin the two PURE decision helpers directly — they make NO `gh`
// calls (the live sweep and its gh-api helpers are behind the import.meta.url
// guard and are not exported). The live helpers are FAIL-SAFE by construction:
// every one returns the value that makes the sweep fall back to current
// (enqueue) behavior on any error, so a bug there can only fail-to-skip, never
// strand a good PR.

import { describe, expect, it } from "vitest";
import {
  baseShaFromMergeQueueBranch,
  prNumberFromMergeQueueBranch,
  prNumbersFromMergeGroupSubjects,
  shouldSkipParkingRace,
} from "../scripts/enqueue-green-prs.mjs";

describe("#2975 park-race guard — merge-queue branch parsing", () => {
  it("parses the PR number from a gh-readonly-queue synthetic branch", () => {
    expect(prNumberFromMergeQueueBranch("gh-readonly-queue/main/pr-2975-0a1b2c3d4e5f")).toBe(2975);
  });

  it("parses a non-main base branch too", () => {
    expect(prNumberFromMergeQueueBranch("gh-readonly-queue/release/pr-12-abcdef0")).toBe(12);
  });

  it("returns null for a non-queue branch (never attribute a stray run to a PR)", () => {
    expect(prNumberFromMergeQueueBranch("main")).toBe(null);
    expect(prNumberFromMergeQueueBranch("issue-2975-failure-aware-enqueue")).toBe(null);
    expect(prNumberFromMergeQueueBranch("")).toBe(null);
    // @ts-expect-error — defensive against non-string input
    expect(prNumberFromMergeQueueBranch(undefined)).toBe(null);
  });
});

// #3914 — `pr-<N>` in the queue ref names only the LAST entry in the group. On
// a serial queue that is the whole group, but under `min_entries_to_merge > 1`
// the guard has to implicate every member of a failed group, or the other N-1
// look un-failed and get re-added straight into the race this guard prevents.
describe("#3914 park-race guard — batched merge groups", () => {
  it("extracts the group's base sha from the queue ref", () => {
    // Live shape, run 30631849709: the trailing sha is the BASE the group was
    // built on, not the run's own head sha.
    expect(baseShaFromMergeQueueBranch("gh-readonly-queue/main/pr-3892-a19c4abeaf741e9b8ee74c51e42e18af48df9d4e")).toBe(
      "a19c4abeaf741e9b8ee74c51e42e18af48df9d4e",
    );
    expect(baseShaFromMergeQueueBranch("gh-readonly-queue/release/pr-12-abcdef0")).toBe("abcdef0");
  });

  it("returns null base sha for a non-queue branch", () => {
    expect(baseShaFromMergeQueueBranch("main")).toBe(null);
    // @ts-expect-error — defensive against non-string input
    expect(baseShaFromMergeQueueBranch(undefined)).toBe(null);
  });

  it("names every member PR of a batched group, in queue order", () => {
    expect(
      prNumbersFromMergeGroupSubjects([
        "Merge pull request #3890 from ttraenkler/docs-x\n\nbody text",
        "Merge pull request #3891 from ttraenkler/issue-y",
        "Merge pull request #3892 from ttraenkler/issue-z",
      ]),
    ).toEqual([3890, 3891, 3892]);
  });

  it("resolves a serial group to exactly one PR (today's behaviour, unchanged)", () => {
    expect(prNumbersFromMergeGroupSubjects(["Merge pull request #3892 from ttraenkler/issue-z"])).toEqual([3892]);
  });

  it("recognises the squash-commit subject shape and dedupes", () => {
    expect(prNumbersFromMergeGroupSubjects(["fix(#3647): non-enumerable prototype members (#3892)"])).toEqual([3892]);
    expect(
      prNumbersFromMergeGroupSubjects(["Merge pull request #3892 from a/b", "Merge pull request #3892 from a/b"]),
    ).toEqual([3892]);
  });

  it("returns nothing for subjects with no PR reference (caller falls back)", () => {
    // @ts-expect-error — defensive against non-string entries
    expect(prNumbersFromMergeGroupSubjects(["chore: no pr reference", null, 42])).toEqual([]);
    expect(prNumbersFromMergeGroupSubjects(undefined)).toEqual([]);
  });
});

describe("#2975 park-race guard — skip decision", () => {
  it("does NOT skip when there is no merge_group failure signal", () => {
    expect(shouldSkipParkingRace({})).toBe(false);
    expect(shouldSkipParkingRace({ mergeGroupFailedAtMs: 0 })).toBe(false);
  });

  it("SKIPS a PR with a genuine failure and no later hold-removal (about to be parked)", () => {
    expect(shouldSkipParkingRace({ mergeGroupFailedAtMs: 1000 })).toBe(true);
    // a hold-removal BEFORE the failure does not count as a re-admission
    expect(shouldSkipParkingRace({ mergeGroupFailedAtMs: 2000, holdRemovedAtMs: 1000 })).toBe(true);
  });

  it("does NOT skip when a hold was removed AFTER the failure (deliberate re-admission)", () => {
    // acceptance criterion 2: a human/agent removing `hold` gets exactly one
    // prompt re-admission — the guard must not dead-lock it.
    expect(shouldSkipParkingRace({ mergeGroupFailedAtMs: 1000, holdRemovedAtMs: 2000 })).toBe(false);
  });

  it("real #2517 timeline: re-admitted at 08:13:47Z then re-failed at 08:22:48Z → still skip", () => {
    // Observed on 2026-07-03: hold removed (re-admitted), the PR re-entered the
    // queue and FAILED merge_group again — so the latest failure is newer than
    // the removal and the guard correctly re-skips it (auto-park re-holds it).
    const holdRemovedAtMs = Date.parse("2026-07-03T08:13:47Z");
    const mergeGroupFailedAtMs = Date.parse("2026-07-03T08:22:48Z");
    expect(shouldSkipParkingRace({ mergeGroupFailedAtMs, holdRemovedAtMs })).toBe(true);
  });
});
