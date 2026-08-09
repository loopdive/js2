// #3636 — the >100-file REST fallback must UNION with the GraphQL first page,
// never replace it.
//
// `openPrIssueFiles` collects issue-file paths from a batched GraphQL query
// (100 files per PR), then re-reads any PR whose file list was truncated via
// REST `--paginate`. That second pass used to `byPr.set(n, hits)` outright, so
// everything the first page had already told us about that PR was discarded.
//
// In production `--paginate` returns a superset, which is why this has not been
// witnessed. It is still wrong, and wrong in the dangerous direction: the id
// universe feeds `--allocate`, and an id missing from the universe does not look
// like an error — it looks like a FREE id, and the collision only surfaces in
// the merge_group.
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(__dirname, "..", "scripts", "claim-issue.mjs");

function scanWithFakeGh(fakeGhBody: string): { ids: number[]; complete: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-3636-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!/usr/bin/env bash\n${fakeGhBody}\n`);
  chmodSync(gh, 0o755);
  const out = execFileSync(process.execPath, [SCRIPT, "--debug-pr-scan"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

/** GraphQL reports PR 7 as truncated, with one issue file on the first page. */
const GRAPHQL_TRUNCATED = `
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  cat <<'EOF'
{"data":{"repository":{"pullRequests":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[
  {"number":7,"files":{"pageInfo":{"hasNextPage":true},"nodes":[{"path":"plan/issues/9998-first-page.md","changeType":"ADDED"}]}}
]}}}}
EOF
  exit 0
fi`;

describe("#3636 open-PR scan — the id universe must only ever grow", () => {
  it("keeps first-page ids when the REST fallback does not repeat them", () => {
    // The REST page lists a DIFFERENT issue file. Replacing would drop 9998 —
    // and 9998 would then look free to --allocate.
    const { ids, complete } = scanWithFakeGh(`${GRAPHQL_TRUNCATED}
if [ "$1" = "api" ] && [[ "$2" == repos/*/pulls/7/files ]]; then
  printf 'src/a.ts\\nplan/issues/9997-tail-page.md\\n'
  exit 0
fi
exit 1`);
    expect(complete).toBe(true);
    expect(ids).toEqual([9997, 9998]);
  });

  it("keeps first-page ids when the REST fallback returns no issue files at all", () => {
    // A REST result carrying only non-issue files must not erase the PR. Under
    // the old `else byPr.delete(n)` this returned [] — a silently empty id
    // universe, which is indistinguishable from "nothing is in flight".
    const { ids, complete } = scanWithFakeGh(`${GRAPHQL_TRUNCATED}
if [ "$1" = "api" ] && [[ "$2" == repos/*/pulls/7/files ]]; then
  printf 'src/a.ts\\nsrc/b.ts\\n'
  exit 0
fi
exit 1`);
    expect(complete).toBe(true);
    expect(ids).toEqual([9998]);
  });

  it("does not duplicate an id the REST page repeats", () => {
    const { ids } = scanWithFakeGh(`${GRAPHQL_TRUNCATED}
if [ "$1" = "api" ] && [[ "$2" == repos/*/pulls/7/files ]]; then
  printf 'plan/issues/9998-first-page.md\\nplan/issues/9997-tail-page.md\\n'
  exit 0
fi
exit 1`);
    expect(ids).toEqual([9997, 9998]);
  });
});
