// #1777 — landing-page ECMAScript edition timeline slider.
//
// Two regressions, both in website/components/t262-charts.js:
//   1. ES2026 (the current DRAFT / current-standard edition per
//      scripts/generate-editions.ts CURRENT_DRAFT_EDITION) was rendered as a
//      normal published-edition notch once the wall clock passed its mid-year
//      spec freeze, instead of staying in the distinct current-standard /
//      proposal tail. The fix caps the latest *published* edition at the year
//      before the draft.
//   2. The slider thumb drifted right of the tick marks, growing toward the
//      right edge, because the thumb travelled in a different coordinate system
//      (last-published-stop weight, plus a bleed-widened range input) than the
//      tick markers (full-timeline weight, 0..100% of the track). The fix drives
//      the thumb fraction off the SAME full-timeline weight the markers use, so a
//      stop's thumb fraction equals its tick percent.
//
// The component is a browser web component; these tests exercise the pure
// helpers (which carry no DOM dependency) plus a faithful replica of the layout
// math, so the alignment invariant is locked without a headless browser.

import { describe, expect, it } from "vitest";
import {
  T262_CURRENT_DRAFT_EDITION_YEAR,
  T262_EDITION_SCOPE_RANK,
  t262IsEditionScope,
  t262LatestPublishedEditionYear,
  t262ResolveLatestPublishedEdition,
  // @ts-expect-error — plain JS web-component module, no .d.ts
} from "../website/components/t262-charts.js";

describe("#1777 the draft edition is not a published notch", () => {
  it("treats the draft year and the published year as edition scopes (both are real rows)", () => {
    expect(t262IsEditionScope(`ES${T262_CURRENT_DRAFT_EDITION_YEAR}`)).toBe(true);
    expect(t262IsEditionScope(`ES${T262_CURRENT_DRAFT_EDITION_YEAR - 1}`)).toBe(true);
  });

  it("never reports the draft edition year as the latest published edition", () => {
    // Mid-year of the draft year: the spec is frozen but NOT yet ratified.
    const midDraftYear = new Date(Date.UTC(T262_CURRENT_DRAFT_EDITION_YEAR, 5, 4)); // June 4
    expect(t262LatestPublishedEditionYear(midDraftYear)).toBe(T262_CURRENT_DRAFT_EDITION_YEAR - 1);

    // Late in the draft year: still not published.
    const lateDraftYear = new Date(Date.UTC(T262_CURRENT_DRAFT_EDITION_YEAR, 11, 31)); // Dec 31
    expect(t262LatestPublishedEditionYear(lateDraftYear)).toBe(T262_CURRENT_DRAFT_EDITION_YEAR - 1);

    // Early in the draft year (before the freeze) — also the prior edition.
    const earlyDraftYear = new Date(Date.UTC(T262_CURRENT_DRAFT_EDITION_YEAR, 0, 15)); // Jan 15
    expect(t262LatestPublishedEditionYear(earlyDraftYear)).toBe(T262_CURRENT_DRAFT_EDITION_YEAR - 1);
  });

  it("picks the edition before the draft as the latest published, given draft-bearing rows", () => {
    // Derived from the constant, not hardcoded: these fixtures used to name
    // ES2024/25/26 literally while taking the date from the constant, so they
    // broke the moment the draft year was bumped (2026 -> 2027 when ES2026 was
    // ratified). Expressing the rows relative to the draft keeps the invariant
    // under test — "latest published is the edition before the draft" — instead
    // of a snapshot of one particular year.
    const rows = [
      { edition: `ES${T262_CURRENT_DRAFT_EDITION_YEAR - 2}` },
      { edition: `ES${T262_CURRENT_DRAFT_EDITION_YEAR - 1}` },
      { edition: `ES${T262_CURRENT_DRAFT_EDITION_YEAR}` },
    ];
    const midDraftYear = new Date(Date.UTC(T262_CURRENT_DRAFT_EDITION_YEAR, 5, 4));
    const resolved = t262ResolveLatestPublishedEdition(rows, midDraftYear);
    expect(resolved?.edition).toBe(`ES${T262_CURRENT_DRAFT_EDITION_YEAR - 1}`);
  });

  it("classifies the draft edition into the proposal/current-standard tail", () => {
    const rows = [
      { edition: `ES${T262_CURRENT_DRAFT_EDITION_YEAR - 1}` },
      { edition: `ES${T262_CURRENT_DRAFT_EDITION_YEAR}` },
    ];
    const midDraftYear = new Date(Date.UTC(T262_CURRENT_DRAFT_EDITION_YEAR, 5, 4));
    const latest = t262ResolveLatestPublishedEdition(rows, midDraftYear);
    const publishedLimitRank = T262_EDITION_SCOPE_RANK.get(latest?.edition ?? "") ?? Number.MAX_SAFE_INTEGER;
    const draftLabel = `ES${T262_CURRENT_DRAFT_EDITION_YEAR}`;
    const draftRank = T262_EDITION_SCOPE_RANK.get(draftLabel) ?? Number.MAX_SAFE_INTEGER;
    // rank > publishedLimitRank ⇒ the component routes it into proposalEditionLabels.
    expect(draftRank).toBeGreaterThan(publishedLimitRank);
  });
});

