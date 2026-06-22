---
id: 2588
title: "Standalone RegExp named-groups result object (`m.groups`) + `$<name>` substitution"
status: done
completed: 2026-06-22
sprint: 65
priority: high
feasibility: medium
parent: 2161
area: regexp
goal: standalone-mode
language_feature: regexp
task_type: conformance
created: 2026-06-22
---

# Standalone RegExp named-groups result object (`m.groups`) + `$<name>` substitution

Slice of umbrella #2161. **Substrate-independent** (regex engine + match-result
struct shape, not value-rep).

## Problem

In `--target standalone`, named capture groups `(?<name>…)` parse and the
**numbered** capture and **`\k<name>` backreference** both work, but the named
groups are **never exposed on the match-result object** and **`$<name>`
replacement substitution is dropped**:

| form | standalone result | spec (§22.2.7.2 step 28, §22.1.3.x) |
|---|---|---|
| `/(?<yr>\d{4})/.exec("2026").groups` | falsy / not an object | `{ yr: "2026" }` |
| `m.groups.yr` | unreachable (groups falsy) | `"2026"` |
| `"2026-06".replace(/(?<y>\d{4})-(?<m>\d{2})/, "$<m>/$<y>")` | `undefined` (drops) | `"06/2026"` |

Verified on current main (`--target standalone`, empty importObject): the `.groups`
read returns falsy and `$<name>` expansion yields wrong output. The `native-regex.ts`
substitution code even has the literal comment "`$<` (no named groups in the standalone
backend) → literal" (line ~3055), confirming the gap is intentional-stub, not a bug
in otherwise-correct code.

## Root cause

1. **Match-result shape** — `ensureRegexMatchVecType` (`native-regex.ts:1690`) builds
   the `$__regexp_match_vec` struct with only `index` (field 2) and `input` (field 3).
   There is **no `groups` field**, so `__regex_capture_array` (`native-regex.ts:1738`)
   never populates a named-groups object.
2. **Property dispatch** — the match-result property reader in
   `regexp-standalone.ts` (the match-result-prop branch, ~line 2240) handles only
   `index` explicitly and treats **every other property name as `input`** (line 2246
   falls through). `m.groups` therefore reads the `input` string, not a groups object.
3. **`$<name>` substitution** — the `__regex_get_substitution` emitter (#1913,
   `native-regex.ts` ~3000-3060) handles `$&`, `` $` ``, `$'`, `$n` but treats `$<` as
   a literal because it has no name→capture-index mapping at substitution time.

The parser already produces everything needed: `parsePattern` returns
`{ root, numCaptures, groupNames }` (`regex/parse.ts:829`) where
`groupNames: Map<string, number>` maps each name to its 1-based capture index.
This map is available wherever `compilePattern` is called
(`regexp-standalone.ts:418`) — it just isn't threaded into the result-shape or
substitution emitters.

## Implementation Plan

### Approach — compile the groups object statically from `groupNames`

The named-group set is **statically known** at compile time (the pattern is a
literal / backend-created RegExp). So the `groups` object can be a **fixed-shape
struct** whose fields are the named-group capture slots, built per-exec from the
same `caps` array `__regex_capture_array` already consumes. No dynamic key
machinery is needed.

**File: `src/codegen/native-regex.ts`**

1. `ensureRegexMatchVecType` (line ~1690): add a 5th field
   `groups (ref null any)` (mutable false) to the `$__regexp_match_vec` struct.
   For a pattern with no named groups it stays `null` (spec: `groups` is
   `undefined` when there are no named captures — represent as a null ref that the
   standalone `undefined` reader already maps). Export a
   `MATCH_VEC_FIELD_GROUPS = 4` constant next to `MATCH_VEC_FIELD_INDEX/INPUT`.
2. `__regex_capture_array` builds the `[0]+captures` vec from `caps`. Add an
   **optional groups-builder parameter**: the call site that knows `groupNames`
   passes the name→index list. For each `(name, idx)` the helper reads
   `result[idx]` (already a native-string-or-null) and stores it into a
   groups object field. Two viable representations — **prefer (b)**:
   - (a) a per-pattern generated struct `$__regex_groups_<hash>` with one field
     per name; the property reader (`m.groups.yr`) does a `struct.get`.
   - (b) **reuse the existing open `$Object` / native-object literal path** the
     standalone backend already builds for object literals — emit a small object
     with the named string fields, so `m.groups.yr` flows through the existing
     standalone object property read. This avoids inventing a new dispatch and is
     the lower-risk lowering. Follow the object-literal construction in
     `object-ops.ts` / the standalone object literal path.
3. `__regex_get_substitution` (~line 3000-3060): thread the `groupNames` map in,
   and handle `$<name>` — look up `name → idx`, emit the same capture-slot read
   used for `$n` (read `result[idx]`, empty string if unmatched/out-of-range).
   Unknown `$<bad>` stays literal per Annex B when no named groups exist; throws/
   is literal per spec otherwise (match the host `String.prototype.replace`
   §22.1.3.x — confirm against the fetched spec text before coding).

