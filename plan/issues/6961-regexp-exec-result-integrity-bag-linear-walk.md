---
id: 6961
title: "standalone: every RegExp exec result array walks the global vec integrity-bag linked list (O(n²)) — Octane regexp 34–49 s/rep vs node 76 ms"
status: ready
sprint: current
goal: standalone-gap
area: compiler
priority: high
horizon: s
feasibility: easy
---

# Problem

Octane **regexp** on `--target standalone` is correct but takes **34–49 s per
rep** (node: **76 ms/rep**, ~500x). Node calibrates 6 reps, so standalone blows
the 180 s run budget.

Measured with `node --cpu-prof` on the compiled module (c-octane-integ,
`.tmp/regexp.raw.wasm`, 1 rep, 49.1 s total):

| self % | function | note |
|---|---|---|
| 86.9 % | `__integrity_bag` | one caller path, see below |
| 5.9 % | `__vec_bag_ensure` | the list walk + prepend |
| 2.6 % | `run` (benchmark body) | the actual work |
| 1.2 % | `__regex_run` | the regex engine |

Single hot path (42.7 s of 49 s):

```
__integrity_bag <- __object_isExtensible_obj <- __vec_dp_value
  <- __defineProperty_value <- __regexp_exec_carrier <- Exec
```

# Root cause

1. `__regexp_exec_carrier` (regexp-standalone.ts ~L3955–3963, `defineOwn`)
   builds each match array and then calls `__defineProperty_value(result,
   "index"|"input"|"groups"[|"indices"], v, CREATE_DATA_PROPERTY_FLAGS)` on it.
2. The vec arm of `__defineProperty_value` is `__vec_dp_value`
   (vec-overlay.ts). For a NAMED key (`i < 0`) it runs
   `nonExtensibleFreshIndexGuard` (vec-define-rejections.ts L147–175):
   `__object_isExtensible_obj(recv)`.
3. `__object_isExtensible_obj` → `__integrity_bag(recv)`
   (object-integrity-carrier.ts L98–205) → vec carrier → **`__vec_bag_ensure`**.
4. `__vec_bag_ensure` (vec-props.ts L367–395) is the #3537 expando side table:
   a **global singly-linked list** keyed by vec identity (`walkLoop`, L318–343),
   walked from the head on every call; a miss **allocates a `$Object` bag and
   prepends** an entry. The list is never pruned and holds strong refs.

So the FIRST define on every fresh match array misses, walks the entire list
(every match array ever created in the run), then prepends. With n result
arrays per rep that is Θ(n²) list hops — and a memory leak (every match array
is retained by the list; a `$Object` bag is allocated per match for a
predicate that only wanted to *read* a flag).

The overlay table had the same shape-problem for the same `defineOwn` calls
and already got a fix (`__vec_overlay_prime` / `ensure_fresh`, #3673 r15 —
regexp-standalone.ts ~L3940); the integrity bag was not covered.

## Implementation Plan

### Change 1 (the fix) — integrity *predicates* must not mint a bag

**File: `src/codegen/object-integrity-carrier.ts`**, `registerIntegrityBagResolver`
and the predicate emitter at ~L630–650.

Split the resolver in two:

- `__integrity_bag` (ENSURE) stays for WRITERS (`Object.preventExtensions`/
  `seal`/`freeze` need somewhere to put the bit).
- Add `__integrity_bag_lookup` (READ-ONLY): same arms but calling
  `__vec_bag_lookup` / `__closure_bag_lookup` / the error/instance lookup twins
  (vec-props.ts already has `__vec_bag_lookup`, L357–365; closure-props.ts has
  the closure twin), returning `ref.null.extern` on a miss.
- `__object_isExtensible_obj`, `__object_isFrozen_obj`, `__object_isSealed_obj`
  (and the non-`_obj` trio) use the LOOKUP variant and treat a null bag as the
  pristine answer (extensible = true, frozen = sealed = false for a vec/closure
  carrier; the terminal fallback rule they already carry). A freshly minted bag
  has `flags == 0` which decodes to exactly that, so the answers are identical.

The resolver's doc comment ("ENSURE, not lookup … refusing to mint it is
refusing to answer") is about writers; update it.

### Change 2 (belt) — fresh result arrays skip the extensibility guard

**File: `src/codegen/regexp-standalone.ts`** `defineOwn` (~L3945): the result
vec was constructed a few instructions earlier and cannot be non-extensible.
Either call the overlay applier directly with a "fresh receiver" flag, or add a
`__vec_dp_value_fresh` entry that bypasses `nonExtensibleFreshIndexGuard` (same
pattern as `__vec_overlay_ensure_fresh`). Optional once Change 1 lands, but it
also removes 3–4 `ref.test` ladders per exec.

### Change 3 (structural, follow-up issue) — the side tables are lists

`__vec_bag_*` (vec-props.ts), `__closure_bag_*` (closure-props.ts) and the
overlay table (`__vec_overlay_lookup`, vec-overlay.ts ~L400–500: linear array
scan) are all identity-keyed linear structures. Any program that touches a
named property on many distinct arrays/closures degrades quadratically. Proper
fix: a slot in the carrier struct (`$__vec_base` gets a `(mut externref) bag`
field) or an identity hash table. File separately; not needed for the Octane
target.

### Acceptance

- `node .tmp/run-raw.mjs .tmp/regexp.raw.wasm 1` (after re-dump) ≤ 5 s/rep
  (expected 2–4 s: the remaining cost is `run` + `__regex_run` + per-exec
  overlay work).
- `pnpm run -s benchmark:octane -- --only regexp --lanes node,standalone
  --timeout 600` → standalone `ok` within the 180 s budget at node-calibrated
  reps (6 × ≤5 s).
- `tests/equivalence/`: `Object.isExtensible(arr)` / `isFrozen` / `isSealed`
  on pristine, `preventExtensions`'d, `seal`'d, `freeze`'d arrays and closures
  still agree with node (standalone + gc); a loop creating 100k match arrays
  via `re.exec(s)` on an `any` receiver finishes in < 1 s.

### Expected speedup

~10–20x on this benchmark (93 % of samples are in the walk). It does not fix
the second-order cost (3–4 `__defineProperty_value` calls per exec + overlay
prime), which is why the acceptance is 5 s rather than 100 ms.
