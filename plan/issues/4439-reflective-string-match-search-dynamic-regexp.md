---
id: 4439
title: "Reflective String.prototype.match/search + dynamic-pattern residual — borrowed-method and runtime-pattern regexp shapes in standalone"
status: in-review
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
# The IMPLEMENTATION lives in the new subsystem module
# `src/codegen/string-proto-match-search.ts` — these four are the unavoidable
# seams it plugs into, and every one of them is a small, local edit:
#   regexp-standalone.ts  the poison struct (replacing an in-place throw) +
#                         nullable operand nodes for the reflective lane
#   native-regex.ts       the `__regex_search` poison guard + its throw builder
#   array-object-proto.ts the two dispatcher arms (the file IS the dispatcher)
#   calls-closures.ts     one `noJsHost` argument on an existing refusal call
# The majority of each delta is the explanatory comment the seam needs.
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
  - src/codegen/native-regex.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/calls-closures.ts
# All three are single-emitter functions whose body IS one contiguous Wasm
# instruction list — splitting them would move instructions away from the
# ordering contracts documented in-place, not reduce complexity:
#   ensureDynamicStandaloneRegExpCompiler  one arm swapped from `throw` to a
#     struct + `return`; the added lines are the struct's 12 operands and the
#     note on why it is not the ~1030 empty-program hazard
#   ensureRegexSearch  a 3-instruction guard at the head + its comment
#   tryExternClassMethodOnAny  one argument added to an existing call; it
#     crosses 300 only because it is already a long ladder of refusals
func-budget-allow:
  - src/codegen/regexp-standalone.ts::ensureDynamicStandaloneRegExpCompiler
  - src/codegen/native-regex.ts::ensureRegexSearch
  - src/codegen/expressions/calls-closures.ts::tryExternClassMethodOnAny
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

---

## Implementation notes (2026-08-15)

Three clusters, three DIFFERENT root causes. Only the first was the one the
plan predicted; the other two were mis-attributed in the problem statement and
are worth reading before touching this area again.

### 1. Borrowed `match` / `search` — the predicted cause, confirmed

`emitStringProtoMemberBody` (`src/codegen/array-object-proto.ts`) had no
`match`/`search` arm, so the reflective closure body fell through to
`emitProtoMemberBodyRefusal`. New module
`src/codegen/string-proto-match-search.ts` supplies both.

**The one design decision worth recording.** `string-proto-split.ts` documents
a carve-out saying a reflective closure "receives its separator as a runtime
`externref`, so there is no static pattern to compile and no runtime
interpreter to fall back on." That reasoning does **not** transfer, and taking
it at face value would have produced a ToString-only body that silently
mismatches every borrowed `s.match(/re/)`:

1. a backend-created RegExp **is** recoverable from an opaque `externref` —
   `ref.test $NativeRegExp`, the same recovery `recoverRegExpStructFromExternref`
   already does for `RegExp.prototype.test.call`; and
