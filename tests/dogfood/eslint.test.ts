// Thin contract wrapper for the pinned ESLint npm-compat harness (#1400).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDogfoodScript } from "./run-dogfood-script";

// @ts-expect-error — .mjs dogfood setup has no declaration file
import { setupEslint } from "./setup-eslint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("eslint dogfood harness (#1400)", () => {
  it("acquires the pinned ESLint tarball and verifies the installed payload", () => {
    const { version, pin, entryModulePath } = setupEslint();
    expect(version).toBe("10.0.3");
    expect(pin.shasum).toBe("360a7de7f2706eb8a32caa17ca983f0089efe694");
    expect(entryModulePath).toMatch(/eslint[/\\]lib[/\\]api\.js$/);
  });

  const heavy = process.env.DOGFOOD_ESLINT === "1" ? it : it.skip;
  heavy("runs the bounded compile and records the honest package-entry frontier", { timeout: 240_000 }, async () => {
    const out = await runDogfoodScript(join(HERE, "eslint-harness.mjs"), ["--json"]);
    const report = JSON.parse(out);
    expect(report.eslint?.version).toBe("10.0.3");
    expect(report.compile).toBeTruthy();
    expect(report.validation).toBeTruthy();
    expect(report.diff.runnable).toBe(false);
    if (report.compile.success) {
      expect(report.validation.validates).toBe(true);
    } else {
      expect(report.compile.timedOut || report.compile.errorCount > 0).toBe(true);
    }
  });
});
