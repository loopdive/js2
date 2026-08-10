// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * A release PR must not drag the full test262 matrix through the merge queue.
 *
 * `package.json` is on the `&test262-paths` allowlist because a DEPENDENCY
 * change genuinely can move conformance. `node scripts/release.mjs <x.y.z>`
 * touches it too, and a version bump provably cannot — so PR #4317 (v0.69.0)
 * ran the whole ~19-minute matrix in its merge group for a one-line diff.
 *
 * The classifier's contract is the matcher's: **if detection is in any way
 * uncertain, keep the path and run the shards.** Only a positive proof that
 * nothing outside the keys `release.mjs` moves has changed may drop a path.
 * The tests below are organised around that asymmetry — one case proves the
 * skip, the rest prove the fallbacks.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyManifestChange, differingKeyPaths, RELEASE_MOVED_KEYS } from "../scripts/manifest-version-only.mjs";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

const pkg = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "@loopdive/js2",
    version: "0.68.0",
    keywords: ["webassembly", "typescript"],
    dependencies: { binaryen: "1.2.3" },
    scripts: { build: "tsc" },
    engines: { node: ">=22" },
    ...over,
  });

describe("classifyManifestChange — the skip", () => {
  it("drops a version-only package.json bump", () => {
    const verdict = classifyManifestChange({
      path: "package.json",
      before: pkg({ version: "0.68.0" }),
      after: pkg({ version: "0.69.0" }),
    });
    expect(verdict.versionOnly).toBe(true);
    expect(verdict.reason).toBe("version-only");
  });

  it("drops the lockstep version + pinned-dependency bump in packages/js2wasm/package.json", () => {
    // release.mjs moves the proxy package's own version AND its pin on the
    // canonical package together; both are in that file's allowlist.
    const before = JSON.stringify({ name: "js2wasm", version: "0.68.0", dependencies: { "@loopdive/js2": "0.68.0" } });
    const after = JSON.stringify({ name: "js2wasm", version: "0.69.0", dependencies: { "@loopdive/js2": "0.69.0" } });
    expect(classifyManifestChange({ path: "packages/js2wasm/package.json", before, after }).versionOnly).toBe(true);
  });

  it("treats an identical-content diff entry as droppable", () => {
    // A file can appear in `--name-only` for a mode change. Identical content
    // cannot move conformance either.
    const verdict = classifyManifestChange({ path: "package.json", before: pkg(), after: pkg() });
    expect(verdict).toEqual({ versionOnly: true, reason: "no-key-differences" });
  });
});

describe("classifyManifestChange — everything uncertain keeps the matrix", () => {
  it("keeps a version bump that ALSO changes a dependency", () => {
    const verdict = classifyManifestChange({
      path: "package.json",
      before: pkg({ version: "0.68.0" }),
      after: pkg({ version: "0.69.0", dependencies: { binaryen: "1.3.0" } }),
    });
    expect(verdict.versionOnly).toBe(false);
    expect(verdict.reason).toContain("dependencies.binaryen");
  });

  it.each([
    ["an added dependency", { dependencies: { binaryen: "1.2.3", acorn: "8.0.0" } }],
    ["a removed dependency", { dependencies: {} }],
    ["a script change", { scripts: { build: "tsc --noEmit" } }],
    ["an engines change", { engines: { node: ">=24" } }],
    ["a keywords reorder", { keywords: ["typescript", "webassembly"] }],
  ])("keeps %s", (_label, over) => {
    expect(classifyManifestChange({ path: "package.json", before: pkg(), after: pkg(over) }).versionOnly).toBe(false);
  });

  it.each([
    ["malformed on the after side", pkg(), "{ not json"],
    ["malformed on the before side", "{ not json", pkg()],
    ["empty on one side (added/deleted file)", "", pkg()],
  ])("keeps a manifest %s", (_label, before, after) => {
    const verdict = classifyManifestChange({ path: "package.json", before, after });
    expect(verdict).toEqual({ versionOnly: false, reason: "unparseable-json" });
  });

  it("keeps a manifest whose blob could not be read", () => {
    expect(classifyManifestChange({ path: "package.json", before: null, after: pkg() })).toEqual({
      versionOnly: false,
      reason: "blob-unavailable",
    });
  });

  it("keeps a JSON document that is not an object", () => {
    expect(classifyManifestChange({ path: "package.json", before: "[]", after: "[1]" }).reason).toBe(
      "not-a-json-object",
    );
  });

  it("leaves non-manifest paths alone", () => {
    // Unchanged behaviour: only the table's paths are ever considered, so a
    // source file is never even inspected.
    for (const path of ["src/codegen/index.ts", "pnpm-lock.yaml", "tests/test262-runner.ts"]) {
      expect(classifyManifestChange({ path, before: pkg(), after: pkg() })).toEqual({
        versionOnly: false,
        reason: "not-a-release-manifest",
      });
    }
    expect(RELEASE_MOVED_KEYS.has("pnpm-lock.yaml")).toBe(false);
  });
});

describe("differingKeyPaths", () => {
  it("reports nested keys by full path and treats arrays as whole values", () => {
    expect(differingKeyPaths({ a: { b: 1 }, k: [1, 2] }, { a: { b: 2 }, k: [2, 1] })).toEqual([["a", "b"], ["k"]]);
  });

  it("reports keys present on only one side", () => {
    expect(differingKeyPaths({ a: 1 }, { a: 1, b: 2 })).toEqual([["b"]]);
    expect(differingKeyPaths({ a: 1, b: 2 }, { a: 1 })).toEqual([["b"]]);
  });
});

