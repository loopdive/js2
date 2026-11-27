// Open pull requests and the files they change, over REST (#7559).
//
// WHY. On 2026-11-27 four PRs of one lane conflicted with main because two PRs
// of another lane changed the same files and landed first; neither lane knew.
// The manual lock table (plan/method/file-locks.md) that was meant to prevent
// this had rotted for seven months, because nothing forces an entry in or out.
// The changed-file lists of the open PRs are the same information, always
// current, so this module reads those instead.
//
// REST, not GraphQL: GraphQL is refused (HTTP 403) in Claude Code cloud
// sessions, which is where most lanes run. REST needs one call per PR for its
// files, so the file lists are cached by `number@headSha` — a PR's files can
// only change when its head moves — and only the PR list itself expires.
//
// The check is a coordination hint, so every GitHub failure degrades to
// `{ checked: false, reason }` instead of throwing: it must never block work,
// and the caller must say loudly that it did not run.

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isTransientGhFailure } from "./gh-api-retry.mjs";
import { UPSTREAM_REPO } from "./open-pr-issue-files.mjs";

/**
 * Path prefixes that never conflict meaningfully: the planning artifacts
 * (`dashboard/`, `plan/`, `public/`) that CLAUDE.md's merge protocol resolves
 * with `git checkout --theirs` + regen. Two PRs both editing an issue file are
 * not a coordination problem.
 */
export const IGNORED_OVERLAP_PATHS = ["dashboard/", "plan/", "public/"];

const PAGE_SIZE = 100;
const LIST_TTL_MS = 5 * 60_000;
const PARALLEL_CALLS = 8;
// GitHub's REST `pulls/N/files` stops at 3,000 files; a PR at the cap may change more.
const PR_FILES_CAP = 3000;
// Bumped when the cache's shape changes, so an older file is ignored, not misread.
const CACHE_VERSION = 2;

export function isIgnoredOverlapPath(file) {
  return IGNORED_OVERLAP_PATHS.some((prefix) => file.startsWith(prefix));
}

/** `.js2wasm-cache/open-pr-files.json` in the main checkout, so every worktree shares one cache. */
export function defaultCacheFile() {
  const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  return path.join(path.dirname(commonDir), ".js2wasm-cache", "open-pr-files.json");
}

/** `gh api <endpoint>` as parsed JSON — the default fetcher; tests inject their own. */
export function ghRest(endpoint, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["api", endpoint],
      { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(Object.assign(error, { stderr }));
        // Parse HERE so a non-JSON body (e.g. a proxy's HTML page) rejects the
        // promise instead of throwing out of the callback, past every catch.
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`gh api ${endpoint}: response is not JSON (${stdout.trim().slice(0, 60)})`));
        }
      },
    );
  });
}

/**
 * One call within the deadline; a transient server/network error gets one retry.
 * Not `ghWithRetry`: that one is synchronous and sleeps 2-15 s between tries,
 * which would stall the parallel fetch and overrun the deadline. Its transient
 * classifier is shared.
 */
async function call(ghJson, endpoint, deadline, now) {
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("time budget exhausted");
    try {
      return await ghJson(endpoint, remaining);
    } catch (error) {
      if (attempt > 0 || !isTransientGhFailure(error)) throw error;
    }
  }
}

/** Every page of a REST list endpoint; a page shorter than PAGE_SIZE is the last. */
async function allPages(ghJson, endpoint, deadline, now) {
  const sep = endpoint.includes("?") ? "&" : "?";
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await call(ghJson, `${endpoint}${sep}per_page=${PAGE_SIZE}&page=${page}`, deadline, now);
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
}

async function listOpenPrs(ghJson, repo, deadline, now) {
  const raw = await allPages(ghJson, `repos/${repo}/pulls?state=open`, deadline, now);
  return raw.map((pr) => ({
    number: pr.number,
    title: pr.title,
    // A deleted account's PRs have `user: null`.
    author: pr.user?.login ?? "ghost",
    branch: pr.head.ref,
    // null when the head fork was deleted.
    headRepo: pr.head.repo?.full_name ?? null,
    draft: pr.draft,
    hold: pr.labels.some((label) => label.name === "hold"),
    sha: pr.head.sha,
  }));
}

/** A PR's changed paths. A rename's OLD path counts too: editing it conflicts just the same. */
async function prFiles(ghJson, repo, number, deadline, now) {
  const files = await allPages(ghJson, `repos/${repo}/pulls/${number}/files`, deadline, now);
  return {
    paths: files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])),
    truncated: files.length >= PR_FILES_CAP,
  };
}

const fileKey = (pr) => `${pr.number}@${pr.sha}`;

function readCache(cacheFile, repo) {
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (cache.repo === repo && cache.version === CACHE_VERSION) return cache;
  } catch {
    // No cache yet (or a torn one): start empty.
  }
  return { version: CACHE_VERSION, repo, listedAt: 0, prs: null, files: {} };
}

function writeCache(cacheFile, cache) {
  // Keep only the open PRs' current heads, so the file does not grow forever.
  const live = new Set((cache.prs || []).map(fileKey));
  const files = Object.fromEntries(Object.entries(cache.files).filter(([key]) => live.has(key)));
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...cache, files }));
    fs.renameSync(tmp, cacheFile); // atomic, so a concurrent reader never sees half a file
  } catch {
    // An unwritable cache only costs the next call its API calls.
  }
}

/** Run `task` over `items`, PARALLEL_CALLS at a time; stop taking new items after the first failure. */
async function forEachParallel(items, task) {
  const queue = [...items];
  let failure = null;
  const worker = async () => {
    while (queue.length && !failure) {
      const item = queue.shift();
      await task(item).catch((error) => {
        failure ??= error;
      });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_CALLS }, worker));
  if (failure) throw failure;
}

