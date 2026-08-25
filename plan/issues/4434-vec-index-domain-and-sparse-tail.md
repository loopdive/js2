---
id: 4434
title: "SOUNDNESS: the vec sparse tail traps every dynamic MOP chokepoint (`a.length = 3; a[1]` is an uncatchable abort), and a 2^32 key is stored as array index 0"
status: done
completed: 2026-08-15
assignee: ttraenkler/claude-es5-standalone
sprint: 78
created: 2026-08-15
updated: 2026-08-18
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
coercion-sites-allow:
  # New CALL SITES of the existing engine helpers (number_toString /
  # __str_to_number) for index-key canonicalization in the sparse-tail MOP
  # arms — no fresh coercion matrix; both delegate to the #1917 engine.
  - src/codegen/vec-index-domain.ts
  - src/codegen/vec-overlay.ts
area: codegen, standalone
language_feature: arrays, array-length, property-descriptors
es_edition: 5
goal: standalone-mode
related: [3251, 3225, 4159, 4222, 3984, 4062, 2001, 4197]
origin: "ES5-standalone defineProperty-on-array-receivers family measurement, 2026-08-15"
# (#3102 LOC ratchet) The substance of this change-set is the NEW subsystem
# module src/codegen/vec-index-domain.ts (the exact overflow guard, the
# CanonicalNumericIndexString predicate, the sparse-tail bound). What lands in
# vec-overlay.ts is the per-carrier `vecBackedLen` emitter and its three
# consumers, and those cannot move: `array.len(data)` is not readable through
# the `$__vec_base` supertype, so the emitter has to enumerate `carriers`, the
# per-carrier whitelist that `fillVecOverlayHelpers` privately owns. Exporting
# `carriers` to a sibling module would export the overlay's carrier policy —
# a larger and more fragile surface than the ~90 emitted lines it would save.
loc-budget-allow:
  - src/codegen/vec-overlay.ts
# Same reasoning at function granularity: `fillVecOverlayHelpers` is the single
# finalize-time owner of the overlay's emission ORDER (its module header makes
# that discipline explicit), and `vecBackedLen` plus its three call sites are
# emission, not policy.
func-budget-allow:
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
---

# #4434 — the vec index domain and the sparse tail

Found while measuring the largest remaining ES5-standalone failure family
(`Object.defineProperty`/`defineProperties` on ARRAY receivers, 74 failing
files). Two of the family's buckets turned out to be symptoms of defects with a
much wider blast radius than descriptors, so they are filed and fixed here
rather than inside the #3251 overlay epic.

## Defect 1 — the sparse tail is an uncatchable trap (both lanes)

A vec is `struct { 0: length i32, 1: data (ref $arr) }`. Every growth path keeps
`array.len(data) >= length` **except the `a.length = N` setter**, which bumps
field 0 alone (`expressions/assignment.ts`, the `arr.length = N` arm). #3225
established exactly this shape and fixed the in-place WRITE methods
(`fill`/`reverse`/`copyWithin`) by growing the backing.

The dynamic metaobject chokepoints never got the same treatment. They bounds-check
against the LOGICAL length and then index `data[i]`, so on `--target standalone`
**every one of them aborted** — measured on this tree before the fix:

| program (after `var a = []; a.length = 3`) | before | Node |
| --- | --- | --- |
| `a[1]` | **TRAP** | `undefined` |
| `a[1] = 9` | **TRAP** | 9 |
| `a.hasOwnProperty("1")` | **TRAP** | `false` |
| `Object.getOwnPropertyDescriptor(a, "1")` | **TRAP** | `undefined` |
| `a.join(",")` | **TRAP** | `",,"` |
| `Object.defineProperty(a, "1", {value: 14})` | **TRAP** | 14 |

This is not a descriptor bug and not a corner case: `a.length = N` presizing is
ordinary ES5, and the failure is a terminal Wasm abort, not a catchable error.
The two test262 files that surfaced it (`15.2.3.6-4-274`,
`15.2.3.7-6-a-263`) are the smallest part of it.

**The host lane traps on the same idiom**, through its own bridge (`__vec_get`,
`vec-oob-read.ts`) rather than `__extern_get_idx`.

### Why the fix is reader-tolerance, not growth at the setter

Growing the backing inside `a.length = N` was rejected on two independent
grounds:

1. `a.length = 4294967294` is legal ES5 and must not allocate four billion
   slots — the ceiling would have to be arbitrary, and above it the tail comes
   back anyway.
