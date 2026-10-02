# shellcheck shell=sh
# Pre-push prettier gate (.husky/pre-push, section 3b). POSIX sh only; sourced
# by the hook and unit-tested directly (tests/hooks/pre-push-format-gate.test.ts),
# mirroring the #3410 push-remote-classify.sh split.
#
# #6799 — CHANGED FILES ONLY, NO WATCHDOG. The gate used to run the whole-tree
# `pnpm run format:check` under a 90 s watchdog and, on timeout, print
# "TIMED OUT — skipping" and let the push through. Measured 2026-09-30: 82 s on
# an idle box, 108 s with one concurrent job — so the check was skipped exactly
# when the machine was busy, i.e. whenever agents were pushing. A bounded check
# that turns itself off under load is not a check.
#
# Prettier's cost is per file, so the fix is to check only the files this push
# changes: `git diff --name-only <merge-base>..HEAD`, filtered to the globs
# `format:check` covers (`src/**/*.ts`, `tests/**/*.ts`, `scripts/**/*.ts` — see
# package.json). That is seconds, so it runs unbounded and its verdict is final.
# CI's `quality` job still runs the whole-tree `format:check`.
#
# (#3409's portable-watchdog logic lived here before; with no watchdog there is
# no `timeout`/`gtimeout` probe left to get wrong on macOS.)

# format_gate_base: echo the merge-base of HEAD with upstream main, or nothing
# when no main ref resolves. The authoritative base is UPSTREAM's main, whatever
# the remote is called: in a fork checkout `origin` is the fork (whose main may
# have diverged) and `upstream` is loopdive/js2, so `upstream/main` is tried
# first, then `origin/main`.
format_gate_base() {
  for _fg_ref in upstream/main origin/main; do
    if git rev-parse --verify --quiet "$_fg_ref^{commit}" >/dev/null 2>&1; then
      _fg_base=$(git merge-base "$_fg_ref" HEAD 2>/dev/null) || continue
      if [ -n "$_fg_base" ]; then
        echo "$_fg_base"
        return 0
      fi
    fi
  done
  return 0
}

# format_changed_files BASE: one path per line — files changed in BASE..HEAD
# that `format:check` covers and that still exist in the working tree (prettier
# errors on a path it cannot read; a deleted file has nothing to format).
format_changed_files() {
  git diff --name-only --diff-filter=d "$1..HEAD" -- 2>/dev/null |
    grep -E '^(src|tests|scripts)/.+\.ts$' |
    while IFS= read -r _fg_file; do
      [ -f "$_fg_file" ] && printf '%s\n' "$_fg_file"
    done
  return 0
}

# run_format_gate: prettier --check over the changed files. Output goes to
# stdout (combined) for the caller to capture; the return code is prettier's
# (via xargs: any failing batch makes it non-zero). With no resolvable base it
# falls back to the whole-tree `pnpm run format:check` — still unbounded, never
# skipped. With nothing to check it returns 0 and says so.
run_format_gate() {
  _fg_base=$(format_gate_base)
  if [ -z "$_fg_base" ]; then
    echo "Pre-push: no upstream/main or origin/main ref — checking the whole tree."
    pnpm run format:check 2>&1
    return $?
  fi
  _fg_files=$(format_changed_files "$_fg_base")
  if [ -z "$_fg_files" ]; then
    echo "Pre-push: no changed src/tests/scripts *.ts files since $(echo "$_fg_base" | cut -c1-10) — nothing to format-check."
    return 0
  fi
  _fg_count=$(printf '%s\n' "$_fg_files" | wc -l | tr -d ' ')
  echo "Pre-push: prettier --check on $_fg_count changed file(s) since $(echo "$_fg_base" | cut -c1-10)."
  printf '%s\n' "$_fg_files" | tr '\n' '\0' | xargs -0 pnpm exec prettier --check 2>&1
  return $?
}
