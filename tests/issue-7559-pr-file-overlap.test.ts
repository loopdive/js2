// #7559 — the advisory open-PR file-overlap check.
//
// Hermetic: every GitHub call goes through an injected `ghJson` fetcher or a
// fake `gh` on PATH, and the cache lives in a temp dir, so no test touches the
// GitHub API.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findPathOverlaps,
  formatOverlaps,
  issuePlanPaths,
  ghRest,
  openPrFiles,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../scripts/lib/open-pr-files.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { main } from "../scripts/pr-file-overlap.mjs";

type Call = string;

const pull = (number: number, branch: string, labels: string[] = []) => ({
  number,
  title: `PR ${number}`,
  user: { login: "dev" },
  head: { ref: branch, sha: `sha${number}`, repo: { full_name: "loopdive/js2" } },
  draft: false,
  labels: labels.map((name) => ({ name })),
});

/** A fake GitHub: `pulls` is the open-PR list, `files[n]` PR n's changed-file entries. */
function fakeGitHub(pulls: object[], files: Record<number, object[]>) {
  const calls: Call[] = [];
  const page = (items: object[], endpoint: string) => {
    const n = Number(new URL(`https://x/${endpoint}`).searchParams.get("page"));
    return items.slice((n - 1) * 100, n * 100);
  };
  const ghJson = async (endpoint: string) => {
    calls.push(endpoint);
    const m = endpoint.match(/pulls\/(\d+)\/files/);
    return page(m ? files[Number(m[1])] : pulls, endpoint);
  };
  return { ghJson, calls };
}

let dir: string;
let cacheFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-overlap-"));
  cacheFile = path.join(dir, "cache.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("#7559 findPathOverlaps", () => {
  const prs = [
    {
      number: 1,
      title: "a",
      author: "x",
      branch: "b1",
      headRepo: "Me/js2",
      draft: false,
      hold: false,
      sha: "s",
      files: ["src/a.ts"],
    },
    {
      number: 2,
      title: "b",
      author: "y",
      branch: "b2",
      draft: true,
      hold: true,
      sha: "s",
      files: ["src/a.ts", "src/b.ts", "plan/issues/9-x.md"],
    },
    { number: 3, title: "c", author: "z", branch: "b3", draft: false, hold: false, sha: "s", files: ["docs/c.md"] },
  ];

  it("finds the overlapping PRs, most overlapping paths first", () => {
    const overlaps = findPathOverlaps(["src/a.ts", "src/b.ts"], prs);
    expect(overlaps.map((o: { number: number; paths: string[] }) => [o.number, o.paths])).toEqual([
      [2, ["src/a.ts", "src/b.ts"]],
      [1, ["src/a.ts"]],
    ]);
    expect(overlaps[0]).toMatchObject({ draft: true, hold: true, author: "y", branch: "b2" });
  });

  it("returns nothing when no PR touches the paths", () => {
    expect(findPathOverlaps(["src/z.ts"], prs)).toEqual([]);
  });

  it("excludes the caller's own PR, by number or by branch AND head repository", () => {
    const excludeHead = { branch: "b1", repos: ["me/js2"] };
    expect(findPathOverlaps(["src/a.ts"], prs, { excludePr: 2, excludeHead })).toEqual([]);
  });

  it("keeps a same-named branch from another fork: that is the duplicate PR to show", () => {
    const excludeHead = { branch: "b1", repos: ["someone-else/js2"] };
    const overlaps = findPathOverlaps(["src/a.ts"], prs, { excludePr: 2, excludeHead });
    expect(overlaps.map((o: { number: number }) => o.number)).toEqual([1]);
  });

  it("marks a PR whose file list GitHub cut at its cap", () => {
    const lines = formatOverlaps(findPathOverlaps(["src/a.ts"], [{ ...prs[0], truncated: true }]));
    expect(lines[0]).toContain("file list cut at 3000 by GitHub");
  });

  it("ignores planning paths that never conflict meaningfully", () => {
    expect(findPathOverlaps(["plan/issues/9-x.md", "dashboard/x.json", "public/y.html"], prs)).toEqual([]);
  });

  it("formats one header per PR, then its paths, cut to maxLines", () => {
    const lines = formatOverlaps(findPathOverlaps(["src/a.ts", "src/b.ts"], prs), { maxLines: 3 });
    expect(lines).toEqual([
      "#2 b — y, branch b2 [draft, hold]",
      "    src/a.ts",
      "… 3 more line(s); run without --max-lines",
    ]);
  });
});

