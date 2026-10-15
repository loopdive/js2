// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6706 (S4 of #5385) — the native-first measurement lane links the same eval
 * and Temporal providers as the standalone lane.
 *
 * A: the lane downloads + verifies the shared runtime-eval provider instead of
 *    building the REFUSAL tier in-job, and the provider job runs on `schedule`.
 * B: a regime-compiled Temporal provider with its OWN stamp; the host stamp
 *    never certifies it (no silent fallback to host semantics), and a stamp
 *    recorded outside the regime never certifies a regime consumer.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readTemporalPrewarmStamp,
  temporalPrewarmStampName,
  temporalProviderCompileOptions,
  test262TemporalLaneEnabled,
  writeTemporalPrewarmStamp,
} from "../scripts/test262-temporal.mjs";

const workflow = readFileSync(join(process.cwd(), ".github/workflows/test262-sharded.yml"), "utf8");

function jobBlock(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(0);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("#6706 A — eval provider on the native-first lane", () => {
  it("builds the shared provider on schedule", () => {
    const job = jobBlock("runtime-eval-provider");
    expect(job).toContain("github.event_name == 'schedule' ||");
    expect(job).toContain("JS2WASM_EVAL_ENGINE: ${{ inputs.eval_engine || 'quickjs' }}");
  });

  it("downloads and verifies the provider instead of building the refusal tier", () => {
    const job = jobBlock("test262-native-first");
    expect(job).toContain("needs: [runtime-eval-provider, temporal-provider]");
    expect(job).toContain("!cancelled()");
    expect(job).toContain("needs.runtime-eval-provider.result == 'success'");
    expect(job).toContain("name: runtime-eval-provider-${{ github.run_id }}");
    expect(job).toContain("node scripts/build-quickjs-eval-provider.mjs --require-cache");
    expect(job).toContain("JS2WASM_EVAL_ENGINE: ${{ inputs.eval_engine || 'quickjs' }}");
    expect(job).not.toContain("--refusal-only");
    expect(job).not.toContain("JS2WASM_EVAL_ENGINE: interpreter");
  });
});

describe("#6706 B — regime-compiled Temporal provider", () => {
  let dir: string;
  const savedDisable = process.env.JS2WASM_TEST262_TEMPORAL;
  const info = { key: "k", namespace: "n", bytes: 1, buildMs: 1, cacheHit: false };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "issue-6706-"));
    Reflect.deleteProperty(process.env, "JS2WASM_TEST262_TEMPORAL");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedDisable === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST262_TEMPORAL");
    else process.env.JS2WASM_TEST262_TEMPORAL = savedDisable;
  });

  // (#6979 S7) The JS-host lane IS the regime lane; there is no other policy.
  it("keys the regime provider separately and leaves standalone unchanged", () => {
    expect(temporalProviderCompileOptions(undefined)).toEqual({ hostBridge: "always" });
    expect(temporalPrewarmStampName(undefined)).toBe("prewarm-native-first.json");
    expect(temporalProviderCompileOptions("standalone")).toEqual({ target: "standalone", hostBridge: "off" });
    expect(temporalPrewarmStampName("standalone")).toBe("prewarm-standalone.json");
  });

  it("never lets a pre-S6 host-semantics stamp certify the regime lane", () => {
    writeFileSync(join(dir, "prewarm.json"), JSON.stringify({ ...info, target: null }));
    expect(test262TemporalLaneEnabled(undefined, dir)).toBe(false);
    expect(readTemporalPrewarmStamp(dir, undefined)).toBeNull();
  });

  it("links with a regime stamp", () => {
    const stamp = writeTemporalPrewarmStamp(dir, info, undefined);
    expect(stamp).toMatchObject({ target: null, key: "k" });
    expect(test262TemporalLaneEnabled(undefined, dir)).toBe(true);
  });

  it("refuses a stamp recorded while the removed S6 kill switch was off", () => {
    writeFileSync(
      join(dir, "prewarm-native-first.json"),
      JSON.stringify({ ...info, target: null, nativeRegime: false }),
    );
    expect(test262TemporalLaneEnabled(undefined, dir)).toBe(false);
  });

  it("threads the target-only lane through prewarm and worker", () => {
    const prewarm = readFileSync(join(process.cwd(), "scripts/prewarm-temporal-provider.mjs"), "utf8");
    expect(prewarm).not.toContain("--semantic-providers");
    expect(prewarm).toContain("temporalProviderCompileOptions(target)");
    expect(prewarm).toContain("temporalProviderCacheKey({ polyfillSource, compileOptions })");
    const worker = readFileSync(join(process.cwd(), "scripts/test262-worker.mjs"), "utf8");
    expect(worker).toContain("getWorkerTemporalProvider(target)");
    expect(worker).toContain("temporalProviderCompileOptions(target)");
    expect(worker).toContain("readTemporalPrewarmStamp(cacheDir, target)");
  });

  it("builds and ships the regime provider under its own artifact", () => {
    const provider = jobBlock("temporal-provider");
    expect(provider).toContain("--semantic-providers native-first");
    expect(provider).toContain("name: temporal-provider-native-first-${{ github.run_id }}");
    // The host artifact keeps its name and directory.
    expect(provider).toContain(
      "name: temporal-provider-${{ github.run_id }}\n          path: .test262-cache/temporal\n",
    );
    const lane = jobBlock("test262-native-first");
    expect(lane).toContain("name: temporal-provider-native-first-${{ github.run_id }}");
    expect(lane).not.toMatch(/name: temporal-provider-\$\{\{ github\.run_id \}\}/);
  });
});
