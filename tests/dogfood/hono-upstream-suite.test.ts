import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDogfoodScript } from "./run-dogfood-script";

const HERE = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(HERE, "hono-upstream-suite-pin.json"), "utf-8"));

describe("hono v4.12.16 upstream suite", () => {
  it("pins the complete source-unit inventory and an explicit initial slice", () => {
    expect(pin.repo).toBe("https://github.com/honojs/hono.git");
    expect(pin.tag).toBe("v4.12.16");
    expect(pin.commit).toBe("90d4182aabd328e2ec6af3f25ec62ddc574ad8cb");
    expect(pin.testFileCount).toBe(120);
    expect(pin.registrationSites).toBe(2355);
    expect(pin.selectedFiles).toEqual(["src/utils/accept.test.ts", "src/utils/mime.test.ts"]);
  });

  const heavy = process.env.DOGFOOD_HONO_UPSTREAM_SUITE === "1" ? it : it.skip;
  heavy("runs the selected original callbacks against Node and Wasm", { timeout: 600_000 }, async () => {
    const out = await runDogfoodScript(join(HERE, "hono-upstream-suite.mjs"), ["--json"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    const report = JSON.parse(out);
    expect(report.upstreamSuite.commit).toBe(pin.commit);
    expect(report.extraction.filesSeen).toBe(120);
    expect(report.extraction.filesSelected).toBe(2);
    expect(report.extraction.testsRegistered).toBe(31);
    expect(report.extraction.nativePassed).toBe(31);
    expect(report.results.passed + report.results.failed + report.results.runtimeFailed).toBe(report.results.scored);
  });
});
