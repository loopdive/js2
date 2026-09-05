import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(process.cwd(), "test262", "test");
const ASSIGN_ROOT = join(TEST262_ROOT, "built-ins", "Object", "assign");

const PINS = ["source-own-prop-desc-missing.js", "source-own-prop-error.js"] as const;

// These controls exercise the neighbouring Object.assign paths without relying
// on a Proxy descriptor failure, and are green in both host and standalone
// lanes.
const CONTROLS = ["Target-Object.js", "source-non-enum.js", "source-own-prop-keys-error.js"] as const;

const LANES = [
  { name: "host", target: undefined },
  { name: "standalone", target: "standalone" as const },
] as const;

describe("#4749 — Object.assign Proxy source descriptors", () => {
  for (const lane of LANES) {
    for (const file of PINS) {
      it(`${lane.name} pin: ${file}`, async () => {
        const result = await runTest262File(join(ASSIGN_ROOT, file), "issue-4749", 120_000, lane.target);
        expect(result.status, JSON.stringify(result)).toBe("pass");
      }, 120_000);
    }

    for (const file of CONTROLS) {
      it(`${lane.name} control: ${file}`, async () => {
        const result = await runTest262File(join(ASSIGN_ROOT, file), "issue-4749-control", 120_000, lane.target);
        expect(result.status, JSON.stringify(result)).toBe("pass");
      }, 120_000);
    }
  }
});