2. It is **less correct**, not more. A grown backing reads the carrier default
   (`0` for an f64 vec) where the spec wants a hole; the tolerant reader answers
   `undefined`. Measured: with tolerance `a[1] === undefined` is `true`; with
   growth it would be `false`.

So `length` stays logical, `array.len(data)` is the capacity, and indices in
`[capacity, length)` are HOLES — the model every JS engine uses.

## Defect 2 — `"4294967296"` is stored as array index 0

`__obj_index_of_key` accumulated decimal digits into an i32 and rejected
out-of-range keys by testing the accumulator for a NEGATIVE value **after** the
multiply-add. That misses every key whose wrap lands on a non-negative residue.
`"4294967296"` accumulates to exactly `0`:

```js
var a = [];
Object.defineProperty(a, "4294967296", { value: 100 });
a.length;  // 1   — should be 0 (2^32 is not an array index)
a[0];      // 100 — a property invented at a key nobody named
```

`"4294967295"` happened to wrap to `-1` and so was caught, which is why the
family looked half-correct: adjacent boundary tests disagreed for no visible
reason.

## Defect 3 — a non-index numeric key was invisible to the INDEXED read lane

`Object.defineProperty(arr, 4294967295, {value: 100})` stores into the overlay
companion (gOPD confirmed it present) but `arr[4294967295]` answered
`undefined`. Two independent causes, both fixed:

- **Authority.** The `__extern_get_idx` prologue treats a plain data entry as
  "the vec is authoritative, fall through", which is true only where the vec
  physically backs the index. It does not for a key outside the canonical index
  domain, nor for the unbacked tail. Decided at READ time (`i >= backedLen` ⇒
  the companion answers) rather than by marking the entry at define time, so a
  later `a.length = …` cannot leave a stale authority bit.
- **Reachability.** That prologue is gated on the #3673 numeric-companion flag,
  which the define set only for keys with an index `>= 0`. But `arr[4294967295]`
  reaches the prologue as an f64 whose `number_toString` IS the stored key, so
  the flag must follow *reachability through the indexed lane*, not
  index-ness. Now armed by a CanonicalNumericIndexString test on the named-key
  path — deliberately narrow, so an ordinary `arr.foo` expando still does not
  arm it and #3673's fast path is preserved.

> **Instrument warning, learned the hard way.** Defect 3 is INVISIBLE to any
> probe whose module also performs a normal indexed define: that define arms the
> module-global flag and every later read then works for the wrong reason. Two
> rounds of probing reported "fixed" on this confound. Every case in
> `tests/issue-4434-*.test.ts` is therefore its own module.

## Changes

| file | what |
| --- | --- |
| `src/codegen/vec-index-domain.ts` (NEW) | the exact pre-multiply overflow guard, the CanonicalNumericIndexString predicate, the sparse-tail bound, and the reasoning for all three |
| `src/codegen/object-runtime.ts` | `__obj_index_of_key` digit step → the exact guard; `fillExternGetIdxVecArms` vec arms → capacity conjunct |
| `src/codegen/vec-overlay.ts` | `vecBackedLen` (per-carrier `min(length, array.len(data))`); consumed by the `__vec_dp_value` / `__vec_dp_accessor` real-element seeds, the `__vec_gopd` implicit-descriptor synthesis, and the new `__extern_get_idx` companion-authority arm; numeric-flag arming for canonical-numeric named keys |
| `src/codegen/vec-oob-read.ts` | `guardVecElementRead` → capacity conjunct (host bridge; NOT standalone-gated, see below) |

The host-lane guard is deliberately not gated: the only behaviour it changes is
a terminal trap, and no passing program can depend on one.

`vecLen` (the LOGICAL length) is untouched — §10.4.2.2's at-or-beyond-length
rejections must keep comparing against it. Only the three "is this a REAL
element?" predicates moved to the backed bound.

## Measurement

Paired A/B by file-copy revert, same process, same instrument.

| set | before | after |
| --- | --- | --- |
| the 74-file array-receiver `defineProperty`/`defineProperties` sample | 0 / 74 | **4 / 74 (+4, −0)** |
| 220-file control of currently-PASSING `Array.prototype.*` / `Object.*` / `for-in` standalone tests | 217 / 220 | **217 / 220 (0 gained, 0 lost)** |
| `tests/issue-4434-*.test.ts` (new) | — | 17 / 17 |
| descriptor + overlay suites (`es5-standalone-descriptors`, `es5-standalone-array-filter`, `issue-4159`, `issue-4159-4160-prescan-flags`, `issue-3251`, `issue-4010`) | 104 | 104 |
| host-lane binary sha over 5 descriptor/array/index-key sources | — | **byte-identical** except `__vec_get`'s own body |
| 10 array suites (`array-capacity`, `array-methods`, `array-oob-bounds-check`, `array-prototype-methods`, `fast-arrays`, …) | 7 failed / 111 passed | **7 failed / 111 passed — the SAME 7, verified on base** |