describe("CLI filtering", () => {
  const run = (stdin: string, args: string[] = []) =>
    execFileSync("node", [resolve(ROOT, "scripts/manifest-version-only.mjs"), ...args], {
      input: stdin,
      encoding: "utf8",
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });

  it("keeps every path when --base/--head are missing", () => {
    // Fail-safe: with no revisions there is nothing to prove, so nothing drops.
    expect(run("package.json\nsrc/x.ts\n").trim().split("\n")).toEqual(["package.json", "src/x.ts"]);
  });

  it("passes non-manifest paths through untouched", () => {
    const out = run("src/x.ts\ntests/test262-runner.ts\n", ["--base", "HEAD", "--head", "HEAD"]);
    expect(out.trim().split("\n")).toEqual(["src/x.ts", "tests/test262-runner.ts"]);
  });
});

describe("wiring in test262-sharded.yml", () => {
  const wf = readFileSync(resolve(ROOT, ".github/workflows/test262-sharded.yml"), "utf8");
  const detect = wf.slice(wf.indexOf("- name: Detect test262-relevant changes"));

  it("filters the diff and feeds the FILTERED list to the matcher", () => {
    expect(detect).toContain("node scripts/manifest-version-only.mjs --base");
    expect(detect).toMatch(/\$FILTERED[\s\S]*test262-paths-match\.sh --target host/);
    expect(detect).toMatch(/\$FILTERED[\s\S]*test262-paths-match\.sh --target standalone/);
  });

  it("runs AFTER the empty-diff fail-safe, never before it", () => {
    // An empty RAW diff is suspicious and must still force a full run; an
    // empty FILTERED list is the legitimate release-only answer. Swapping the
    // order would turn the second into the first and silently undo the fix.
    expect(detect.indexOf("Empty diff for merge_group")).toBeLessThan(detect.indexOf("manifest-version-only.mjs"));
  });

  it("falls back to the unfiltered diff when the filter exits non-zero", () => {
    expect(detect).toMatch(/filter_rc[\s\S]{0,400}FILTERED="\$DIFF"/);
  });

  it("keeps the filter itself on the test262-relevant path list", () => {
    // It is part of the gating decision now, so a change to it must be
    // validated by exactly what it might skip — same rule as the matcher.
    expect(wf).toContain('- "scripts/manifest-version-only.mjs"');
    expect(readFileSync(resolve(ROOT, "scripts/test262-paths-match.sh"), "utf8")).toContain(
      "scripts/manifest-version-only.mjs) echo both ;;",
    );
  });
});

describe("the real #4317 release diff", () => {
  // The control case from the report: v0.69.0 ran the full matrix with no
  // source change. Read the actual commit rather than a reconstruction — a
  // hand-written fixture would not catch release.mjs changing what it writes.
  const RELEASE_COMMIT = "9b6968b3517b07717659e96b425974f9a9ab5e56";

  const available = (() => {
    try {
      execFileSync("git", ["cat-file", "-e", `${RELEASE_COMMIT}^{commit}`], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  const show = (rev: string, path: string) =>
    execFileSync("git", ["show", `${rev}:${path}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

  it.runIf(available)("touches only manifests plus release notes, and no lockfile", () => {
    const changed = execFileSync("git", ["show", "--name-only", "--format=", RELEASE_COMMIT], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(changed.sort()).toEqual([
      "docs/release-notes/v0.69.0.md",
      "jsr.json",
      "package.json",
      "packages/js2wasm/package.json",
    ]);
    expect(changed).not.toContain("pnpm-lock.yaml");
  });

  it.runIf(available)("classifies every manifest it touches as version-only", () => {
    for (const path of ["package.json", "packages/js2wasm/package.json", "jsr.json"]) {
      const verdict = classifyManifestChange({
        path,
        before: show(`${RELEASE_COMMIT}^`, path),
        after: show(RELEASE_COMMIT, path),
      });
      expect(verdict, `${path}: ${verdict.reason}`).toEqual({ versionOnly: true, reason: "version-only" });
    }
  });

  it.runIf(available)("leaves nothing test262-relevant, so the matrix would skip", () => {
    // End to end through both stages: the filter drops package.json (the only
    // one of the four on the allowlist) and the matcher then sees nothing
    // relevant. `docs/` and `jsr.json` were never on the list.
    const changed = "docs/release-notes/v0.69.0.md\njsr.json\npackage.json\npackages/js2wasm/package.json\n";
    const filtered = execFileSync(
      "node",
      [resolve(ROOT, "scripts/manifest-version-only.mjs"), "--base", `${RELEASE_COMMIT}^`, "--head", RELEASE_COMMIT],
      {
        input: changed,
        encoding: "utf8",
        cwd: ROOT,
      },
    );
    expect(filtered).not.toContain("package.json\n");
    const verdict = execFileSync("bash", [resolve(ROOT, "scripts/test262-paths-match.sh")], {
      input: filtered,
      encoding: "utf8",
      cwd: ROOT,
    }).trim();
    expect(verdict).toBe("false");
    // Control: WITHOUT the filter the same diff is relevant — which is exactly
    // what cost #4317 a full matrix.
    expect(
      execFileSync("bash", [resolve(ROOT, "scripts/test262-paths-match.sh")], {
        input: changed,
        encoding: "utf8",
        cwd: ROOT,
      }).trim(),
    ).toBe("true");
  });
});
