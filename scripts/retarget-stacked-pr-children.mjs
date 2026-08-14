#!/usr/bin/env node
// Retarget and refresh the immediate children of a merged stacked PR.
//
// A stacked child targets its parent's head branch. Once the parent merges,
// leaving the child on that branch strands it. This helper runs from the
// trusted default branch on the parent's pull_request_target `closed` event,
// moves each exact immediate child to the parent's former base, and asks
// GitHub to integrate that new base into the child branch. The integration is
// App-authored, so it emits `pull_request:synchronize`; existing PR CI and
// workflow_run auto-enqueue then own the rest.
//
// Safety invariants:
//   - fresh parent metadata must exactly match the merge event;
//   - only parents merged into the repository default branch are handled;
//   - the original parent head must be an ancestor of the destination branch;
//   - a child must still be open on the exact parent base ref AND base SHA;
//   - the original parent head must be an ancestor of the child head;
//   - only same-repository heads are mutated;
//   - each child gets an automation-owned pending label across PATCH ->
//     exact re-read -> update-branch -> synchronize;
//   - update-branch uses expected_head_sha as its compare-and-swap guard;
//   - a partial failure leaves the pending label, never stale-green/enqueueable;
//   - human hold/do-not-merge/wip labels cause a no-op and are never changed;
//   - only one stack layer changes; drafts remain drafts;
//   - there are no polls, retries, comments, CI reruns, or queue mutations.
//
// Usage:
//   node scripts/retarget-stacked-pr-children.mjs --self-check
//   GH_TOKEN=<app-token> HOLD_TOKEN=<github-token> GH_REPO=owner/repo \
//     PARENT_PR_NUMBER=123 PARENT_HEAD_REF=feature \
//     PARENT_HEAD_SHA=<40 hex> PARENT_BASE_REF=main DEFAULT_BRANCH=main \
//     node scripts/retarget-stacked-pr-children.mjs

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const API_VERSION = "2022-11-28";
export const PENDING_LABEL = "stack-retarget-pending";
const PENDING_LABEL_COLOR = "d4c5f9";
const PENDING_LABEL_DESCRIPTION = "Automation is retargeting and refreshing this stacked PR";
const USER_HOLD_LABELS = new Set(["hold", "do-not-merge", "do not merge", "wip", "blocked"]);
const MAX_OPEN_PR_PAGES = 100;
const PER_PAGE = 100;

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function parseRepository(value) {
  const repo = requiredString(value, "GH_REPO");
  const match = repo.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error("GH_REPO must have the form owner/name");
  return { owner: match[1], name: match[2], fullName: repo };
}

export function parseParentNumber(value) {
  const text = requiredString(String(value ?? ""), "PARENT_PR_NUMBER");
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error("PARENT_PR_NUMBER must be a positive integer");
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    throw new Error("PARENT_PR_NUMBER is outside the safe integer range");
  }
  return number;
}

function repoFullName(side) {
  return side?.repo?.full_name || "";
}

function refName(side) {
  return typeof side?.ref === "string" ? side.ref : "";
}

function sha(side) {
  return typeof side?.sha === "string" ? side.sha : "";
}

function hasLabel(pr, label) {
  const target = label.toLowerCase();
  return (pr?.labels || []).some((entry) => String(entry?.name || "").toLowerCase() === target);
}

function hasUserHold(pr) {
  return (pr?.labels || []).some((entry) => USER_HOLD_LABELS.has(String(entry?.name || "").toLowerCase()));
}

export function verifyMergedParent(parent, expected) {
  if (!parent || typeof parent !== "object") {
    throw new Error("parent pull request response is missing");
  }
  if (parent.number !== expected.number) {
    throw new Error(`parent number changed: expected #${expected.number}, got #${parent.number}`);
  }
  if (parent.state !== "closed" || parent.merged !== true || !parent.merged_at) {
    throw new Error(`#${expected.number} is not a closed, merged pull request`);
  }
  if (repoFullName(parent.base) !== expected.repo) {
    throw new Error(
      `parent base repository changed: expected ${expected.repo}, got ${repoFullName(parent.base) || "missing"}`,
    );
  }
  if (refName(parent.head) !== expected.headRef) {
    throw new Error(`parent head ref changed: expected ${expected.headRef}, got ${refName(parent.head) || "missing"}`);
  }
  if (sha(parent.head) !== expected.headSha) {
    throw new Error(`parent head SHA changed: expected ${expected.headSha}, got ${sha(parent.head) || "missing"}`);
  }
  if (refName(parent.base) !== expected.baseRef) {
    throw new Error(`parent base ref changed: expected ${expected.baseRef}, got ${refName(parent.base) || "missing"}`);
  }
  if (expected.baseRef !== expected.defaultBranch) {
    throw new Error(
      `parent destination ${expected.baseRef} is not the repository default branch ${expected.defaultBranch}`,
    );
  }
  if (expected.headRef === expected.baseRef) {
    throw new Error("parent head and base refs must differ");
  }
  return parent;
}

export function isImmediateOpenChildByRef(pr, parent, repo) {
  return (
    pr?.state === "open" &&
    pr.number !== parent.number &&
    repoFullName(pr.base) === repo &&
    refName(pr.base) === refName(parent.head)
  );
}

export function selectImmediateOpenChildren(openPulls, parent, repo) {
  return (openPulls || [])
    .filter((pr) => isImmediateOpenChildByRef(pr, parent, repo))
    .sort((a, b) => a.number - b.number);
}

export function comparisonProvesAncestor(comparison, ancestorSha) {
  return comparison?.merge_base_commit?.sha === ancestorSha;
}

