// #5201 — a landing-page feature row discloses which editions its tests
// actually belong to.
//
// The row's SECTION is hand-authored per feature: "Comma operator" sits under
// ES3 / Core because the operator is ES3. The row's NUMBER comes from the
// test262 files its `testCategories` match, and those carry their own edition
// markers — the six `language/expressions/comma` tests are five ES5 (Sputnik
// files whose `es5id` names the ES5.1 section defining the operator, not the
// edition that introduced it) plus `tco-final.js`, which carries
// `features: [tail-call-optimization]` and classifies as ES2015. That last one
// is the one that fails in the standalone lane.
//
// Rendered as a bare "5 / 6" under an "ES3 / Core" heading whose own 100% is
// computed from a different 273-test bucket entirely, it reads as "ES3 is
// broken". These tests pin the data that makes the two axes distinguishable.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { patchFeatureExamples, type ClassifiedTest, type StatusKey } from "../scripts/generate-editions.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "js2-5201-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const COMMA_FILES = [
  "test/language/expressions/comma/S11.14_A1.js",
  "test/language/expressions/comma/S11.14_A2.1_T1.js",
  "test/language/expressions/comma/S11.14_A2.1_T2.js",
  "test/language/expressions/comma/S11.14_A2.1_T3.js",
  "test/language/expressions/comma/S11.14_A3.js",
  "test/language/expressions/comma/tco-final.js",
];

/** The real shape: five ES5 files, one ES2015 file, the ES2015 one failing. */
function commaLane(tcoStatus: StatusKey) {
  const pathTests = COMMA_FILES.map((file) => ({
    file,
    status: (file.endsWith("tco-final.js") ? tcoStatus : "pass") as StatusKey,
  }));
  const fileEditions: Record<string, string> = {};
  for (const f of COMMA_FILES) {
    fileEditions[f.replace(/^test\//, "")] = f.endsWith("tco-final.js") ? "ES2015" : "ES5";
  }
  return { pathTests, fileEditions };
}

function writeCatalog(path: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    path,
    JSON.stringify({
      features: [
        {
          name: "Comma operator",
          edition: "ES3 / Core",
          testCategories: ["language/expressions/comma"],
          passCount: 0,
          totalCount: 0,
          ...extra,
        },
      ],
    }),
  );
}

function readRow(path: string) {
  return JSON.parse(readFileSync(path, "utf8")).features[0];
}

describe("#5201 per-row edition spread", () => {
  it("reports the editions of the tests that actually score the row", () => {
    const src = join(dir, "feature-examples.json");
    writeCatalog(src);
    const { pathTests, fileEditions } = commaLane("fail");

    patchFeatureExamples(src, [], pathTests, undefined, fileEditions);

    const row = readRow(src);
    expect(row.passCount).toBe(5);
    expect(row.totalCount).toBe(6);
    // The failure is ES2015, not ES3 and not ES5 — which is the whole point.
    expect(row.editionSpread).toEqual([
      { edition: "ES5", pass: 5, total: 5 },
      { edition: "ES2015", pass: 0, total: 1 },
    ]);
  });

  it("orders the spread by EDITION_ORDER, not by first appearance", () => {
    const src = join(dir, "feature-examples.json");
    writeCatalog(src);
    // Feed the ES2015 file FIRST so insertion order would be the wrong answer.
    const { fileEditions } = commaLane("pass");
    const pathTests = [...COMMA_FILES].reverse().map((file) => ({ file, status: "pass" as StatusKey }));

    patchFeatureExamples(src, [], pathTests, undefined, fileEditions);

    expect(readRow(src).editionSpread.map((s: { edition: string }) => s.edition)).toEqual(["ES5", "ES2015"]);
  });

  it("tracks the lane: the same tests, a different pass column", () => {
    const host = join(dir, "host.json");
    const standalone = join(dir, "standalone.json");
    writeCatalog(host);
    writeCatalog(standalone);
    const { fileEditions } = commaLane("pass");

    patchFeatureExamples(host, [], commaLane("pass").pathTests, undefined, fileEditions);
    patchFeatureExamples(standalone, [], commaLane("fail").pathTests, undefined, fileEditions);

    expect(readRow(host).editionSpread).toContainEqual({ edition: "ES2015", pass: 1, total: 1 });
    expect(readRow(standalone).editionSpread).toContainEqual({ edition: "ES2015", pass: 0, total: 1 });
  });

  it("carries the spread into the slim standalone twin", () => {
    const src = join(dir, "feature-examples.json");
    const out = join(dir, "feature-examples-standalone.json");
    writeCatalog(src);
    const { pathTests, fileEditions } = commaLane("fail");

    patchFeatureExamples(src, [], pathTests, out, fileEditions);

    // The twin is what the page reads when the JS-host toggle is off, so the
    // spread has to travel with it — otherwise the toggle would show host
    // per-edition numbers under standalone totals.
    const row = readRow(out);
    expect(Object.keys(row).sort()).toEqual(["editionSpread", "name", "passCount", "testCategories", "totalCount"]);
    expect(row.editionSpread).toContainEqual({ edition: "ES2015", pass: 0, total: 1 });
  });

  it("omits the spread for a tag-sliced row (one edition by construction)", () => {
    const src = join(dir, "feature-examples.json");
    writeFileSync(
      src,
      JSON.stringify({
        features: [
          {
            name: "Class fields (public, private, static)",
            edition: "ES2022",
            testCategories: ["language/statements/class/fields"],
            passCount: 0,
            totalCount: 0,
          },
        ],
      }),
    );
    const tagged: ClassifiedTest[] = [
      { edition: 2022, features: ["class-fields-public"], status: "pass" },
      { edition: 2022, features: ["class-fields-public"], status: "fail" },
    ];

    patchFeatureExamples(src, tagged, [], undefined, {});

    const row = readRow(src);
    expect(row.totalCount).toBe(2);
    expect(row.editionSpread).toBeUndefined();
  });

  it("leaves the spread off when no edition is known for the scored files", () => {
    const src = join(dir, "feature-examples.json");
    writeCatalog(src);
    const { pathTests } = commaLane("fail");

    // No fileEditions map (the default) — counts still land, spread does not.
    patchFeatureExamples(src, [], pathTests);

    const row = readRow(src);
    expect(row.totalCount).toBe(6);
    expect(row.editionSpread).toBeUndefined();
  });
});
