import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDogfoodScript } from "./run-dogfood-script";

const HERE = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(HERE, "moment-upstream-suite-pin.json"), "utf-8"));

describe("moment 2.30.1 upstream suite", () => {
  it("pins the complete core and locale unit inventory plus an explicit initial slice", () => {
    expect(pin.repo).toBe("https://github.com/moment/moment.git");
    expect(pin.tag).toBe("2.30.1");
    expect(pin.commit).toBe("485d9a7d709bd5f3869a7ad24630cf0746d072dc");
    expect(pin.testFileCount).toBe(190);
    expect(pin.registrationSites).toBe(2638);
    expect(pin.selectedFiles).toHaveLength(6);
  });

  const heavy = process.env.DOGFOOD_MOMENT_UPSTREAM_SUITE === "1" ? it : it.skip;
  heavy("runs every callback in the selected original files against Node and Wasm", { timeout: 900_000 }, async () => {
    const out = await runDogfoodScript(join(HERE, "moment-upstream-suite.mjs"), ["--json"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    const report = JSON.parse(out);
    expect(report.upstreamSuite.commit).toBe(pin.commit);
    expect(report.extraction.filesSeen).toBe(190);
    expect(report.extraction.filesSelected).toBe(6);
    expect(report.extraction.testsRegistered).toBe(10);
    expect(report.extraction.nativePassed).toBe(10);
    expect(report.results.passed + report.results.failed + report.results.runtimeFailed).toBe(report.results.scored);
  });
});