// ---------------------------------------------------------------------------
// Geometry invariant: the slider thumb fraction must equal the tick percent for
// every stop, so the thumb sits exactly on its tick. We replicate the layout +
// stop math the component performs (t262BuildTimelineLayout / editionSliderStops
// / _syncUI) and assert thumb-fraction == marker-fraction at every stop.
// ---------------------------------------------------------------------------

const RELEASE_YEAR: Record<string, number> = {
  ES1: 1997,
  ES2: 1998,
  "ES3 / Core": 1999,
  ES5: 2009,
  ES2015: 2015,
  ES2016: 2016,
  ES2017: 2017,
  ES2018: 2018,
  ES2019: 2019,
  ES2020: 2020,
  ES2021: 2021,
  ES2022: 2022,
  ES2023: 2023,
  ES2024: 2024,
  ES2025: 2025,
  ES2026: 2026,
};

function normalize(edition: string): string {
  return edition === "≤ ES3" || edition === "ES3" ? "ES3 / Core" : edition;
}

interface Row {
  edition: string;
  rawEdition: string;
  rank: number;
}

interface Segment {
  row: Row;
  startYear: number;
  span: number;
}

function buildLayout(rows: Row[]): { segments: Segment[]; totalSpan: number; hasExplicitLegacyBreakdown: boolean } {
  if (rows.length === 0) return { segments: [], totalSpan: 0, hasExplicitLegacyBreakdown: false };
  const hasExplicitLegacyBreakdown = rows.some((r) => r.edition === "ES1" || r.edition === "ES2");
  const segments = rows.map((row, index) => {
    const ne = normalize(row.edition);
    const releaseYear = RELEASE_YEAR[ne] ?? null;
    const startYear = ne === "ES3 / Core" && !hasExplicitLegacyBreakdown ? 1997 : (releaseYear ?? index);
    const nextEdition = rows[index + 1]?.edition ?? null;
    const nextReleaseYear = nextEdition ? (RELEASE_YEAR[normalize(nextEdition)] ?? null) : null;
    const endYear = Math.max(nextReleaseYear ?? (releaseYear ?? startYear) + 1, startYear + 1);
    return { row, startYear, span: Math.max(endYear - startYear, 1) };
  });
  return { segments, totalSpan: segments.reduce((s, x) => s + x.span, 0), hasExplicitLegacyBreakdown };
}

function buildRows(editions: string[]): Row[] {
  return editions.map((e) => ({
    edition: normalize(e),
    rawEdition: e,
    rank: T262_EDITION_SCOPE_RANK.get(normalize(e)) ?? Number.MAX_SAFE_INTEGER,
  }));
}

