#!/bin/sh
# Symlink heavyweight local dependencies into git worktrees.
#
# Usage:
#   scripts/provision-worktree-deps.sh [worktree ...]
#
# With no worktree arguments, all registered worktrees for the canonical
# workspace are scanned. Existing populated directories are left untouched;
# empty placeholder directories are replaced with symlinks.

set -u

say() {
  echo "[provision-worktree-deps] $*"
}

resolve_repo() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null || true
}

SOURCE_ROOT="${JS2_WORKTREE_SOURCE:-}"
if [ -n "$SOURCE_ROOT" ]; then
  SOURCE_ROOT="$(resolve_repo "$SOURCE_ROOT")"
fi
if [ -z "$SOURCE_ROOT" ] && [ -d /workspace ]; then
  SOURCE_ROOT="$(resolve_repo /workspace)"
fi
if [ -z "$SOURCE_ROOT" ]; then
  SOURCE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [ -z "$SOURCE_ROOT" ]; then
  say "no git repo found; skipping"
  exit 0
fi

is_empty_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]
}

dep_available() {
  case "$1" in
    node_modules) [ -d "$SOURCE_ROOT/node_modules" ] ;;
    test262) [ -d "$SOURCE_ROOT/test262/test" ] ;;
    *) return 1 ;;
  esac
}

link_dep() {
  wt="$1"
  dep="$2"
  src="$SOURCE_ROOT/$dep"
  dst="$wt/$dep"

  dep_available "$dep" || {
    say "source $dep unavailable at $src; skipping"
    return 0
  }

  [ "$wt" = "$SOURCE_ROOT" ] && return 0
  [ -d "$wt" ] || return 0

  if [ "$dep" = "test262" ]; then
    link_test262 "$wt" "$src" "$dst"
    return 0
  fi

  if [ -L "$dst" ]; then
    current="$(readlink "$dst" 2>/dev/null || true)"
    if [ "$current" = "$src" ]; then
      return 0
    fi
    say "leaving existing $dep symlink in $wt -> $current"
    return 0
  fi

  if [ -e "$dst" ]; then
    if is_empty_dir "$dst"; then
      rmdir "$dst" 2>/dev/null || {
        say "could not remove empty $dst; skipping"
        return 0
      }
    else
      say "leaving existing non-empty $dst"
      return 0
    fi
  fi

  if ln -s "$src" "$dst" 2>/dev/null; then
    say "linked $dep -> $wt"
  else
    say "failed to link $dep into $wt"
  fi
}

link_test262() {
  wt="$1"
  src="$2"
  dst="$3"

  if [ -L "$dst" ]; then
    rm "$dst" 2>/dev/null || {
      say "could not remove $dst symlink; skipping"
      return 0
    }
  fi

  if [ -e "$dst" ] && [ ! -d "$dst" ]; then
    say "leaving existing non-directory $dst"
    return 0
  fi

  mkdir -p "$dst" 2>/dev/null || {
    say "could not create $dst; skipping"
    return 0
  }

  linked=0
  for entry in "$src"/* "$src"/.[!.]* "$src"/..?*; do
    [ -e "$entry" ] || continue
    base="$(basename "$entry")"
    [ "$base" = "." ] && continue
    [ "$base" = ".." ] && continue
    [ "$base" = ".git" ] && continue
    [ -e "$dst/$base" ] || [ -L "$dst/$base" ] && continue
    if ln -s "$entry" "$dst/$base" 2>/dev/null; then
      linked=$((linked + 1))
    fi
  done

  if [ "$linked" -gt 0 ]; then
    say "linked test262 contents -> $wt"
  fi
}

provision_one() {
  wt="$1"
  link_dep "$wt" node_modules
  link_dep "$wt" test262
  hook_installer="$wt/scripts/configure-git-hooks.sh"
  if [ -f "$hook_installer" ]; then
    sh "$hook_installer" "$wt" || say "failed to configure hooks in $wt"
  fi
}

if [ "$#" -gt 0 ]; then
  for wt in "$@"; do
    provision_one "$wt"
  done
else
  git -C "$SOURCE_ROOT" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | while read -r wt; do
    provision_one "$wt"
  done
fi

exit 0
