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
    expect(pin.selectedFiles).toEqual([
      "src/http-exception.test.ts",
      "src/request.test.ts",
      "src/helper/accepts/accepts.test.ts",
      "src/helper/testing/index.test.ts",
      "src/helper/dev/index.test.ts",
      "src/middleware/powered-by/index.test.ts",
      "src/middleware/trailing-slash/index.test.ts",
      "src/utils/accept.test.ts",
      "src/utils/basic-auth.test.ts",
      "src/utils/body.test.ts",
      "src/utils/cookie.test.ts",
      "src/utils/encode.test.ts",
      "src/utils/concurrent.test.ts",
      "src/utils/buffer.test.ts",
      "src/utils/crypto.test.ts",
      "src/utils/filepath.test.ts",
      "src/utils/html.test.ts",
      "src/utils/ipaddr.test.ts",
      "src/utils/mime.test.ts",
      "src/utils/url.test.ts",
    ]);
  });

  const heavy = process.env.DOGFOOD_HONO_UPSTREAM_SUITE === "1" ? it : it.skip;
  heavy("runs the selected original callbacks against Node and Wasm", { timeout: 600_000 }, async () => {
    const out = await runDogfoodScript(join(HERE, "hono-upstream-suite.mjs"), ["--json"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    const report = JSON.parse(out);
    expect(report.upstreamSuite.commit).toBe(pin.commit);
    expect(report.extraction.filesSeen).toBe(120);
    expect(report.extraction.filesSelected).toBe(20);
    expect(report.extraction.testsRegistered).toBe(324);
    expect(report.extraction.nativePassed).toBe(324);
    expect(report.extraction.nativeFailed).toBe(0);
    expect(report.extraction.unavailableInfra).toBe(2031);
    expect(report.compile).toMatchObject({ modules: 20, succeeded: 20, validated: 18 });
    expect(report.results).toMatchObject({ scored: 324, passed: 90, runtimeFailed: 6 });
    expect(report.results.passed + report.results.failed + report.results.runtimeFailed).toBe(report.results.scored);
  });
});
