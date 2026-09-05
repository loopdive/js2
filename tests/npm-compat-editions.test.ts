import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { measurePackageSyntax, sourceSyntaxEdition } from "../scripts/lib/npm-compat-editions.mjs";

describe("npm syntax edition evidence", () => {
  it.each([
    ["var value = function (x) { return x + 1; };", "script", 3],
    ["var value = { get x() { return 1; } };", "script", 5],
    ["export var value = 1;", "module", 2015],
    ["var value = 1;", "module", 2015],
    ["const value = () => 1;", "script", 2015],
    ["const value = input?.x;", "script", 2020],
    ["await operation();", "module", 2022],
    ["const value: number = 1;", "script", null],
    ["await operation();", "script", null],
  ])("classifies %s without relaxing parser rules", async (source, sourceType, expected) => {
    expect(await sourceSyntaxEdition(source, sourceType)).toBe(expected);
  });

  it("does not turn unavailable or mismatched pinned sources into an edition", async () => {
    expect(await measurePackageSyntax({ name: "not-in-corpus", version: "1.0.0" })).toMatchObject({
      edition: null,
      files: 0,
      reason: expect.any(String),
    });
    expect(await measurePackageSyntax({ name: "acorn", version: "0.0.0" })).toMatchObject({ edition: null });
  });

  it("measures a real pinned archive including its alternative module build", async () => {
    expect(await measurePackageSyntax({ name: "clsx", version: "2.1.1" })).toMatchObject({
      edition: 2015,
      files: 5,
      scope: "published-javascript",
      tarballShasum: "eed397c9fd8bd882bfb18deab7102049a2f32999",
    });
  });

  it("publishes matching syntax metadata for the entire measured corpus", () => {
    const report = JSON.parse(readFileSync(new URL("../benchmarks/results/npm-compat.json", import.meta.url), "utf8"));
    const published = JSON.parse(
      readFileSync(new URL("../website/public/benchmarks/results/npm-compat.json", import.meta.url), "utf8"),
    );
    expect(report.packages.length).toBeGreaterThanOrEqual(24);
    for (const pkg of report.packages) {
      expect(pkg.esSyntax, pkg.name).toMatchObject({ scope: "published-javascript", files: expect.any(Number) });
      expect(published.packages.find((candidate) => candidate.name === pkg.name).esSyntax).toEqual(pkg.esSyntax);
      if (pkg.esSyntax.edition !== null) expect(pkg.esSyntax.files).toBeGreaterThan(0);
    }
  });
});
