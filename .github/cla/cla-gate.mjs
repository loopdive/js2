#!/usr/bin/env node
// cla-gate.mjs — self-hosted CLA-acceptance gate (issue #1660).
//
// SECURITY (pull_request_target): the workflow that calls this runs on the
// `pull_request_target` trigger, which executes with a WRITE token in the
// context of the BASE repo even for fork PRs. We therefore NEVER check out or
// execute PR head code. This script only:
//   - reads PR / comment metadata that the workflow passes in via env vars,
//   - reads/writes the in-repo signature store (.github/cla/signatures.json),
//   - makes read-only GitHub API calls for org-membership / PR author.
// No PR-supplied code is ever run.
//
// The script is intentionally dependency-free (Node stdlib + the GitHub REST
// API via fetch) and split into pure, unit-testable functions plus a thin
// `main()` that the workflow drives. See .github/cla/cla-gate.test.mjs.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const SIGNATURES_PATH = path.join(REPO_ROOT, ".github", "cla", "signatures.json");
export const ALLOWLIST_PATH = path.join(REPO_ROOT, ".github", "cla", "allowlist.json");
export const CLA_PATH = path.join(REPO_ROOT, "CLA.md");

// The exact phrase a contributor must comment (case-insensitive, trimmed).
export const AGREEMENT_PHRASE = "I have read and agree to the CLA";

// ---------------------------------------------------------------------------
// CLA version — tied to the content hash of CLA.md so that ANY change to the
// CLA terms bumps the version and forces all contributors to re-accept. A
// signature is only valid for the cla_version it was recorded against.
// ---------------------------------------------------------------------------
export function computeClaVersion(claText) {
  const hash = crypto.createHash("sha256").update(claText, "utf8").digest("hex");
  return `sha256:${hash.slice(0, 12)}`;
}

