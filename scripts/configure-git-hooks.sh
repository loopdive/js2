#!/bin/sh
# Install the repository hooks for one checkout without changing sibling
# worktrees. A relative hooksPath is essential: an absolute path inherited
# from another container/workspace can silently disable every local gate.

set -u

target="${1:-.}"
repo_root="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  exit 0
fi

hooks_path_is_local() {
  [ "$(git -C "$repo_root" config --get core.hooksPath 2>/dev/null || true)" = ".husky" ]
}

# Worktree-local config prevents `pnpm install` in one checkout from redirecting
# hooks for every sibling checkout. Older Git versions may not support this
# extension, so retain the previous repository-local fallback.
if git -C "$repo_root" config extensions.worktreeConfig true 2>/dev/null &&
  git -C "$repo_root" config --worktree core.hooksPath .husky 2>/dev/null &&
  hooks_path_is_local; then
  exit 0
fi

if git -C "$repo_root" config core.hooksPath .husky 2>/dev/null && hooks_path_is_local; then
  exit 0
fi

echo "configure-git-hooks: failed to set core.hooksPath=.husky for $repo_root" >&2
exit 1
