// #6979 S7-e — the conformance trend graph after the JS-host lane's retirement.
//
// Stakeholder decision (2026-11-05, recorded in #5385): the JS-host series
// stays on the graph as a BACKGROUND series, frozen at the 2026-10-12
// retirement — historical context, visually subdued, not interactive — and
// the standalone series is the only interactive one. These tests pin the two
// data-side halves of that: the host lane ends at the retirement date (it is
// neither carried forward to "now" nor extended by later standalone points),
// and the standalone lane is untouched.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module without type declarations
import * as trend from "../website/components/t262-conformance-trend.js";

const { T262_HOST_LANE_RETIRED_AT, t262ClipLaneAt, t262MergeConformanceLanes } = trend as any;

const day = (iso: string, rate: number) => {
  const time = new Date(iso).getTime();
  return { label: iso.slice(5, 10), timestamp: iso, time, rate, pass: rate, total: 100 };
};

describe("#6979 S7-e — retired JS-host lane on the trend graph", () => {
  it("retires the host lane on 2026-10-12", () => {
    expect(T262_HOST_LANE_RETIRED_AT.toISOString().slice(0, 10)).toBe("2026-10-12");
  });

  it("clips the host lane at retirement and ends it exactly on the retirement date", () => {
    // The last point is the "hold the last value out to now" extension that
    // t262BuildHistoryPoints adds for a stale lane — it must not survive.
    const host = [
      day("2026-09-01T00:00:00Z", 70),
      day("2026-10-10T00:00:00Z", 81.6),
      day("2026-11-05T00:00:00Z", 81.6),
    ];
    const clipped = t262ClipLaneAt(host, T262_HOST_LANE_RETIRED_AT);
    expect(clipped.map((p: any) => p.rate)).toEqual([70, 81.6, 81.6]);
    expect(clipped.at(-1).time).toBe(T262_HOST_LANE_RETIRED_AT.getTime());
  });

  it("leaves a lane that already ends before retirement as it is", () => {
    const host = [day("2026-09-01T00:00:00Z", 70), day("2026-10-01T00:00:00Z", 80)];
    expect(t262ClipLaneAt(host, T262_HOST_LANE_RETIRED_AT)).toEqual(host);
  });

  it("does not carry the host value forward across later standalone points", () => {
    const host = t262ClipLaneAt(
      [day("2026-09-01T00:00:00Z", 70), day("2026-10-10T00:00:00Z", 81.6), day("2026-11-05T00:00:00Z", 81.6)],
      T262_HOST_LANE_RETIRED_AT,
    );
    const standalone = [
      day("2026-09-15T00:00:00Z", 80),
      day("2026-10-20T00:00:00Z", 87),
      day("2026-11-04T00:00:00Z", 88),
    ];
    const merged = t262MergeConformanceLanes(host, standalone, { hostEndsAt: T262_HOST_LANE_RETIRED_AT });
    const after = merged.filter((p: any) => p.time > T262_HOST_LANE_RETIRED_AT.getTime());
    expect(after.length).toBeGreaterThan(0);
    for (const p of after) expect(p.hostRate).toBeNull();
    // The standalone lane is still carried forward as before.
    expect(merged.at(-1).standaloneRate).toBe(88);
  });

  it("without hostEndsAt the merge keeps its old carry-forward behaviour", () => {
    const host = [day("2026-09-01T00:00:00Z", 70), day("2026-09-02T00:00:00Z", 71)];
    const standalone = [day("2026-09-01T12:00:00Z", 80), day("2026-11-01T00:00:00Z", 88)];
    const merged = t262MergeConformanceLanes(host, standalone);
    expect(merged.at(-1).hostRate).toBe(71);
  });
});
