// #7559 — the advisory open-PR file-overlap check.
//
// Hermetic: every GitHub call goes through an injected `ghJson` fetcher, and
// the cache lives in a temp dir, so no test touches the network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findPathOverlaps,
  formatOverlaps,
  issuePlanPaths,
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
  head: { ref: branch, sha: `sha${number}` },
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
    { number: 1, title: "a", author: "x", branch: "b1", draft: false, hold: false, sha: "s", files: ["src/a.ts"] },
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

  it("excludes the caller's own PR and branch", () => {
    expect(findPathOverlaps(["src/a.ts"], prs, { excludePr: 2, excludeBranch: "b1" })).toEqual([]);
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
      checked: false,
      reason: "GitHub unreachable or rate-limited (HTTP 403: API rate limit exceeded)",
    });
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

  it("exits 2 on a usage error", async () => {
    expect((await run(["--paths"], {})).code).toBe(2);
    expect((await run(["--nope"], {})).code).toBe(2);
  });
});
