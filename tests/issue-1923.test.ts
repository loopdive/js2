// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1923 — meter IR post-claim demotions in the fallback ratchet.
//
// The IR selector can CLAIM a function that then fails during build/verify/
// lower. `CompileResult.irPostClaimErrors` meters the compatibility channel;
// #3519 additionally makes any untyped throw an invariant, so it cannot demote
// to legacy even when a legacy body exists. These tests exercise both channels
// through the test-only build-throw injection seam.

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

  it("types an injected unclassified post-claim throw as a fatal invariant", async () => {
    // The injection seam forces the per-function IR build to throw for every
    // CLAIMED function, simulating a compiler regression rather than a known
    // source capability gap. #3519 requires that untyped throw to fail hybrid
    // with `unexpected-internal-throw`, while retaining the old compatibility
    // meter. Run in a subprocess so the env var cannot leak.
    const dir = mkdtempSync(join(tmpdir(), "issue-1923-"));
    const probe = join(dir, "probe.mts");
    writeFileSync(
      probe,
      `import { compile } from ${JSON.stringify(join(REPO_ROOT, "src/index.ts"))};\n` +
        `const r = await compile(${JSON.stringify(CLAIMED_FN)}, { fileName: "fib.ts", experimentalIR: true, trackIrOutcomes: true });\n` +
        `process.stdout.write(JSON.stringify({ success: r.success, postClaim: r.irPostClaimErrors ?? [], outcomes: r.irOutcomes ?? [], errors: r.errors }));\n`,
    );
    const out = execFileSync("npx", ["tsx", probe], {
      cwd: REPO_ROOT,
      env: { ...process.env, JS2WASM_TEST_INJECT_IR_BUILD_THROW: "1" },
    }).toString();
    const parsed = JSON.parse(out) as {
      success: boolean;
      postClaim: { kind: string; func: string }[];
      outcomes: { kind: string; code?: string; stage: string; displayName: string }[];
      errors: { message: string; severity: string }[];
    };
    expect(parsed.success).toBe(false);
    expect(parsed.postClaim.length).toBeGreaterThan(0);
    expect(parsed.postClaim.some((e) => e.kind === "build" && e.func === "fib")).toBe(true);
    expect(parsed.outcomes).toContainEqual(
      expect.objectContaining({
        displayName: "fib",
        kind: "invariant",
        code: "unexpected-internal-throw",
        stage: "build",
      }),
    );
    expect(parsed.errors).toContainEqual(expect.objectContaining({ severity: "error" }));
  });

  it("the legacy fallback gate fails loudly on the injected invariant", () => {
    // Run the real gate against the committed corpus + baseline, with the
    // build-throw injection on: every claimed corpus function violates the IR
    // contract, so the gate must exit non-zero before accepting fallback.
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
    expect(output).toMatch(/gate invariant|unexpected-internal-throw|Codegen error/i);
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
