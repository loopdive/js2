// #3964 — the committed-tree issue-integrity gate (.husky/pre-push step 5b,
// and the `quality` job via check-merged-issue-integrity.mjs) now reads every
// issue blob with a single `git cat-file --batch` instead of one `git show`
// per file. These tests pin the two things that rewrite could plausibly break:
//
//   1. It still DETECTS. A faster checker that checks nothing also "passes",
//      so each of the three defect classes it is responsible for — duplicate
//      id, filename<->frontmatter id mismatch, dangling depends_on — gets an
//      explicit positive control.
//   2. It reads blob bodies by BYTE COUNT, not by scanning for newlines. A
//      `git cat-file --batch` stream is `<oid> blob <size>\n<body>\n`, and an
//      issue body can contain a line that looks exactly like that header. The
//      `headerShapedBody` fixture below is the trap: a line-splitting reader
//      desynchronises on it and misreads every subsequent file.
//
// Everything runs against a throwaway git repo in tmp, so no network, no
// fixtures in the real tree, and no dependence on the ~3,500 real issue files.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-committed-issue-integrity.mjs");

let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function writeIssue(name: string, frontmatter: Record<string, string>, body = "placeholder"): void {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(join(repo, "plan", "issues", name), `---\n${fm}\n---\n\n${body}\n`);
}

/** Commit everything and run the checker against the resulting tree. */
function checkCommitted(): { status: number; output: string } {
  git(["add", "-A"]);
  git(["commit", "--no-verify", "-q", "-m", "fixture"]);
  const res = spawnSync("node", [CHECKER, "HEAD"], { cwd: repo, encoding: "utf8" });
  return { status: res.status ?? 1, output: (res.stdout ?? "") + (res.stderr ?? "") };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "issue-integrity-"));
  mkdirSync(join(repo, "plan", "issues"), { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  // A healthy baseline: three well-formed issues, one depending on another.
  writeIssue("100-alpha.md", { id: "100", title: '"alpha"' });
  writeIssue("101-beta.md", { id: "101", title: '"beta"', depends_on: "[100]" });
  writeIssue("102-gamma.md", { id: "102", title: '"gamma"' });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("committed issue integrity — clean tree", () => {
  it("passes and reports how much it actually scanned", () => {
    const { status, output } = checkCommitted();
    expect(status).toBe(0);
    expect(output).toContain("OK");
    // Floor the count: a checker that silently scanned zero files is
    // indistinguishable from a clean tree unless it says what it read.
    expect(output).toContain("3 files scanned");
    expect(output).toContain("3 with frontmatter");
  });
});

describe("committed issue integrity — positive controls (it must still DETECT)", () => {
  it("fails on a duplicate id and names both files", () => {
    writeIssue("100-alpha-copy.md", { id: "100", title: '"dup"' });
    const { status, output } = checkCommitted();
    expect(status).toBe(1);
    expect(output).toContain("DUPLICATE IDs");
    expect(output).toContain("plan/issues/100-alpha.md");
    expect(output).toContain("plan/issues/100-alpha-copy.md");
  });

  it("fails when the frontmatter id disagrees with the filename prefix", () => {
    writeIssue("200-mismatch.md", { id: "201", title: '"mismatch"' });
    const { status, output } = checkCommitted();
    expect(status).toBe(1);
    expect(output).toContain("FILENAME/FRONTMATTER ID MISMATCH");
    expect(output).toContain("plan/issues/200-mismatch.md");
    expect(output).toContain("filename prefix=200");
    expect(output).toContain("frontmatter id=201");
  });

  it("fails on a dangling depends_on and names the missing target", () => {
    writeIssue("300-dangler.md", { id: "300", title: '"dangler"', depends_on: "[99999]" });
    const { status, output } = checkCommitted();
    expect(status).toBe(1);
    expect(output).toContain("DANGLING depends_on");
    expect(output).toContain("plan/issues/300-dangler.md");
    expect(output).toContain("#99999");
  });

  it("reports every defect class at once, not just the first", () => {
    writeIssue("100-alpha-copy.md", { id: "100", title: '"dup"' });
    writeIssue("200-mismatch.md", { id: "201", title: '"mismatch"' });
    writeIssue("300-dangler.md", { id: "300", title: '"dangler"', depends_on: "[99999]" });
    const { status, output } = checkCommitted();
    expect(status).toBe(1);
    expect(output).toContain("DUPLICATE IDs");
    expect(output).toContain("FILENAME/FRONTMATTER ID MISMATCH");
    expect(output).toContain("DANGLING depends_on");
  });
});

describe("committed issue integrity — batch-stream framing", () => {
  // The trap. `git cat-file --batch` frames each object as
  //   <oid> blob <size>\n<body>\n
  // and this body contains a line with exactly that shape. A reader that
  // located bodies by scanning for newlines instead of consuming <size> bytes
  // would resynchronise on the fake header and misread everything after it.
  const headerShapedBody = [
    "Some prose about a blob.",
    "0123456789abcdef0123456789abcdef01234567 blob 999999",
    "More prose, plus a stray NUL-free separator line.",
    "",
    "```",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa blob 12",
    "```",
  ].join("\n");

  it("reads bodies containing header-shaped lines without desynchronising", () => {
    writeIssue("400-header-shaped.md", { id: "400", title: '"trap"' }, headerShapedBody);
    // Files sort after the trap; if framing broke, their frontmatter would be
    // misparsed and the ids would go missing or collide.
    writeIssue("401-after.md", { id: "401", title: '"after"', depends_on: "[400]" });
    writeIssue("402-after.md", { id: "402", title: '"after two"', depends_on: "[401]" });

    const { status, output } = checkCommitted();
    expect(status).toBe(0);
    expect(output).toContain("6 files scanned");
    // All six parsed real frontmatter — the number that makes a silent
    // empty-read impossible to mistake for a clean tree.
    expect(output).toContain("6 with frontmatter");
    expect(output).toContain("6 issues indexed");
  });

  it("still detects a defect that sits after a header-shaped body", () => {
    writeIssue("400-header-shaped.md", { id: "400", title: '"trap"' }, headerShapedBody);
    writeIssue("401-after.md", { id: "402", title: '"mismatch after the trap"' });
    const { status, output } = checkCommitted();
    expect(status).toBe(1);
    expect(output).toContain("FILENAME/FRONTMATTER ID MISMATCH");
    expect(output).toContain("plan/issues/401-after.md");
  });

  it("handles a body whose byte length exceeds its character length (multi-byte UTF-8)", () => {
    // size is in BYTES; slicing by character offset would truncate here.
    writeIssue("500-utf8.md", { id: "500", title: '"utf8"' }, "→→→ ünïcödé ✓ →→→".repeat(50));
    writeIssue("501-next.md", { id: "501", title: '"next"' });
    const { status, output } = checkCommitted();
    expect(status).toBe(0);
    expect(output).toContain("5 files scanned");
    expect(output).toContain("5 with frontmatter");
  });
});

describe("committed issue integrity — refuses to pass vacuously", () => {
  it("does not report OK when it scanned zero issue files", () => {
    // An empty (but valid) tree: no issue files at all. A checker that passes
    // here cannot distinguish "clean" from "never looked".
    rmSync(join(repo, "plan", "issues"), { recursive: true, force: true });
    mkdirSync(join(repo, "plan", "issues"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "no issues here\n");
    const { status, output } = checkCommitted();
    expect(status).toBe(1);
    expect(output).toContain("INCONCLUSIVE");
    expect(output).toMatch(/scanned 0 issue files/);
  });
});
