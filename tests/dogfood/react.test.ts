import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDogfoodScript } from "./run-dogfood-script";

// @ts-expect-error — .mjs dogfood setup has no declaration file
import { setupReact } from "./setup-react.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("react dogfood harness", () => {
  it("acquires the pinned React tarball and verifies the package entry", () => {
    const { version, pin, entryModulePath } = setupReact();
    expect(version).toBe("19.2.6");
    expect(pin.shasum).toBe("3dadb8e12b2a7934c1d5317973e5dce1301f9a4d");
    expect(entryModulePath).toMatch(/react[/\\]package[/\\]index\.js$/);
  });

  const heavy = process.env.DOGFOOD_REACT === "1" ? it : it.skip;
  heavy("compiles the package entry to valid Wasm", { timeout: 180_000 }, async () => {
    const out = await runDogfoodScript(join(HERE, "react-harness.mjs"), ["--json"]);
    const report = JSON.parse(out);
    expect(report.react?.version).toBe("19.2.6");
    expect(report.compile.success).toBe(true);
    expect(report.validation.validates).toBe(true);
    expect(report.diff.runnable).toBe(false);
  });
});
