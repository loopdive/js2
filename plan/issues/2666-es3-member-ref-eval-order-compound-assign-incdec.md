---
id: 2666
title: "≤ES3: member-reference base[prop] evaluation order in compound-assignment and prefix/postfix ++/-- (ToPropertyKey once, left-before-right)"
status: done
completed: 2026-07-28
assignee: ttraenkler/codex-es5-2666
created: 2026-06-25
updated: 2026-07-28
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: multi
language_feature: compound-assignment, increment-decrement, evaluation-order
goal: es5
sprint: 67
---

# #2666 — ≤ES3 member-reference `base[prop]` evaluation order (compound-assign + ++/--)

## Edition / impact

- **Editions:** ≤ES3 (base language) + ES5 + ES2015 (same root cause spans all three).
- **Fail count (current baseline):**
  - ≤ES3: 11 `compound-assignment/S11.13.2_A7.*_T4.js` + 4 `prefix/postfix-(in|de)crement/*_A6_T2.js` = **15**.
  - ES5: 77 `language/expressions/compound-assignment` + ~32 `prefix/postfix-(in|de)crement` (es5id-tagged) overlap the same root.
  - ES2015: 22 `language/expressions/compound-assignment`.
  - **Net addressable cluster ≈ 100+ failing tests** sharing one codegen root.
- This is the **top ≤ES3 priority** — it is base-language semantics every edition inherits.

## Problem

For an assignment target of the form `base[prop]` the spec requires:

1. Evaluate `base` (the MemberExpression's object) **once**.
2. Evaluate `prop` and apply `ToPropertyKey` **exactly once** — left-hand side
   before the right-hand side operand.
3. For compound assignment `base[prop] op= expr`, read the current value using
   the _already-evaluated_ reference, compute `op`, then write back to the
   _same_ reference — without re-evaluating `base` or re-calling `ToPropertyKey(prop)`.
4. For `++base[prop]` / `base[prop]++` (and `--`), the reference is evaluated
   once; `base = undefined` must throw **before** the property key is evaluated
   (GetValue on the base reference happens first).

Current codegen re-evaluates the property-key expression (and/or `base`) more
than once, so `prop.toString()` side effects fire twice and ordering asserts
fail. The `base = undefined` cases also evaluate `prop` when they should throw
on the base first.

## Failing-test cluster (examples)

```
language/expressions/compound-assignment/S11.13.2_A7.1_T4.js   (base[prop] *= expr — ToPropertyKey once)
language/expressions/compound-assignment/S11.13.2_A7.2_T4.js   (... and A7.3..A7.11 — one per operator)
language/expressions/prefix-increment/S11.4.4_A6_T2.js         (++base[prop], base undefined throws before prop)
language/expressions/postfix-increment/S11.3.1_A6_T2.js
language/expressions/prefix-decrement/S11.4.5_A6_T2.js
language/expressions/postfix-decrement/S11.3.2_A6_T2.js
```

Representative assertion (`S11.13.2_A7.1_T4.js`):

```js
var propKeyEvaluated = false;
var prop = {
  toString: function () {
    assert(!propKeyEvaluated);
    propKeyEvaluated = true;
    return "";
  },
};
base[prop] *= expr(); // toString must be called EXACTLY once
```

## Acceptance criteria

- All 11 `compound-assignment/S11.13.2_A7.*_T4.js` pass.
- All 4 `prefix/postfix-(in|de)crement/*_A6_T2.js` pass.
- No regression in the broader compound-assignment / inc-dec test set.
- Property-key expression with observable `toString`/`valueOf` side effects is
  evaluated exactly once for `base[prop] op= rhs` and `++/-- base[prop]`.

## Notes

- Root cause is in the member-target lowering for compound-assignment and
  update expressions — likely a "compile the target twice (once to read, once to
  write)" pattern. Fix: evaluate `base` and the property key once into temps,
  then read/modify/write through the temps.
- Related (different root): #1938 (linear array element double-eval of RHS).

## Resolution — COMPOUND-ASSIGN done (2026-06-25, dev-2046; inc/dec → #2675)

**`base[prop] op= rhs` ToPropertyKey-ONCE: FIXED.** Root cause confirmed: the
computed key flowed raw into BOTH `__extern_get` and `__extern_set`, each of
which runs ToPropertyKey internally (host `_toPropertyKey`) — so a side-effecting
`toString`/`valueOf` fired **twice** and the value came out `null`.

- New **`__to_property_key(externref)->externref` host import** (`src/runtime.ts`)
  wrapping `_toPropertyKey` (§7.1.19, Symbol-preserving). Standalone reuses the
  existing native `__to_property_key` (`object-runtime.ts`).
