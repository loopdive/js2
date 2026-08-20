import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDogfoodScript } from "./run-dogfood-script";

// @ts-expect-error — .mjs dogfood setup has no declaration file
import { setupPrettier } from "./setup-prettier.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("prettier dogfood harness", () => {
  it("acquires the pinned Prettier tarball and verifies the package entry", () => {
    const { version, pin, entryModulePath } = setupPrettier();
    expect(version).toBe("3.8.1");
    expect(pin.shasum).toBe("edf48977cf991558f4fcbd8a3ba6015ba2a3a173");
    expect(entryModulePath).toMatch(/prettier[/\\]package[/\\]standalone\.mjs$/);
  });

  const heavy = process.env.DOGFOOD_PRETTIER === "1" ? it : it.skip;
  heavy("records the bounded compile and validation frontier", { timeout: 180_000 }, async () => {
    const out = await runDogfoodScript(join(HERE, "prettier-harness.mjs"), ["--json"]);
    const report = JSON.parse(out);
    expect(report.prettier?.version).toBe("3.8.1");
    expect(report.compile.success).toBe(false);
    expect(report.compile.timedOut || report.compile.errorCount > 0).toBe(true);
    expect(report.validation.validates).toBe(false);
    expect(report.diff.runnable).toBe(false);
  });
});
