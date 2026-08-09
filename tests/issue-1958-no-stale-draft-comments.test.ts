// #1958d — intentionally dormant draft PRs must not receive scheduled nags.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const enqueueScript = readFileSync(new URL("../scripts/enqueue-green-prs.mjs", import.meta.url), "utf8");
const enqueueWorkflow = readFileSync(new URL("../.github/workflows/auto-enqueue.yml", import.meta.url), "utf8");

describe("#1958 auto-enqueue leaves draft PRs silent", () => {
  it("contains no stale-draft reminder path", () => {
    expect(enqueueScript).not.toContain("enqueue-bot:stale-draft");
    expect(enqueueScript).not.toContain("DRAFT_AGE_HOURS");
  });

  it("does not grant issue-write permission", () => {
    expect(enqueueWorkflow).not.toMatch(/^\s*issues:\s*write\b/m);
  });
});
