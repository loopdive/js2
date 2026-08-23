---
id: 4654
title: "ES5 standalone: RegExp residual — 12 rows: a NUL (\\u0000) in regexp source truncates the pattern (7 rows, one root), prototype accessor own-ness (3), dynamic-pattern refusal (3)"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: regexp
goal: standalone-gap
related: [3875, 4228, 682]
origin: "wave-5 lead sweep (2026-08-23) on campaign HEAD, fresh compiler bundle + eval adapter. All 12 rows re-verified failing. Prior failed attempt at the accessor half is recorded in ensureNativeProtoCompanionSeeder / native-proto.ts — read it before repeating it."
---

# #4654 — ES5 RegExp standalone residual (12 rows)

## A. NUL in regexp source — 7 rows, ONE root (start here)

```
language/literals/regexp/S7.8.5_A1.1_T2.js   Code unit: 0 — SameValue(«undefined», «"\u0000"»)
language/literals/regexp/S7.8.5_A1.4_T2.js   ... «"\\\u0000"»
language/literals/regexp/S7.8.5_A2.1_T2.js   ... «"nnnn\u0000"»
language/literals/regexp/S7.8.5_A2.4_T2.js   ... «"a\\\u0000"»
annexB/built-ins/RegExp/RegExp-leading-escape-BMP.js    ... «"\\\u0000"»
annexB/built-ins/RegExp/RegExp-trailing-escape-BMP.js   ... «"a\\\u0000"»
built-ins/RegExp/S15.10.2_A1_T1.js           XML shallow-parse regex (verify: may be a distinct root)
```

Every one reports the **same shape**: indexing the pattern `source` at the
position of a `\u0000` yields `undefined` where the spec says the NUL code
unit. The signature of a C-string truncation or a length computed before
the NUL. Find the single place the pattern string crosses into the regexp
representation and stops at the NUL; one fix should take the family.

## B. Prototype accessor own-ness — 3 rows

```
built-ins/RegExp/prototype/global/S15.10.7.2_A9.js       __re.hasOwnProperty('global') must be false
built-ins/RegExp/prototype/multiline/S15.10.7.4_A9.js    ... 'multiline'
built-ins/RegExp/prototype/ignoreCase/S15.10.7.3_A9.js   ... 'ignoreCase'
```

An instance answers `hasOwnProperty` **true** for flags that in ES5.1 (and
in the version of the spec these tests encode) live on the prototype, not
the instance. **A prior attempt at this half failed** — the record is in
`ensureNativeProtoCompanionSeeder` / `src/codegen/native-proto.ts` (it
flips issue-2885). Read that record FIRST and say in your report why your
approach differs, or decline with the measurement. Overlaps #3875
(reflection routes disagree on built-in prototype properties) — if the
root is #3875's, hand it back with evidence rather than patching here.

## C. Dynamic-pattern refusal + misc — 3 rows

```
built-ins/RegExp/S15.10.2.8_A3_T15.js   TypeError: Unsupported dynamic regular expression pattern
built-ins/RegExp/S15.10.2.8_A3_T16.js   (same)
annexB/.../RegExp-control-escape-russian-letter.js  (same)
built-ins/RegExp/prototype/S15.10.6.1_A1_T2.js      TypeError: is not a constructor
built-ins/RegExp/S15.10.4.1_A6_T1.js    __re.toString() must return "[object RegExp]"
built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T11.js  "intoint"
```