describe("#7559 openPrFiles", () => {
  it("pages through a PR's files and counts a rename's old path", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ filename: `src/f${i}.ts` }));
    many.push({ filename: "src/new.ts", previous_filename: "src/old.ts" } as never);
    const gh = fakeGitHub([pull(7, "b7")], { 7: many });
    const result = await openPrFiles({ ghJson: gh.ghJson, cacheFile });
    expect(result.checked).toBe(true);
    expect(result.prs[0].files).toHaveLength(152);
    expect(result.prs[0].files).toContain("src/old.ts");
    expect(gh.calls.filter((c) => c.includes("/files"))).toHaveLength(2);
  });

  it("serves a repeat call from the cache without a second fetch", async () => {
    const gh = fakeGitHub([pull(7, "b7", ["hold"])], { 7: [{ filename: "src/a.ts" }] });
    await openPrFiles({ ghJson: gh.ghJson, cacheFile });
    const first = gh.calls.length;
    const again = await openPrFiles({ ghJson: gh.ghJson, cacheFile });
    expect(gh.calls.length).toBe(first);
    expect(again.prs[0]).toMatchObject({ number: 7, hold: true, files: ["src/a.ts"] });
  });

  it("after the list expires, refetches files only for a PR whose head moved", async () => {
    let t = 0;
    const now = () => t;
    const pulls = [pull(7, "b7"), pull(8, "b8")];
    const gh = fakeGitHub(pulls, { 7: [{ filename: "a" }], 8: [{ filename: "b" }] });
    await openPrFiles({ ghJson: gh.ghJson, cacheFile, now });
    gh.calls.length = 0;
    t = 10 * 60_000;
    pulls[1].head.sha = "moved";
    await openPrFiles({ ghJson: gh.ghJson, cacheFile, now });
    expect(gh.calls.map((c) => c.split("?")[0])).toEqual([
      "repos/loopdive/js2/pulls",
      "repos/loopdive/js2/pulls/8/files",
    ]);
  });

  it("degrades to NOT CHECKED when GitHub is unreachable", async () => {
    const ghJson = async () => {
      throw Object.assign(new Error("Command failed"), { stderr: "HTTP 403: API rate limit exceeded" });
    };
    expect(await openPrFiles({ ghJson, cacheFile })).toEqual({
      prs: null,
      checked: false,
      reason: "GitHub unreachable or rate-limited (HTTP 403: API rate limit exceeded)",
    });
  });

  it("returns the PR list but NOT CHECKED when a file fetch fails partway", async () => {
    const gh = fakeGitHub([pull(7, "b7"), pull(8, "b8")], { 7: [{ filename: "a" }] });
    const ghJson = (endpoint: string) =>
      endpoint.includes("/8/files") ? Promise.reject(new Error("HTTP 404: Not Found")) : gh.ghJson(endpoint);
    const result = await openPrFiles({ ghJson, cacheFile });
    expect(result.checked).toBe(false);
    expect(result.prs.map((pr: { number: number }) => pr.number)).toEqual([7, 8]);
    expect(result.prs[1].files).toBeUndefined();
  });

  it("stops at the deadline with NOT CHECKED", async () => {
    let t = 0;
    const gh = fakeGitHub([pull(7, "b7")], { 7: [{ filename: "a" }] });
    const ghJson = (endpoint: string) => {
      t += 25_000; // the list call alone spends the 20 s budget
      return gh.ghJson(endpoint);
    };
    const result = await openPrFiles({ ghJson, cacheFile, timeoutMs: 20_000, now: () => t });
    expect(result).toMatchObject({ checked: false, reason: expect.stringContaining("time budget exhausted") });
  });

  it("ignores a corrupt cache file and a cache from another repository", async () => {
    const gh = fakeGitHub([pull(7, "b7")], { 7: [{ filename: "a" }] });
    fs.writeFileSync(cacheFile, "{ torn");
    expect((await openPrFiles({ ghJson: gh.ghJson, cacheFile })).checked).toBe(true);
    const calls = gh.calls.length;
    expect(calls).toBe(2);
    const other = await openPrFiles({ ghJson: gh.ghJson, cacheFile, repo: "someone/else" });
    expect(other.checked).toBe(true);
    expect(gh.calls.length).toBe(calls + 2);
  });

  it("turns a non-JSON `gh` response into NOT CHECKED, not a crash", async () => {
    // A fake `gh` on PATH that answers like an intercepting proxy, exit 0.
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\necho "<html>proxy</html>"\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
      await expect(ghRest("repos/x/y/pulls", 5000)).rejects.toThrow("response is not JSON");
      const result = await openPrFiles({ cacheFile });
      expect(result).toMatchObject({ checked: false, reason: expect.stringContaining("not JSON") });
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("#7559 issuePlanPaths", () => {
  it("takes existing backticked paths from the Implementation Plan only", () => {
    const text = [
      "## Problem",
      "`src/elsewhere.ts`",
      "## Implementation Plan",
      "Edit `src/a.ts:120` and `src/b.ts#L4`, maybe `src/missing.ts`, run `npm test`.",
      "## Follow-up",
      "`src/c.ts`",
    ].join("\n");
    const exists = (p: string) => ["src/a.ts", "src/b.ts", "src/c.ts", "src/elsewhere.ts"].includes(p);
    expect(issuePlanPaths(text, exists)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("#7559 pr-file-overlap CLI", () => {
  const run = async (argv: string[], deps: object) => {
    const out: string[] = [];
    const code = await main(argv, { log: (l: string) => out.push(l), cacheFile, ...deps });
    return { code, out };
  };

  it("names the overlapping PR and ends with the verdict line", async () => {
    const gh = fakeGitHub([pull(7, "b7")], { 7: [{ filename: "src/a.ts" }] });
    const { code, out } = await run(["--paths", "src/a.ts", "src/b.ts"], { ghJson: gh.ghJson });
    expect(code).toBe(0);
    expect(out[0]).toContain("#7 PR 7");
    expect(out.at(-1)).toBe(
      "pr-file-overlap: 1 open PR(s) touch 1 of your 2 path(s) — settle it with the other lane on #7526",
    );
  });

  it("says OK when no open PR touches the paths", async () => {
    const gh = fakeGitHub([pull(7, "b7")], { 7: [{ filename: "src/a.ts" }] });
    const { out } = await run(["--paths", "src/z.ts"], { ghJson: gh.ghJson });
    expect(out).toEqual(["pr-file-overlap: OK — no open PR touches these 1 path(s)"]);
  });

  it("exits 0 with a NOT CHECKED verdict when GitHub is unreachable", async () => {
    const ghJson = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { code, out } = await run(["--paths", "src/a.ts"], { ghJson });
    expect(code).toBe(0);
    expect(out[0]).toContain("did NOT run");
    expect(out.at(-1)).toBe("pr-file-overlap: NOT CHECKED — GitHub unreachable or rate-limited (connect ECONNREFUSED)");
  });

  it("says NOT CHECKED, never OK, when one PR's files could not be fetched", async () => {
    const gh = fakeGitHub([pull(7, "b7"), pull(8, "b8")], { 7: [{ filename: "src/x.ts" }] });
    const ghJson = (endpoint: string) =>
      endpoint.includes("/8/files") ? Promise.reject(new Error("HTTP 404: Not Found")) : gh.ghJson(endpoint);
    const { code, out } = await run(["--paths", "src/a.ts"], { ghJson });
    expect(code).toBe(0);
    expect(out.at(-1)).toMatch(/^pr-file-overlap: NOT CHECKED — /);
  });

  it("--branch ends in NOT CHECKED, not a crash, when main cannot be resolved", () => {
    const repo = path.join(dir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    const run = spawnSync(process.execPath, [path.resolve("scripts/pr-file-overlap.mjs"), "--branch"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split("\n").at(-1)).toMatch(/^pr-file-overlap: NOT CHECKED — cannot read this checkout/);
  });

  it("exits 2 on a usage error", async () => {
    expect((await run(["--paths"], {})).code).toBe(2);
    expect((await run(["--nope"], {})).code).toBe(2);
  });
});

describe("#7559 pre-dispatch-gate", () => {
  it("never exits 1 (STOP) when the open-PR lookup cannot run", () => {
    // An empty git repo (so the cache lands in it) and a `gh` that returns HTML.
    const repo = path.join(dir, "repo");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\necho "<html>proxy</html>"\n', { mode: 0o755 });
    execFileSync("git", ["init", "-q", repo]);
    const gate = path.resolve("scripts/pre-dispatch-gate.mjs");
    const run = spawnSync(process.execPath, [gate, "1", "--paths", "src/a.ts"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      timeout: 150_000,
    });
    expect(run.stdout).toContain("FILE OVERLAP NOT CHECKED");
    expect(run.status).toBe(2);
  }, 160_000);
});
