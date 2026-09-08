import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #5286 — `scripts/audit-legacy-reachability.mjs` reports R10's deletion scope,
 * but the *bucket* half of that report is asserted, not measured: `bucketOf` is
 * a lookup on the file path (`BUCKET_FILE` by name, `BUCKET_PREFIX` by
 * directory, else `stays`) that consumes nothing from the reachability
 * analysis printed beside it. The audit now records HOW each file got its
 * bucket (`bucketBasis`) and flags files whose measured classes contradict it
 * (`bucketConflict`).
 *
 * These are the properties that make that reporting non-vacuous. The audit
 * writes its per-file result only to a JSON artifact — it exports no structure
 * to import — so the test runs the script and reads that artifact. That is
 * deliberate: #5286 was scoped to leave the script's behaviour inert, and
 * reshaping it into an importable module to suit a test would have been exactly
 * the change the issue said not to make.
 *
 * Pinned by property, never by count. Asserting "12 conflicts" or "107 frontend
 * files" would go red the day someone legitimately re-buckets a file — which is
 * the outcome this issue exists to enable. The named files below are
 * intentional tripwires: if one is deliberately re-bucketed, update it here in
 * that same change.
 */

type AuditFile = {
  file: string;
  bucket: string;
  bucketBasis: "named" | "prefix" | "default";
  bucketConflict: boolean;
  totalLines: number;
  legacyLoc: number;
  sharedLoc: number;
  deadLoc: number;
  fns: { name: string; loc: number; cls: string; exported: boolean; start: number }[];
};

const CLOSURES = "src/codegen/closures.ts";
const NESTED_DECLS = "src/codegen/statements/nested-declarations.ts";

// Conflicts with ZERO legacy-only lines — nothing in them dies with the legacy
// front end, yet they sit in its deletion scope. The most clearly wrong
// membership the audit reports, and the easiest to lose silently in a refactor.
const ZERO_LEGACY_CONFLICTS = [
  "src/codegen/expressions/identifier-module-storage.ts",
  "src/codegen/expressions/this-keyword.ts",
  "src/codegen/statements/tdz.ts",
  "src/codegen/expressions/eval-source.ts",
];

describe("#5286 — audit-legacy-reachability bucket provenance", () => {
  let tmpDir: string;
  let perFile: AuditFile[];
  let byFile: Map<string, AuditFile>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-bucket-provenance-"));
    const out = join(tmpDir, "legacy-reachability.json");
    // Written to a temp path so a developer's own .tmp/legacy-reachability.json
    // is not clobbered by running the suite.
    execFileSync("node", ["scripts/audit-legacy-reachability.mjs", "--json", out], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    perFile = JSON.parse(readFileSync(out, "utf-8")).perFile;
    byFile = new Map(perFile.map((f) => [f.file, f]));
  }, 180_000);

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const rec = (file: string): AuditFile => {
    const f = byFile.get(file);
    if (!f) throw new Error(`${file} missing from the audit — it no longer parses as a src/codegen file?`);
    return f;
  };

  // -- 1. Non-vacuity: the flag must actually fire ---------------------------

  it("flags closures.ts as a bucket conflict", () => {
    const f = rec(CLOSURES);
    expect(f.bucket).toBe("frontend");
    expect(f.bucketConflict).toBe(true);
    expect(f.sharedLoc).toBeGreaterThan(f.legacyLoc);
  });

  it("flags statements/nested-declarations.ts as a bucket conflict", () => {
    const f = rec(NESTED_DECLS);
    expect(f.bucket).toBe("frontend");
    expect(f.bucketConflict).toBe(true);
    expect(f.sharedLoc).toBeGreaterThan(f.legacyLoc);
  });

  // -- 2. The distinction the issue is about --------------------------------

  it("records closures.ts as bucketed by NAME and nested-declarations.ts by PREFIX", () => {
    // One was hand-typed into BUCKET_FILE; the other was swept in by the
    // `src/codegen/statements/` directory prefix. Same bucket, different basis —
    // that difference is the whole point of #5286, so a change that collapsed
    // the two into one basis would be a real regression.
    expect(rec(CLOSURES).bucketBasis).toBe("named");
    expect(rec(NESTED_DECLS).bucketBasis).toBe("prefix");
  });

  it("keeps both bases represented among the conflicts", () => {
    // Survives any single file being legitimately re-bucketed, so the
    // non-vacuity guarantee does not rest solely on the two names above.
    const bases = new Set(perFile.filter((f) => f.bucketConflict).map((f) => f.bucketBasis));
    expect(bases).toContain("named");
    expect(bases).toContain("prefix");
  });

  // -- 3. The provably-wrong membership -------------------------------------

  it.each(ZERO_LEGACY_CONFLICTS)("flags %s — zero legacy-only lines, still in deletion scope", (file) => {
    const f = rec(file);
    expect(f.bucket).toBe("frontend");
    expect(f.legacyLoc).toBe(0);
    expect(f.sharedLoc).toBeGreaterThan(0);
    expect(f.bucketConflict).toBe(true);
  });

  // -- 4. The flag means what the report says it means -----------------------

  it("sets bucketConflict exactly when a frontend file's shared lines exceed its legacy-only lines", () => {
    // Guards the definition itself rather than any file list, so it holds
    // across re-bucketing.
    for (const f of perFile) {
      expect(f.bucketConflict).toBe(f.bucket === "frontend" && f.sharedLoc > f.legacyLoc);
    }
  });

  it("gives every file a basis, and every default-basis file the fall-through bucket", () => {
    for (const f of perFile) {
      expect(["named", "prefix", "default"]).toContain(f.bucketBasis);
      if (f.bucketBasis === "default") expect(f.bucket).toBe("stays");
    }
  });
});