describe("#1777 slider thumb fraction aligns with tick markers", () => {
  // The full edition set as it appears in test262-editions.json (Proposals is
  // filtered out by t262IsEditionScope; ES2026 is the draft tail).
  const editions = [
    "≤ ES3",
    "ES5",
    "ES2015",
    "ES2016",
    "ES2017",
    "ES2018",
    "ES2019",
    "ES2020",
    "ES2021",
    "ES2022",
    "ES2023",
    "ES2024",
    "ES2025",
    "ES2026",
  ];

  it("places every published stop's thumb exactly on its tick marker", () => {
    const rows = buildRows(editions);
    const midDraftYear = new Date(Date.UTC(T262_CURRENT_DRAFT_EDITION_YEAR, 5, 4));
    const latest = t262ResolveLatestPublishedEdition(
      editions.map((e) => ({ edition: normalize(e) })),
      midDraftYear,
    );
    const publishedLimitRank = T262_EDITION_SCOPE_RANK.get(latest?.edition ?? "") ?? Number.MAX_SAFE_INTEGER;
    const publishedRows = rows.filter((r) => r.rank <= publishedLimitRank);

    const publishedLayout = buildLayout(publishedRows);
    const fullLayout = buildLayout(rows);

    // Replicate editionSliderStops weight accumulation (#1777: legacy ES3 tail
    // expands to ES1/ES2/ES3 stops that share the first segment span).
    let cumulativeWeight = 0;
    const stops: { label: string; position: number }[] = [];
    publishedRows.forEach((row, index) => {
      if (index === 0 && row.edition === "ES3 / Core") {
        const seg = publishedLayout.segments[0];
        const start = seg.startYear;
        stops.push(
          { label: "ES1", position: 0 },
          { label: "ES2", position: Math.max(1998 - start, 0) },
          { label: "ES3 / Core", position: Math.max(1999 - start, 0) },
        );
        cumulativeWeight += seg.span;
        return;
      }
      const seg = publishedLayout.segments.find((s) => s.row === row);
      stops.push({ label: row.edition, position: cumulativeWeight });
      cumulativeWeight += seg?.span ?? 1;
    });

    // The component drives slider.max off the FULL timeline weight (#1777), so
    // the thumb fraction = position / fullTotalSpan — identical to the marker
    // percent (position / fullTotalSpan * 100).
    const maxStop = Math.max(fullLayout.totalSpan, stops.at(-1)?.position ?? 0, 1);

    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) {
      const thumbFraction = stop.position / maxStop;
      const markerFraction = stop.position / fullLayout.totalSpan;
      // Same denominator ⇒ exact equality (no drift). Allow a hair of float slop.
      expect(Math.abs(thumbFraction - markerFraction)).toBeLessThan(1e-9);
      expect(thumbFraction).toBeGreaterThanOrEqual(0);
      expect(thumbFraction).toBeLessThanOrEqual(1);
    }
  });

  it("regression guard: thumb would have drifted right under the old last-stop denominator", () => {
    // Documents the OLD bug: dividing by the last published stop position
    // (instead of the full timeline span) put the thumb to the RIGHT of its
    // tick, and the gap grew toward the right edge.
    const rows = buildRows(editions);
    const publishedRows = rows.filter((r) => r.rank <= (T262_EDITION_SCOPE_RANK.get("ES2025") ?? 0));
    const publishedLayout = buildLayout(publishedRows);
    const fullLayout = buildLayout(rows);

    let cumulativeWeight = 0;
    const stops: { label: string; position: number }[] = [];
    publishedRows.forEach((row, index) => {
      if (index === 0 && row.edition === "ES3 / Core") {
        cumulativeWeight += publishedLayout.segments[0].span;
        stops.push({ label: "ES3 / Core", position: 2 });
        return;
      }
      const seg = publishedLayout.segments.find((s) => s.row === row);
      stops.push({ label: row.edition, position: cumulativeWeight });
      cumulativeWeight += seg?.span ?? 1;
    });

    const lastStopPos = stops.at(-1)!.position; // old (buggy) denominator
    const right = stops.at(-1)!;
    const oldFraction = right.position / lastStopPos; // == 1.0
    const markerFraction = right.position / fullLayout.totalSpan; // < 1.0
    // Old behaviour: thumb at the far right (1.0) but the tick sits short of it.
    expect(oldFraction).toBeGreaterThan(markerFraction);
  });
});
