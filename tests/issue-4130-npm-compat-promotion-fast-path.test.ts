// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyNpmCompatChange,
  isNpmCompatPromotionOnly,
  NPM_COMPAT_PROMOTION_ARTIFACTS,
  validateNpmCompatPromotion,
} from "../scripts/check-npm-compat-promotion.mjs";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const ci = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const benchmarks = readFileSync(resolve(ROOT, ".github/workflows/benchmark-refresh.yml"), "utf8");
const autoEnqueue = readFileSync(resolve(ROOT, ".github/workflows/auto-enqueue.yml"), "utf8");

function copyArtifacts() {
  const root = mkdtempSync(join(tmpdir(), "npm-compat-promotion-"));
  for (const path of NPM_COMPAT_PROMOTION_ARTIFACTS) {
    cpSync(resolve(ROOT, path), resolve(root, path), { recursive: true });
  }
  return root;
}

describe("npm-compat promotion artifact validation", () => {
  it("recognizes only the complete six-file generated diff", () => {
    expect(isNpmCompatPromotionOnly(NPM_COMPAT_PROMOTION_ARTIFACTS)).toBe(true);
    expect(isNpmCompatPromotionOnly(NPM_COMPAT_PROMOTION_ARTIFACTS.slice(0, -1))).toBe(false);
    expect(isNpmCompatPromotionOnly([...NPM_COMPAT_PROMOTION_ARTIFACTS, "src/index.ts"])).toBe(false);
    expect(classifyNpmCompatChange(NPM_COMPAT_PROMOTION_ARTIFACTS.slice(0, -1))).toMatchObject({
      touchesArtifacts: true,
      hasAllArtifacts: false,
      promotionOnly: false,
    });
    expect(classifyNpmCompatChange([...NPM_COMPAT_PROMOTION_ARTIFACTS, "src/index.ts"])).toMatchObject({
      touchesArtifacts: true,
      hasAllArtifacts: true,
      promotionOnly: false,
    });
  });

  it("accepts the committed report, mirrors, timings, and provenance", () => {
    expect(validateNpmCompatPromotion(ROOT)).toMatchObject({
      packageCount: expect.any(Number),
      perfCount: expect.any(Number),
      sourceRevision: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
  });

  it("rejects a public artifact that differs from its canonical twin", () => {
    const root = copyArtifacts();
    const publicReport = resolve(root, "website/public/benchmarks/results/npm-compat.json");
    writeFileSync(publicReport, `${readFileSync(publicReport, "utf8")}\n`);
    expect(() => validateNpmCompatPromotion(root)).toThrow(/not byte-identical/);
  });

  it("rejects report/history provenance drift", () => {
    const root = copyArtifacts();
    for (const path of ["benchmarks/results/npm-compat.json", "website/public/benchmarks/results/npm-compat.json"]) {
      const fullPath = resolve(root, path);
      const report = JSON.parse(readFileSync(fullPath, "utf8"));
      report.generatedAt = "2099-01-01T00:00:00.000Z";
      writeFileSync(fullPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    expect(() => validateNpmCompatPromotion(root)).toThrow(/exactly one run/);
  });
});

describe("npm-compat promotion CI fast path", () => {
  it("classifies the exact artifact diff before selecting heavy suites", () => {
    const changes = ci.slice(ci.indexOf("  changes:"), ci.indexOf("  quality:"));
    expect(changes).toContain("scripts/check-npm-compat-promotion.mjs");
    expect(changes).toContain("steps.npm_compat.outputs.only");
    expect(changes).toMatch(/npm-compat artifact-only diff[\s\S]*?code=false/);
  });

  it("keeps every post-classification quality step off the artifact-only path", () => {
    const quality = ci.slice(ci.indexOf("  quality:"), ci.indexOf("  cancel-test262-on-quality-failure:"));
    const stepBlocks = quality
      .slice(quality.indexOf("    steps:"))
      .split(/\n(?= {6}- (?:name:|uses:|run:))/)
      .slice(1);

    for (const block of stepBlocks) {
      const isCheckout = block.includes("actions/checkout@v5");
      const isClassifier = block.includes("id: npm_compat");
      if (isCheckout || isClassifier) continue;
      expect(block, block.split("\n")[0]).toContain("steps.npm_compat.outputs.only != 'true'");
    }
  });

  it("measures benchmarks only after merge and ignores the npm-compat artifact push", () => {
    const trigger = benchmarks.slice(benchmarks.indexOf("on:"), benchmarks.indexOf("permissions:"));
    expect(trigger).not.toContain("pull_request:");
    expect(trigger).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(trigger.match(/paths-ignore:/g)).toHaveLength(1);
    for (const path of NPM_COMPAT_PROMOTION_ARTIFACTS) {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(trigger.match(new RegExp(`^\\s+- "${escaped}"$`, "gm"))).toHaveLength(1);
    }
  });

  it("does not wait for post-merge benchmarks before enqueueing PRs", () => {
    const workflowRun = autoEnqueue.slice(autoEnqueue.indexOf("workflow_run:"), autoEnqueue.indexOf("schedule:"));
    expect(workflowRun).not.toContain("Refresh Benchmarks");
    expect(workflowRun).toContain('workflows: ["Test262 Sharded", "CI"]');
  });
});
