// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1923 — meter IR post-claim demotions in the fallback ratchet.
//
// The IR selector can CLAIM a function that then fails during build/verify/
// lower and demotes to legacy through the warning channel — counted by no
// selector-level metric. Such a regression (the #1922 while-loop defect was a
// live example) was invisible to CI. The compiler now surfaces these on
// `CompileResult.irPostClaimErrors`, and `scripts/check-ir-fallbacks.ts`
// baselines + gates them. This test exercises the metering end to end via a
// test-only build-throw injection seam.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GATE = join(REPO_ROOT, "scripts", "check-ir-fallbacks.ts");

const CLAIMED_FN = `export function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }`;

describe("#1923 — IR post-claim demotion metering", () => {
  it("a cleanly-claimed function reports no post-claim demotions", async () => {
    const result = await compile(CLAIMED_FN, { fileName: "fib.ts", experimentalIR: true });
    expect(result.success).toBe(true);
    // `fib` is an IR-claimable numeric kernel; it compiles via IR with no
    // build/verify/lower demotion.
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("an injected post-claim build failure is metered on irPostClaimErrors (not silently dropped)", async () => {
    // The injection seam forces the per-function IR build to throw for every
    // CLAIMED function, simulating a regression that demotes a claimed shape to
    // legacy. The compile still SUCCEEDS (legacy fallback), but the demotion is
    // now metered on `irPostClaimErrors` instead of vanishing. Run in a
    // subprocess so the env var doesn't leak into other in-process tests.
    const dir = mkdtempSync(join(tmpdir(), "issue-1923-"));
    const probe = join(dir, "probe.mts");
    writeFileSync(
      probe,
      `import { compile } from ${JSON.stringify(join(REPO_ROOT, "src/index.ts"))};\n` +
        `const r = await compile(${JSON.stringify(CLAIMED_FN)}, { fileName: "fib.ts", experimentalIR: true });\n` +
        `process.stdout.write(JSON.stringify({ success: r.success, postClaim: r.irPostClaimErrors ?? [] }));\n`,
    );
    const out = execFileSync("npx", ["tsx", probe], {
      cwd: REPO_ROOT,
      env: { ...process.env, JS2WASM_TEST_INJECT_IR_BUILD_THROW: "1" },
    }).toString();
    const parsed = JSON.parse(out) as { success: boolean; postClaim: { kind: string; func: string }[] };
    expect(parsed.success).toBe(true); // demoted to legacy, not a hard error
    expect(parsed.postClaim.length).toBeGreaterThan(0);
    expect(parsed.postClaim.some((e) => e.kind === "build" && e.func === "fib")).toBe(true);
  });

  it("the ratchet gate FAILS when post-claim demotions grow above the committed baseline", () => {
    // Run the real gate against the committed corpus + baseline, with the
    // build-throw injection on: every claimed corpus function demotes, so the
    // post-claim bucket grows above the baseline (0) and the gate must exit 1.
    let failed = false;
    let output = "";
    try {
      output = execFileSync("npx", ["tsx", GATE], {
        cwd: REPO_ROOT,
        env: { ...process.env, JS2WASM_TEST_INJECT_IR_BUILD_THROW: "1" },
        stdio: "pipe",
      }).toString();
    } catch (e: unknown) {
      failed = true;
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      output = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
    }
    expect(failed).toBe(true);
    expect(output).toMatch(/post-claim demotions grew/i);
    expect(output).toMatch(/build:/);
  });

  it("the ratchet gate PASSES on the clean corpus (no post-claim growth)", () => {
    // Sanity: without the injection, the committed corpus has zero post-claim
    // demotions and matches the baseline, so the gate exits 0.
    let failed = false;
    try {
      execFileSync("npx", ["tsx", GATE], { cwd: REPO_ROOT, stdio: "pipe" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(false);
  });
});