2. there **is** a runtime compiler for everything else,
   `__regex_compile_dynamic_simple` (#2161), which the direct path's
   `RegExpCreate(ToString(v), "")` arm (`string-search-value.ts`) already calls.

So the argument dispatch is a RUNTIME two-lane branch, not a compile-time
decision. `split` legitimately stops at ToString because §22.1.3.23 has no
RegExpCreate step; `match`/`search` have one, which is what makes the second
lane spec-correct rather than a widening.

The `g` flag is likewise only known at runtime here, so `match` picks between
`__regex_match_all` and the `exec` path with a runtime test on the struct's
flags field (both arms yield `ref null $__regexp_match_vec`, so they share one
block type). Emitting only the `exec` arm would have been a silent wrong
answer for a borrowed `match` with a `/…/g` argument.

`emitRegexSearchCall` / `emitRegexExecArrayCall` now accept `ts.Expression |
null` for their two operand nodes: a reflective closure has no operand AST at
all. Null is only reachable together with the matching override.

### 2. `Cache_match` — NOT a String.prototype problem

The plan called this a "`Cache_match` host-import leak" to be gated on the host
lane. It is not in the String-proto lane at all. `o.match = String.prototype.match;
o.match(true)` reaches the `any`-receiver **extern-class first-match loop**
(`compileExternClassMethodCallAny`, `src/codegen/expressions/calls-closures.ts`
~L1838), which binds the FIRST registered extern class declaring `match` — the
DOM `Cache` interface — and emits `env::Cache_match`.

That loop already has the correct refusal (#3033: "if the program's OWN code
defines a function-valued member of this name, the receiver is far more
plausibly a user object"). It missed this shape for one reason:
`sourceAssignsAliasedFunctionMember` required the assignment's RHS to be an
**identifier**, and the ES5-sputnik spelling is a **property access**
(`String.prototype.match`). Widened, keyed by RHS shape so the identifier-only
answer is bit-for-bit what it was, and **opted into only under `noJsHost`** —
host-side the import is satisfiable, so widening there would change host output
for no host benefit (the gc/host byte-identity requirement).

The refusal stays receiver-scoped: only the identifier this file assigned the
member to declines the extern binding.

### 3. Dynamic-pattern residual — deferred, not extended

The plan asked for "a MODEST extension of the runtime subset (character
classes, quantifiers on literals?)". Measured against the corpus, that is the
wrong lever. The patterns are `[z-z]`, `[0-9]`, `a|b|[]`, `abc{1}` — character
classes and counted quantifiers, i.e. genuine engine features (a runtime class
table plus new bytecode), not tokenizer additions.

But the tests do not need them. Every one of the affected S15.10.4.1_A8 files
**constructs the RegExp and then reads only `.ignoreCase` / `.multiline` /
`.global` / `.lastIndex` / `.source`** — none of them ever matches with the
value. §22.2.3.1 RegExpInitialize does not fail for those patterns either;
only *this compiler* cannot run them. So the defect was the *timing* of the
refusal, not its absence.

`__regex_compile_dynamic_simple` now returns a **poisoned** `$NativeRegExp`
(`nGroups = 0`, `nScratch = 0`, zero-length `prog`, real flags + real `source`)
instead of throwing, and `__regex_search` throws the identical catchable
TypeError on first use. `nSlots = 2*nGroups + nScratch == 0` is unrepresentable
for a compiled program (group 0 alone makes it ≥ 2), so the marker is
unambiguous.

**This is not the hazard the `~1030` comment warns about.** That warning is
about manufacturing an empty *executable* program: the VM then ran it and read
past its bounds, an **uncatchable** Wasm trap. Here the guard is the first
thing in `__regex_search` and throws before the VM touches `prog` or `caps`.
`__regex_search` is the single VM entry — `test` / `exec` / `search` / `match` /
`matchAll` / `split` / `replace` and `__regex_run` are all reached through it —
so the guard has complete coverage. A per-call-site guard was rejected for
exactly that reason: partial coverage would resurrect the uncatchable trap.

## Measurements

Base = this branch's merge base (`origin/main` 09ecad8 + the wave-8 plan commit
3a2189b), compiled and run by me on 2026-08-15 with the single-test /
scoped-sweep drivers in `.tmp/`, `--target standalone`. Every "before" figure
below is from a base run I executed, not from a baseline artifact.

**Scoped sweep — `built-ins/String/prototype/{match,search,matchAll}` (119 files):**

| | pass | fail | compile_error |
| --- | --- | --- | --- |
| base | 74 | 33 | 12 |
| after | **78** | 29 | 12 |

`gained=4 lost=0` — no status change anywhere else in the scope.

**Per target file:**