**File: `src/codegen/regexp-standalone.ts`**

4. Match-result property reader (~line 2240): before the `input` fallthrough, add
   a `propName === "groups"` case that reads `MATCH_VEC_FIELD_GROUPS` (returns the
   object ref, or the standalone `undefined` for a null/no-named-groups pattern).
5. Thread `groupNames` from `compilePattern` (line 418) into the capture-array /
   match-vec construction calls (the exec, match, matchAll, and @@match cores all
   route through `__regex_capture_array`). Since `groupNames` is per-pattern and
   the pattern is static at these sites, pass it as a compile-time argument
   (NOT a runtime value).

### Edge cases
- Pattern with **no** named groups → `m.groups` is `undefined` (null ref); existing
  numbered-capture behaviour unchanged.
- **Unmatched** named group → its field is `undefined` (null native-string), matching
  the `caps` slot being `-1/-1`.
- **Duplicate named groups** (ES2025 `(?<n>a)|(?<n>b)`, `named-groups/duplicate-*`):
  the matched alternative's value wins; the parser's `groupNames` must map the name
  to whichever group participated. If duplicate-name support is not yet in the
  parser, **narrow-refuse duplicate-name patterns** (don't silently mis-populate) and
  leave them for a follow-up — note it in the issue.
- `matchAll` / `@@match` results: they reuse `__regex_capture_array`, so `.groups`
  on each iterated match comes for free once (2) lands.

### Representative failing test262 paths
- `test/built-ins/RegExp/named-groups/groups-object.js`
- `test/built-ins/RegExp/named-groups/unicode-property-names.js`
- `test/built-ins/RegExp/named-groups/string-replace-get.js` (`$<name>`)
- `test/built-ins/RegExp/named-groups/string-replace-unclosed.js`
- `test/built-ins/RegExp/prototype/Symbol.replace/named-groups.js`
- `test/built-ins/RegExp/named-groups/groups-properties.js`

### Estimated rows recovered
~40-50 (named-groups dir 28 + the named-group cases inside Symbol.replace /
String.replace / exec buckets). Duplicate-named-groups (ES2025) may need the
follow-up refusal carve-out.

### Test gate (standalone, empty importObject, no env/`__extern_*` leak)
- `/(?<yr>\d{4})/.exec("2026").groups.yr === "2026"`
- `"2026-06".replace(/(?<y>\d{4})-(?<m>\d{2})/, "$<m>/$<y>") === "06/2026"`
- pattern with no named groups: `m.groups === undefined`
- unmatched named group via alternation → field `undefined`

## Implementation Notes (completed 2026-06-22)

Landed in one branch with #2589 (shared files: `native-regex.ts` +
`regexp-standalone.ts`).

**What landed:**
- `$__regexp_match_vec` extended with `groups` (externref `$Object`) and
  `indices` (externref `$ObjVec`) fields (#2588 + #2589). Field order:
  `length, data, index, input, groups, indices`. Both `null` (≙ `undefined`)
  when absent.
- `CompiledRegex.groupNames` (name→1-based-index) now threaded from
  `compileParsed` (was discarded). Both the result-shape builder and the
  `$<name>` substitution read it.
- `m.groups` object is materialised INLINE per-exec via `__new_plain_object` +
  `__extern_set` (the object-literal path) — native in standalone, no host
  import. Reader added in `tryCompileStandaloneRegExpMatchResultRead`.
- **`$<name>` replacement substitution — FULLY WORKING.** A names table
  `[count, (idx,len,ch...)*]` is threaded into `__regex_replace` →
  `__regex_get_substitution`, which resolves `$<name>` against it. Verified:
  `"2026-06".replace(/(?<y>\d{4})-(?<m>\d{2})/, "$<m>/$<y>") === "06/2026"`,
  unknown `$<bad>` → empty, `$<` literal when no named groups (Annex B),
  no-closing-`>` literal, no regression to `$&`/`$1`.

**Substrate-blocked (follow-up, NOT a regex bug):** `m.groups.<name>` returns
`undefined` because the generic standalone any-typed open-object reader drops
native-string VALUES (numeric values read back fine; key presence + `m.groups`
object identity are correct). This is the in-flight value-rep substrate
(#2580 / `project_standalone_any_string_value_read_substrate`). The groups
object built here is forward-compatible: `m.groups.yr` starts returning the
string the moment #2580 M2 lands — no further regex change needed.

**Critical cross-cutting fix:** `isVecStructAccess` in `property-access.ts`
required the match-vec to have EXACTLY 4 fields; the new 6-field shape broke
`m[0]` element reads (routed to `env::__extern_get`). Relaxed to `>= 4` with the
`index`/`input` name guard. Per-matchAll-element `.groups`/`.indices` pass null
(follow-up — the eager `__regex_match_all` walk doesn't thread the parser map
yet).

Tests: `tests/issue-2588-2589-regex-groups-indices.test.ts` (13 passing).
Regex suite at exact baseline parity (8 pre-existing refusal-drift failures,
0 new regressions).
