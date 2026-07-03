// Shared persistence for the Symphony dispatch channel: a claims.json map
// (issue -> owner/status) and a messages.jsonl append log, both rooted under
// `<root>/.codex/dispatch/`. Consumed by the daemon (symphony.mjs), the MCP
// channel server (symphony-channel.mjs), and the CLI (symphony-dispatch.mjs)
// so all three agree on file shape without duplicating the I/O.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function dispatchPaths(root) {
  const dir = path.join(root, ".codex", "dispatch");
  return {
    dir,
    messagesFile: path.join(dir, "messages.jsonl"),
    claimsFile: path.join(dir, "claims.json"),
    receiptsDir: path.join(dir, "receipts"),
  };
}

function ensureDispatchStateDir(root) {
  const paths = dispatchPaths(root);
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(paths.receiptsDir, { recursive: true });
  return paths;
}

export function loadDispatchClaims(root) {
  try {
    return JSON.parse(readFileSync(dispatchPaths(root).claimsFile, "utf8"));
  } catch {
    return {};
  }
}

export function saveDispatchClaims(root, claims) {
  const { claimsFile } = ensureDispatchStateDir(root);
  const tmp = `${claimsFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(claims, null, 2)}\n`);
  renameSync(tmp, claimsFile);
}

export function setDispatchClaim(root, issue, patch) {
  const claims = loadDispatchClaims(root);
  const key = String(issue);
  claims[key] = { ...(claims[key] || { issue: key }), ...patch };
  saveDispatchClaims(root, claims);
  return claims[key];
}

export function activeDispatchClaim(root, issueId) {
  const claim = loadDispatchClaims(root)[String(issueId)];
  return claim && claim.status === "claimed" ? claim : null;
}

export function releaseDispatchClaim(root, issueId, reason) {
  return setDispatchClaim(root, issueId, {
    status: "released",
    reason,
    released_at: new Date().toISOString(),
  });
}

export function appendDispatchMessage(root, message) {
  const { messagesFile } = ensureDispatchStateDir(root);
  appendFileSync(messagesFile, `${JSON.stringify(message)}\n`);
}

export function readAllDispatchMessages(root) {
  const { messagesFile } = dispatchPaths(root);
  if (!existsSync(messagesFile)) return [];
  return readFileSync(messagesFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function receiptOffsetFile(root, name) {
  const { receiptsDir } = dispatchPaths(root);
  return path.join(receiptsDir, `${String(name || "default").replace(/[^A-Za-z0-9._-]/g, "_")}.offset`);
}

/**
 * Reads messages appended since `offsetFile`'s last recorded position.
 * Pass `advance: true` to move the watermark forward as a side effect
 * (used by pollers); omit it for read-only inspection (e.g. `status`).
 */
export function readMessagesSince(root, offsetFile, { advance = false, filter } = {}) {
  ensureDispatchStateDir(root);
  const { messagesFile } = dispatchPaths(root);
  const text = existsSync(messagesFile) ? readFileSync(messagesFile, "utf8") : "";
  let offset = existsSync(offsetFile) ? Number(readFileSync(offsetFile, "utf8") || 0) : 0;
  if (offset > text.length) offset = 0;
  const chunk = text.slice(offset);
  if (advance) writeFileSync(offsetFile, String(text.length));
  return chunk
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((msg) => msg && (!filter || filter(msg)));
}