| file | before | after |
| --- | --- | --- |
| `String/prototype/search/S15.5.4.12_A1_T1.js` | FAIL `String.prototype.search is not yet implemented` | **PASS** |
| `String/prototype/search/S15.5.4.12_A1_T2.js` | FAIL (same refusal) | **PASS** |
| `String/prototype/match/this-val-obj.js` | FAIL `[0] === undefined` (`env::Cache_match`) | **PASS** |
| `String/prototype/match/this-val-bool.js` | FAIL (same) | **PASS** |
| `String/prototype/match/S15.5.4.10_A2_T17.js` | FAIL `match is not yet implemented` | FAIL `[0] === undefined` — see residual R1 |
| `String/prototype/match/S15.5.4.10_A2_T18.js` | FAIL (same refusal) | FAIL — R1 |
| `String/prototype/match/S15.5.4.10_A1_T3.js` | FAIL (same refusal) | FAIL — R1 |
| `RegExp/S15.10.4.1_A8_T4.js` (`[z-z]`) | FAIL `Unsupported dynamic regular expression pattern` | **PASS** |
| `RegExp/S15.10.4.1_A8_T5.js` (`abc{1}`) | FAIL (same) | **PASS** |
| `RegExp/S15.10.4.1_A8_T3.js` (`a\|b\|[]`) | FAIL (same) | **PASS** |
| `RegExp/S15.10.4.1_A8_T2.js` | FAIL (same) | **PASS** |
| `RegExp/S15.10.3.1_A3_T2.js` | FAIL (same) | **PASS** |

(`S15.10.4.1_A8_T7`, the `[0-9]`+"m" case, passed on base already — its flags
operand is static enough for the other arm. It is listed in the plan's cluster
but is not a gain; the A/B below is what settled that, a per-file check on the
new tree alone would have mis-credited it.)

The three A2_T17/T18/A1_T3 non-flips are root-caused below; the reflective body
itself is correct for them (verified: `.length`, `.index`, `.input` and the
STRING-key element read `m["0"]` are all right — only the NUMERIC index read is
lost).

**Collateral sweeps (both arms run by me, same box, same list, file-copy A/B):**

| scope | files | base | after | delta |
| --- | --- | --- | --- | --- |
| `String/prototype/{match,search,matchAll}` | 119 | 74 / 33 / 12 | **78** / 29 / 12 | `gained=4 lost=0` |
| `RegExp/S15.10.4.1_*` + `S15.10.3.1_*` | 52 | 46 / 6 | **51** / 1 | `gained=5 lost=0` |
| `RegExp/prototype/{exec,test}` | 124 | 102 / 19 / 3 | 102 / 19 / 3 | `gained=0 lost=0` |

(pass / fail / compile_error). The constructor-family scope is the population
the deferral targets; the `exec`+`test` scope is its collateral check — the
`__regex_search` poison guard sits on the single VM entry every regexp
operation funnels through, and it does not move a single verdict there.

**Net across the three measured scopes: +9 pass, 0 regressions.**

**gc/host byte-identity: sha256-IDENTICAL on all 13 corpus programs**, compiled
with no `target` (the default gc/host lane): the 11 `website/playground/examples`
sources plus two written for this issue that exercise borrowed `match`/`search`
and dynamic `RegExp` construction directly. That identity is what the two
`noJsHost` gates buy — see the notes on the alias widening and on the
poison/guard pair.

**Unit suites:** `tests/issue-4439.test.ts` (new, 18 cases) passes; so do
`es5-standalone-regexp`, `issue-1539-standalone-regex{,-replace}`,
`issue-1539-standalone-array-coercion`, `regexp`, `issue-4016-…`,
`issue-4220-…`, `issue-2161-{regex-symbol-protocol,matchall,regex-string-
coercion,regex-const-ctor}`, `issue-4089-…`, `issue-3724-…`, `issue-4164`,
`issue-682-regexp-standalone-abi` — 350 cases, 0 new failures.
`issue-2875-slice3-search.test.ts` has **5 failures that reproduce identically
on base** (the `includes`/`startsWith`/`endsWith` arm); A/B'd, not mine.

