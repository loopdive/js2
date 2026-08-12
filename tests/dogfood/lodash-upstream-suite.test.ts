import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(HERE, "lodash-upstream-suite-pin.json"), "utf-8"));

describe("lodash 4.18.1 upstream suite", () => {
  it("pins the monolithic QUnit suite and explicit module slices", () => {
    expect(pin.repo).toBe("https://github.com/lodash/lodash.git");
    expect(pin.tag).toBe("4.18.1");
    expect(pin.commit).toBe("cb0b9b9212521c08e3eafe7c8cb0af1b42b6649e");
    expect(pin.testFileCount).toBe(1);
    expect(pin.registrationSites).toBe(1753);
    expect(pin.selectedModules).toHaveLength(7);
  });

  const heavy = process.env.DOGFOOD_LODASH_UPSTREAM_SUITE === "1" ? it : it.skip;
  heavy("runs unchanged selected QUnit callbacks against Node and Wasm", { timeout: 600_000 }, () => {
    const out = execFileSync("node", ["--import", "tsx", join(HERE, "lodash-upstream-suite.mjs"), "--json"], {
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const report = JSON.parse(out);
    expect(report.upstreamSuite.commit).toBe(pin.commit);
    expect(report.extraction.testsRegistered).toBe(11);
    expect(report.extraction.nativePassed).toBe(11);
    expect(report.results.passed + report.results.failed + report.results.runtimeFailed).toBe(report.results.scored);
  });
});
