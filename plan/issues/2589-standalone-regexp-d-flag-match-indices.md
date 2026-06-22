---
id: 2589
title: "Standalone RegExp `d` flag — match `.indices` array (RegExpBuiltinExec step 28-29)"
status: done
completed: 2026-06-22
sprint: 65
priority: medium
feasibility: medium
parent: 2161
area: regexp
goal: standalone-mode
language_feature: regexp
task_type: conformance
created: 2026-06-22
---

# Standalone RegExp `d` flag — match `.indices` array

Slice of umbrella #2161. **Substrate-independent** (regex engine + match-result
struct shape).

## Problem

The `d` (hasIndices) flag (§22.2.7.2 RegExpBuiltinExec steps 28-29 / MakeMatchIndicesIndexPairArray)
makes `exec`/`match` return a match object carrying an extra **`indices`** array:
`indices[0]` is `[startOfMatch, endOfMatch]`, `indices[n]` is `[start, end]` for
capture group `n` (or `undefined` when unmatched), and `indices.groups` mirrors the
named-group start/end pairs.

In `--target standalone` this is entirely missing:

| form | standalone result | spec |
|---|---|---|
| `/a/d.flags`, `re.hasIndices` | `"d"`, `true` ✓ (flag bit already works) | — |
| `/(a)(b)/d.exec("xab").indices` | reads `.input` (wrong) **and leaks `env::__extern_get`** | `[[1,3],[1,2],[2,3]]` |

Verified on current main: `/(a)/d.exec("xa").indices[0][0]` makes the binary leak
`env::__extern_get` (an unsatisfiable host import in standalone) — the `.indices`
read falls through to the generic externref-object index path because the match-vec
struct has no `indices` field.

## Root cause

Same shape gap as #2588 (named-groups), different field:

1. `ensureRegexMatchVecType` (`native-regex.ts:1690`) has no `indices` field — only
   `index` (field 2) and `input` (field 3).
2. The match-result property reader (`regexp-standalone.ts` ~line 2240) maps every
   non-`index` property to `input`; `m.indices` has no handler, so a downstream
   `m.indices[0][0]` index-access routes through the dynamic externref reader
   (`__extern_get`) instead of a native struct read.
3. The `caps` i32 array that `__regex_capture_array` already consumes **already holds
   every start/end pair** (`caps[2*i]`, `caps[2*i+1]`) — the raw data for `.indices`
   is present; it's just never materialised into a result array.

## Implementation Plan

### Approach — materialise `indices` from the existing `caps` pairs, gated on the `d` flag

The `caps` i32 array is the exact source data. `.indices` is a vec-of-(2-element
number-pairs), where each pair is itself a 2-element array `[start, end]` or
`undefined` for an unmatched slot.

**File: `src/codegen/native-regex.ts`**

1. `ensureRegexMatchVecType` (line ~1690): add a 6th field
   `indices (ref null any)` (mutable false), `null` when the `d` flag is absent.
   Export `MATCH_VEC_FIELD_INDICES`. (Coordinate field ordering with #2588 if both
   land together — pick a stable order: `index, input, groups, indices`.)
2. New helper `ensureRegexIndicesArray(ctx)` — analogous to `__regex_capture_array`
   but builds the **pairs array**: for each group slot `i` in `[0, nGroups)`, read
   `caps[2*i]` / `caps[2*i+1]`; if both `>= 0` push a 2-element number vec
   `[start, end]`, else push the `undefined` (null) sentinel. Build it from the
   same `nGroups`/`caps` the capture-array helper already has. Returns a vec-of-vecs
   (`__vec_ref_<numberVec>` or the open `$Vec`/`$Object` array path — reuse whatever
   native array representation `String.prototype.split`/`match` already returns so
   the downstream `m.indices[0][0]` index reads stay native, NO `__extern_get`).
3. Only emit the indices array when the **compile-time-known flag bits include `d`**
   (the flags are static at every backend exec/match site). When `d` is absent the
   field stays `null`.

**File: `src/codegen/regexp-standalone.ts`**

4. Match-result property reader (~line 2240): add a `propName === "indices"` case
   that reads `MATCH_VEC_FIELD_INDICES` and returns the native array ref type (so
   `m.indices[i]` and `m.indices[i][j]` are native index reads, not `__extern_get`).
   When the receiver's flags lack `d`, the field is `null` → standalone `undefined`.
5. At the exec/match/matchAll cores, when the static flags include `d`, also call
   `ensureRegexIndicesArray` and store the result into the new field; otherwise
   store `null`.

### Edge cases
- `d` flag absent → `.indices` is `undefined` (null field); zero overhead, existing
  paths unchanged.
- Unmatched capture group → `indices[n]` is `undefined` (null), NOT `[undefined,undefined]`.
- Named groups + `d`: `indices.groups` (§ MakeMatchIndicesIndexPairArray) is a
  follow-on that depends on #2588's groups-object machinery — if #2588 hasn't landed,
  **narrow-refuse `indices.groups`** (return `undefined` is acceptable as a first
  slice; note it) rather than mis-populate.
- Unicode (`u`/`v`) indices are code-point offsets — reuse the same offset arithmetic
  the engine already uses for `.index`; do NOT introduce a second offset convention.

### Representative failing test262 paths
- `test/built-ins/RegExp/match-indices/indices-array.js`
- `test/built-ins/RegExp/match-indices/indices-array-element.js`
- `test/built-ins/RegExp/match-indices/indices-array-matched.js`
- `test/built-ins/RegExp/match-indices/indices-array-unmatched.js`
- `test/built-ins/RegExp/match-indices/indices-array-properties.js`
- `test/built-ins/RegExp/prototype/hasIndices/this-val-regexp.js`

### Estimated rows recovered
~15-22 (match-indices dir 9 + the `hasIndices`/`d`-flag cases in
`RegExp/prototype/*` and `String/prototype/*` that read `.indices`). The
`indices.groups` cases may defer to a #2588 follow-up.

### Test gate (standalone, empty importObject, no env/`__extern_*` leak)
- `/(a)(b)/d.exec("xab").indices[0][0] === 1` and `[0][1] === 3`
- `indices[1]` === `[1,2]`, `indices[2]` === `[2,3]`
- unmatched group → `indices[n] === undefined`
- pattern without `d` → `m.indices === undefined`
