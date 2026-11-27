// Label a PR and post one marker-guarded comment on it. Shared by auto-park
// (#2547) and the #7537 post-merge test262 alarm, so both bots label through
// the REST endpoint and stay idempotent the same way: a run that is retried, or
// a merge group that is rebuilt, never posts its comment twice.
//
// `gh` is `(args: string[]) => string` and throws on failure, as
// execFileSync("gh", args) does; callers inject it so tests need no network.

/**
 * REST, not `gh pr edit --add-label`, which has hit a Projects-classic error on
 * this repo. GitHub creates the label if it does not exist yet.
 */
export function addLabel(gh, repo, pr, label) {
  gh(["api", "-X", "POST", `repos/${repo}/issues/${pr}/labels`, "-f", `labels[]=${label}`]);
}

/** Posts `body` unless a comment on the PR already carries `marker`. Returns whether it posted. */
export function commentOnce(gh, repo, pr, marker, body) {
  const existing = gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`, "--jq", ".[].body"]);
  if (existing.includes(marker)) return false;
  gh(["api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${marker}\n${body}`]);
  return true;
}
