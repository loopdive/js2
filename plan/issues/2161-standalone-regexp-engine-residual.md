---
id: 2161
title: "Standalone RegExp engine conformance residual (~579 tests)"
status: blocked
assignee: ttraenkler/fable-2161
sprint: Backlog
created: 2026-06-15
updated: 2026-07-26
blocked_on: [2175]
reconcile_note: "RECONCILED 2026-06-23 — all 4 sliced sub-issues merged (#2588/#2589 PR#1914, #2590 #1908, #2591 #1907). 2026-06-25 (sdev-async-sm): Slice 9 landed one MORE bounded substrate-independent win the prior reconcile missed — const-foldable new RegExp() patterns (concat / const-bound literal / §22.2.3.1 regex-literal copy-ctor) now compile to the native engine instead of runtime-trapping (see Slice 9). Remaining residual = RegExp.prototype reflection (gated on #2175) + dynamic/any-typed receivers + truly-runtime ctor patterns (need a runtime regex compiler — future architect-spec, NOT bounded). Umbrella stays blocked on #2175 for the reflection bucket."
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

| count | bucket                                                                                                                  | nature                                                                                                                                                                                                                                                                                                                                                                               |
| ----: | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|   126 | `RegExp.prototype.<prop>` built-in value read (#1907/#1888 S6-b)                                                        | **reflection** — `RegExp.prototype.test`/`.flags`/getter _descriptor_ reads. Verified: **instance** `re.flags`/`re.source`/`re.global`/`re.ignoreCase`/`re.multiline` ALREADY compile + run in standalone — only the `RegExp.prototype`-as-receiver reflection form refuses (`property-access.ts:1975`, `ensureStandaloneBuiltinStaticMethodClosure` has no RegExp.prototype pairs). |
|  ~128 | `@@match`/`@@replace`/`@@split`/`@@matchAll` symbol-protocol calls (literal-substring backend refuses; `string-ops.ts`) | **native built-in prototype-method closures** — `re[Symbol.match](s)` etc. The String.prototype.matchAll _call_ form is DONE (#1504); this is the explicit `re[Symbol.X]()` protocol form.                                                                                                                                                                                           |
|   ~64 | dynamic constructor patterns/flags (RegExp Phase 2a)                                                                    | regex-engine feature work                                                                                                                                                                                                                                                                                                                                                            |
|    33 | `\q{…}` string disjunction (Phase 2a)                                                                                   | unsupported regex feature (v-flag)                                                                                                                                                                                                                                                                                                                                                   |
|    30 | `__get_builtin` dynamic-shape (Phase B)                                                                                 | not RegExp-specific; dynamic-object reflection                                                                                                                                                                                                                                                                                                                                       |
|    33 | `\\`-class / literal-substring backend gaps                                                                             | regex-engine feature work                                                                                                                                                                                                                                                                                                                                                            |
|    10 | `Cannot convert object to primitive value` (runtime)                                                                    | a `_toPrimitiveSync`/key-coercion gap on a RegExp receiver                                                                                                                                                                                                                                                                                                                           |

**Conclusion (honest scope call):** there is **no clean bounded point-fix** left
in #2161. The matchAll concrete leak (the one named in the original triage) is
already shipped via #1504. Each remaining bucket is a sub-project:

1. **RegExp.prototype reflection (126)** — add native built-in _method/getter
   closures_ for the RegExp.prototype pairs to
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

- (b) together recover ~250 standalone tests.

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
test.call(re, s)`), 57 Symbol.\* protocol members, 31 this-val brand-check, 26
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

## Sub-bucket (b), first slice — LANDED (2026-06-17, sdev-regex3)

Re-validated against upstream/main (`fe0e21ba1`). Probed every RegExp form in
standalone: only the explicit well-known-symbol protocol forms still refused
(`re[Symbol.match/matchAll/search/replace/split](str)` at
`calls.ts:~10414`). `RegExp.prototype.test.call(...)` and `String.prototype.*`
native paths already work, so the prior (a)/(b) split holds: this PR is the
first slice of (b).

**Shipped — the READ protocol forms** `re[Symbol.match](s)`,
`re[Symbol.matchAll](s)`, `re[Symbol.search](s)` for static / backend-created
RegExp receivers route to the native engine, **zero host imports**:

- `src/codegen/regexp-standalone.ts`: extracted operand-explicit cores
  `emitStandaloneRegExpSearchCore` / `…MatchCore` / `…MatchAllCore` out of the
  `tryCompileStandaloneStringSearch/Match/MatchAll` functions (which now
  delegate), then added `tryCompileStandaloneRegExpSymbolCall` that calls those
  same cores with **swapped operands** (regex = receiver, subject = argument).
  The native lower-level emitters were already operand-order agnostic, so there
  is no second engine path. Also taught `isStandaloneMatchResultCall` to
  recognise the `re[Symbol.match](s)` shape so a `let m = …` local gets the
  precise `$__regexp_match_vec` ref type (else `m[1]` routes through
  `__extern_get_idx` and leaks `env::__extern_get` — the bug the runtime probe
  caught).
- `src/codegen/index.ts`: mirrored that recognition in
  `inferStandaloneRegExpMatchArrayType` + `isStaticRegExpMatchArrayCallForImportScan`
  (the let/const local-type + import-scan inferers).
- `src/codegen/expressions/calls.ts`: at the standalone `@@`-refusal site, try
  `tryCompileStandaloneRegExpSymbolCall` first; fall through to the existing
  refusal (and JS-host `__regex_symbol_call` in host mode) when it returns
  `undefined`.
- Tests: `tests/issue-2161-regex-symbol-protocol.test.ts` (8 cases, all
  standalone + empty importObject). 257 existing regex tests still green
  (refactor is behaviour-preserving).

**Deferred (still narrowed-refuse, NOT silently wrong):** `@@replace` / `@@split`
(carry extra replacement / limit operands — their cores still need the
operand-explicit extraction; next slice), dynamic-flag / `any`-typed receivers
(fall through to host `__regex_symbol_call`), string-coercion arguments. The
`RegExp.prototype` reflection bucket (a) remains gated on #2158's prototype-object
representation. #2161 stays open for those.

## Sub-bucket (b), second slice — LANDED (2026-06-18, sdev-regex3)

Re-validated against upstream/main (`4b0072923`). The prior slice wired the
READ protocol forms (`@@match`/`@@matchAll`/`@@search`). This slice closes the
deferred `@@replace`/`@@split` half of bucket (b).

**Shipped — the WRITE/SPLIT protocol forms** `re[Symbol.replace](str, repl)`
and `re[Symbol.split](str[, limit])` for static / backend-created RegExp
receivers route to the native engine, **zero host imports**:

- `src/codegen/regexp-standalone.ts`: extracted operand-explicit cores
  `emitStandaloneRegExpReplaceCore` / `emitStandaloneRegExpSplitCore` out of
  `tryCompileStandaloneStringReplace` / `tryCompileStandaloneStringSplit` (which
  now delegate, unchanged behaviour). The cores take explicit `subjExpr` /
  `reExpr` / (`replExpr` | `limitExpr`) plus a `diag` label for refusal
  messages — mirroring how match/matchAll/search were factored last slice.
  Then `tryCompileStandaloneRegExpSymbolCall` adds `@@replace`/`@@split` cases
  that call those same cores with **swapped operands** (regex = receiver,
  subject = arg[0], replacement/limit = arg[1]). No second engine path.
  - `@@replace` honors the receiver's own `g` flag for global-vs-first-only
    (there is no `replaceAll` distinction in the @@ form); `$n`/`$&`/`$'`
    substitution patterns expand at runtime via the existing
    `__regex_get_substitution` path (#1913). A function replacer stays a
    narrowed refusal (needs closure dispatch with capture marshalling).
  - `@@split` honors an optional numeric `limit` (arg[1]); the existing
    `__regex_split` ToUint32 lowering is reused unchanged.
- `src/codegen/expressions/calls.ts`: unchanged — the standalone `@@`-refusal
  site already tries `tryCompileStandaloneRegExpSymbolCall` first (added last
  slice) and falls through to the refusal for forms it returns `undefined` for.
- No `index.ts` change: `@@replace` returns a `$NativeString` and `@@split`
  returns the same native-string vec as `String.prototype.split` — neither
  produces a match-array result that needs the let/const local-type inference
  the `@@match` form required.
- Tests: 6 new cases in `tests/issue-2161-regex-symbol-protocol.test.ts`
  (replace first/global/`$&`-substitution; split count/content/limit), all
  standalone with an empty importObject asserting no `__regex_symbol_call` /
  `__extern_get` leak. 14 file cases green; #1539 replace/split + #1913
  substitution regression suites (43 cases) still green (refactor is
  behaviour-preserving); host-mode #1328/#1329/#1330/#1830 symbol-protocol
  (15 cases) unaffected.

**Bucket (b) is now fully landed** for static / backend-created receivers
(all five @@ forms: match/matchAll/search/replace/split). **Remaining #2161
work:** (a) `RegExp.prototype` reflection — still gated on #2158's standalone
prototype-object representation; (c) dynamic / `any`-typed receivers — need the
runtime-externref regex receiver generalisation (every @@ form falls through to
host `__regex_symbol_call` today); and the regex-engine feature tail (v-flag
`\q{}`, dynamic ctor patterns). #2161 stays open for those.

## Slice 7 (2026-06-18, cs-2164) — standalone `RegExp.prototype.toString()`

**Landed.** A standalone-shard re-probe (against `955552ecc`) found `re.toString()`
leaked `env::Object_toString` — an unsatisfiable host import in `--target
standalone` — even though both `re.source` and `re.flags` already resolve
natively (#1914). It fell through the RegExp method dispatch to the generic
object `toString` path.

**Fix** (`regexp-standalone.ts` + `expressions/calls.ts`): new
`tryCompileStandaloneRegExpToString` lowers `re.toString()` (§22.2.6.14) to
`"/" ++ re.source ++ "/" ++ re.flags` — the struct's spec-escaped `source` field
read (§22.2.6.13.1, already stored escaped) and the `__regex_flags_str(flags)`
flag-string, composed with `__str_concat` via the shared `nativeStringRepr`
concat primitive. Returns a native string, **zero host imports**. Gated on
`ctx.standalone` + a static / backend-created RegExp receiver (a dynamic
externref receiver falls through to the host/refusal path unchanged); host mode
is untouched (`re.toString()` still run=6 there). Wired at the RegExp method
dispatch in `calls.ts`, right after `tryCompileStandaloneRegExpTest`.

**Validation.** New `tests/issue-2161-regex-tostring.test.ts` (7): `/source/flags`
for flagged + flagless literals, the empty-pattern `/(?:)/` form, escaped-slash
source, a const-bound receiver, the canonical `dgimsy` flag order, and exact
host-JS parity across four pattern/flag pairs — all standalone with an empty
importObject asserting no `Object_toString` / `__extern_*` leak. The 35
#2161/#2161-matchall/#1474 + 201 #2175/#1914/#1539 regex cases stay green
(behaviour-preserving). tsc + prettier + biome(error) + stack-balance +
coercion-sites + any-box gates clean.

**Deferred (separate code paths, NOT this method dispatch):** `String(re)` (still
null-derefs — the `String()` builtin lowering) and `` `${re}` `` (template-literal
coercion returns a wrong-length string) both route through value→string
coercion, not `re.toString()`, and need RegExp-aware coercion in those lowerings
— a distinct slice. The (a) reflection and (c) dynamic-receiver buckets remain
as noted above. **#2161 stays open.**

## Slice 8 (2026-06-19, sd1) — standalone `String(re)` + template `` `${re}` `` coercion

**Landed.** Closes the slice-7 deferral: the value→string COERCION paths now
route through the native RegExp.prototype.toString rendering, matching the
already-working `re.toString()` method form. Confirmed against `2af57ffc0`:

| form                 | before                           | after       |
| -------------------- | -------------------------------- | ----------- |
| `String(/abc/gi)`    | runtime null-deref (null string) | `/abc/gi`   |
| `` `x${/abc/gi}y` `` | `x[object Object]y`              | `x/abc/giy` |
| `re.toString()`      | `/abc/gi` (slice 7)              | unchanged   |

**Fix** — extracted a shared operand-explicit core from the slice-7 method
helper, then wired it into the two coercion sites:

- `src/codegen/regexp-standalone.ts`: factored
  `emitStandaloneRegExpToStringFromExpr(ctx, fctx, regexpExpr)` out of
  `tryCompileStandaloneRegExpToString` (§22.2.6.14 → `"/" + source + "/" +
flags` via `__regex_flags_str` + `__str_concat`). The method helper now
  delegates to it; behaviour byte-identical for the `re.toString()` path. Gated
  on `ctx.standalone` + a static / backend-created RegExp receiver (dynamic
  externref receivers fall through unchanged).
- `src/codegen/expressions/calls.ts`: in the `String(...)` builtin lowering,
  try the core BEFORE `compileExpression` (so the RegExp receiver is compiled
  by the core, not the generic ref→string `coerceType` that null-deref'd the
  `$NativeRegExp` struct). Additive — falls through for non-RegExp args, mirrors
  the adjacent `tryEmitArrayToStringNative` (#2160) String(arr) hook.
- `src/codegen/string-ops.ts`: in `compileNativeTemplateExpression`, a static /
  backend-created RegExp span routes through the core (BEFORE `compileExpression`)
  instead of falling to the `$__any_to_string` `"[object Object]"` path, then
  applies the shared concat-tail (head/literal). Guarded on
  `standaloneNativeStrings` (= `noJsHost`), so host + fast-mode-with-host are
  untouched.

**Validation.** New `tests/issue-2161-regex-string-coercion.test.ts` (13):
`String(re)` flagged/flagless/empty-pattern/escaped-slash/const-bound/canonical
dgimsy + 4-pair host-JS parity; `` `${re}` `` head/flagless/leading-no-head/
two-spans/const-bound + 3-pair host-JS parity — all standalone with an empty
importObject asserting no `Object_toString` / `__extern_*` / `js-string` leak.
The 28 #2161 (tostring/symbol-protocol/matchall) + 700 regex regression cases
(#1539/#1913/#1914/#1911/#1912/#1474/#2175/#1328/#1329/#1330/#1830/regexp/
regex-bytecode/#682) stay green (refactor is behaviour-preserving). tsc +
prettier + biome(lint) + stack-balance + coercion-sites + any-box gates clean.

**Still open under #2161:** (a) `RegExp.prototype` reflection — gated on #2158's
standalone prototype-object representation; (c) dynamic / `any`-typed receivers
(both coercion forms fall through to host for those); and the regex-engine
feature tail (v-flag `\q{}`, dynamic ctor patterns). **#2161 stays open.**

## Triage re-probe (2026-06-21, dev-carla) — common patterns verified on upstream/main

Probed against current upstream/main (`--target standalone`, empty/`wasm:js-string`
imports, no env leak): `re.test`, `re.exec` with capture groups, `String.replace`
global, `String.match` global, `String.split` with a regex, `re.flags`, and
sticky (`/y/` + `lastIndex`) **all PASS host-import-free**. So the high-frequency
RegExp surface is already correct standalone — **no quick dev win remains here**;
the open residual is the documented feature/representation tail above (v-flag
`\q{}`, dynamic ctor patterns, `any`-typed receivers). Not claimed.

## Umbrella sub-issue slicing (2026-06-22, architect)

Re-bucketed the **full standalone-vs-host gap** (host baseline `2026-06-20`,
standalone baseline `2026-06-19`, both from `loopdive/js2wasm-baselines`):
**747 RegExp tests pass host / fail standalone** (478 `compile_error` + 269
`fail`). Re-probed every distinctive feature against **current upstream/main**
(`--target standalone`, empty importObject) to find the **concrete, bounded,
substrate-independent** wins. Sliced into 4 dispatch-ready dev issues:

| #         | slice                                                          | root cause (verified on main)                                                                                                                                                                                                                      | est. rows | feasibility |
| --------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------: | ----------- |
| **#2588** | named-groups result object `m.groups` + `$<name>` substitution | match-vec struct has no `groups` field; reader maps any non-`index` prop to `input`; `$<` is a literal stub. Numbered captures + `\k<name>` already work; only the result-object exposure + `$<name>` are missing.                                 |    ~40-50 | medium      |
| **#2589** | `d`-flag match `.indices` array                                | match-vec struct has no `indices` field; `m.indices` read leaks `env::__extern_get`. The `caps` i32 array already holds every start/end pair — just unmaterialised.                                                                                |    ~15-22 | medium      |
| **#2590** | `RegExp.escape(str)` static method (ES2025)                    | entirely unimplemented; leaks `env::__get_builtin` and fails to instantiate. Pure native string transform, no engine.                                                                                                                              |    ~20-29 | medium      |
| **#2591** | `v`-flag `\q{…}` string disjunction                            | set ops `&&`/`--` already work; `\q{}` **traps at runtime** ("illegal cast") — the unicode.ts refusal guard is bypassed for some forms, lowering a malformed multi-char-in-class node. Implement (desugar to alternation) or complete the refusal. |    ~25-39 | medium      |

**Sub-total ≈ 100-140 standalone rows** across the 4 slices. Each has ONE
concrete root cause, is independently implementable (~1-2 days), and is pure
regex-engine / result-shape work — **no value-rep / substrate dependency**.

### Residual NOT covered by the 4 slices (left under #2161)

- **`RegExp.prototype` reflection (~126)** — gated on **#2158**'s standalone
  builtin-prototype-object representation (every `RegExp.prototype.test`/`.flags`/
  descriptor form chains off the `RegExp.prototype` OBJECT read that has no native
  handler). NOT a bounded point-fix; do not slice here. Documented above
  (2026-06-16 sdev5 + refinement).
- **Dynamic / `any`-typed receivers (bucket c, ~50+)** — `function f(re: RegExp)`
  / `re.test` on an externref receiver returns wrong results because the native
  engine takes a statically-typed `$NativeRegExp`. Needs the runtime-externref
  regex-receiver generalisation (`emitRegexExecArrayCall`). A larger architectural
  slice; not in this batch.
- **Dynamic constructor patterns/flags** (`new RegExp("a"+"b","g")` runtime-traps
  "illegal cast"; ~64) — engine feature + dynamic-pattern lowering.
- **`String.prototype.split`/`replace`/`search` `.call()` + ToString-coercion +
  symbol-protocol dynamic forms** — overlaps the bucket-c dynamic-receiver work.
- The static `@@match/@@matchAll/@@search/@@replace/@@split` protocol forms and
  `matchAll`, `toString`, `String(re)`/`` `${re}` `` coercion are **already
  landed** (slices above); not re-sliced.

**#2161 stays open** as the umbrella tracker for the reflection (#2158-gated) and
dynamic-receiver residuals once #2588-#2591 land.

## Slice 9 (2026-06-25, sdev-async-sm) — const-foldable `new RegExp(...)` patterns

**Landed.** Regrounded against current main (HEAD `7f66cc33e`, after #2588-#2591 +
#2637 all merged): probed every residual RegExp bucket in `--target standalone`
(empty importObject). The 4 architect slices are done; the dominant remaining
buckets are #2175-gated reflection and the dynamic/`any`-typed receiver
architecture — neither bounded. The **one genuinely bounded, substrate-independent
win left** was the dynamic-constructor-pattern bucket, _narrowed to its
compile-time-constant subset_.

**Root cause (pinned):** `compileStandaloneRegExpConstructor`
(`regexp-standalone.ts`) recovered the pattern via the narrow `staticStringValue`,
which only accepts a bare string literal. Patterns that ARE compile-time-constant
and CAN be compiled to native bytecode were rejected → lowered to a placeholder
that **runtime-traps** (the documented "dynamic ctor patterns illegal-cast"):

- `new RegExp("a" + "b")` — string-literal concatenation,
- `const p = "ab"; new RegExp(p)` — `const`-bound literal,
- `new RegExp(/ab/g)` / `new RegExp(/ab/, "i")` — §22.2.3.1 copy-constructor.

**Fix** (`regexp-standalone.ts`, +112 LoC, zero new host imports, zero substrate
dep): new `staticConstStringValue` (recursively folds string literals, `const`-
bound identifiers, and `a + b` concatenation; refuses template substitutions,
numeric coercions, `let`/`var`/reassigned bindings) + `staticRegExpLiteralCopy`
(the §22.2.3.1 copy form: flags arg OVERRIDES the literal's flags, omitted/
`undefined` INHERITS them). Both `compileStandaloneRegExpConstructor` and
`staticRegExpPatternFlags` (the receiver-recovery helper used by downstream
`re.test`/`re.exec`/etc.) now route these const-foldable forms to the existing
native `compileStandaloneRegExpPattern`. A genuinely-dynamic pattern (function
param, `let`, reassigned) still resolves to `null` and keeps the prior dynamic
behaviour — behaviour-preserving for every existing static form.

**Validation.** New `tests/issue-2161-regex-const-ctor.test.ts` (9 cases: concat,
const-bound, chained const+concat, copy-ctor inherit/override flags, downstream
`re.test`, two no-regression controls, and a guard that a dynamic param is NOT
mis-folded). All standalone, empty importObject, zero host-import leak. The
pre-existing standalone-regex suites are unchanged by this slice (the handful of
already-red "expects refusal" cases in `issue-1474`/`issue-1539` predate this
slice — earlier slices (#1912) turned those static-invalid refusals into a
runtime `throw`; not in this slice's scope and not in the CI equivalence gate).

**Future architect-spec items (NOT this window — bounded budget call):**

- **Dynamic / `any`-typed regex receivers** (`function f(re: RegExp){re.test(s)}`
  returns wrong / `re.exec` → "Cannot convert object to primitive value"; truly-
  runtime `new RegExp(runtimeString)` runtime-traps): needs a **runtime regex
  compiler in wasm** (parse + compile-to-bytecode at runtime) and/or the
  runtime-externref regex-receiver generalisation of `emitRegexExecArrayCall`.
  Larger architectural slice — file as its own architect-spec issue.
- **`RegExp.prototype` reflection (~126)** — still gated on **#2175** (in-progress;
  standalone builtin-prototype-object representation). Both are the next-sprint
  pickups for the #2161 umbrella.

## Slice 10 (2026-07-04, fable-2161) — FRESH HARVEST + undefined-sentinel families (B0/B2/B4)

**Fresh harvest, current main (post-#2630, standalone baseline 2026-07-04 12:10).**
The stale "~579" framing recomputed: **510 RegExp-attributed host-pass/standalone-fail
rows** (476 runtime `fail` + 34 `compile_error`), bucketed by error signature
(`.tmp` harvest scripts; family map below). Root-caused the four biggest runtime
families on current main; three had bounded fixes which THIS slice lands.

### Family map (510 rows, by root cause)

| family                                                                                                                                                                                                  |                                                                                                                                                                      rows | root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | verdict                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **B0 — null native-string ≠ undefined sentinel**                                                                                                                                                        |                                                                      ~76 in-bucket ("deref null in test()" 73 + compareArray 3; **109 across ALL standalone categories**) | THREE sinks mishandled the null-string = `undefined` sentinel (non-strict checker ERASES `undefined` from `["a",undefined]` unions; unmatched capture groups are null slots): (a) `coerceType` `ref_null→ref` emitted a trapping `ref.as_non_null` for native-string targets (type-coercion.ts ~1468); (b) the mixed `any === string` #1914 eq-arm and the tag-cascade eqref identity arm returned 0 for null/null (`ref.test` is false for null); (c) `$__regexp_match_vec` → `any[]` param fell into struct-NARROWING (`getVecInfo` only matches `__vec_*` names), ref-casting the `__arr_ref_<anyStr>` data array to `$__arr_externref` → null → trap; (d) `s === undefined` on a `string`-typed local constant-folded to false (#1105 gate was `ref_null`-only).                                                                                                                                                                                                                                                                                                | **FIXED this slice**                                                                                                                           |
| **B2 — split undefined separator/limit**                                                                                                                                                                |                                                                                                                                                    ~15-25 of the split 72 | §22.1.3.23: `s.split()` / `s.split(undefined)` fell past the string-like-separator gate to the host marshal path (no standalone `string_split`) → null deref; a statically-`undefined` LIMIT compiled to f64 NaN → ToUint32(NaN)=0 → `[]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **FIXED this slice**                                                                                                                           |
| **B4 — never-reassigned `var` pattern fold**                                                                                                                                                            |                                                                                                                                           ~15-20 of the 37 "illegal cast" | Slice 9's fold was `const`-only; sputnik binds patterns/flags with `var` (`var __re="d+"; RegExp(__re,"i")`), uses `void 0` / hoisted-uninitialised flags, `new RegExp(ctorCopy, "g")`, and diamond concat chains (the `seen` cycle-guard blocked same-binding re-references).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **FIXED this slice**                                                                                                                           |
| B1 — boxed `new String(x)` receiver OR argument                                                                                                                                                         | ~40 (`__str_flatten` deref: every `instance-is-string-hello` split/search/match/replace test + `re.exec(new String(...))` — verified the ARG position hits the same site) | `new String()` builds a `$Object` wrapper (`__new_String`, object-runtime.ts:~1390, primitive under `WRAPPER_PRIMITIVE_KEY`); any externref→AnyString coercion (`coerceType`'s externref→ref arm, type-coercion.ts ~1743: `ref.test $AnyString` → else `ref.null`) drops the wrapper to null → flatten trap. **Exact contract:** for a NATIVE-STRING target, extend that else-arm with the wrapper-slot probe `__to_primitive` already implements INLINE (object-runtime.ts ~2544: `ref.cast $Object` → `__obj_find(WRAPPER_PRIMITIVE_KEY)` → FLAG_INTERNAL check → value): `ref.test $Object` → read the internal slot → `ref.test $AnyString` → cast, else null. Do NOT call full `__to_primitive` (it would pull OrdinaryToPrimitive semantics — valueOf/toString dispatch — into every string coercion); extract just the slot read, gated on the object runtime already being in the module (`ctx.funcMap.has("__obj_find")` — `new String` registration guarantees it). Watch late-registration ordering (funcIdx shifts — flushLateImportShifts discipline). | Opus point-fix (bounded, shared-coercion blast radius — needs the full string-suite battery this slice's `.tmp/battery-final` set established) |
| B5 — annexB identity-escape fallbacks                                                                                                                                                                   |                                                                                                                                                                     ~6-10 | `/\x/`, `/\u/` (incomplete hex/unicode), `/\c1/`-class escapes: the pattern compiler refuses → placeholder trap. AnnexB says incomplete escapes fall through to IdentityEscape. **Exact contract:** in the bytecode pattern parser's escape handling, on failed `\x`/`\u` hex parse emit the literal char (annexB §B.1.4 ExtendedAtom); `\c` + non-letter → literal `\c`. Blocks `separator-regexp.js` (needs split-at-end-anchor fix too: our `__regex_split` matches at q==size — `"x".split(/$/)` → 2 elems, JS spec loops q<size → 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Opus point-fix (engine parser)                                                                                                                 |
| F6 — reflection (`.name`/`.length`/prop-desc/`hasOwnProperty` on builtin methods, `RegExpStringIteratorPrototype`, legacy accessors `RegExp.$1`, cross-realm)                                           |                                                                                     ~80+ (48 "Cannot access property" + hasOwnProperty clusters + 15 CE legacy-accessors) | Builtin-prototype-object representation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | dying via **#2175** (in-flight) — do NOT slice                                                                                                 |
| F7 — dynamic receivers / RegExpExec protocol observables (lastIndex-err tests, custom `exec`, `split.call(numberReceiver)`, ToPrimitive ctor args, `new RegExp(arr[i])`, 200-paren loop-built patterns) |                                                                                                                                                ~120+ (38+8+5+4… clusters) | Needs the runtime regex compiler + runtime-externref receiver generalisation (documented Slice 9 "future architect-spec").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | architect-spec (NOT bounded)                                                                                                                   |
| F8 — eval-based literal tests                                                                                                                                                                           |                                                                                                                                                                        11 | `eval` unsupported by design.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | wont-fix scope                                                                                                                                 |
| misc engine tail                                                                                                                                                                                        |                                                                                                                                                                       ~30 | duplicate named groups (ES2025), regexp-modifiers, `\q{}` residue, step-limit (2), quantifier-integer-limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | separate small engine issues                                                                                                                   |

### Shipped (this slice, all standalone, zero new host imports)

- **B0a** `src/codegen/type-coercion.ts`: `ref_null→ref` same/different-idx coercion
  SKIPS the trailing `ref.as_non_null` when the target is a native-string type —
  null is the in-band `undefined` sentinel and every string sink (params/locals/
  fields) is physically nullable, so the null flows exactly like a
  `string | undefined` local already did. Non-string ref targets keep the assert.
- **B0b** `src/codegen/type-coercion.ts`: `getVecShapedInfo` + a vec-shaped→vec
  arm in `emitSafeStructConversion` — `$__regexp_match_vec` (length/data prefix +
  result fields) now ELEMENT-COPIES into `any[]`/vec params via `emitVecToVecBody`
  instead of falling into the trapping struct-narrow data-array cast. Declared-
  subtype pairs (match-vec → its own base vec) still short-circuit (identity).
- **B0c** `src/codegen/binary-ops.ts`: the #1914 mixed `any === string` arm and
  the #1776 tag-cascade eqref identity arm both get a both-`ref.is_null` else
  (null/null ⇒ equal — `undefined === undefined` through the compareArray /
  assert_sameValue_str harness shapes); the #1105 `x === undefined` nullable-
  string gate widened to non-null-claimed `ref` string locals (runtime
  `ref.is_null` instead of constant-false).
- **B2** `src/codegen/string-ops.ts` + `regexp-standalone.ts`: undefined-separator
  split arm (returns `[S]` / `[]` per limit), statically-`undefined` limit →
  unbounded (-1) in both the string-split and regex-split lowerings;
  `isStaticallyUndefinedExpr` (side-effect-free `undefined`/`void 0` only).
- **B4** `src/codegen/regexp-standalone.ts`: `staticConstStringValue` accepts
  never-reassigned `var`/`let` bindings (single declaration + `bindingHasWrites`
  scan — same proof as `isTrustedBackendCreatedRegExpBinding`), never-written
  UNINITIALISED vars fold to `undefined`, `void 0` folds, the `seen` cycle-guard
  unwinds after recursion (diamond `a + "x" + a` folds — REX XML chains);
  `staticRegExpLiteralCopy` follows never-reassigned bindings to regex-literal
  AND ctor-copy sources (`new RegExp(regObj, "g")`), with a depth guard against
  self-referential bindings.
- Tests: `tests/issue-2161-undefined-sentinel-families.test.ts` (16 cases:
  6 B0 + 4 B2 + 6 B4, incl. controls for one-null-one-value inequality, numeric
  limits, and the reassigned-var no-fold guard).

**Validation.** Probes on real test262 files flipped fail→pass: S15.10.2.8_A3_T2/
T15-class exec-vs-expected suites, lookBehind/misc.js, S15.10.3.1_A3_T1,
S15.10.4.1_A1_T1-T4, 15.10.4.1-1.js, S15.10.2.8_A1_T4/A3_T19/T25/T26/T27, split
undefined-separator forms. Regression battery (798 regex tests across 16 suites +
equality/nullable-string/vec suites): every failure is PRE-EXISTING on clean main
(verified by running the identical set on `/workspace` @ cf2fb1c40 — 10 regex +
3 equality + 5 refusal-suite reds, byte-identical sets). tsc, stack-balance,
coercion-sites, any-box-sites, prettier all clean.

**#2161 stays open (blocked on #2175)** for F6 reflection; F7 dynamic-receiver
architecture and B1/B5 point-fix contracts above are the next pickups.

## Slice 12 (2026-07-04, opus-2161b1) — family B5: Annex B identity escapes + split-at-end-anchor — LANDED

**Landed** the banked B5 contract (slice-10 family map, row B5). Two bounded
regex-engine root causes, both runtime traps on current main:

1. **Annex B §B.1.4 identity escapes** — `/\x/`, `/\u/` (incomplete hex) and
   `/\c1/` trapped "illegal cast": the bytecode pattern parser
   (`src/codegen/regex/parse.ts` `parseEscapedCodeUnit`) refused them
   (`RegexUnsupportedError` → placeholder trap) instead of falling through to
   IdentityEscape. In **non-unicode** mode an incomplete `\x`/`\u` is now the
   literal `x`/`u` (read-without-consume so trailing chars re-parse: `/\xGG/`
   matches `xGG`), and a `\c` not forming a control escape is a literal reverse
   solidus with the following char re-parsed (`/\c1/` matches `\`,`c`,`1`).
   Inside a character class, Annex B ClassControlLetter additionally admits
   DecimalDigit and `_` (`/[\c1]/` → U+0011, `/[\c_]/` → U+001F) via a new
   `inClass` parameter. u/v mode stays strict (a bad escape there is a real
   SyntaxError — still refused).

2. **`split` at an end-of-string anchor** — `"x".split(/$/)` returned `["x",""]`
   instead of `["x"]`. §22.2.5.2's SplitMatch loop only tests positions
   `q < size`, so a zero-width separator match STARTING at the end is never seen;
   the native `__regex_split` (`src/codegen/native-regex.ts`) used a forward
   `search` that could land such a match at `mstart == slen`. Added a
   `mstart >= slen → break` guard right after the match bounds are read. A
   non-end match starts at `mstart < slen`, so ordinary/multiline/empty-pattern
   splits are unaffected (`"a\nb".split(/$/m)` still → `["a","\nb"]`).

**Validation.** New `tests/issue-2161-b5-annexb-escapes.test.ts` (12 cases, all
standalone + empty importObject, zero host-import leak): incomplete `\x`/`\u`
identity + valid-hex controls, `\xGG` trailing re-parse, `\c1` atom vs
`[\c1]`/`[\c_]` class ControlLetter, `\cA` control escape, `[\x]` in-class; the
real test262 `built-ins/String/prototype/split/separator-regexp.js` shapes
(`/$/`, `/^/`, plus ordinary/empty-pattern/lookahead no-regression splits). All
13 assertions of `separator-regexp.js` verified byte-for-content against host JS.
Blast-radius battery (11 regex suites: #1539/#1911/#1912/#1913/#1914/#1474/#2671/
#2588/#2591/#2091 — 465 pass) shows every failure PRE-EXISTING on clean main
(the same 6 #1474/#1539 "expects-refusal" reds); **zero** new failures.
Byte-inert for non-regex programs (numeric/array/string/object sha256-identical
vs clean main). tsc clean.

**#2161 stays open (blocked on #2175)** for F6 reflection; F7 dynamic-receiver
architecture remains the next (unbounded) pickup.

## Slice 11 (2026-07-04, opus-2161b1) — family B1: boxed `new String` receiver/argument — LANDED

**Landed** the banked B1 contract (slice-10 family map, row B1). Regrounded on
current main: every `new String(...)` receiver/argument in a standalone
RegExp/String-method context trapped **"dereferencing a null pointer"** — split /
search / match / replace / matchAll on a boxed-String receiver, and
`re.exec(new String(s))` / `re.test(new String(s))` in the argument position.

**Root cause (verified).** `new String(x)` builds a `$Object` wrapper
(`__new_String`, object-runtime.ts) carrying its [[StringData]] under the
reserved FLAG_INTERNAL `WRAPPER_PRIMITIVE_KEY` slot. When that wrapper reached
the externref → native-`$AnyString` coercion else-arm in `coerceType`
(type-coercion.ts — the string-method subject / string-argument path both target
`nativeStringType` = `ref $AnyString`), the generic `ref.test $AnyString` missed
it (a wrapper is an object, not a string) and the value was dropped to
`ref.null` → the downstream `__str_flatten` trapped on null.

**Fix** (zero new host imports, standalone-only, byte-inert for non-boxing
programs):

- `src/codegen/object-runtime.ts`: new lazily-registered
  `ensureWrapperStringValueHelper(ctx)` → defines
  `__wrapper_string_value(externref) -> ref null $AnyString`. It extracts JUST
  the wrapper's primitive-string slot — the SAME internal-slot read
  `__to_primitive` performs inline (§7.1.1.1: `ref.test $Object` →
  `__obj_find(WRAPPER_PRIMITIVE_KEY)` → FLAG_INTERNAL check → `ref.test
$AnyString` on the slot value → cast, else null) — WITHOUT pulling in
  OrdinaryToPrimitive (the valueOf/toString method dispatch). Returns the native
  string for a boxed-String wrapper, null for every other value (plain object,
  other wrapper kind, non-string slot). Registered on demand and idempotently, so
  a module that never boxes a String stays byte-identical.
- `src/codegen/type-coercion.ts`: the externref → `ref/ref_null` arm's failed-cast
  else-branch, when the target is exactly `$AnyString` (`toIdx ===
ctx.anyStrTypeIdx`) and the object runtime is present
  (`ctx.objectRuntimeTypes` + `__obj_find`), now calls `__wrapper_string_value`
  instead of dropping to null. Only the `$AnyString` supertype target qualifies —
  the wrapper's stored string is a native-string subtype, so the helper's
  `ref.cast $AnyString` never traps; narrower string-subtype targets keep the
  prior null fallthrough. gc/host mode (anyStrTypeIdx = -1) and string-free
  modules fall through unchanged.

**Validation.** New `tests/issue-2161-b1-boxed-string.test.ts` (11 cases, all
standalone + empty importObject asserting zero non-`wasm:js-string` import leak):
the real test262 `instance-is-string-hello` split shape (length/`[0]`/`[1]`/`[2]`),
split-by-string, search, match (global + numbered captures), replace, matchAll on
a boxed receiver; `re.exec` / `re.test` with a boxed-String argument; plus
no-regression controls (plain string receiver, plain-object argument stays a
non-match). Byte-inertness confirmed: numeric / array / string / object programs
compile to sha256-identical binaries vs clean main (helper is emitted only when a
qualifying coercion needs it). Blast-radius battery (~35 files: regex #1539/#1911/
#1912/#1913/#1914/#1474/#2161-_/#2175/#2588/#2591/#2671, wrapper #1910-_/#2029/
#2160-wrapper-_, equality #2191/#2503b, string-coercion #1470-_/#2160/#2598/#2600/
#2374, coercion #1917/call-arg/#2934) shows every failure is PRE-EXISTING on clean
main (identical sets — the #1539/#2161 "expects-refusal" reds and the #2175
in-flight / #2600 gc-mode reds) — my change adds **zero** new failures. tsc clean.

**#2161 stays open (blocked on #2175)** for F6 reflection; F7 dynamic-receiver
architecture and the B5 annexB-escape point-fix are the remaining pickups.

## Acorn branch residual remeasurement (2026-07-26, codex-acorn)

The broad targeted battery was rerun as an exact local-vs-local comparison
while refreshing the standalone Acorn artifact:

- Acorn branch: **243/244**;
- exact upstream control at
  `932e042a20d45ce5172f3926a62ad03e9df53fb4`: **242/244**;
- the one branch failure, `match result passed to any[] param element-copies`,
  also fails on the upstream control (`91` returned, `1` expected);
- the Acorn branch fixes the control's other reassigned-pattern failure.

Therefore the remaining match-array result is **base-reproducing**, not an
Acorn-branch regression and not a blocker for the parser/interpreter boundary.
This note does not change #2161 ownership or its `blocked` status: the existing
assignee retains the RegExp residual, while the Acorn branch only records the
measured compatibility boundary.
