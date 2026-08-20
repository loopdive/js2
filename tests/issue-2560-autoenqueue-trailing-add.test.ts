// #2560 — auto-enqueue must keep feeding the queue while a head is forming.
//
// The old back-off in scripts/enqueue-green-prs.mjs skipped the ENTIRE sweep
// whenever any merge-queue entry was AWAITING_CHECKS ("head forming"). Because
// the SERIAL merge queue almost always has a forming head, auto-enqueue then
// rarely added waiting green PRs, so they stranded until a human enqueued them.
//
// The fix: proceed with the sweep even while a head forms, and rely on the
// trailing-add invariant — only enqueue PRs NOT already in the queue. A trailing
// append to the queue tail does NOT change the forming head's merge group and so
// does NOT cancel its in-flight run (only dequeuing/re-adding the HEAD does —
// that was the #1758 cancellation wedge). These tests pin that invariant
// (`isTrailingAddCandidate`) directly — they make no `gh` calls (the live sweep
// is guarded behind an import.meta.url check).

import { describe, expect, it } from "vitest";
import { isTrailingAddCandidate, reconcileAlreadyQueued } from "../scripts/enqueue-green-prs.mjs";

describe("#2560 auto-enqueue trailing-add invariant", () => {
  // The forming HEAD is in the queue snapshot's `queued` set, so it must never
  // be a trailing-add candidate — re-touching it is exactly what cancels its run.
  it("never re-touches the forming head (it is in the queue set)", () => {
    const queued = new Set([101]); // #101 is the forming head
    expect(isTrailingAddCandidate(101, queued)).toBe(false);
  });

  it("never re-touches a stable queued entry either", () => {
    const queued = new Set([101, 102]); // #101 forming head, #102 stable behind it
    expect(isTrailingAddCandidate(102, queued)).toBe(false);
  });

  // A green PR that is NOT in the queue IS a candidate — appending it to the tail
  // is safe even while #101 forms, which is the whole point of dropping the
  // over-broad back-off.
  it("appends a green PR that is not yet queued, even while a head forms", () => {
    const queued = new Set([101]); // #101 is forming
    expect(isTrailingAddCandidate(200, queued)).toBe(true);
  });

  it("treats an empty queue as all-candidates", () => {
    const queued = new Set<number>();
    expect(isTrailingAddCandidate(200, queued)).toBe(true);
    expect(isTrailingAddCandidate(201, queued)).toBe(true);
  });

  // The safety property holds for EVERY queued entry regardless of size: no PR in
  // the queue is ever a candidate, so every enqueue is strictly a tail append.
  it("excludes every queued PR no matter the queue size", () => {
    const queued = new Set([10, 11, 12, 13, 14]);
    for (const n of queued) expect(isTrailingAddCandidate(n, queued)).toBe(false);
    expect(isTrailingAddCandidate(15, queued)).toBe(true);
  });

  it("clears a stale manual-enqueue label while keeping a queued PR on the skip edge", () => {
    const cleared: number[] = [];
    const queued = new Set([101]);

    expect(reconcileAlreadyQueued(101, queued, ["needs-manual-enqueue"], (number) => cleared.push(number))).toBe(true);
    expect(cleared).toEqual([101]);
  });

  it("does not call the labels API for an ordinarily queued PR", () => {
    const cleared: number[] = [];
    const queued = new Set([101]);

    expect(reconcileAlreadyQueued(101, queued, [{ name: "ready" }], (number) => cleared.push(number))).toBe(true);
    expect(cleared).toEqual([]);
  });

  it("does not mutate a stale label during a dry-run sweep", () => {
    const cleared: number[] = [];
    const queued = new Set([101]);

    expect(reconcileAlreadyQueued(101, queued, ["needs-manual-enqueue"], (number) => cleared.push(number), true)).toBe(
      true,
    );
    expect(cleared).toEqual([]);
  });

  it("does not run queued-only cleanup for a trailing enqueue candidate", () => {
    const cleared: number[] = [];
    const queued = new Set([101]);

    expect(reconcileAlreadyQueued(200, queued, ["needs-manual-enqueue"], (number) => cleared.push(number))).toBe(false);
    expect(cleared).toEqual([]);
  });

  it("keeps a queued PR skipped even when best-effort label cleanup fails", () => {
    const queued = new Set([101]);
    const failingCleanup = () => {
      throw new Error("labels API unavailable");
    };

    expect(reconcileAlreadyQueued(101, queued, ["needs-manual-enqueue"], failingCleanup)).toBe(true);
  });
});
