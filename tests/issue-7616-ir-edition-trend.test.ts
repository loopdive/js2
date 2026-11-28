// #7616 — the merge queue's edition-only IR measurements on the edition trend.
// An edition scope is cumulative, so an entry that measured one edition is a
// point only where that edition is the whole sum.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module without type declarations
import * as trend from "../website/components/t262-conformance-trend.js";

const { t262EditionScopeExtract } = trend as any;

const full = (timestamp: string, editions: { edition: string; pass: number; total: number }[]) => ({
  timestamp,
  editions,
});
const editionOnly = (timestamp: string, pass: number) => ({
  timestamp,
  scope: "edition",
  edition: "ES5",
  editions: [{ edition: "ES5", pass, total: 100 }],
});

describe("#7616 edition-only points on the IR edition trend", () => {
  const runs = [
    full("2026-11-26T12:00:00Z", [
      { edition: "ES5", pass: 20, total: 100 },
      { edition: "ES2015", pass: 5, total: 50 },
    ]),
    editionOnly("2026-11-27T12:00:00Z", 30),
  ];

  it("plots an ES5-only measurement at the ES5 scope", () => {
    const extract = t262EditionScopeExtract("ES5", runs);
    expect(runs.map(extract)).toEqual([
      { pass: 20, total: 100, timestampRaw: "2026-11-26T12:00:00Z" },
      { pass: 30, total: 100, timestampRaw: "2026-11-27T12:00:00Z" },
    ]);
  });

  it("never plots it at a later, cumulative scope it does not cover", () => {
    const extract = t262EditionScopeExtract("ES2015", runs);
    expect(runs.map(extract)).toEqual([{ pass: 25, total: 150, timestampRaw: "2026-11-26T12:00:00Z" }, null]);
  });

  it("never plots it where the full runs also count an earlier edition", () => {
    const withEarlier = [
      full("2026-11-26T12:00:00Z", [
        { edition: "ES3", pass: 1, total: 10 },
        { edition: "ES5", pass: 20, total: 100 },
      ]),
      editionOnly("2026-11-27T12:00:00Z", 30),
    ];
    expect(withEarlier.map(t262EditionScopeExtract("ES5", withEarlier))[1]).toBeNull();
  });
});
