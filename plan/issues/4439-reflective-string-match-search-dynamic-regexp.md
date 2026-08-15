---
id: 4439
title: "Reflective String.prototype.match/search + dynamic-pattern residual — borrowed-method and runtime-pattern regexp shapes in standalone"
status: in-progress
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: regexp-string-methods
goal: standalone-gap
related: [4426, 4220, 4232, 2928, 1539]
origin: "2026-08-15 ES5-standalone campaign wave 8 — from the fresh baseline cluster map (built-ins/String/prototype 41 ES<=5 non-pass; 'Unsupported dynamic regular expression pattern' x8)."
---

# #4439 — reflective `String.prototype.match`/`search` + dynamic-pattern residual

## Problem

Three related ES≤5 standalone clusters (fresh baseline 2026-08-15, es5id scope):

1. **Borrowed `match`/`search` throw the refusal** `String.prototype.<m> is
   not yet implemented in --target standalone` — e.g.
   `test/built-ins/String/prototype/search/S15.5.4.12_A1_T1.js`
   (`new Object(true)` receiver, `search(true)` — a LITERAL pattern after
   ToString), `match/S15.5.4.10_A2_T17/T18`, `A1_T3` (`match` bound to the
   global object). The DIRECT lanes (`"abc".match(/b/)`, `.search(/b/)`)
   already work.
2. **`Cache_match` host-import leak** on `match/this-val-obj.js`,
   `this-val-bool.js` (#2961 refusal).
3. **`Unsupported dynamic regular expression pattern`** ×8 (e.g.
   `built-ins/RegExp/S15.10.4.1_A8_T4.js`) — patterns outside
   `__regex_compile_dynamic_simple`'s literal/alternation subset.

## Implementation Plan

1. Follow the established reflective-body pattern (`string-proto-split.ts` —
   the closest sibling: it already returns a non-string result and handles a
   TWO-lane arg: static RegExp vs ToString'd separator). Wire `match` and
   `search` in `emitStringProtoMemberBody`
   (`src/codegen/array-object-proto.ts`) to new bodies in a NEW module
   (`string-proto-match-search.ts`), refusal fallback preserved.
2. The arg dispatch at runtime: `ref.test` the native `$NativeRegExp` struct
   (`ensureStandaloneRegExpStruct`, `regexp-standalone.ts`) → use its
   prog/classTable/nGroups fields; otherwise ToString(arg) →
   `ensureDynamicStandaloneRegExpCompiler` (`__regex_compile_dynamic_simple`,
   regexp-standalone.ts ~1023) with empty flags.
3. `search` semantics: `__regex_search`-based sequence
   (`emitRegexSearchCallSequence` ~2189 — used by `.test`; returns match
   start or -1) → box as Number. `match` (non-global): the `exec` result
   shape — `__regex_capture_array` → `$__regexp_match_vec` (~2397) → null on
   miss. Reuse the ensure* helpers; do NOT hand-roll a matcher.
4. The `Cache_match` leak: locate the emit site (grep `Cache_match`), gate it
   on the host lane, route standalone to the same new body.
5. Dynamic-pattern residual: measure which of the 8 files' patterns fall
   inside a MODEST extension of the runtime subset (character classes,
   quantifiers on literals?) — extend only what the corpus needs, keep the
   catchable-TypeError refusal for the rest (never manufacture an empty
   program — the ~1030 comment explains the OOB hazard).
6. Verify per-file with the single-test driver; scoped standalone run over
   `built-ins/String/prototype/match|built-ins/String/prototype/search|built-ins/RegExp`
   for collateral; the regexp unit suites (`es5-standalone-regexp*`,
   `issue-1539*`) stay green.

## Acceptance criteria

- S15.5.4.12_A1_T1/T2 and the S15.5.4.10 borrowed-match family flip, or each
  non-flip is root-caused in this file with an owner.
- Zero regressions in the scoped regexp/string sweep; gc/host byte-identical.
