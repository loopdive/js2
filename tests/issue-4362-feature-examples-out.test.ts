// #4362 — `generate-editions.ts --feature-examples-out` writes the standalone
// twin of the landing-page feature-row counts.
//
// The contract that matters is the SEPARATION: the standalone lane reads the
// host catalog (for row names, curated examples and `testCategories`) but must
// write its host-free counts somewhere else. If it patched in place, the host
// counts would be overwritten with standalone ones and the landing page would
// show standalone numbers in BOTH toggle positions — the mirror image of the
// bug #4362 fixes, and just as invisible.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { patchFeatureExamples, type ClassifiedTest } from "../scripts/generate-editions.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "js2-4362-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A catalog with one path-scored row (no `features:` tag needed). */
function writeCatalog(path: string, passCount: number, totalCount: number) {
  writeFileSync(
    path,
    JSON.stringify({
      features: [
        {
          name: "eval()",
          edition: "ES5",
          testCategories: ["language/eval-code"],
          js: "eval('1 + 2')",
          passCount,
          totalCount,
        },
      ],
    }),
  );
}

const noTaggedTests: ClassifiedTest[] = [];
/** 3 of 4 tests pass — a row the path-prefix scorer can score. */
const pathTests = [
  { file: "test/language/eval-code/a.js", status: "pass" as const },
  { file: "test/language/eval-code/b.js", status: "pass" as const },
  { file: "test/language/eval-code/c.js", status: "pass" as const },
  { file: "test/language/eval-code/d.js", status: "fail" as const },
];

describe("#4362 patchFeatureExamples --feature-examples-out", () => {
  it("writes the recomputed counts to the out path", () => {
    const src = join(dir, "feature-examples.json");
    const out = join(dir, "feature-examples-standalone.json");
    writeCatalog(src, 999, 999);

    patchFeatureExamples(src, noTaggedTests, pathTests, out);

    const written = JSON.parse(readFileSync(out, "utf8"));
    expect(written.features[0].passCount).toBe(3);
    expect(written.features[0].totalCount).toBe(4);
  });

  it("leaves the SOURCE catalog byte-identical", () => {
    const src = join(dir, "feature-examples.json");
    const out = join(dir, "feature-examples-standalone.json");
    writeCatalog(src, 999, 999);
    const before = readFileSync(src, "utf8");

    patchFeatureExamples(src, noTaggedTests, pathTests, out);

    expect(readFileSync(src, "utf8")).toBe(before);
  });

  it("emits a SLIM twin — row identity and counts, nothing lane-independent", () => {
    // The twin is a second file shipped to every visitor. The host catalog is
    // ~4 MB, ~96% of it the per-row `tests[]` failure lists, which are NOT what
    // differs between lanes. Duplicating them would cost megabytes to convey
    // kilobytes of differing numbers, so the twin carries only what the page
    // reads off the active catalog: name, testCategories, and the two counts.
    const src = join(dir, "feature-examples.json");
    const out = join(dir, "feature-examples-standalone.json");
    writeCatalog(src, 0, 0);

    patchFeatureExamples(src, noTaggedTests, pathTests, out);

    const row = JSON.parse(readFileSync(out, "utf8")).features[0];
    expect(row.name).toBe("eval()");
    expect(row.testCategories).toEqual(["language/eval-code"]);
    expect(Object.keys(row).sort()).toEqual(["name", "passCount", "testCategories", "totalCount"]);
    expect(row.js).toBeUndefined();
  });

  it("still patches in place when no out path is given (host lane unchanged)", () => {
    const src = join(dir, "feature-examples.json");
    writeCatalog(src, 999, 999);

    patchFeatureExamples(src, noTaggedTests, pathTests);

    const row = JSON.parse(readFileSync(src, "utf8")).features[0];
    expect(row.passCount).toBe(3);
    expect(row.totalCount).toBe(4);
  });
});
