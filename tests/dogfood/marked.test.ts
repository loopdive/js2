// Thin vitest wrapper around the marked dogfood harness (#3716).
//
// This asserts the harness contract, not full marked conformance:
//   - the pinned-tarball integrity gate holds,
//   - the plain-JavaScript entry compiles and validates despite checker-only
//     diagnostics (the #3715 evolving-array issue remains a compiler gap),
//   - runtime rendering failures remain recorded for separate triage.

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDogfoodScript } from "./run-dogfood-script";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { setupMarked } from "./setup-marked.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("marked dogfood harness (#3716)", () => {
  it("acquires the pinned marked tarball and passes the integrity gate", () => {
    const { version, pin } = setupMarked();
    expect(version).toBe("18.0.2");
    expect(pin.shasum).toMatch(/^[0-9a-f]{40}$/);
  });

  // Same reasoning as acorn.test.ts: run the compile→validate→diff loop as a
  // CHILD PROCESS so a slow synchronous compile never blocks the vitest
  // worker's event loop / RPC heartbeat. Opt-in (DOGFOOD_MARKED=1) — the
  // canonical entrypoint is `pnpm run dogfood:marked`.
  const heavy = process.env.DOGFOOD_MARKED === "1" ? it : it.skip;
  heavy(
    "runs the compile→validate→diff loop to completion and emits a structured report",
    { timeout: 60_000 },
    async () => {
      const out = await runDogfoodScript(join(HERE, "marked-harness.mjs"), ["--json"]);
      const report = JSON.parse(out);

      expect(report.marked?.version).toBe("18.0.2");
      expect(report.compile).toBeTruthy();
      expect(report.validation).toBeTruthy();
      expect(report.summary?.headline).toBeTypeOf("string");

      // Marked is plain published JavaScript. The harness deliberately skips
      // checker-only semantic diagnostics, so #3715 must not prevent a binary
      // from being emitted and validated. Runtime failures are measured below
      // the compile/validation boundary and belong to separate issues.
      expect(report.compile.success).toBe(true);
      expect(report.compile.binaryBytes).toBeGreaterThan(0);
      expect(report.validation.validates).toBe(true);
      expect(report.diff.runnable).toBe(true);
    },
  );
});
