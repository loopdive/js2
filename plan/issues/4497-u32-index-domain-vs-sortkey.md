---
id: 4497
title: "Array index domain [2^31, 2^32-2]: __obj_index_of_key's i32 result conflates is-index with index-value (blocks 7 ES5 MOP tests)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
assignee: unassigned
priority: medium
horizon: m
feasibility: hard
architect_spec: candidate
task_type: conformance
area: codegen
es_edition: es5
goal: standalone-mode
related: [4491, 4434, 4247]
---

# #4497 — the u32 index domain vs the signed sort key

**Do NOT implement from this file.** It is a representation question with a
named downstream consumer; it needs a design decision first. Split out of
#4491, where it was blocking 7 tests and was initially mistaken for a
one-line boundary correction.

## The constraint (documented, deliberate — not a bug that slipped in)

`vec-index-domain.ts` §1 (#4434) states it plainly:

> The ceiling stays `2^31-1` rather than the spec's `2^32-2`, which is the
> pre-existing documented cap of `__obj_index_of_key` (the result doubles as a
> SIGNED sort key for OrdinaryOwnPropertyKeys ordering). Keys in
> `[2^31, 2^32-2]` are therefore treated as ordinary string keys. That is a
> deliberate, narrower approximation — and it is now a CONSISTENT one.

## Root cause, stated precisely

`__obj_index_of_key(key) -> i32` returns **one i32 that carries two facts**:

- **is-index**, encoded in the SIGN (`-1` = not an array index), and
- **the index VALUE**, encoded in the magnitude.

`__obj_ordered` / `__obj_ordered_all` consume exactly that conflation. Their
`keyLess` comparator (object-runtime.ts) tests `i32.ge_s ... 0` to mean "is an
integer index", then orders integer keys with `i32.lt_s`. §10.1.11.1 wants
integer-index keys ascending by NUMERIC value before all string keys.

An array index is a uint32 with value `< 2^32-1` (§6.1.7), so the legal domain
is `[0, 2^32-2]` — which needs the full u32 range. Widening the accumulator
alone would make every index in `[2^31, 2^32-2]` read as NEGATIVE, i.e.
indistinguishable from the `-1` "not an index" sentinel, and would silently
re-sort those keys after all string keys. That is why this is not a boundary
tweak: **the sentinel and the value share a representation.**

## Measured impact (from #4491's triage)

7 non-passing ES5 standalone tests use indices in the window:

```
defineProperty/15.2.3.6-4-{154,183,415,589,591}.js
defineProperties/15.2.3.7-6-a-{150,179}.js
```

Values seen: `4294967294` (the LAST legal index — `length` must become
`4294967295`) and `4255551212`.

**Re-bucketed into this issue from #4491's D-a gate (2026-08-15):**
`defineProperty/15.2.3.6-4-155.js` and `defineProperties/15.2.3.7-6-a-151.js`.
Both were counted in #4491's 8-test D-a gate; reading their FIRST failing
assertion shows both fail on `arr.length === 4294967295`, i.e. they need index
`4294967294` to be recognised as a legal index — this issue's window, not
#4491's non-index read path. Candidate count here is therefore **9**, and
#4491's D-a gate is **6**. Measured symptom for `4294967294`: the property
IS created (as an ordinary named key, per the approximation), but `length` does
not extend and the element does not read back.

Adjacent and NOT part of this issue: keys `>= 2^32-1` (`4294967295`,
`4294967296`, `4294967297`) are correctly NOT array indices. Their 8 failures
are a different defect, fixed in #4491's D-a slice.

## Design options (decide before coding)

1. **Widen the result to i64.** Full u32 fits with room for a negative
   sentinel; `keyLess` moves to `i64` compares. Cost: every consumer signature
   and the per-digit accumulate loop; i64 compares in a hot ordering path.
2. **Split the two facts.** Return the u32 magnitude and report is-index
   out-of-band (a second result, an out-param, or a reserved magnitude paired
   with unsigned compares). `keyLess` then uses `i32.lt_u`. Probably the
   smallest honest change, but it touches every call site.
3. **Keep the ceiling, accept the 7.** Zero risk, and the status quo is already
   documented and self-consistent. The cost is that `4294967294` — the last
   legal array index, and a boundary test262 exercises deliberately — stays
   wrong.

**Recommendation: option 2**, with option 3 as the acceptable outcome if the
ordering path proves too hot to disturb for 7 tests. Whichever is chosen, the
decision belongs in `vec-index-domain.ts` §1 next to the existing note, so the
next reader finds the constraint and its resolution together.

## Validation

`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/Object/defineProperty|built-ins/Object/defineProperties"` —
the 7 listed tests, plus a no-regression check on `built-ins/Object/keys`,
`getOwnPropertyNames` and `built-ins/Array` (the ordering consumers).