/**
 * Every open PR with its changed files. The list and the files are separate
 * answers: `prs` is the PR list when it was read now or is within its 5-minute
 * TTL (null otherwise — never an expired list),
 * while `checked` says every PR's `files`/`truncated` are known too.
 *
 * @returns {Promise<{prs: Array<{number, title, author, branch, headRepo, draft, hold, sha,
 *   files?: string[], truncated?: boolean}> | null, checked: boolean, reason?: string}>}
 */
export async function openPrFiles({
  repo = UPSTREAM_REPO,
  ghJson = ghRest,
  cacheFile = defaultCacheFile(),
  timeoutMs = 20_000,
  now = Date.now,
} = {}) {
  const cache = readCache(cacheFile, repo);
  const deadline = now() + timeoutMs;
  // Only a list fetched now or still within its TTL is an answer. An expired
  // one is history: a PR opened since would be missing without a word.
  let listed = Boolean(cache.prs) && now() - cache.listedAt < LIST_TTL_MS;
  try {
    if (!listed) {
      cache.prs = await listOpenPrs(ghJson, repo, deadline, now);
      cache.listedAt = now();
      listed = true;
    }
    const missing = cache.prs.filter((pr) => !cache.files[fileKey(pr)]);
    await forEachParallel(missing, async (pr) => {
      cache.files[fileKey(pr)] = await prFiles(ghJson, repo, pr.number, deadline, now);
    });
  } catch (error) {
    // Bank what was fetched: a cold cache then warms up over a few runs.
    if (listed) writeCache(cacheFile, cache);
    const reason = String(error?.stderr || error?.message || error)
      .trim()
      .split("\n")[0]
      .slice(0, 200);
    return {
      prs: listed ? withFiles(cache) : null,
      checked: false,
      reason: `GitHub unreachable or rate-limited (${reason})`,
    };
  }
  writeCache(cacheFile, cache);
  return { prs: withFiles(cache), checked: true };
}

const withFiles = (cache) =>
  cache.prs &&
  cache.prs.map((pr) => {
    const entry = cache.files[fileKey(pr)];
    return { ...pr, files: entry?.paths, truncated: entry?.truncated };
  });

/**
 * `owner/repo` of a remote URL or a GitHub `full_name`, lowercased, in one
 * spelling: https, ssh and SCP forms (an ssh host alias included), a `.git`
 * suffix, and the repo's two names `js2wasm`/`js2` folded to `js2` — the
 * forms `scripts/hooks/push-remote-classify.sh` documents for this repo.
 * Null when no owner/repo can be recovered.
 */
export function repoSlug(urlOrName) {
  const segments = urlOrName
    .trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replaceAll(":", "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase()
    .split("/");
  if (segments.length < 2 || !segments.at(-1) || !segments.at(-2)) return null;
  const name = segments.at(-1) === "js2wasm" ? "js2" : segments.at(-1);
  return `${segments.at(-2)}/${name}`;
}

/**
 * The open PRs that change any of `paths` (ignored planning paths dropped),
 * most overlapping paths first. Pure.
 *
 * `excludeHead: { branch, repos }` drops the caller's own PR: same branch name
 * AND a head repository among the caller's remotes. The name alone is not
 * enough — the same branch name pushed to another fork is exactly the
 * duplicate PR this check should show.
 */
export function findPathOverlaps(paths, prs, { excludePr, excludeHead } = {}) {
  const wanted = new Set(paths.filter((p) => !isIgnoredOverlapPath(p)));
  const own = (pr) =>
    pr.branch === excludeHead?.branch && pr.headRepo !== null && excludeHead.repos.includes(repoSlug(pr.headRepo));
  return prs
    .filter((pr) => pr.number !== excludePr && !own(pr))
    .map(({ files, sha, ...pr }) => ({ ...pr, paths: [...new Set(files)].filter((f) => wanted.has(f)).sort() }))
    .filter((overlap) => overlap.paths.length)
    .sort((a, b) => b.paths.length - a.paths.length || a.number - b.number);
}

/**
 * Numbers of the PRs whose file list GitHub cut at its cap and that are not
 * already in `overlaps`: they may change the paths beyond what was seen.
 */
export function truncatedUnlisted(prs, overlaps) {
  const shown = new Set(overlaps.map((o) => o.number));
  return prs.filter((pr) => pr.truncated && !shown.has(pr.number)).map((pr) => pr.number);
}

/** One header line per overlapping PR, then its paths, cut to `maxLines`. */
export function formatOverlaps(overlaps, { maxLines = Infinity } = {}) {
  const lines = [];
  for (const o of overlaps) {
    const state = [o.draft && "draft", o.hold && "hold", o.truncated && `file list cut at ${PR_FILES_CAP} by GitHub`]
      .filter(Boolean)
      .join(", ");
    lines.push(`#${o.number} ${o.title} — ${o.author}, branch ${o.branch}${state ? ` [${state}]` : ""}`);
    for (const p of o.paths) lines.push(`    ${p}`);
  }
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), `… ${lines.length - maxLines + 1} more line(s); run without --max-lines`];
}

/**
 * Repo paths an issue's `## Implementation Plan` names in backticks, kept only
 * if `exists(path)` — a best-effort answer to "which files will this touch".
 * A `:120` or `#L12` line suffix is dropped. Pure.
 */
export function issuePlanPaths(text, exists) {
  const plan = text.match(/^## Implementation Plan\b[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? "";
  const named = [...plan.matchAll(/`([^`\s]+)`/g)].map((m) => m[1].replace(/[:#].*$/, ""));
  return [...new Set(named)].filter(exists).sort();
}