"Unsupported dynamic regular expression pattern" is an explicit refusal in
the standalone RegExp backend (#682's dual backend). Establish what the
refusal actually cannot handle for THESE patterns — the answer may be a
narrow gap, not the general dynamic-pattern problem. `is not a constructor`
belongs to the builtin-as-value family (#4492 lane); hand it over if that
is its root.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING, read
   fully. Note especially: revert copies at first edit; every claimed
   delta from runs YOU executed; pins must EXECUTE the shape; the
   gitlink hazard (`git status -- test262` before every commit,
   `git diff <base>..HEAD --stat -- test262` empty before finishing).
2. **A first** — one root, 7 rows, highest value per unit of risk.
3. B only after reading the prior-attempt record; decline with a
   measurement rather than repeat it.
4. C last, and scope it by measurement.

## Acceptance

Scoped standalone sweep over `built-ins/RegExp`, `annexB/built-ins/RegExp`,
`language/literals/regexp` before AND after from your own runs; per-file
flip list; **zero regressions**. `tests/issue-4654.test.ts` pinning each
fixed family (executing the operation), verified failing on base by revert;
`it.fails` for residuals with owners. Record `## Root cause` / `## Fix` /
`## Test Results` / `## Residuals` here.

## Root cause

Three independent roots, one per part. The issue's grouping was right about the
COUNTS and wrong about part A's mechanism.

### A — not a NUL truncation. A RegExp loses its RegExp-ness crossing OUT of eval.

All six eval-based rows in part A have the identical body:

```js
for (var cu = 0; cu <= 0xffff; ++cu) {
  …
  var pattern = eval("/" + xx + "/");
  assert.sameValue(pattern.source, xx, "Code unit: " + cu.toString(16));
}
```

`cu = 0` is the FIRST iteration, so the NUL is simply the first — and, because
`assert.sameValue` throws, the ONLY — code unit that ever reported. Measured on
campaign HEAD `c42bdbe3e` with a freshly built bundle + adapter:

| probe (standalone lane, quickjs tier)              | base answer                            |
| -------------------------------------------------- | -------------------------------------- |
| `eval("/" + String.fromCharCode(97) + "/").source` | `undefined`  ← not a NUL at all        |
| `… instanceof RegExp`                              | `false`                                |
| `… .test("xax")`                                   | `TypeError: called value is not a function` |
| `… .lastIndex`                                     | `0`                                    |
| `new RegExp("a\u0000b").source.length` (no eval)   | `3`  ← the NUL survives fine           |

The last row is the one that kills the truncation reading: the compiled RegExp
constructor handles an embedded NUL correctly. The defect is entirely in the
outward half of the QuickJS eval membrane.

`qjsPublish` (`scripts/quickjs-eval-provider.mjs`) publishes a non-callable
QuickJS object as the #4245-slice-2 MIRRORED BOX — a compiled `$Object` carrying
the QuickJS object's own STRING keys, read through
`Object.getOwnPropertyNames`. A RegExp instance has exactly ONE own string key,
`lastIndex`; `source`, `flags`, `global`, `ignoreCase`, `multiline`, `sticky`,
`exec` and `test` are %RegExp.prototype% accessors and methods. So the box
arrived carrying none of them — which is exactly the table above, `lastIndex`
included.

`eval("/a/")` written as a LITERAL answers `source === "a"` even on base,
because `tryStaticEvalInline` folds it at compile time and it never reaches the
membrane. That is why the defect survived: only a runtime-composed eval source
exposes it.

### B — a deleted `RegExp.prototype` ACCESSOR is resurrected by the member CSV

The three rows are `RegExp.prototype` itself, not an instance:

```js
var __re = RegExp.prototype;
assert.sameValue(__re.hasOwnProperty('global'), true);    // passes
assert.sameValue(delete __re.global, true);               // passes
assert.sameValue(__re.hasOwnProperty('global'), false);   // FAILS
```

(The runner's `at L14` attribution on two of the three rows is a heuristic
artifact; the assertion MESSAGE — "must return false" — is authoritative and is
L16 in all three.)

`__nproto_hasown` (`src/codegen/native-proto-own-props.ts`) answers `1` for any
key in the brand's `$memberCsv`, and `global`/`ignoreCase`/`multiline` are in
`REGEXP_PROTO_STRING_MEMBERS`. The seeded-member ladder that consults the
MUTABLE companion — the one #4491 T9 added `constructor` to — is restricted to
`kind === "method"`, because `ensureNativeProtoCompanionSeeder` deliberately
does not seed accessors. So a delete of an accessor member can never be
observed. Structurally the same defect T9 closed for `constructor`, one
member-kind over.

### C — the dynamic-pattern refusal is the GENERAL runtime-grammar gap

The issue asked whether the refusal is narrow for these specific patterns.
Measured: it is not. `regexp-dynamic-pattern.ts` recognises literals, `.`, `|`
and `CharacterEscape`s, and refuses everything else. What each row actually
needs:

| row                                             | pattern that refuses | missing feature                     |
| ----------------------------------------------- | -------------------- | ----------------------------------- |
| `built-ins/RegExp/S15.10.2_A1_T1.js`            | `[^<]+`              | character classes + `+`             |
| `built-ins/RegExp/S15.10.2.8_A3_T15/T16.js`     | 200 nested `(`…`)`   | capture groups                      |
| `annexB/…/RegExp-control-escape-russian-letter` | `\c*`, `\c+`, `\c?`  | quantifiers                         |

(The Annex B `\c`-not-followed-by-an-ASCII-letter rule the russian-letter file
is named for is ALREADY implemented — see the grammar table in
`regexp-dynamic-pattern.ts`. It is the metacharacters in the ASCII half of that
file's generator that refuse.)

`S15.10.2_A1_T1.js` is therefore NOT a distinct root, as the issue suspected it
might be: it is part C's, and it fails with the identical `#0: … [^<]+` message
before and after this change.

The three remaining part-C rows are other families:

- `built-ins/RegExp/prototype/S15.10.6.1_A1_T2.js` — `new RegExp.prototype.constructor`
  → `TypeError: is not a constructor`. Builtin-as-value family (#4492 lane).
- `built-ins/RegExp/S15.10.4.1_A6_T1.js` — needs `Object.prototype.toString`,
  which reports `not yet implemented in --target standalone`. Separate family.
- `built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T11.js` — `__re.lastIndex = {valueOf(){throw "intoint"}}`
  must STORE the object (§22.2.7.1) and coerce inside `exec`. The standalone
  `$StandaloneRegExp` struct types `lastIndex` as an `f64` FIELD, so the
  coercion happens at ASSIGNMENT — one statement ABOVE the test's `try`, which
  is why the raw `"intoint"` escapes uncaught. A value-representation change to
  the regexp struct, not a coercion bug.

## Fix

`scripts/quickjs-eval-provider.mjs` only — the adapter source. No `src/` change.

`qjsPublish` gains a RegExp arm BEFORE the mirrored-box arm: a realm helper
`__js2wasm_eval_reinfo__(o)` returns `""` for a non-RegExp and
`flags ∥ U+0001 ∥ source` for a RegExp (branded by
`Object.prototype.toString.call`, so a prototype-swapped regexp still answers by
its `[[RegExpMatcher]]` slot), and the adapter rebuilds it as a real compiled
`new RegExp(source, flags)`, registered in the handle registry with
`mirror = 0` so identity round-trips in both directions.

Three things make this safe rather than a trade, each measured:

1. **`new RegExp(<dynamic>)` never refuses at CONSTRUCTION.** The runtime
   grammar refuses at MATCH time. Measured: `new RegExp("[a-z]+")` constructs,
   `.source` is `"[a-z]+"` (6 units, first `[`), and only `.test(…)` throws a
   catchable TypeError — exactly what the same pattern does in ordinary user
   code today. So `source`/`flags` are right for EVERY pattern, and nothing that
   worked before regresses (the box could not run `test` at all).
   `tests/issue-4654.test.ts`'s ungated arm pins this premise, because if it
   ever moved to construction time this fix would silently fall back to the
   useless box.
2. **Construction that does throw falls through to the box.** Absent-not-wrong:
   the box is what shipped before.
3. **Only regexps are affected.** A pinned case asserts a plain realm object
   still crosses as the mirrored box.

The separator is split at the FIRST U+0001 only, because a regexp SOURCE may
legitimately contain that code unit; flags cannot.

Stated residual: the reconstruction is a SNAPSHOT, not the box's live view.
`lastIndex` is carried across once at publish time; a later realm-side mutation
of it is not observed, and a compiled write is not pushed back. Every other
piece of regexp state is immutable, so `lastIndex` is the whole divergence.

### …and the part that was NOT optional: the membrane registry was quadratic

The six eval rows are `for (cu = 0; cu <= 0xffff; ++cu)` loops. On base they
abort on iteration 0, so nothing ever ran them; the moment `.source` answers,
they run **65,536 evals**. That turned out to be the real work of this issue.

Three registry costs scaled with the number of PUBLISHED OBJECTS, each paid
once per eval, i.e. O(N²) over a loop:

| site                        | what it did per eval                                            | fix                                                                                |
| --------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `qjsFindBoxIndex` (forward) | one `qjs_is_equal` **FFI call per registry row**                | O(1) open-addressing hash keyed by the JSValue PAYLOAD word (`qjs_abi_payload_offset`) |
| `qjsSyncBoxes`              | one array read per row, twice per crossing, to test `mirror==1` | walk a maintained `qjsMirroredRows` index list instead                              |
| `qjsHandleOf` (reverse)     | four `===` per row, **once per global pushed** — globals × rows | partition the rows by `value instanceof RegExp`; the globals push skips the exploding partition |

The payload key is safe rather than merely likely-unique **because every row
retains its handle for the instance lifetime** (the slice-3 note), so a
registered object cannot be freed and its `JSObject*` cannot be recycled.

`Map` is not an alternative and that is measured, not assumed: js2wasm's
standalone `Map` is LINEAR — 6.8 µs/lookup at 500 entries, 45 µs at 4,000,
480 µs at 32,000.

Measured on the same build, an N-eval loop with 16 object-valued globals
(`.tmp/evalbench.mts`, no test262 harness):

| what the eval RETURNS                     | N=3,200         | N=12,800       |
| ----------------------------------------- | --------------- | -------------- |
| a number (publishes nothing)              | 2.28 ms/eval    | 2.73 ms/eval   |
| a RegExp (this fix)                       | 1.71 ms/eval    | 4.03 ms/eval   |
| a plain object (the **pre-existing** box) | **116 ms/eval** | (did not finish) |

Two things follow, and the second is the one that matters for merge:

1. The reconstruction's marginal cost over publishing nothing is ~1–1.3 ms/eval
   and roughly flat, not quadratic.
2. **The mirrored box — what base publishes for these very files — is ~68×
   more expensive per eval than the reconstruction, and still super-linear.**
   So this fix does not make these loops slower than base would have been; it
   makes them dramatically cheaper. The box path's own quadratic
   (`qjsPullBox` re-reads every mirrored box's keys from the realm on every
   crossing) is untouched here and is a separate, pre-existing problem.

Before the three fixes the same regexp loop measured 8.9 s at N=800 and 52.0 s
at N=3,200 — a fit of b ≈ 6.7 µs per row per eval, extrapolating to ~4 HOURS at
N=65,536. That is what would have burned the 40-minute CI shard.

## Test Results

(placeholder — filled in below once the after-arm sweep lands)

## Residuals

(placeholder)
