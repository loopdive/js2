// Thin vitest wrapper around the @js-temporal/polyfill spike harness (#4628).
//
// Cheap lane (always runs): the ACQUISITION contract — both pinned tarballs
// are committed, pass their sha1 integrity gate, and the link step still finds
// the exact bytes it rewrites. That is the part that rots when someone bumps a
// pin, and it costs milliseconds.
//
// Heavy lane (opt-in, DOGFOOD_TEMPORAL_POLYFILL=1): the actual compile +
// validate measurement. It is opt-in and NOT gated on a pass/fail floor,
// because #4628 is a SPIKE — the deliverable is a number, and pinning a floor
// to today's number would turn an exploratory measurement into a required
// check on work nobody has committed to yet. It asserts only that the harness
// produced a well-formed measurement.

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDogfoodScript } from "./run-dogfood-script";
// @ts-expect-error — .mjs harness, no .d.ts (pure tooling)
import { setupTemporalPolyfill, linkPolyfillSource } from "./setup-temporal-polyfill.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("@js-temporal/polyfill dogfood harness (#4628 spike)", () => {
  it("acquires both pinned tarballs and passes the integrity gate", () => {
    const { version, pin } = setupTemporalPolyfill();
    expect(version).toBe("0.5.1");
    expect(pin.shasum).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.dependency.version).toBe("4.3.0");
    expect(pin.dependency.shasum).toMatch(/^[0-9a-f]{40}$/);
  });

  it("links jsbi into the polyfill's ESM bundle without leaving an import behind", () => {
    const setup = setupTemporalPolyfill();
    const { source } = linkPolyfillSource(setup);
    // The published ESM bundle is NOT self-contained — it carries exactly one
    // import against jsbi. After linking there must be no bare import left, or
    // the harness would be measuring a module-resolution failure instead of
    // the compiler's real frontier on the polyfill.
    expect(source).not.toMatch(/^import\s/m);
    expect(source).toContain("const e=JSBI;");
    expect(source.length).toBeGreaterThan(150_000);
  });

  // Run as a CHILD PROCESS (same rationale as clsx/acorn): a synchronous
  // compile must never block the vitest worker's event loop / RPC heartbeat.
  // The polyfill is ~157 KB of minified JS and the compile is measured in
  // minutes, hence the generous timeout and the opt-in gate.
  const heavy = process.env.DOGFOOD_TEMPORAL_POLYFILL === "1" ? it : it.skip;
  heavy("runs the compile→validate lane and reports a well-formed measurement", { timeout: 3_600_000 }, async () => {
    const out = await runDogfoodScript(join(HERE, "temporal-polyfill-harness.mjs"), ["--json", "--no-umd"]);
    const report = JSON.parse(out);

    expect(report.issue).toBe(4628);
    expect(report.polyfill?.version).toBe("0.5.1");
    // The measurement must use the SAME options as tests/test262-runner.ts —
    // without allowJs this would measure TypeScript diagnostics on published
    // JS rather than compiler gaps.
    expect(report.compileOptions.allowJs).toBe(true);
    expect(report.compileOptions.skipSemanticDiagnostics).toBe(true);
    expect(report.lanes.esm).toBeTruthy();
    expect(report.lanes.esm.compile).toBeTruthy();
    expect(report.lanes.esm.validation).toBeTruthy();
    // No pass/fail floor — see the header. The spike records the number;
    // #4628 records the decision.
    expect(report.summary.threshold661).toBeTypeOf("string");
  });
});
