---
id: 2161
title: "Standalone RegExp engine conformance residual (~579 tests)"
status: ready
sprint: 63
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

## Data-backed residual triage (2026-06-16, sdev5)

Pulled the standalone-shard baseline (`loopdive/js2wasm-baselines`
`test262-standalone-current.jsonl`, 48,117 entries, sha 2026-06-16) and bucketed
every RegExp-bucket failure. **1,120 RegExp failures: 843 compile_error + 277
fail.** The 651 RegExp compile_errors by `error_signature`:

| count | bucket | nature |
|---:|---|---|
| 126 | `RegExp.prototype.<prop>` built-in value read (#1907/#1888 S6-b) | **reflection** — `RegExp.prototype.test`/`.flags`/getter *descriptor* reads. Verified: **instance** `re.flags`/`re.source`/`re.global`/`re.ignoreCase`/`re.multiline` ALREADY compile + run in standalone — only the `RegExp.prototype`-as-receiver reflection form refuses (`property-access.ts:1975`, `ensureStandaloneBuiltinStaticMethodClosure` has no RegExp.prototype pairs). |
| ~128 | `@@match`/`@@replace`/`@@split`/`@@matchAll` symbol-protocol calls (literal-substring backend refuses; `string-ops.ts`) | **native built-in prototype-method closures** — `re[Symbol.match](s)` etc. The String.prototype.matchAll *call* form is DONE (#1504); this is the explicit `re[Symbol.X]()` protocol form. |
| ~64 | dynamic constructor patterns/flags (RegExp Phase 2a) | regex-engine feature work |
| 33 | `\q{…}` string disjunction (Phase 2a) | unsupported regex feature (v-flag) |
| 30 | `__get_builtin` dynamic-shape (Phase B) | not RegExp-specific; dynamic-object reflection |
| 33 | `\\`-class / literal-substring backend gaps | regex-engine feature work |
| 10 | `Cannot convert object to primitive value` (runtime) | a `_toPrimitiveSync`/key-coercion gap on a RegExp receiver |

**Conclusion (honest scope call):** there is **no clean bounded point-fix** left
in #2161. The matchAll concrete leak (the one named in the original triage) is
already shipped via #1504. Each remaining bucket is a sub-project:

1. **RegExp.prototype reflection (126)** — add native built-in *method/getter
   closures* for the RegExp.prototype pairs to
   `ensureStandaloneBuiltinStaticMethodClosure`, backed by the native engine's
   flag fields (`RE_FIELD_*`) + the existing exec/test helpers. ~14 pairs
   (test/exec/compile/toString + 10 flag getters). Self-contained but meaty
   (each getter needs a closure fctx + brand check + descriptor reflection for
   the `Object.getOwnPropertyDescriptor(RegExp.prototype, "flags").get` form).
2. **Symbol-protocol calls (~128)** — `re[Symbol.match/replace/split/matchAll]`
   route the global forms to the existing native `tryCompileStandaloneStringMatch*`
   path (reuse #1504's `__regex_match_all_arrays`); the non-global/symbol form
   needs RegExpExec-protocol lowering.
3. **Regex-engine features (~97)**: dynamic ctor patterns/flags, `\q{}`
   v-flag string disjunction — backend feature work, separate from the object
   model.

**Recommend:** split #2161 into (a) `fix: standalone RegExp.prototype reflection
closures` (~126 tests, self-contained, architect-spec'd), (b) `fix: standalone
RegExp @@symbol protocol calls` (~128, reuses #1504), (c) `feat: standalone
RegExp engine v-flag / dynamic-ctor features` (~97, regex backend). Each is a
dispatchable issue with a concrete test gate; none is a tail-end slice. Sub (a)
+ (b) together recover ~250 standalone tests.

### Refinement on sub-bucket (a) — REVISED scope (2026-06-16, sdev5, #2161a)

On implementation entry I pinpointed the exact refusal: it is **reading
`RegExp.prototype` itself** (the prototype OBJECT), not the individual
method/getter. `RegExp.prototype.test`, `RegExp.prototype.flags`,
`RegExp.prototype.flags.length`, `Object.getOwnPropertyDescriptor(RegExp.
prototype, "flags").get` — ALL fail at the inner `RegExp.prototype` read
(`property-access.ts:1969-1976`: `RegExp` is a `BUILTIN_CTOR_NAME` identifier,
`propName === "prototype"` has no native handler → `reportUnsupported…`). There
is **no isolated slice** (not even `.length`/`.name`) that avoids it: every form
chains off `RegExp.prototype`.

Sub-categories of the 126 (by test form): 52 legacy `.call` (`RegExp.prototype.
test.call(re, s)`), 57 Symbol.* protocol members, 31 this-val brand-check, 26
`.length`/`.name`, 7 prop-desc reflection.

**This means (a) is NOT self-contained** — it requires `RegExp.prototype` to be a
**standalone-queryable object** whose members resolve to native method/getter
closures + descriptors. That is the **same architecture as #2158's standalone
builtin-prototype readers** (representing a builtin's `.prototype` host-free,
replacing the `__register_prototype` host-Proxy that `nativeStrings` skips). The
method closures additionally need the native RegExp engine generalized to a
**runtime (externref) regex receiver** (today `emitRegexExecArrayCall` takes a
statically-typed `$NativeRegExp` from a known expression).

**Recommendation (revised):** (a) is NOT a bounded point-fix; fold it into
#2158's standalone-prototype-reader phase (or architect-spec it as "standalone
builtin-prototype object + native-method-closure dispatch", which #2159
TypedArray and other builtins will also need). The cleanly-isolated wins inside
(a) are gated on the same `RegExp.prototype`-object representation, so there is
no tail-end slice to peel off. sdev5 flagged this at the implementation boundary
rather than half-building the prototype-object representation at session tail.
