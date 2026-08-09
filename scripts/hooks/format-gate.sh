# shellcheck shell=sh
# #3409 — portable format-gate watchdog for the pre-push hook.
#
# The pre-push prettier gate (.husky/pre-push, section 3b) must bound how long
# `pnpm run format:check` may run so a hung check never SIGTERMs at git's 300s
# limit and silently aborts the push. It previously called GNU `timeout`
# UNCONDITIONALLY:
#
#     fmt_out=$(timeout 90 pnpm run format:check 2>&1)
#
# Stock macOS ships no `timeout` (and Homebrew's `gtimeout` may be absent), so
# the shell returned 127 (command-not-found) BEFORE prettier ever ran. The hook
# treats any code other than 124 as a genuine format failure and blocked the
# push — with a blank "Offending files" section, because the real
# `timeout: command not found` error was filtered out. `--no-verify` was the
# only escape, and it bypasses every other pre-push guard.
#
# This helper is sourced by `.husky/pre-push` and unit-tested directly
# (tests/hooks/pre-push-format-timeout.test.ts), mirroring the #3410
# push-remote-classify.sh split. POSIX sh only.

# find_watchdog: echo the available bounded-run binary (`timeout` or the
# Homebrew-coreutils `gtimeout`), or nothing when neither is on PATH.
find_watchdog() {
  if command -v timeout >/dev/null 2>&1; then
    echo timeout
  elif command -v gtimeout >/dev/null 2>&1; then
    echo gtimeout
  fi
}

# run_format_watchdog SECS CMD [ARG...]
#
# Runs CMD under a SECS-second watchdog when one is available; otherwise runs
# CMD directly (no local bound — CI's `quality` job re-runs the identical
# `format:check`, so a rare local hang defers to git's own limit rather than
# manufacturing a failure). CMD's combined stdout+stderr is emitted on stdout so
# the caller can capture and grep it. Returns:
#
#   0        CMD succeeded
#   124      the watchdog expired (only possible when a watchdog exists)
#   <rc>     CMD's own non-zero exit (a genuine format failure)
#
# The load-bearing fix: when no watchdog exists we run CMD ITSELF, so the return
# code is always CMD's real result — NEVER a 127 from a missing `timeout` that
# the caller would mislabel as a format failure. The watchdog-absent notice goes
# to stderr with a non-prettier prefix so it does not pollute the caller's
# `[warn]`/`*.ts` offending-files filter.
run_format_watchdog() {
  _fw_secs=$1
  shift
  _fw_wd=$(find_watchdog)
  if [ -n "$_fw_wd" ]; then
    "$_fw_wd" "$_fw_secs" "$@"
    return $?
  fi
  echo "Pre-push: no 'timeout'/'gtimeout' on PATH — running format:check without a local ${_fw_secs}s watchdog (CI 'quality' enforces it)." >&2
  "$@"
  return $?
}