Flipped: `15.2.3.6-4-274`, `15.2.3.7-6-a-263` (the traps),
`15.2.3.6-4-191`, `15.2.3.7-6-a-187` (`Array.prototype["0"]` inheritance —
index 0 of an empty array is now correctly a hole, so the own define is a first
definition and the read resolves through the prototype).

The +4 is a fair count of what this change owns and is deliberately not inflated:
the rest of the family is gated by the residuals below, each of which has a named
owner.

## Residuals (measured, each with its owner)

1. **The STATIC `compileObjectDefineProperty` lane bypasses the overlay for
   non-index keys.** Discriminating probe (under the real test262 harness):
   ```
   dynamic receiver  (`id([])`)          arr[4294967295] -> 100   ✓
   statically-visible vec receiver       arr[4294967295] -> undefined   ✗   (gOPD: present)
   ```
   With a receiver the compiler can see as a vec, the define is expanded inline
   and the value lands somewhere the indexed read lane cannot see. This is the
   same class #3984/#4227 resolved for `length` by standalone-gating the inline
   path off and letting the native own it. **Gates `15.2.3.6-4-184/-185/-186`
   and `15.2.3.7-6-a-180/-181/-182` (6 files).** Not attempted here — it is a
   distinct root cause with its own blast radius. Nearest owner: **#3251** (the
   overlay epic) or a new slice.
2. **`hasOwnProperty` on an array with ANY named key answers `false`** under the
   harness — measured directly with `a.foo = 7`: the read gives 7, the presence
   check gives `false`. Independent of this change; additionally gates
   `-184/-185/-186`. Nearest owner: **#4062** (array `length` absent from
   descriptor reflection) is the same reflection-surface family.
3. **Array `length` cannot exceed 2^31−1.** `vec.length` is an **i32** compared
   with `i32.lt_s` throughout, so `arr.length === 4294967295` is unreachable
   without making the length a uint32 across every signed compare in the
   compiler. Gates `15.2.3.6-4-154/-155/-183`, `15.2.3.7-6-a-150/-151/-179`
   (6 files). Deliberately NOT attempted: the risk/reward of touching every
   length compare for 6 files is bad. Wants its own issue.
4. **The TYPED lane still traps on the sparse tail** — `const a: number[] = [];
   a.length = 3; a[1]` aborts. The typed read bounds-checks against the logical
   length (`emitBoundsCheckedArrayGet`'s `lengthBoundInstrs`, #2773 S7) and a
   capacity conjunct there is a per-read cost inside every counted loop. That is
   precisely the guard-cost tradeoff **#4159** exists to decide; routed there
   rather than paid blind.
5. **Host lane: writes into the unbacked tail do not stick, and
   `Object.defineProperty(a, "1", {value: 42})` does not write through even on a
   fully DENSE `[1,2,3]`** (`a[1]` still answers 2). Verified identical on
   `origin/main`, so pre-existing; this fix is what made it observable (the read
   used to trap first). Nearest owner: **#3116** / the host descriptor sidecar.
6. **Hole semantics past the trap** — `a.length = 3; a.join(",")` yields
   `"undefined,undefined,undefined"` and `for (k in a)` visits 3 keys, where
   Node gives `",,"` and 0 keys. Strictly better than the previous abort, still
   wrong. Owner: **#4222** / **#2001** (array-hole materialisation).

## Acceptance criteria

- [x] `a.length = N; a[i]` / `a[i] = v` / `hasOwnProperty` / gOPD /
      `defineProperty` / `join` do not trap on either lane.
- [x] A hole in the unbacked tail reads `undefined`, is not an own property, and
      has no own descriptor (standalone).
- [x] `"4294967296"` is a named key: `length` stays 0 and index 0 is untouched.
- [x] A non-index numeric key reads back through the indexed lane.
- [x] An ordinary named expando does not arm the indexed-read consult (#3673
      fast path preserved).
- [x] Host lane byte-identical apart from `__vec_get`'s body.
- [x] Zero regressions on a 220-file control of currently-passing tests.