class GitHubRestApi {
  constructor({ token, repository, apiUrl = "https://api.github.com", tokenName = "token" }) {
    this.token = requiredString(token, tokenName);
    this.repository = parseRepository(repository);
    this.apiUrl = new URL(apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
  }

  async request(method, path, body, { allowStatuses = [] } = {}) {
    const response = await fetch(new URL(path.replace(/^\//, ""), this.apiUrl), {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "js2-passive-stack-retarget",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok && !allowStatuses.includes(response.status)) {
      const detail =
        typeof data === "object" && data !== null && typeof data.message === "string"
          ? data.message
          : String(data || "no response body").slice(0, 500);
      throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${detail}`);
    }
    return { status: response.status, data };
  }

  repoPath() {
    const { owner, name } = this.repository;
    return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  pullPath(number) {
    return `${this.repoPath()}/pulls/${number}`;
  }

  async getPull(number) {
    return (await this.request("GET", this.pullPath(number))).data;
  }

  async listOpenPulls() {
    const pulls = [];
    for (let page = 1; page <= MAX_OPEN_PR_PAGES; page += 1) {
      const path = `${this.repoPath()}/pulls?state=open&per_page=${PER_PAGE}&page=${page}`;
      const batch = (await this.request("GET", path)).data;
      if (!Array.isArray(batch)) {
        throw new Error(`GitHub API returned a non-array open pull request page (${page})`);
      }
      pulls.push(...batch);
      if (batch.length < PER_PAGE) return pulls;
    }
    throw new Error(`open pull request list exceeded ${MAX_OPEN_PR_PAGES * PER_PAGE} entries`);
  }

  async compare(ancestor, descendant) {
    const path = `${this.repoPath()}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(descendant)}`;
    return (await this.request("GET", path)).data;
  }

  async updatePullBase(number, baseRef) {
    const response = await this.request("PATCH", this.pullPath(number), { base: baseRef });
    if (response.status !== 200) {
      throw new Error(`#${number}: base update returned unexpected status ${response.status}`);
    }
    return response.data;
  }

  async updatePullBranch(number, expectedHeadSha) {
    const response = await this.request("PUT", `${this.pullPath(number)}/update-branch`, {
      expected_head_sha: expectedHeadSha,
    });
    if (response.status !== 202) {
      throw new Error(`#${number}: update-branch returned unexpected status ${response.status}`);
    }
    return response.data;
  }

  async addIssueLabel(number, label) {
    await this.request("POST", `${this.repoPath()}/issues/${number}/labels`, { labels: [label] });
  }

  async removeIssueLabel(number, label) {
    await this.request("DELETE", `${this.repoPath()}/issues/${number}/labels/${encodeURIComponent(label)}`);
  }

  async ensureRepositoryLabel(name, color, description) {
    const path = `${this.repoPath()}/labels/${encodeURIComponent(name)}`;
    const existing = await this.request("GET", path, undefined, { allowStatuses: [404] });
    const isExactLabel = (label) =>
      label?.name === name &&
      String(label?.color || "").toLowerCase() === color.toLowerCase() &&
      label?.description === description;
    if (existing.status !== 404) {
      if (isExactLabel(existing.data)) return;
      throw new Error(`repository label ${name} exists with unexpected metadata`);
    }
    const created = await this.request(
      "POST",
      `${this.repoPath()}/labels`,
      {
        name,
        color,
        description,
      },
      { allowStatuses: [422] },
    );
    if (created.status === 422) {
      // Cross-parent jobs deliberately run independently. Two first uses can
      // both observe 404 and race to create the same automation label. Treat
      // 422 as the benign loser only after fresh exact metadata confirmation.
      const confirmed = await this.request("GET", path);
      if (confirmed.status === 200 && isExactLabel(confirmed.data)) return;
      throw new Error(`creating label ${name} raced, but the exact label was not confirmed`);
    }
    if (created.status !== 201) {
      throw new Error(`creating label ${name} returned unexpected status ${created.status}`);
    }
  }
}

async function requireAncestor(api, ancestorSha, descendant, context) {
  const comparison = await api.compare(ancestorSha, descendant);
  if (!comparisonProvesAncestor(comparison, ancestorSha)) {
    throw new Error(`${context}: ${ancestorSha} is not an ancestor of ${descendant}`);
  }
}

function assertExactChildBase(pr, parent, repo) {
  if (!isImmediateOpenChildByRef(pr, parent, repo)) {
    throw new Error(`#${pr?.number || "unknown"} is no longer an immediate open child`);
  }
  if (sha(pr.base) !== sha(parent.head)) {
    throw new Error(
      `#${pr.number}: base SHA ${sha(pr.base) || "missing"} does not equal merged parent head ${sha(parent.head)}`,
    );
  }
  if (repoFullName(pr.head) !== repo) {
    throw new Error(`#${pr.number}: head repository ${repoFullName(pr.head) || "missing"} is not ${repo}`);
  }
  if (!sha(pr.head)) {
    throw new Error(`#${pr.number}: head SHA is missing`);
  }
}

export async function retargetImmediateChildren({ api, holdApi, expected, log = console.log }) {
  const parent = verifyMergedParent(await api.getPull(expected.number), expected);

  // A fork head ref is not a base-repository branch and therefore cannot be a
  // real parent of PRs in this repository. A same-named base-repository branch
  // would be unrelated, so fail safely with a no-op.
  if (repoFullName(parent.head) !== expected.repo) {
    log(
      `#${parent.number}: head repository ${repoFullName(parent.head) || "missing"} is not ${expected.repo}; no children`,
    );
    return { parent: parent.number, candidates: [], retargeted: [], skipped: [] };
  }

  // This is the preservation proof. If the repository squash/rebase-merged
  // the parent, or the destination branch was rewritten, retargeting would
  // reintroduce parent commits into every child diff. Fail before touching any
  // child.
  await requireAncestor(
    api,
    sha(parent.head),
    expected.baseRef,
    `#${parent.number}: merged-parent destination ancestry failed`,
  );

  const candidates = selectImmediateOpenChildren(await api.listOpenPulls(), parent, expected.repo);
  const retargeted = [];
  const skipped = [];
  const errors = [];
  if (candidates.length > 0) {
    await holdApi.ensureRepositoryLabel(PENDING_LABEL, PENDING_LABEL_COLOR, PENDING_LABEL_DESCRIPTION);
  }

  for (const candidate of candidates) {
    try {
      // Exact race/idempotence guard. Another event or maintainer may have moved
      // or closed the PR after the list snapshot; never overwrite that decision.
      let current = await api.getPull(candidate.number);
      if (!isImmediateOpenChildByRef(current, parent, expected.repo)) {
        skipped.push(candidate.number);
        log(`#${candidate.number}: no longer an immediate open child; skip`);
        continue;
      }
      if (hasUserHold(current)) {
        skipped.push(candidate.number);
        log(`#${candidate.number}: human hold/do-not-merge/wip label present; skip`);
        continue;
      }
      assertExactChildBase(current, parent, expected.repo);
      await requireAncestor(
        api,
        sha(parent.head),
        sha(current.head),
        `#${candidate.number}: child-head ancestry failed`,
      );

      if (!hasLabel(current, PENDING_LABEL)) {
        await holdApi.addIssueLabel(candidate.number, PENDING_LABEL);
      }

      // Re-read after taking the safety hold. The App PATCH has no conditional
      // base-update parameter, so per-parent workflow concurrency plus this
      // exact last-moment check is the narrowest available write guard.
      current = await api.getPull(candidate.number);
      if (hasUserHold(current)) {
        throw new Error(`#${candidate.number}: human hold appeared after pending-label acquisition`);
      }
      if (!hasLabel(current, PENDING_LABEL)) {
        throw new Error(`#${candidate.number}: automation pending label was removed before retarget`);
      }
      assertExactChildBase(current, parent, expected.repo);
      await requireAncestor(
        api,
        sha(parent.head),
        sha(current.head),
        `#${candidate.number}: held child-head ancestry failed`,
      );
      const expectedChildHead = sha(current.head);

      const updated = await api.updatePullBase(candidate.number, expected.baseRef);
      if (
        updated?.number !== candidate.number ||
        updated?.state !== "open" ||
        repoFullName(updated.base) !== expected.repo ||
        refName(updated.base) !== expected.baseRef ||
        repoFullName(updated.head) !== expected.repo ||
        !sha(updated.head)
      ) {
        throw new Error(`#${candidate.number}: GitHub did not confirm the retargeted base and same-repository head`);
      }

      const confirmed = await api.getPull(candidate.number);
      if (
        confirmed?.state !== "open" ||
        repoFullName(confirmed.base) !== expected.repo ||
        refName(confirmed.base) !== expected.baseRef ||
        repoFullName(confirmed.head) !== expected.repo ||
        !sha(confirmed.head)
      ) {
        throw new Error(`#${candidate.number}: base/head changed before update-branch`);
      }
      if (!sha(confirmed.base)) {
        throw new Error(`#${candidate.number}: post-retarget base SHA is missing`);
      }
      await requireAncestor(
        api,
        sha(parent.head),
        sha(confirmed.base),
        `#${candidate.number}: post-retarget destination ancestry failed`,
      );
      await requireAncestor(
        api,
        sha(parent.head),
        sha(confirmed.head),
        `#${candidate.number}: post-retarget child-head ancestry failed`,
      );
      if (hasUserHold(confirmed)) {
        throw new Error(`#${candidate.number}: human hold appeared after base retarget`);
      }

      // A human/App update can race after PATCH. If the changed head already
      // contains the exact default-branch base, skip our PUT. Only the separate
      // pull_request_target:synchronize path may clear the pending label: a
      // GITHUB_TOKEN-authored ref change can suppress that event and fresh CI,
      // in which case retaining the label is the required failure-closed state.
      if (sha(confirmed.head) !== expectedChildHead) {
        await requireAncestor(
          api,
          sha(confirmed.base),
          sha(confirmed.head),
          `#${candidate.number}: concurrent synchronized head lacks destination base`,
        );
        retargeted.push(candidate.number);
        log(
          `#${candidate.number}: concurrent head already contains ${expected.baseRef};` +
            ` ${PENDING_LABEL} retained for observed synchronize`,
        );
        continue;
      }
      if (!hasLabel(confirmed, PENDING_LABEL)) {
        throw new Error(`#${candidate.number}: retarget safety label changed before update-branch`);
      }

      // Existing auto-refresh-prs uses this same App-authored endpoint because
      // it emits pull_request:synchronize. expected_head_sha is the endpoint's
      // atomic guard: a concurrent push fails instead of absorbing/overwriting
      // it. A 202 means GitHub accepted the integration. If the asynchronous
      // merge later cannot complete, the automation-owned pending label stays
      // in place. A separate pull_request_target:synchronize job removes it
      // only after observing the changed, base-integrated head.
      await api.updatePullBranch(candidate.number, expectedChildHead);

      retargeted.push(candidate.number);
      log(
        `#${candidate.number}: retargeted ${expected.headRef} -> ${expected.baseRef};` +
          ` base integration accepted, ${PENDING_LABEL} retained until synchronize` +
          (confirmed.draft ? " (draft preserved)" : ""),
      );
    } catch (error) {
      log(`#${candidate.number}: retarget/integration failed; ${PENDING_LABEL} retained`);
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (candidates.length === 0) {
    log(`#${parent.number}: no immediate open children`);
  }
  const result = {
    parent: parent.number,
    candidates: candidates.map((pr) => pr.number),
    retargeted,
    skipped,
  };
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `${errors.length} stacked child retarget operation(s) failed: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
  return result;
}

export async function releasePendingAfterSynchronize({ api, holdApi, expected, log = console.log }) {
  if (expected.baseRef !== expected.defaultBranch) {
    log(
      `#${expected.number}: synchronize base ${expected.baseRef} is not default branch ${expected.defaultBranch};` +
        ` keep ${PENDING_LABEL}`,
    );
    return { number: expected.number, released: false };
  }
  const pr = await api.getPull(expected.number);
  if (pr?.state !== "open") {
    throw new Error(`#${expected.number}: synchronized pull request is not open`);
  }
  if (repoFullName(pr.base) !== expected.repo || refName(pr.base) !== expected.baseRef) {
    throw new Error(`#${expected.number}: synchronized pull request base changed`);
  }
  // Compare ONLY the head SHA. A pull request's head REPOSITORY is fixed at
  // creation and is the fork for every fork-head PR, so comparing it against
  // `expected.repo` — which is GH_REPO, the BASE repository — is a category
  // error: the disjunct is unconditionally true for forks and says nothing
  // about whether the head moved since the synchronize event. It made this job
  // fail on EVERY fork-head PR, and because a red non-required check drives
  // `mergeStateStatus` to UNSTABLE (which `auto-enqueue.yml` excludes), every
  // PR this team opens stranded un-enqueued (#3878). The error message made it
  // worse by reporting "head changed" when the head had not changed at all.
  //
  // The genuine race guard is the SHA, which the workflow supplies from the
  // event payload; it is kept below unchanged. The base side (checked above) is
  // different and correctly still compares repositories: a PR's base MUST live
  // in this repository. Compare `retargetImmediateChildren`, which already
  // treats a fork head as a benign no-op rather than an error.
  if (sha(pr.head) !== expected.headSha) {
    throw new Error(`#${expected.number}: synchronized pull request head changed`);
  }
  if (expected.previousHeadSha === expected.headSha) {
    throw new Error(`#${expected.number}: synchronize did not change the head SHA`);
  }
  if (!hasLabel(pr, PENDING_LABEL)) {
    log(`#${expected.number}: ${PENDING_LABEL} is already absent; nothing to release`);
    return { number: expected.number, released: false };
  }
  if (!expected.baseSha) {
    throw new Error(`#${expected.number}: synchronize event base SHA is missing`);
  }
  await requireAncestor(
    api,
    expected.baseSha,
    expected.headSha,
    `#${expected.number}: synchronized head does not contain its event base`,
  );
  await holdApi.removeIssueLabel(expected.number, PENDING_LABEL);
  log(`#${expected.number}: released ${PENDING_LABEL} after exact base-integrated synchronize`);
  return { number: expected.number, released: true };
}

function makeSide(ref, repo, sideSha) {
  return { ref, sha: sideSha, repo: { full_name: repo } };
}

function makePull({
  number,
  state = "open",
  merged = false,
  mergedAt = null,
  headRef,
  headSha = `${number}`.padStart(40, "0"),
  headRepo = "loopdive/js2wasm",
  baseRef,
  baseSha = "0".repeat(40),
  baseRepo = "loopdive/js2wasm",
  draft = false,
  labels = [],
}) {
  return {
    number,
    state,
    merged,
    merged_at: mergedAt,
    draft,
    labels: labels.map((name) => ({ name })),
    head: makeSide(headRef, headRepo, headSha),
    base: makeSide(baseRef, baseRepo, baseSha),
  };
}

class FakeApi {
  constructor(pulls, { ancestorPairs = [], targetShas = {}, failUpdateBranch = [] } = {}) {
    this.pulls = new Map(pulls.map((pr) => [pr.number, structuredClone(pr)]));
    this.ancestorPairs = new Set(ancestorPairs.map(([ancestor, descendant]) => `${ancestor}->${descendant}`));
    this.targetShas = new Map(Object.entries(targetShas));
    this.failUpdateBranch = new Set(failUpdateBranch);
    this.patchCalls = [];
    this.updateBranchCalls = [];
    this.events = [];
    this.beforeRead = null;
  }

  async getPull(number) {
    if (this.beforeRead) await this.beforeRead(number, this);
    return structuredClone(this.pulls.get(number));
  }

  async listOpenPulls() {
    return [...this.pulls.values()].filter((pr) => pr.state === "open").map((pr) => structuredClone(pr));
  }

  async compare(ancestor, descendant) {
    const proves = this.ancestorPairs.has(`${ancestor}->${descendant}`);
    return { merge_base_commit: { sha: proves ? ancestor : "f".repeat(40) } };
  }

  async updatePullBase(number, baseRef) {
    const pr = this.pulls.get(number);
    pr.base.ref = baseRef;
    pr.base.sha = this.targetShas.get(baseRef) || "e".repeat(40);
    this.patchCalls.push({ number, baseRef });
    this.events.push(`base:${number}:${baseRef}`);
    return structuredClone(pr);
  }

  async updatePullBranch(number, expectedHeadSha) {
    this.events.push(`update-branch:${number}:${expectedHeadSha}`);
    if (this.failUpdateBranch.has(number)) {
      throw new Error(`#${number}: simulated update-branch failure`);
    }
    const pr = this.pulls.get(number);
    if (pr.head.sha !== expectedHeadSha) {
      throw new Error(`#${number}: simulated expected_head_sha mismatch`);
    }
    const newHead = `${number}`.padStart(40, "d").slice(-40);
    this.ancestorPairs.add(`${pr.base.sha}->${newHead}`);
    pr.head.sha = newHead;
    this.updateBranchCalls.push({ number, expectedHeadSha });
    return { message: "Updating pull request branch." };
  }

  async addIssueLabel(number, label) {
    const pr = this.pulls.get(number);
    if (!hasLabel(pr, label)) pr.labels.push({ name: label });
    this.events.push(`label-add:${number}:${label}`);
  }

  async removeIssueLabel(number, label) {
    const pr = this.pulls.get(number);
    pr.labels = pr.labels.filter((entry) => entry.name.toLowerCase() !== label.toLowerCase());
    this.events.push(`label-remove:${number}:${label}`);
  }

  async ensureRepositoryLabel(name) {
    this.events.push(`label-ensure:${name}`);
  }
}

function fakeOptions(parentSha, children, { targetRef = "main", targetSha = "b".repeat(40), ...rest } = {}) {
  return {
    ancestorPairs: [
      [parentSha, targetRef],
      [parentSha, targetSha],
      ...children.map((child) => [parentSha, child.head.sha]),
      ...(rest.ancestorPairs || []),
    ],
    targetShas: { [targetRef]: targetSha, ...(rest.targetShas || {}) },
    failUpdateBranch: rest.failUpdateBranch || [],
  };
}

async function selfCheck() {
  const repo = "loopdive/js2wasm";
  const parentSha = "a".repeat(40);
  const targetSha = "b".repeat(40);
  const expected = {
    repo,
    number: 10,
    headRef: "stack/parent",
    headSha: parentSha,
    baseRef: "main",
    defaultBranch: "main",
  };
  const parent = makePull({
    number: 10,
    state: "closed",
    merged: true,
    mergedAt: "2026-07-29T00:00:00Z",
    headRef: expected.headRef,
    headSha: parentSha,
    baseRef: expected.baseRef,
    baseSha: "9".repeat(40),
  });

  assert.deepEqual(parseRepository(repo), { owner: "loopdive", name: "js2wasm", fullName: repo });
  assert.equal(parseParentNumber("10"), 10);
  assert.throws(() => parseRepository("loopdive/js2wasm/extra"), /owner\/name/);
  assert.throws(() => parseParentNumber("0"), /positive integer/);
  assert.equal(comparisonProvesAncestor({ merge_base_commit: { sha: parentSha } }, parentSha), true);
  assert.equal(comparisonProvesAncestor({ merge_base_commit: { sha: targetSha } }, parentSha), false);

  const unmerged = structuredClone(parent);
  unmerged.merged = false;
  assert.throws(() => verifyMergedParent(unmerged, expected), /not a closed, merged/);
  assert.throws(() => verifyMergedParent(parent, { ...expected, headSha: "c".repeat(40) }), /parent head SHA changed/);
  assert.throws(
    () => verifyMergedParent(parent, { ...expected, defaultBranch: "trunk" }),
    /not the repository default branch/,
  );

  // Concurrent first use of the repository label is idempotent: the losing
  // create receives 422, freshly confirms the exact label, and continues.
  const labelRaceApi = new GitHubRestApi({
    token: "test-token",
    repository: repo,
    apiUrl: "https://api.github.test",
  });
  const labelRaceCalls = [];
  labelRaceApi.request = async (method) => {
    labelRaceCalls.push(method);
    if (labelRaceCalls.length === 1) return { status: 404, data: { message: "Not Found" } };
    if (labelRaceCalls.length === 2) return { status: 422, data: { message: "already_exists" } };
    return {
      status: 200,
      data: {
        name: PENDING_LABEL,
        color: PENDING_LABEL_COLOR,
        description: PENDING_LABEL_DESCRIPTION,
      },
    };
  };
  await labelRaceApi.ensureRepositoryLabel(PENDING_LABEL, PENDING_LABEL_COLOR, PENDING_LABEL_DESCRIPTION);
  assert.deepEqual(labelRaceCalls, ["GET", "POST", "GET"]);
  const labelMismatchApi = new GitHubRestApi({
    token: "test-token",
    repository: repo,
    apiUrl: "https://api.github.test",
  });
  let labelMismatchCall = 0;
  labelMismatchApi.request = async () => {
    labelMismatchCall += 1;
    if (labelMismatchCall === 1) return { status: 404, data: { message: "Not Found" } };
    if (labelMismatchCall === 2) return { status: 422, data: { message: "already_exists" } };
    return {
      status: 200,
      data: {
        name: PENDING_LABEL,
        color: PENDING_LABEL_COLOR,
        description: "human-owned label",
      },
    };
  };
  await assert.rejects(
    labelMismatchApi.ensureRepositoryLabel(PENDING_LABEL, PENDING_LABEL_COLOR, PENDING_LABEL_DESCRIPTION),
    /exact label was not confirmed/,
  );

  const childReady = makePull({
    number: 11,
    headRef: "stack/child-ready",
    headSha: "1".repeat(40),
    baseRef: expected.headRef,
    baseSha: parentSha,
  });
  const childDraft = makePull({
    number: 12,
    headRef: "stack/child-draft",
    headSha: "2".repeat(40),
    baseRef: expected.headRef,
    baseSha: parentSha,
    draft: true,
  });
  const grandchild = makePull({
    number: 13,
    headRef: "stack/grandchild",
    baseRef: childReady.head.ref,
    baseSha: childReady.head.sha,
  });
  const unrelated = makePull({
    number: 14,
    headRef: "unrelated",
    baseRef: "main",
    baseSha: targetSha,
  });
  const closedChild = makePull({
    number: 15,
    state: "closed",
    headRef: "closed",
    baseRef: expected.headRef,
    baseSha: parentSha,
  });

  const api = new FakeApi(
    [parent, childDraft, childReady, grandchild, unrelated, closedChild],
    fakeOptions(parentSha, [childReady, childDraft], { targetSha }),
  );
  const result = await retargetImmediateChildren({ api, holdApi: api, expected, log: () => {} });
  assert.deepEqual(result, {
    parent: 10,
    candidates: [11, 12],
    retargeted: [11, 12],
    skipped: [],
  });
  assert.deepEqual(api.patchCalls, [
    { number: 11, baseRef: "main" },
    { number: 12, baseRef: "main" },
  ]);
  assert.deepEqual(api.updateBranchCalls, [
    { number: 11, expectedHeadSha: childReady.head.sha },
    { number: 12, expectedHeadSha: childDraft.head.sha },
  ]);
  const firstPending = api.events.indexOf(`label-add:11:${PENDING_LABEL}`);
  assert.deepEqual(api.events.slice(firstPending, firstPending + 3), [
    `label-add:11:${PENDING_LABEL}`,
    "base:11:main",
    `update-branch:11:${childReady.head.sha}`,
  ]);
  assert.equal(hasLabel(api.pulls.get(11), PENDING_LABEL), true);
  assert.equal(api.pulls.get(12).draft, true, "retargeting must preserve draft state");
  assert.equal(api.pulls.get(13).base.ref, childReady.head.ref, "grandchildren must not be retargeted");

  const synchronizedHead = api.pulls.get(11).head.sha;
  const released = await releasePendingAfterSynchronize({
    api,
    holdApi: api,
    expected: {
      repo,
      number: 11,
      baseRef: "main",
      defaultBranch: "main",
      baseSha: targetSha,
      previousHeadSha: childReady.head.sha,
      headSha: synchronizedHead,
    },
    log: () => {},
  });
  assert.deepEqual(released, { number: 11, released: true });
  assert.equal(hasLabel(api.pulls.get(11), PENDING_LABEL), false);
  const idempotentRelease = await releasePendingAfterSynchronize({
    api,
    holdApi: api,
    expected: {
      repo,
      number: 11,
      baseRef: "main",
      defaultBranch: "main",
      baseSha: targetSha,
      previousHeadSha: childReady.head.sha,
      headSha: synchronizedHead,
    },
    log: () => {},
  });
  assert.deepEqual(idempotentRelease, { number: 11, released: false });

  // Replaying the same event, or a serialized duplicate parent event with the
  // same head branch, is a deterministic no-op.
  api.patchCalls = [];
  const replay = await retargetImmediateChildren({ api, holdApi: api, expected, log: () => {} });
  assert.deepEqual(replay, { parent: 10, candidates: [], retargeted: [], skipped: [] });
  assert.deepEqual(api.patchCalls, []);
  const duplicateParent = { ...structuredClone(parent), number: 20 };
  api.pulls.set(20, duplicateParent);
  const duplicate = await retargetImmediateChildren({
    api,
    holdApi: api,
    expected: { ...expected, number: 20 },
    log: () => {},
  });
  assert.deepEqual(duplicate, { parent: 20, candidates: [], retargeted: [], skipped: [] });

  // A child independently moved between list and exact read is skipped.
  const racedChild = makePull({
    number: 17,
    headRef: "raced",
    headSha: "7".repeat(40),
    baseRef: expected.headRef,
    baseSha: parentSha,
  });
  const raceApi = new FakeApi([parent, racedChild], fakeOptions(parentSha, [racedChild]));
  let parentRead = false;
  raceApi.beforeRead = async (number, fake) => {
    if (number === 10) parentRead = true;
    if (number === 17 && parentRead) fake.pulls.get(17).base.ref = "release";
  };
  const raced = await retargetImmediateChildren({ api: raceApi, holdApi: raceApi, expected, log: () => {} });
  assert.deepEqual(raced, { parent: 10, candidates: [17], retargeted: [], skipped: [17] });
  assert.deepEqual(raceApi.patchCalls, []);

  // A concurrent post-PATCH head update that already contains main suppresses
  // our update-branch call, but the retarget path never clears the pending
  // label. Only an observed synchronize workflow may release it.
  const concurrentChild = makePull({
    number: 23,
    headRef: "stack/concurrent-child",
    headSha: "3".repeat(40),
    baseRef: expected.headRef,
    baseSha: parentSha,
  });
  const concurrentHead = "4".repeat(40);
  const concurrentApi = new FakeApi([parent, concurrentChild], fakeOptions(parentSha, [concurrentChild]));
  let concurrentChildReads = 0;
  concurrentApi.beforeRead = async (number, fake) => {
    if (number !== 23) return;
    concurrentChildReads += 1;
    if (concurrentChildReads === 3) {
      fake.pulls.get(23).head.sha = concurrentHead;
      fake.ancestorPairs.add(`${parentSha}->${concurrentHead}`);
      fake.ancestorPairs.add(`${targetSha}->${concurrentHead}`);
    }
  };
  const concurrent = await retargetImmediateChildren({
    api: concurrentApi,
    holdApi: concurrentApi,
    expected,
    log: () => {},
  });
  assert.deepEqual(concurrent, { parent: 10, candidates: [23], retargeted: [23], skipped: [] });
  assert.deepEqual(concurrentApi.updateBranchCalls, []);
  assert.equal(hasLabel(concurrentApi.pulls.get(23), PENDING_LABEL), true);
  assert.equal(concurrentApi.events.includes(`label-remove:23:${PENDING_LABEL}`), false);

  // Squash/rebase parent merges, branch reuse, and diverged children all fail
  // before any base mutation.
  const squashApi = new FakeApi([parent, childReady]);
  await assert.rejects(
    retargetImmediateChildren({ api: squashApi, holdApi: squashApi, expected, log: () => {} }),
    /destination ancestry failed/,
  );
  assert.deepEqual(squashApi.patchCalls, []);

  const reused = structuredClone(childReady);
  reused.base.sha = "8".repeat(40);
  const reuseApi = new FakeApi([parent, reused], fakeOptions(parentSha, [reused]));
  await assert.rejects(
    retargetImmediateChildren({ api: reuseApi, holdApi: reuseApi, expected, log: () => {} }),
    /base SHA .* does not equal merged parent head/,
  );
  assert.deepEqual(reuseApi.patchCalls, []);

  const divergedApi = new FakeApi(
    [parent, childReady],
    fakeOptions(parentSha, [], { ancestorPairs: [[parentSha, "main"]] }),
  );
  await assert.rejects(
    retargetImmediateChildren({ api: divergedApi, holdApi: divergedApi, expected, log: () => {} }),
    /child-head ancestry failed/,
  );
  assert.deepEqual(divergedApi.patchCalls, []);

  // #3878 — a FORK-HEAD pull request must not fail this job. The head repository
  // is fixed at PR creation and is the fork for every PR this team opens, so it
  // must never be compared against GH_REPO (the base repository). Regression
  // guard: with the head SHA matching the event exactly, the ordinary fork-head
  // PR (no pending label) must reach the benign "nothing to release" no-op
  // rather than throwing "head changed". Before the fix this threw for EVERY
  // fork-head PR, driving mergeStateStatus to UNSTABLE and stranding the PR
  // outside auto-enqueue's ENQUEUEABLE set.
  const forkHeadSha = "a".repeat(39) + "1";
  const forkPlainPr = makePull({
    number: 41,
    headRef: "issue-1-fork-branch",
    headSha: forkHeadSha,
    headRepo: "ttraenkler/js2",
    baseRef: "main",
    baseSha: targetSha,
  });
  const forkPlainApi = new FakeApi([forkPlainPr], { ancestorPairs: [[targetSha, forkHeadSha]] });
  const forkPlainRelease = await releasePendingAfterSynchronize({
    api: forkPlainApi,
    holdApi: forkPlainApi,
    expected: {
      repo,
      number: 41,
      baseRef: "main",
      defaultBranch: "main",
      baseSha: targetSha,
      previousHeadSha: "5".repeat(40),
      headSha: forkHeadSha,
    },
    log: () => {},
  });
  assert.deepEqual(forkPlainRelease, { number: 41, released: false });

  // ...and a fork-head STACKED child that legitimately carries the pending label
  // must actually RELEASE it. `isImmediateOpenChildByRef` filters children on
  // their BASE repository only, so a fork-head PR can genuinely acquire the
  // label. Treating a fork head as a bare no-op here would strand a HOLD_LABELS
  // member forever — trading a red check for a permanent hold.
  const forkHeldSha = "b".repeat(39) + "2";
  const forkHeldPr = makePull({
    number: 42,
    headRef: "issue-2-fork-branch",
    headSha: forkHeldSha,
    headRepo: "ttraenkler/js2",
    baseRef: "main",
    baseSha: targetSha,
    labels: [PENDING_LABEL],
  });
  const forkHeldApi = new FakeApi([forkHeldPr], { ancestorPairs: [[targetSha, forkHeldSha]] });
  const forkHeldRelease = await releasePendingAfterSynchronize({
    api: forkHeldApi,
    holdApi: forkHeldApi,
    expected: {
      repo,
      number: 42,
      baseRef: "main",
      defaultBranch: "main",
      baseSha: targetSha,
      previousHeadSha: "6".repeat(40),
      headSha: forkHeldSha,
    },
    log: () => {},
  });
  assert.deepEqual(forkHeldRelease, { number: 42, released: true });
  assert.equal(hasLabel(forkHeldApi.pulls.get(42), PENDING_LABEL), false);

  // The genuine race guard is PRESERVED: when the live head has moved away from
  // the synchronize event's head SHA, this still throws — on a fork head too, so
  // the fix cannot be mistaken for "skip the check for forks".
  const forkMovedApi = new FakeApi([forkHeldPr], { ancestorPairs: [[targetSha, forkHeldSha]] });
  await assert.rejects(
    releasePendingAfterSynchronize({
      api: forkMovedApi,
      holdApi: forkMovedApi,
      expected: {
        repo,
        number: 42,
        baseRef: "main",
        defaultBranch: "main",
        baseSha: targetSha,
        previousHeadSha: "6".repeat(40),
        headSha: "c".repeat(40),
      },
      log: () => {},
    }),
    /head changed/,
  );

  // A synchronize from the old stack base can arrive after pending-label
  // acquisition. Only a default-branch synchronize can release the hold.
  const oldBaseHead = "7".repeat(40);
  const oldBaseSync = makePull({
    number: 16,
    headRef: "stack/old-base-sync",
    headSha: oldBaseHead,
    baseRef: expected.headRef,
    baseSha: parentSha,
    labels: [PENDING_LABEL],
  });
  const oldBaseSyncApi = new FakeApi([oldBaseSync], {
    ancestorPairs: [[parentSha, oldBaseHead]],
  });
  const oldBaseRelease = await releasePendingAfterSynchronize({
    api: oldBaseSyncApi,
    holdApi: oldBaseSyncApi,
    expected: {
      repo,
      number: 16,
      baseRef: expected.headRef,
      defaultBranch: "main",
      baseSha: parentSha,
      previousHeadSha: childReady.head.sha,
      headSha: oldBaseHead,
    },
    log: () => {},
  });
  assert.deepEqual(oldBaseRelease, { number: 16, released: false });
  assert.equal(hasLabel(oldBaseSyncApi.pulls.get(16), PENDING_LABEL), true);

  // A partial PATCH -> update-branch failure leaves the automation-owned
  // pending label in place, preventing stale checks from entering auto-enqueue.
  const failingChild = makePull({
    number: 18,
    headRef: "stack/failing-child",
    headSha: "3".repeat(40),
    baseRef: expected.headRef,
    baseSha: parentSha,
  });
  const failingApi = new FakeApi(
    [parent, failingChild],
    fakeOptions(parentSha, [failingChild], { failUpdateBranch: [18] }),
  );
  await assert.rejects(
    retargetImmediateChildren({ api: failingApi, holdApi: failingApi, expected, log: () => {} }),
    /simulated update-branch failure/,
  );
  assert.equal(failingApi.pulls.get(18).base.ref, "main");
  assert.equal(hasLabel(failingApi.pulls.get(18), PENDING_LABEL), true);
  assert.equal(failingApi.events.includes(`label-remove:18:${PENDING_LABEL}`), false);

  // One child failure is isolated: every later immediate child is still
  // retargeted before the job reports an aggregate failure.
  const laterChild = makePull({
    number: 22,
    headRef: "stack/later-child",
    headSha: "8".repeat(40),
    baseRef: expected.headRef,
    baseSha: parentSha,
  });
  const isolatedFailureApi = new FakeApi(
    [parent, failingChild, laterChild],
    fakeOptions(parentSha, [failingChild, laterChild], { failUpdateBranch: [18] }),
  );
  await assert.rejects(
    retargetImmediateChildren({
      api: isolatedFailureApi,
      holdApi: isolatedFailureApi,
      expected,
      log: () => {},
    }),
    /simulated update-branch failure/,
  );
  assert.deepEqual(isolatedFailureApi.patchCalls, [
    { number: 18, baseRef: "main" },
    { number: 22, baseRef: "main" },
  ]);
  assert.equal(
    isolatedFailureApi.updateBranchCalls.some((call) => call.number === 22),
    true,
  );

  // A human hold is never repurposed or removed; the child is skipped.
  const heldChild = makePull({
    number: 19,
    headRef: "stack/held-child",
    headSha: "4".repeat(40),
    baseRef: expected.headRef,
    baseSha: parentSha,
    labels: ["hold"],
  });
  const heldApi = new FakeApi([parent, heldChild], fakeOptions(parentSha, [heldChild]));
  const held = await retargetImmediateChildren({ api: heldApi, holdApi: heldApi, expected, log: () => {} });
  assert.deepEqual(held, { parent: 10, candidates: [19], retargeted: [], skipped: [19] });
  assert.equal(hasLabel(heldApi.pulls.get(19), "hold"), true);
  assert.deepEqual(heldApi.patchCalls, []);

  // If a human hold appears after the automation pending label, both labels
  // remain and no base write occurs.
  const lateHeldChild = makePull({
    number: 21,
    headRef: "stack/late-held-child",
    headSha: "5".repeat(40),
    baseRef: expected.headRef,
    baseSha: parentSha,
  });
  const lateHoldApi = new FakeApi([parent, lateHeldChild], fakeOptions(parentSha, [lateHeldChild]));
  let lateHoldReads = 0;
  lateHoldApi.beforeRead = async (number, fake) => {
    if (number !== 21) return;
    lateHoldReads += 1;
    if (lateHoldReads === 2) fake.pulls.get(21).labels.push({ name: "hold" });
  };
  await assert.rejects(
    retargetImmediateChildren({
      api: lateHoldApi,
      holdApi: lateHoldApi,
      expected,
      log: () => {},
    }),
    /human hold appeared/,
  );
  assert.equal(hasLabel(lateHoldApi.pulls.get(21), "hold"), true);
  assert.equal(hasLabel(lateHoldApi.pulls.get(21), PENDING_LABEL), true);
  assert.deepEqual(lateHoldApi.patchCalls, []);

  // A human synchronize after a partial failure only releases the pending
  // label if the changed head actually contains the event's base SHA.
  const oldFailingHead = failingApi.pulls.get(18).head.sha;
  const humanHead = "6".repeat(40);
  failingApi.pulls.get(18).head.sha = humanHead;
  await assert.rejects(
    releasePendingAfterSynchronize({
      api: failingApi,
      holdApi: failingApi,
      expected: {
        repo,
        number: 18,
        baseRef: "main",
        defaultBranch: "main",
        baseSha: targetSha,
        previousHeadSha: oldFailingHead,
        headSha: humanHead,
      },
      log: () => {},
    }),
    /does not contain its event base/,
  );
  assert.equal(hasLabel(failingApi.pulls.get(18), PENDING_LABEL), true);
  failingApi.ancestorPairs.add(`${targetSha}->${humanHead}`);
  const humanRelease = await releasePendingAfterSynchronize({
    api: failingApi,
    holdApi: failingApi,
    expected: {
      repo,
      number: 18,
      baseRef: "main",
      defaultBranch: "main",
      baseSha: targetSha,
      previousHeadSha: oldFailingHead,
      headSha: humanHead,
    },
    log: () => {},
  });
  assert.deepEqual(humanRelease, { number: 18, released: true });
  assert.equal(hasLabel(failingApi.pulls.get(18), PENDING_LABEL), false);

  // A merged fork PR cannot parent a base-repository stack edge by ref name.
  const forkParent = structuredClone(parent);
  forkParent.head.repo.full_name = "contributor/js2";
  const forkApi = new FakeApi([forkParent, childReady]);
  const fork = await retargetImmediateChildren({ api: forkApi, holdApi: forkApi, expected, log: () => {} });
  assert.deepEqual(fork, { parent: 10, candidates: [], retargeted: [], skipped: [] });
  assert.deepEqual(forkApi.patchCalls, []);

  console.log("retarget-stacked-pr-children: all self-checks passed");
}

function liveExpected(env) {
  const repo = parseRepository(env.GH_REPO).fullName;
  return {
    repo,
    number: parseParentNumber(env.PARENT_PR_NUMBER),
    headRef: requiredString(env.PARENT_HEAD_REF, "PARENT_HEAD_REF"),
    headSha: requiredString(env.PARENT_HEAD_SHA, "PARENT_HEAD_SHA"),
    baseRef: requiredString(env.PARENT_BASE_REF, "PARENT_BASE_REF"),
    defaultBranch: requiredString(env.DEFAULT_BRANCH, "DEFAULT_BRANCH"),
  };
}

function liveReleaseExpected(env) {
  const repo = parseRepository(env.GH_REPO).fullName;
  return {
    repo,
    number: parseParentNumber(env.PULL_REQUEST_NUMBER),
    baseRef: requiredString(env.PULL_REQUEST_BASE_REF, "PULL_REQUEST_BASE_REF"),
    defaultBranch: requiredString(env.DEFAULT_BRANCH, "DEFAULT_BRANCH"),
    baseSha: requiredString(env.PULL_REQUEST_BASE_SHA, "PULL_REQUEST_BASE_SHA"),
    previousHeadSha: requiredString(env.PREVIOUS_HEAD_SHA, "PREVIOUS_HEAD_SHA"),
    headSha: requiredString(env.PULL_REQUEST_HEAD_SHA, "PULL_REQUEST_HEAD_SHA"),
  };
}

async function main() {
  if (process.argv.includes("--self-check")) {
    await selfCheck();
    return;
  }
  if (process.argv.includes("--release-pending")) {
    const expected = liveReleaseExpected(process.env);
    const api = new GitHubRestApi({
      token: process.env.HOLD_TOKEN,
      tokenName: "HOLD_TOKEN",
      repository: expected.repo,
      apiUrl: process.env.GITHUB_API_URL,
    });
    const result = await releasePendingAfterSynchronize({ api, holdApi: api, expected });
    console.log(`passive stack release complete: pull_request=#${result.number} released=${result.released}`);
    return;
  }
  const expected = liveExpected(process.env);
  const apiUrl = process.env.GITHUB_API_URL;
  const api = new GitHubRestApi({
    token: process.env.GH_TOKEN,
    tokenName: "GH_TOKEN",
    repository: expected.repo,
    apiUrl,
  });
  const holdApi = new GitHubRestApi({
    token: process.env.HOLD_TOKEN,
    tokenName: "HOLD_TOKEN",
    repository: expected.repo,
    apiUrl,
  });
  const result = await retargetImmediateChildren({ api, holdApi, expected });
  console.log(
    `passive stack retarget complete: parent=#${result.parent} candidates=${result.candidates.length}` +
      ` retargeted=${result.retargeted.length} skipped=${result.skipped.length}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`retarget-stacked-pr-children: ${error.message}`);
    process.exitCode = 1;
  });
}
