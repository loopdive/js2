/**
 * #6795 — CHANGELOG.md is published in the package `files`, and it stopped at
 * 0.52 while the package read 0.71. Two guards:
 *
 *  1. `scripts/release.mjs` refuses to cut a version that has no CHANGELOG
 *     entry, so the file cannot fall behind again.
 *  2. The committed CHANGELOG has an entry for every release tag from v0.56.0
 *     (the first tag after v0.52.0; v0.53.0-v0.55.0 were never cut) to the
 *     current package version, and neither it nor `docs/releases/` carries a
 *     local filesystem path.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import { hasChangelogEntry } from "../scripts/release.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("hasChangelogEntry", () => {
  const log = ["# Changelog", "", "## Sprint 52 - v0.52.0", "", "## v0.59.1 - 2026-06-29", "", "### v0.60.0", ""].join(
    "\n",
  );

  it("matches a `## vX.Y.Z` release heading and the older `## Sprint N - vX.Y.Z` form", () => {
    expect(hasChangelogEntry(log, "0.59.1")).toBe(true);
    expect(hasChangelogEntry(log, "0.52.0")).toBe(true);
  });

  it("matches the version as a whole token, never a prefix or suffix of another", () => {
    expect(hasChangelogEntry(log, "0.59")).toBe(false);
    expect(hasChangelogEntry("## v0.59.10 - x", "0.59.1")).toBe(false);
    expect(hasChangelogEntry("## v0.59.1.2 - x", "0.59.1")).toBe(false);
    expect(hasChangelogEntry("## v10.59.1 - x", "0.59.1")).toBe(false);
    expect(hasChangelogEntry("## v0.59.1-rc.1 - x", "0.59.1")).toBe(false);
    expect(hasChangelogEntry("## v0.59.1-rc.1 - x", "0.59.1-rc.1")).toBe(true);
  });

  it("requires a level-2 heading: prose, list items and deeper headings do not count", () => {
    expect(hasChangelogEntry(log, "0.60.0")).toBe(false); // only a ### heading
    expect(hasChangelogEntry("Released v0.61.0 today\n- v0.61.0\n", "0.61.0")).toBe(false);
  });

  it("is false for an empty or missing file", () => {
    expect(hasChangelogEntry("", "0.1.0")).toBe(false);
  });
});

describe("scripts/release.mjs refuses a version with no CHANGELOG entry", () => {
  let sandbox: string | undefined;
  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  });

  /** A throwaway git repo shaped like the real one, with the real script copied in. */
  function makeRepo(changelog: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "issue-6795-release-"));
    sandbox = dir;
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "packages", "js2wasm"), { recursive: true });
    cpSync(join(REPO_ROOT, "scripts", "release.mjs"), join(dir, "scripts", "release.mjs"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@loopdive/js2", version: "0.0.1" }, null, 2));
    writeFileSync(
      join(dir, "packages", "js2wasm", "package.json"),
      JSON.stringify({ name: "js2wasm", version: "0.0.1", dependencies: { "@loopdive/js2": "0.0.1" } }, null, 2),
    );
    writeFileSync(join(dir, "jsr.json"), JSON.stringify({ name: "@loopdive/js2", version: "0.0.1" }, null, 2));
    if (changelog !== null) writeFileSync(join(dir, "CHANGELOG.md"), changelog);
    const git = (...a: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a],
        {
          cwd: dir,
          stdio: "ignore",
        },
      );
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    return dir;
  }

  const release = (dir: string, version: string) =>
    spawnSync(process.execPath, [join(dir, "scripts", "release.mjs"), version], { cwd: dir, encoding: "utf8" });

  for (const [label, changelog] of [
    ["has no entry for that version", "# Changelog\n\n## v0.0.1 - 2026-01-01\n"],
    ["is missing entirely", null],
  ] as const) {
    it(`exits 1 before bumping anything when CHANGELOG.md ${label}`, () => {
      const dir = makeRepo(changelog);
      const r = release(dir, "0.0.2");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("CHANGELOG.md has no entry for v0.0.2");
      // Nothing was touched: versions unchanged, no tag, tree still clean.
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("0.0.1");
      expect(execFileSync("git", ["tag", "--list"], { cwd: dir, encoding: "utf8" }).trim()).toBe("");
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim()).toBe("");
    });
  }

  // The positive path is covered by the hasChangelogEntry cases above: past
  // this gate the script shells out to `pnpm version`, which a throwaway repo
  // has no business running.
});

describe("the committed CHANGELOG", () => {
  const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");

  // Every release tag after v0.52.0. v0.53.0-v0.55.0 were never cut.
  const tagged = [
    "0.56.0",
    "0.57.0",
    "0.58.0",
    "0.59.0",
    "0.59.1",
    "0.59.2",
    "0.59.3",
    "0.59.4",
    "0.59.5",
    "0.60.0",
    "0.60.1",
    "0.61.0",
    "0.62.0",
    "0.63.0",
    "0.64.0",
    "0.64.1",
    "0.65.0",
    "0.66.0",
    "0.67.0",
    "0.68.0",
    "0.69.0",
    "0.70.0",
    "0.71.0",
  ];

  it("has an entry for every release tag from v0.56.0 through v0.71.0", () => {
    const missing = tagged.filter((v) => !hasChangelogEntry(changelog, v));
    expect(missing, `CHANGELOG.md lacks entries for: ${missing.join(", ")}`).toEqual([]);
  });

  it("has an entry for the version package.json currently carries", () => {
    const { version } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(hasChangelogEntry(changelog, version), `no CHANGELOG entry for ${version}`).toBe(true);
  });

  it("carries no local filesystem path", () => {
    expect(changelog).not.toMatch(/\/Users\/|\/home\/[a-z]|[A-Za-z]:\\Users\\/);
  });

  it("docs/releases/ carries no local filesystem path", () => {
    const dir = join(REPO_ROOT, "docs", "releases");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
      expect(readFileSync(join(dir, f), "utf8"), `docs/releases/${f}`).not.toMatch(
        /\/Users\/|\/home\/[a-z]|[A-Za-z]:\\Users\\/,
      );
    }
  });
});