- **`compileElementCompoundAssignment`** (both externref arms,
  `src/codegen/expressions/assignment.ts`): `emitToPropertyKeyOnce` coerces the
  key ONCE right after it compiles to externref; the stored `keyLocal` (primitive
  string / preserved Symbol) is reused by both the get and the set. A primitive
  is idempotent under the host's internal ToPropertyKey → no second `toString`.
- Verified (`tests/issue-2666.test.ts`, 7/7): ToPropertyKey once (`n===1`), value
  correct, base-before-prop-before-rhs (`B()[K()] += R()` → "BKR"), string/array
  keys unchanged. Adjacent #2659/#2663/delete suites green.

**`++`/`--` on a computed object key — CARVED to #2675** (NOT in this PR). It is
entangled with the **#2659-family struct-slot-vs-sidecar asymmetry** (an
`__extern_set` to a typed-struct object updates the sidecar but `o.x` reads the
slot) AND `obj[strKey]++` / `obj["x"]++` are **already broken on `main`**
independent of ToPropertyKey (verified: return the old value, no update) — a
DISTINCT pre-existing bug. #2675 tracks it; it is likely a clean win once the
#2659 read/write asymmetry is fully resolved (connects to the acorn #2674
read-side work). So #2666 stays `in-progress` until #2675 lands the inc/dec half.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — half-sliced. The compound-assignment half `base[prop] op= rhs` (ToPropertyKey-ONCE via \_\_to_property_key) is FIXED (the referencing PR). The prefix/postfix `++`/`--` half is CARVED to #2675 (entangled with the #2659 struct-slot-vs-sidecar read/write asymmetry; obj[k]++ is independently broken on main). Stays in-progress until #2675 lands the inc/dec half.

## Measured residual after #3486 landed (2026-07-25, opus-3486)

#3486 (fnctor `.constructor` identity) unmasked this issue's real remaining
weight. Before #3486 the whole `S11.13.2_A7.*` / `S11.x_A6` family failed at its
FIRST `assert.throws(DummyError, …)` — a `.constructor`-identity defect, not an
evaluation-order one — so this issue's true residual was invisible.

Measured on the CI-equivalent path (`assembleOriginalHarness` →
`CompilerPool("unified")`), before/after #3486, over the 5 named ≤ES3 families
(41 tests, all failing on the baseline):

| outcome                                          | count |
| ------------------------------------------------ | ----: |
| flipped to `pass` by #3486 alone                 |    11 |
| still failing, now on the SECOND `assert.throws` |    30 |

All 30 residuals report `Expected a TypeError but got a Test262Error`.

**The specific sub-defect is NOT "ToPropertyKey once" (that half is fixed) — it
is ORDER: `RequireObjectCoercible(base)` must run BEFORE `ToPropertyKey(key)`.**
Isolated probe, host lane, current main:

| shape                                  | result      | correct?                       |
| -------------------------------------- | ----------- | ------------------------------ |
| `base[prop]` (plain read), base `null` | `TypeError` | yes                            |
| `base[prop] &= expr()`, base `null`    | `key-first` | **no** — `prop.toString()` ran |
| `++base[prop]`, base `null`            | `key-first` | **no** — `prop.toString()` ran |

So the plain member-read path already gets the order right; the
read-modify-write member paths (compound assignment AND `++`/`--`) evaluate and
`ToPropertyKey` the computed key before checking the base is coercible. Fixing
that one ordering is worth **~30 further ≤ES3 tests** on top of #3486's 11, and
would take the ≤ES3 metadata bucket from 241/273 to ~271/273.

## Current-main remeasurement (2026-07-28, Codex)

Reproduced the exact 30-file residual on fresh `origin/main` using the
authoritative original-harness runner, in both directions:

| lane       | pass | fail | compile error | total |
| ---------- | ---: | ---: | ------------: | ----: |
| host       |    0 |   30 |             0 |    30 |
| standalone |    0 |   30 |             0 |    30 |

The host lane reaches the second assertion and reports
`Expected a TypeError but got a Test262Error`, confirming that ToPropertyKey
still observes the key object before RequireObjectCoercible rejects the nullish
base. The standalone lane is layered behind an earlier user-constructor
identity mismatch (`Expected a undefined but got a different error constructor
with the same name`), so a correct ordering change is not assumed to flip its
visible verdict; the post-fix two-direction comparison must report that split.

Post-fix measurement over the same 30 files:

| lane       | before | after | measured flips |
| ---------- | -----: | ----: | -------------: |
| host       |   0/30 | 30/30 |        **+30** |
| standalone |   0/30 |  0/30 |          **0** |

The standalone failures retain the exact earlier constructor-identity message;
none advance far enough to score the second assertion. A host-free focused
probe independently verifies that the standalone lowering evaluates the raw
key expression, rejects the undefined base with a TypeError, and observes
neither ToPropertyKey nor the RHS. This is a layered no-visible-flip result, not
an extrapolated standalone win.
