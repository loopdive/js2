// #4521 — one definition for the caller-direction demotion policy.
//
// The structural selector (select.ts) and the production identity selector
// (select-identity.ts) used to compute `demoteOnLegacyCaller` independently
// ("two mirrored places", per the #3518 2026-08-15 notes). A future edit that
// touches only one silently forks selection behavior between the two paths —
// a drift no other gate detects, because the paths are never diffed against
// each other. This test pins the shared-module contract at the source level.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { demoteOnLegacyCallerPolicy, jsHostExternsEnabled } from "../src/ir/legacy-caller-policy.js";

const IR_DIR = join(__dirname, "..", "src", "ir");

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkTsFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
}

describe("#4521 caller-direction demotion policy", () => {
  it("demotes exactly outside JS-host mode", () => {
    expect(demoteOnLegacyCallerPolicy(undefined)).toBe(true);
    expect(demoteOnLegacyCallerPolicy({})).toBe(true);
    expect(demoteOnLegacyCallerPolicy({ jsHostExterns: false })).toBe(true);
    expect(demoteOnLegacyCallerPolicy({ jsHostExterns: true })).toBe(false);
    expect(jsHostExternsEnabled({ jsHostExterns: true })).toBe(true);
    expect(jsHostExternsEnabled(undefined)).toBe(false);
  });

  it("is the single home of the mode comparison under src/ir/", () => {
    const files: string[] = [];
    walkTsFiles(IR_DIR, files);
    const hits = files.filter((f) => readFileSync(f, "utf-8").includes("jsHostExterns !== true"));
    expect(hits.map((f) => f.slice(IR_DIR.length + 1))).toEqual(["legacy-caller-policy.ts"]);
  });

  it("both selector paths consult the shared policy", () => {
    for (const file of ["select.ts", "select-identity.ts"]) {
      const src = readFileSync(join(IR_DIR, file), "utf-8");
      expect(src, `${file} must consult demoteOnLegacyCallerPolicy`).toContain(
        "demoteOnLegacyCaller = demoteOnLegacyCallerPolicy(options)",
      );
    }
  });
});
