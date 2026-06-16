---
id: 2161
title: "Standalone RegExp engine conformance residual (~579 tests)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: regexp
goal: standalone-mode
parent: 1909
---

# Standalone RegExp engine conformance residual

## Problem

The standalone native RegExp engine landed in #682 and the #1909–#1914 phase
bucket (all `done`, sprint 61, mostly `critical`). The host-vs-standalone
baseline diff (sha `31fa7e099`, 2026-06-15) shows **579 tests still pass in
host mode but fail standalone**, attributed to the RegExp engine — currently
**untracked/unscheduled**.

## Evidence

- Gap category: `built-ins/RegExp` 554, of which 425 are `(none)`-leak
  `compile_error` and ~51 runtime `fail`.
- Residual phases the #1909–#1914 buckets did not fully close: source/flags
  reflection, `lastIndex` for global/sticky, `split`/`replace`/`matchAll`,
  and u/v/d-flag Unicode/lookaround edge cases.

## Acceptance criteria

- Standalone pass count for `built-ins/RegExp` rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1909. Part of sprint-62 standalone catch-up (rank 5 by gap
impact).

## Tech-lead triage note (2026-06-15, from sdev3)

Released to pending after triage — needs CI standalone-shard compile_error
breakdown to scope sub-fixes. Basic standalone RegExp is HEALTHY (test/exec/
captures/source/flags/lastIndex/replace/split/match all correct). Concrete leak:
`String.prototype.matchAll` refused in standalone (string-ops.ts:2786) though
regexp-standalone.ts has `__regex_match_all` (wired only to global `match`);
wiring matchAll = focused sub-feature (iterator of capture-ARRAYS). Dominant
~425 `(none)`-leak compile_errors need the real test262 harness (Symbol.match
protocol). NEXT: pull standalone-shard RegExp compile_error entries from CI,
bucket by leaked import, dispatch top 2-3 + matchAll iterator as sub-PRs.

## matchAll sub-feature — dispatch-ready spec (2026-06-15, sdev5)

Confirmed on main (`39a63edf0`): standalone `"aXbXc".match(/X/g)` works (→ 2, 0
imports) but `"aXbXc".matchAll(/X/g)` is **blanket-refused** with the rest of the
RegExp-or-symbol-protocol forms at `string-ops.ts:2786` (`alwaysRegExp = match ||
matchAll || search`). The native engine is healthy; matchAll just isn't wired.

**Why it's NOT a thin wrap of the existing `match` path:** the global `match`
helper `__regex_match_all` (regexp-standalone.ts:1106+) returns a vec of the
**[0] matched substrings only** (`ensureRegexMatchVecType`). `matchAll` per
§22.2.6.9 must yield **full match arrays** — each with all capture groups,
`.index`, `.input`, named groups — i.e. a vec of capture-ARRAYS, not substrings.

**Building blocks already on main (verified):**
- `ensureRegexCaptureArray` / `__regex_capture_array` (regexp-standalone.ts:934)
  — builds the [0]+captures array for ONE exec result (used by `exec`/`match`).
- `emitRegexExecArrayCall` (the exec driver) — runs one match from lastIndex.
- The `__regex_match_all` loop (1106+) is the exact advance/empty-match-guard
  template to copy, but collecting capture-arrays instead of substrings.

**Implementation plan (focused, ~half-day):**
1. New native helper `ensureRegexMatchAllArrays` — clone `__regex_match_all`'s
   eager loop (SetLastIndex 0; loop RegExpExec with AdvanceStringIndex on empty
   match), but per iteration call the capture-array builder and push the
   capture-array ref into a vec-of-capture-arrays (a `__vec_ref_<captureArr>`).
   Reset lastIndex to 0 after (matchAll is a fresh iterator; spec keeps the
   regex's lastIndex at 0 for a `g` regex after the StringIndexOf loop).
2. `tryCompileStandaloneStringMatchAll` (regexp-standalone.ts) — mirror
   `tryCompileStandaloneStringMatch`'s gating (global RegExp or backend-created
   receiver, static flags, engine present); require the `g` flag (matchAll
   throws TypeError on a non-global regex per §22.1.3.13 — a narrowed refusal is
   acceptable for the slice). Emit the helper call; return the vec-of-arrays as
   an **iterable** (for-of over a vec already works; `.next()`/spread reuse the
   #2169 native-vec consumers).
3. `string-ops.ts:2786` — remove `matchAll` from the blanket `alwaysRegExp`
   refusal and route it to the new path BEFORE the refusal (mirror the
   `method === "match"` branch at :2754). Keep the refusal for `search` +
   dynamic/symbol-protocol forms.

**Test gate:** `for (const m of "a1b2".matchAll(/(\d)/g)) sum += Number(m[1])` →
3; iteration count over `/X/g` → 2; named groups + `.index`. Standalone, zero
host imports.

**Deferred:** non-global matchAll (throws — narrow refuse), dynamic-flags,
string-arg coercion (`s.matchAll("x")` → new RegExp). Dominant ~425 `(none)`
compile_errors remain the separate Symbol.match-protocol harness bucket (needs
the CI standalone-shard breakdown), tracked under #2161 still.

Status kept in-progress; matchAll is the first dispatch-ready slice.

## matchAll slice — LANDED (2026-06-15, sdev5)

Implemented per the spec above. `String.prototype.matchAll(/re/g)` in standalone
now compiles to the native engine — **zero host imports**.

- `src/codegen/native-regex.ts`: new `ensureRegexMatchAllArrays` (clones the
  `__regex_match_all` AdvanceStringIndex loop but per match calls
  `__regex_capture_array(nGroups, subject, caps)` and pushes the capture-array
  ref into a growable vec-of-(match-vec-refs)); `ensureRegexMatchAllVecType`
  exposes the outer-vec type to consumers.
- `src/codegen/regexp-standalone.ts`: `tryCompileStandaloneStringMatchAll`
  (mirrors the global `match` branch; requires a static `g` RegExp).
- `src/codegen/string-ops.ts`: routes `matchAll` to the new path before the
  `alwaysRegExp` refusal.
- Tests: `tests/issue-2161-matchall.test.ts` (7 cases, all standalone +
  empty-importObject: count, capture groups `m[1]`, full match `m[0]`,
  `m.index`, empty iterator (not null), empty-match advance, non-global refusal).
  Updated `tests/issue-1474-standalone-regex-refuse.test.ts` to assert the new
  narrowed behavior (global for-of compiles; non-global refuses).

**Verified working:** `for (const m of s.matchAll(/re/g))` (the
RegExpStringIterator consumption form), capture groups, `.index`, empty/no-match.

**Deferred (still narrowed-refuse, NOT silently wrong):** non-global matchAll
(spec TypeError), string-arg coercion, dynamic flags, AND `[...s.matchAll(re)]`
spread **into an array literal** — that hits a generic native-vec-of-refs →
externref-array element-coercion gap (the spread-into-`[]` consumer expects
externref elements; not matchAll-specific — affects any ref-element native vec).
Tracked as a follow-up.

**#2161 stays open** for the dominant ~425 `(none)` Symbol.match-protocol harness
bucket (needs the CI standalone-shard compile_error breakdown to scope), which
is independent of this matchAll wiring.