export function currentClaVersion() {
  return computeClaVersion(fs.readFileSync(CLA_PATH, "utf8"));
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** A bot login like "github-actions[bot]" / "dependabot[bot]" / any "*[bot]". */
export function isBot(login) {
  return typeof login === "string" && /\[bot\]$/i.test(login);
}

/** Normalize a comment body for phrase matching.
 *
 * Accepts two formats (case-insensitive, trimmed):
 *   1. Exact phrase: "I have read and agree to the CLA"
 *   2. Checkbox:     "[x] I have read and agree to the CLA"
 *                    "- [x] I have read and agree to the CLA"
 *                    "* [x] I have read and agree to the CLA"
 *
 * The checkbox format lets contributors click a GitHub task-list checkbox
 * (if the workflow triggers on issue_comment edited) or copy-paste the
 * pre-filled checkbox from the instruction comment.
 */
export function commentMatchesPhrase(body) {
  if (typeof body !== "string") return false;
  const trimmed = body.trim().toLowerCase();
  const phrase = AGREEMENT_PHRASE.toLowerCase();
  if (trimmed === phrase) return true;
  // Checkbox format: optional "- " or "* " prefix, then "[x] " + phrase
  const m = /^(?:[-*]\s+)?\[x\]\s+(.+)$/.exec(trimmed);
  if (m && m[1].trim() === phrase) return true;
  return false;
}

/** Check whether a PR body contains the CLA checkbox in checked state.
 *
 * Matches the PR template checkbox:  - [x] I have read and agree to the CLA
 * Case-insensitive. The checkbox must be checked ([x] or [X]).
 */
export function prBodyMatchesCheckbox(body) {
  if (typeof body !== "string") return false;
  const phrase = AGREEMENT_PHRASE.toLowerCase();
  for (const line of body.split("\n")) {
    const m = /^(?:[-*]\s+)?\[x\]\s+(.+)$/i.exec(line.trim());
    if (m && m[1].trim().toLowerCase() === phrase) return true;
  }
  return false;
}

/**
 * Decide exemption from the static allowlist + bot rule. Org membership is
 * resolved separately (async, via API) by `isOrgMember`. Returns a reason
 * string when exempt, otherwise null.
 */
export function staticExemptReason(login, allowlist) {
  if (isBot(login)) return "bot";
  const exempt = (allowlist && allowlist.exempt_logins) || [];
  if (exempt.map((l) => l.toLowerCase()).includes(String(login).toLowerCase())) {
    return "allowlist";
  }
  return null;
}

/** Has this login signed at the given cla_version? */
export function hasSigned(signatures, login, claVersion) {
  if (!Array.isArray(signatures)) return false;
  const l = String(login).toLowerCase();
  return signatures.some((s) => String(s.login).toLowerCase() === l && s.cla_version === claVersion);
}

/** Build a signature record. */
export function makeSignature({ login, name, pr, commitSha, claVersion, signedAt }) {
  return {
    login,
    name: name || login,
    pr,
    commit_sha: commitSha,
    cla_version: claVersion,
    signed_at: signedAt || new Date().toISOString(),
  };
}

/** Append a signature into the parsed store object (idempotent per version). */
export function appendSignature(store, sig) {
  if (!store || typeof store !== "object") store = { signatures: [] };
  if (!Array.isArray(store.signatures)) store.signatures = [];
  if (hasSigned(store.signatures, sig.login, sig.cla_version)) {
    return { store, added: false };
  }
  store.signatures.push(sig);
  return { store, added: true };
}

// ---------------------------------------------------------------------------
// Store IO
// ---------------------------------------------------------------------------
export function readStore() {
  const raw = fs.readFileSync(SIGNATURES_PATH, "utf8");
  return JSON.parse(raw);
}

export function readAllowlist() {
  const raw = fs.readFileSync(ALLOWLIST_PATH, "utf8");
  return JSON.parse(raw);
}

export function writeStore(store) {
  // keep the cla_version field in sync with the current CLA on every write
  store.cla_version = currentClaVersion();
  fs.writeFileSync(SIGNATURES_PATH, JSON.stringify(store, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// GitHub API (read-only except the signature commit, which the workflow does)
// ---------------------------------------------------------------------------
async function gh(token, apiPath, { method = "GET" } = {}) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "js2wasm-cla-gate",
    },
  });
  return res;
}

/**
 * Live org-membership check. Uses GET /orgs/{org}/members/{login}, which an
 * org-scoped GITHUB_TOKEN can read (204 => member, 404 => not a member). Any
 * non-204/404 (rate limit, 403) is treated as "unknown" so the caller can
 * fall back to the static allowlist rather than wrongly blocking.
 */
export async function isOrgMember(token, org, login) {
  if (!token) return { member: false, known: false };
  try {
    const res = await gh(token, `/orgs/${org}/members/${encodeURIComponent(login)}`);
    if (res.status === 204) return { member: true, known: true };
    if (res.status === 404 || res.status === 302) return { member: false, known: true };
    return { member: false, known: false };
  } catch {
    return { member: false, known: false };
  }
}

/**
 * Resolve the full exemption decision (static + live org membership).
 * Returns { exempt, reason }.
 */
export async function resolveExemption({ token, org, login, allowlist }) {
  const staticReason = staticExemptReason(login, allowlist);
  if (staticReason) return { exempt: true, reason: staticReason };

  const orgs = (allowlist && allowlist.exempt_orgs) || [org].filter(Boolean);
  for (const o of orgs) {
    const { member, known } = await isOrgMember(token, o, login);
    if (known && member) return { exempt: true, reason: `org:${o}` };
  }
  return { exempt: false, reason: null };
}

export default {
  AGREEMENT_PHRASE,
  computeClaVersion,
  currentClaVersion,
  isBot,
  commentMatchesPhrase,
  prBodyMatchesCheckbox,
  staticExemptReason,
  hasSigned,
  makeSignature,
  appendSignature,
  readStore,
  readAllowlist,
  writeStore,
  isOrgMember,
  resolveExemption,
};