## Residuals

### R1 — `__extern_get_idx` answers `undefined` for a `$__regexp_match_vec` in a builtin-proto-dirty module — PRE-EXISTING, blocks 3 files

**Not caused by this work, and not fixable inside it.** Minimal repro with zero
#4439 code involved (`.tmp/t7.js`):

```js
Number.prototype.foo = 1;                              // ANY builtin-proto write
var m = "10203040506070809000".match(/0./);            // the DIRECT path
var box = {}; box.v = m; var w = box.v;                // force the externref lane
w[0];        // undefined   ← wrong, should be "02"
w.length;    // 1           ← right
w["0"];      // "02"        ← right (string-key lane works)
```

Remove the `Number.prototype.foo = 1` line and `w[0]` is `"02"`. Replace it
with a plain-object write (`var q = {}; q.foo = 1;`) and `w[0]` is `"02"`. A
plain array in the same dirty module reads fine (`["a","b"]` → `w[0] === "a"`),
so it is specific to the match-vec.

Narrowed to `__extern_get_idx`'s arm ladder: under a builtin-proto write the
finalize fills splice an extra arm ahead of the `$__vec_base`/nstr-vec arm, and
control never reaches the arm that would read `vec.data[i]` — the receiver is
answered with the Array-prototype consult (`protoIndexGetIdxMissInstrs(...,
consultArray = 1)`, the `i32.const 18` = `ARR_OFF` delegate), i.e. every index
is treated as a miss. WAT evidence: in the clean module the ladder is
`[2, 4, 42, 84, 86]`; in the dirty module it is a spliced `[58]` followed by
`[2, 4, 42]`, and the spliced arm returns the consult unconditionally.

This blocks `S15.5.4.10_A2_T17/T18` and `A1_T3` — all three write
`Number.prototype.match = String.prototype.match` and then read `[0]`.

**Owner: the vec-overlay / proto-index lane (#4160 / #3673 / #4434 authors).**
It is a general defect — it costs the DIRECT `s.match(re)[0]` path in every
module that touches a builtin prototype — and it wants a fix in
`object-runtime.ts` / `vec-overlay.ts`, not in the String-proto subsystem. It
should be filed with its own id (`claim-issue.mjs --allocate`); this session
was instructed not to push, so no id was reserved rather than burning one.

### R2 — explicit `null` argument is treated as absent

`s.match(null)` / `s.search(null)` build the EMPTY pattern rather than
`ToString(null) === "null"`. The reflective ABI pads an omitted trailing
argument with `ref.null.extern` and the #2106 regime's `__extern_is_undefined`
answers true for both spellings, so the two are indistinguishable inside the
closure. `string-proto-split.ts` carries the identical conflation; fixing it
needs a distinct absent-argument marker in the closure ABI. Owner: whoever
takes the reflective-ABI arity work.

### R3 — `@@match` / `@@search` protocol objects

An arbitrary object carrying a custom `@@match`/`@@search` is `ToString`'d
rather than dispatched to that method (§22.1.3.14/.17 step 2). Visible as the
still-failing `cstm-matcher-invocation` / `cstm-search-invocation` /
`cstm-*-is-null` files, which now reach the poisoned-pattern TypeError instead
of the construction one — same verdict, different message. Shared by the whole
reflective String family; out of scope here.

### Status note

Left at **`in-review`**, not `done`: this session was instructed not to push or
open a PR, so the author is not the merger — the handoff case the lifecycle
reserves `in-review` for. Whoever lands the branch flips it to `done`.

### R4 — the dynamic pattern subset itself

Character classes and counted quantifiers are still uncompilable at runtime;
they now fail at first MATCH instead of at construction. Extending the subset
is real engine work (runtime class table + bytecode) and is deliberately not
attempted here — see "Implementation notes §3".
