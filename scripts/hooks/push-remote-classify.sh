#!/bin/sh
# POSIX-sh helpers for the private-labs pre-push guard (#3410).
#
# This file is SOURCED by `.husky/pre-push` and exercised directly by
# `tests/hooks/pre-push-labs-remote.test.ts`. It defines pure functions and has
# no side effects at source time, so both callers can rely on it. Keep it free
# of bashisms and of any dependency on node — the labs safety control must work
# even when the JS toolchain is unavailable.
#
# Contract
# --------
#   normalize_owner_repo <url>   -> prints "owner/repo" (lowercased, `.git`
#                                   stripped) or "" when no owner/repo can be
#                                   recovered offline.
#   classify_push_remote <url>   -> prints one of:
#                                     labs-remote  the allowlisted private repo
#                                                  (loopdive/js2wasm-labs)
#                                     public       a known public destination
#                                                  (canonical loopdive/js2wasm,
#                                                  pre-rename legacy loopdive/js2,
#                                                  or a public fork <owner>/js2wasm
#                                                  or <owner>/js2)
#                                     unknown      cannot be confirmed private
#   run_labs_guard <remote> <url> reads pre-push ref lines on stdin; returns 0
#                                 (allow) or 1 (block) and prints a diagnostic
#                                 for every blocked ref.
#
# Fail-safe policy: only `labs-remote` skips the labs/ scan. `public` AND
# `unknown` both scan and block labs/ paths — an unrecognized destination can
# never silently masquerade as the private mirror.

# The single allowlisted PRIVATE destination for labs/ content.
LABS_PRIVATE_REPO="js2wasm-labs"
# The canonical public repo name, and its pre-rename legacy alias. A remote
# whose repo segment normalizes to the canonical name is public regardless of
# owner, so upstream and public forks are both covered.
PUBLIC_REPO_CANONICAL="js2wasm"
PUBLIC_REPO_LEGACY="js2"
NULL_OID="0000000000000000000000000000000000000000"

# normalize_owner_repo <url> -> "owner/repo" | ""
#
# Recovers the trailing owner/repo from every remote-URL syntax we care about:
#   https://github.com/loopdive/js2wasm.git
#   https://x-access-token:TOKEN@github.com/loopdive/js2wasm
#   ssh://git@github.com/loopdive/js2wasm.git
#   git@github.com:loopdive/js2wasm.git          (SCP short syntax)
#   http://local_proxy@127.0.0.1:41729/git/loopdive/js2wasm   (proxied)
# by stripping the scheme, turning ':' into '/' (SCP colon and any host:port
# become path separators — harmless because only the last two segments are
# kept), dropping a trailing '.git', and taking the final two '/'-segments.
normalize_owner_repo() {
  _url=$(printf '%s' "${1:-}" | tr -d '[:space:]')
  [ -n "$_url" ] || { printf ''; return 0; }
  # Strip a leading scheme (https://, http://, ssh://, git://, …).
  _s=${_url#*://}
  # Collapse ':' to '/' so SCP syntax and host:port split uniformly.
  _s=$(printf '%s' "$_s" | tr ':' '/')
  # Drop trailing slashes.
  while [ "${_s%/}" != "$_s" ]; do _s=${_s%/}; done
  # Drop a single trailing .git.
  case "$_s" in *.git) _s=${_s%.git} ;; esac
  # Need at least an owner/repo pair (two '/'-separated segments).
  case "$_s" in */*/*|*/*) : ;; *) printf ''; return 0 ;; esac
  _repo=${_s##*/}
  _rest=${_s%/*}
  _owner=${_rest##*/}
  if [ -z "$_repo" ] || [ -z "$_owner" ]; then
    printf ''
    return 0
  fi
  printf '%s/%s' "$(printf '%s' "$_owner" | tr '[:upper:]' '[:lower:]')" \
                 "$(printf '%s' "$_repo" | tr '[:upper:]' '[:lower:]')"
}

# classify_push_remote <url> -> labs-remote | public | unknown
classify_push_remote() {
  _or=$(normalize_owner_repo "${1:-}")
  if [ -z "$_or" ]; then
    printf 'unknown'
    return 0
  fi
  _repo=${_or#*/}
  case "$_repo" in
    "$LABS_PRIVATE_REPO")
      printf 'labs-remote'
      ;;
    "$PUBLIC_REPO_CANONICAL"|"$PUBLIC_REPO_LEGACY")
      # Canonical upstream, legacy upstream, and any public fork keep the
      # repo name — all public.
      printf 'public'
      ;;
    *)
      printf 'unknown'
      ;;
  esac
}

# labs_forbidden_paths <newline-separated-paths> -> the subset under labs/
labs_forbidden_paths() {
  printf '%s\n' "${1:-}" | grep -E '^labs/' || true
}

# run_labs_guard <remote> <remote_url> ; reads ref lines on stdin.
# Returns 0 (allow) or 1 (block). Prints a diagnostic for each blocked ref.
run_labs_guard() {
  _remote=$1
  _remote_url=$2
  _class=$(classify_push_remote "$_remote_url")
  _norm=$(normalize_owner_repo "$_remote_url")
  [ -n "$_norm" ] || _norm="(unrecognized)"

  # Only the explicitly allowlisted private mirror skips the scan.
  if [ "$_class" = "labs-remote" ]; then
    return 0
  fi

  _block=0
  while read local_ref local_oid remote_ref remote_oid; do
    # Skip deletes (no labs/ paths in a delete diff).
    [ -n "$local_oid" ] || continue
    if [ "$local_oid" = "$NULL_OID" ]; then
      continue
    fi

    if [ "$remote_oid" = "$NULL_OID" ]; then
      # New branch on the remote — compare against the remote's main if a
      # merge-base exists; otherwise scan every commit the branch introduces.
      _base=$(git merge-base "$local_oid" "${_remote}/main" 2>/dev/null || echo "")
      if [ -z "$_base" ]; then
        _diff_paths=$(git log --name-only --pretty=format: "$local_oid" 2>/dev/null | sort -u)
      else
        _diff_paths=$(git diff --name-only "$_base..$local_oid" 2>/dev/null)
      fi
    else
      _diff_paths=$(git diff --name-only "$remote_oid..$local_oid" 2>/dev/null)
    fi

    _forbidden=$(labs_forbidden_paths "$_diff_paths")
    if [ -n "$_forbidden" ]; then
      echo ""
      echo "==========================================================================="
      echo "ERROR: Refusing to push labs/ paths to a non-private remote."
      echo "       remote:        $_remote ($_remote_url)"
      echo "       normalized as: $_norm"
      echo "       classified as: $_class (only '$LABS_PRIVATE_REPO' is treated as private)"
      echo "---------------------------------------------------------------------------"
      echo "The following paths are private and may not appear in a public repo:"
      echo ""
      printf '%s\n' "$_forbidden" | sed 's/^/  /' | head -30
      _remaining=$(printf '%s\n' "$_forbidden" | wc -l)
      if [ "$_remaining" -gt 30 ]; then
        echo "  ... and $((_remaining - 30)) more."
      fi
      echo ""
      echo "Push to the private 'labs' remote instead:"
      echo "  git push labs $local_ref"
      echo ""
      echo "If this push is intentionally public AND your diff includes labs/ paths,"
      echo "split the change so the labs/ paths land separately on the labs remote."
      echo "==========================================================================="
      _block=1
    fi
  done

  return "$_block"
}
