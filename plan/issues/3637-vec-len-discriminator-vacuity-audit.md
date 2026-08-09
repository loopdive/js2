---
id: 3637
title: "`typeof __vec_len(x) === \"number\"` is a vacuous vec discriminator — exhaustive audit of the surviving sites"
status: done
sprint: 77
created: 2026-07-25
updated: 2026-07-30
completed: 2026-07-25
priority: high
horizon: l
feasibility: hard
task_type: bug
area: runtime
language_feature: iteration-protocol, json, array-methods, host-marshalling
es_edition: multi
goal: core-semantics
assignee: ttraenkler/opus-loop-b
related: [2836, 3486, 2671, 1634, 1969, 3075]
origin: "Follow-up sweep after #2836 (seven sites) and #3486 (an eighth that suppressed 28 tests). Two more survivors were named up front; the audit found ten."
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  # `resolveImport` is the host-import factory; five of the ten reachable
  # discriminator sites live inside it (`__extern_join_str`, `__make_iterable`'s
  # spread arm, `__iterator`, `__async_iterator`, `__array_concat_any`,
  # `__crypto_get_random_values`). The +37 lines are the `_isWasmVec` guards and
  # the comments recording the measured pre-fix answer at each one; no new
  # branch structure. Splitting the factory is #3399's job, not this audit's —
  # doing it here would bury a ten-site semantic fix inside a large move diff.
  - src/runtime.ts::resolveImport
---

# #3637 — the `__vec_len` discriminator is vacuous; audit every surviving site

## Problem

`__vec_len` is a **length accessor, not a predicate**. Its emitted body
(`src/codegen/vec-access-exports.ts` → `_emitVecAccessExportsInner`) is a
`ref.test` chain over every registered vec type whose final `else` arm is:

```wat
i32.const 0
return
```

It **answers `0` for any non-vec value and does not throw**. Therefore:

- `typeof __vec_len(v) === "number" && v >= 0` is **vacuously true for every
  WasmGC struct**, and
- `__vec_len(v) === 0` is **indistinguishable from "not a vec"**.

Every host-side runtime site that used that idiom as a discriminator silently
classified plain objects, class instances, boxed values and generator states as
**empty arrays** — erasing their contents instead of failing.

`__is_vec` is the positive discriminator: the identical `ref.test` chain
returning 1/0. It is emitted by the **same pass** as `__vec_len` (both
unconditional once `ctx.vecTypeMap` is non-empty), so it is available wherever
`__vec_len` is.

**Root cause of the BUG** is the paragraph above: a length accessor used as a
predicate. **Root cause of its SURVIVAL** is separate and is the next section —
these are two different failures and fixing only the first leaves the second
free to reintroduce it.

## Sizing note — this was a population, not a sample

The task that opened this issue named **two** surviving sites. The enumeration
found **ten reachable** ones, and the two named were the *least* damaging of the
set (both masked by `__struct_field_names`; one, `looksMarshalable`, produces the
correct outcome despite the vacuous test). The unmasked sites were the harmful
ones: `[0].concat({x:1})` silently **dropping the argument** and
`[{x:1}].flat()` **destroying the element** are data-loss bugs, not cosmetic
discriminator slips.

**Size by enumeration, never from a sample.** A defect class that shares one
root cause is a *population* — every site with the shared cause is affected until
individually proven otherwise, so the count comes from walking all of them, not
from extrapolating the ones already noticed. Three independent misestimates the
same day (this one under-called, a trap bucket over-called 2.7×, and a 41-vs-11
count) all had this shape.

## Why it kept surviving review

Three reinforcing reasons, all addressed here:

1. **No named predicate existed.** Every site open-coded the probe, so "is this
   a vec?" had no single answer to review, and each new site was written by
   copy-pasting a neighbour.
2. **Comments that asserted a guard which did not exist — the primary survival
   mechanism.** `_toJsArrayDeep`'s doc said "A non-vec value passes through
   unchanged"; `tryVecLen`'s said "Returns … -1 when `x` is not a vec";
   `wrapExports`'s step list said "If `__vec_len(val)` returns a number ≥ 0 → vec
   wrapper". All three were **false**. The damning detail: these are **exactly
   the three sites with no mask at all**. The comment was doing the mask's job
   *in the reader's head* — a reviewer checking "is this guarded?" read the
   comment, found the guarantee stated, and moved on. That is how one defect
   cleared review at eight separate sites over three issues. A false comment on
   an unguarded site is worse than no comment: it converts an obvious gap into
   an invisible one. (#3486 recorded the same pattern one issue earlier.)
3. **Partial masking.** Several sites sat behind a `_getStructFieldNames(v) ===
   null` pre-filter, which hides the bug for the common case (a struct with
   named fields) and leaves it live for field-less structs. That made the
   symptom look narrow when it was not.

## Base of this classification

Everything below is against **`upstream/main` @ `6f3e43580`** (merged into this
branch). **PR #3635** (`opus-loop-a`, `#3603` S1 — host-side vec-mirror
write-back) was **still open** at classification time; it adds
`src/runtime/vec-mirror-writeback.ts` plus wiring in `src/runtime.ts` on the
adjacent `__vec_*` surface. Different defect (a mirror the Wasm side never reads
vs. a vacuous predicate), but when it lands its new code must be re-checked
against `_isWasmVec` — the audit script below re-runs in seconds:

```bash
node -e 'const L=require("fs").readFileSync("src/runtime.ts","utf8").split("\n");
L.forEach((l,i)=>{ if(!/__vec_len/.test(l)||/^\s*(\/\/|\*)/.test(l))return;
  const c=L.slice(Math.max(0,i-20),i+10).join("\n");
  if(!/_isWasmVec|__is_vec|isVecRecv|isVecFn\(|isVec\b/.test(c)) console.log(":"+(i+1)+": "+l.trim()); })'
```

## Measured reach

Every row below was measured on this branch by compiling the snippet and running
it under `wrapExports`, before and after the change. `host` is the answer plain
V8 gives for the identical source.

| Expression                        | pre-fix        | host / post-fix       | site                                 |
| --------------------------------- | -------------- | --------------------- | ------------------------------------ |
| `for (x of {a:1}) {}`             | ran 0 times    | `TypeError`           | `__iterator`                         |
| `[...{a:1}]`                      | `[]`           | `TypeError`           | `__make_iterable` spread materialise |
| `[1,{x:1}].join("-")`             | `"1-"`         | `"1-[object Object]"` | `__extern_join_str`                  |
| `JSON.stringify(new Empty())`     | `"[]"`         | `"{}"`                | `_wasmToPlain`                       |
| `JSON.stringify({a:new Empty()})` | `{"a":[]}`     | `{"a":{}}`            | `_wasmToPlain`                       |
| `JSON.stringify(inst, fn)`        | `"[]"`         | `"{}"`                | `_liveIsArray` (live walk)           |
| `[0].concat({x:1})`               | `[0]`          | `[0,{"x":1}]`         | `__array_concat_any` `tryVecLen`     |
| `[{x:1}].flat()`                  | `[]`           | `[{"x":1}]`           | `_toJsArrayDeep`                     |
| `wrapExports(m).mkInstance()`     | `[]`           | `{}`                  | `_wasmToPlain` via `looksMarshalable`|
| `Promise.all({a:1})`              | resolves `[]`  | rejects `TypeError`   | `_toIterable`                        |

`new Empty()` above is `class Empty { m() { return 1; } }` — a class instance
with **methods only**, i.e. `__struct_field_names` → `null`, which is exactly the
population the `_getStructFieldNames` pre-filter fails to mask.

Non-regression, also measured: `Map` / `Set` / generator / string / `arguments` /
custom-`@@iterator` iteration, empty vecs (`[...[]]`, `JSON.stringify([])`,
`{a: []}`), `[].concat([1,2])`, `[[1],[2]].flat()`, `Array.from` and
`Array.prototype.slice.call` on array-likes are byte-identical before and after.

## Fix

`src/runtime.ts` gains **one** predicate, `_isWasmVec(v, exports)`, documented
with the codegen reason it exists, and every discriminator site routes through
it. Sites changed:

| Function                       | non-vec answer before | after                        |
| ------------------------------ | --------------------- | ---------------------------- |
| `_materializeIterable`         | `[]`                  | closure-drain, else unchanged |
| `_wasmToPlain`                 | `[]`                  | `{}` + sidecar props         |
| `_liveIsArray`                 | `true`                | `false`                      |
| `_toJsArray`                   | `[]`                  | `[value]` (its documented fallback) |
| `_toJsArrayDeep`               | `[]`                  | unchanged (its documented behaviour) |
| `__extern_join_str`            | `""`                  | ToPrimitive                  |
| `__make_iterable` spread arm   | `[]`                  | iterator protocol → TypeError |
| `__array_concat_any` `tryVecLen` | spread length 0     | `-1` → append whole          |
| `__iterator` / `__async_iterator` | empty iterator     | `TypeError … is not iterable` |
| `_vecToArray` / `_toIterable`  | `[]`                  | `[value]` / native rejection |
| AggregateError `looksLikeVec`  | field-name heuristic  | `_isWasmVec`                 |
| `__crypto_get_random_values`   | `n = 0`, silent no-op | falls through to `__dv_byte_*` |

### `looksMarshalable` is deliberately NOT narrowed

`wrapExports`'s `looksMarshalable` is the one site where the vacuous test
produced the **right outcome**. Its final fallback is
`makeCallableClosureWrapper`, so narrowing step 3 to `__is_vec` would route a
field-less class instance into that arm and hand JS a **function** where the
program returned an object — strictly worse than today. The vacuous branch is
therefore replaced by an explicit step 4 ("not a closure, so it is an object ⇒
marshalable"), which is behaviour-preserving for every module that exports
`__vec_len`. A loud comment records the trap so a later reader does not "finish
the job".

## Full site classification — reachable vs. latent

The deliverable is the classification, including where the answer is "masked,
not reachable". Every `__vec_len` call in `src/runtime.ts` was inspected; the
table below is complete for the base named above. **Masked** = a preceding
filter hides the vacuity for the common case but not for all inputs;
**latent** = the vacuity is present but no caller can currently reach it.

| Site                                | Mask before the fix                  | Class         | Fixed |
| ----------------------------------- | ------------------------------------ | ------------- | ----- |
| `__iterator`                        | `__call_@@iterator` tried first      | **reachable** | yes   |
| `__async_iterator`                  | `__call_@@iterator` tried first      | **reachable** | yes   |
| `__make_iterable` spread arm        | none                                 | **reachable** | yes   |
| `__extern_join_str`                 | none                                 | **reachable** | yes   |
| `_toJsArrayDeep`                    | **none** (doc comment claimed one)   | **reachable** | yes   |
| `_toJsArray`                        | none                                 | **reachable** | yes   |
| `_wasmToPlain`                      | `__struct_field_names` non-empty     | **reachable** (field-less structs) | yes |
| `_liveIsArray`                      | `__struct_field_names` non-empty     | **reachable** (field-less structs) | yes |
| `__array_concat_any` `tryVecLen`    | **none** (doc comment claimed one)   | **reachable** | yes   |
| `_materializeIterable`              | none                                 | **reachable** | yes   |
| `_toIterable` (Promise combinators) | `Symbol.iterator in v` sentinel dance | **reachable** (non-iterable struct) | yes |
| `_vecToArray` (Promise helper)      | none                                 | **reachable** | yes   |
| AggregateError `looksLikeVec`       | `__struct_field_names === null`      | **reachable** (field-less structs) | yes |
| `__crypto_get_random_values`        | none                                 | **reachable** (DataView in a vec-exporting module) | yes |
| `wrapExports` `looksMarshalable`    | `__is_closure` + field names         | **reachable, outcome correct** | *deliberately not narrowed — see below* |
| `__array_entries` / `keys` / `values` | codegen emits only for a known-array receiver | **latent** | no — no reachable caller |
| `_serializeJSONArray`               | caller already classified via `_liveIsArray` | **latent** | no — fixed transitively |
| `_wrapVecForHost`                   | callers gate on `__is_vec`           | **latent**    | no — already gated |
| `__extern_method_call` push/pop     | `__vec_mut_supported` (a real positive discriminator) | **latent** | no — already gated |
| `_convertIterableForHost`, `extern_get` `.constructor`, `getOwnPropertyDescriptor`, `_wrapCallableForHost`, `__array_from` | — | already fixed by #2836 / #3486 | — |

The three sites whose **doc comment asserted a guard that did not exist**
(`_toJsArrayDeep`, `tryVecLen`, `wrapExports`'s step list) are exactly the three
with no mask at all — i.e. the comment was doing the mask's job in the reader's
head. All three comments are corrected in this PR, as are the six
`/* not a vec — fall through */` catch-block comments, which were also false:
`__vec_len` does not throw for a non-vec, so those `catch` arms only ever see a
genuine element-read trap.

### Can the class be made impossible rather than discouraged?

Three options were considered:

1. **Change `__vec_len`'s not-a-vec default to a sentinel `-1`.** This would make
   `len >= 0` a *genuine* test and retroactively repair every open-coded probe.
   Rejected for now: `__vec_len` is a public export with ~30 in-tree call sites
   that legitimately read a known vec's length, and several feed `new Array(len)`
   — which throws `RangeError` on `-1` rather than yielding an empty result. It
   also changes an exported ABI that standalone consumers may read. That is its
   own audit with its own regression surface, and it would *silently* alter the
   behaviour of any site not updated. Worth doing as a follow-up **after** this
   PR establishes that all in-tree discriminators go through one predicate.
2. **Make the length inaccessible without a proof-of-vec** (e.g. a
   `_vecLen(v, exports): number | undefined` returning `undefined` for non-vecs).
   This is the type-level version of (1) and is safe, but with every
   discriminator already routed through `_isWasmVec` it adds churn at ~30 sites
   for little marginal safety — the remaining reads are on values a positive
   discriminator has already accepted.
3. **What this PR does**: one named predicate with the codegen reason written at
   its definition, every discriminator routed through it, a **codegen-invariant
   test** asserting `__is_vec` is exported whenever `__vec_len` is (which is what
   makes the legacy fallback unreachable) and that it actually discriminates
   (1 for a vec, 0 for a field-less struct, while `__vec_len` answers 0 for
   both), and the false comments corrected. The copy-paste vector — a neighbour
   site to imitate — is gone, because no site open-codes the probe any more.

### Legacy-parity arm

`_isWasmVec` falls back to the old `__vec_len` probe when `__is_vec` is missing.
Current codegen cannot emit that shape (asserted by a codegen-invariant test), so
the arm is unreachable; it exists so an unexpected module degrades to the old
over-broad answer rather than losing vec support entirely.

## Out of scope (measured, pre-existing, unchanged by this PR)

A/B'd against stock `main` — identical before and after, so these are separate
gaps, not regressions:

- `var [p] = {a:1}` binds `undefined` instead of throwing `TypeError`. Array
  destructuring does not route through `__iterator`.
- `Array.from({length: 2})` → `[]` (host `[null,null]`); `Array.from({length: 2,
  0: "a", 1: "b"})` → `[]` (host `["a","b"]`). `Array.from` does not honour
  `length` on a wasm struct array-like.
- `[{x:1}, 2].flat()` and `[o, 1].slice(0)` trap with "dereferencing a null
  pointer" on mixed struct/number vecs.

## Acceptance criteria

- [x] One shared `_isWasmVec` predicate; no open-coded `typeof __vec_len(x) ===
      "number"` discriminator remains in `src/runtime.ts`.
- [x] Every false comment about `__vec_len`'s not-a-vec behaviour corrected.
- [x] Regression test asserting each measured row above, verified to FAIL when
      the fix is reverted.
- [x] Codegen-invariant test: a module exporting `__vec_len` also exports
      `__is_vec` (this is what makes the legacy arm unreachable).
- [x] Iteration of real iterables and empty vecs unchanged.
- [x] Reachable vs. latent classification recorded for every site, including the
      ones left unchanged.
- [x] Structural-prevention options evaluated and the decision recorded.

## Local validation

- `scripts/equivalence-gate.mjs` — exit 0.
- `tests/issue-3637-vec-len-discriminator-vacuity.test.ts` — 8/8 pass; **6/8 go
  red when `src/runtime.ts` is reverted to the merge base**, each with exactly
  the pre-fix answer recorded above. The 2 that stay green are the two
  non-regression guards (codegen invariant, genuine iterables) — by design.
- Related-path suites: `#1320` ×3, `#1367`, `#1368`, `#1382`, `#1465`, `#1504`,
  `#1634`, `#1700`, `#1969`, `#1997`, `#1998`, `#2035`, `#2202`, `#2671` ×6,
  `#2836`, `#2841`, `#2851`, `#3049`, `#3075`, `#3116`, `#3195`, `#3227` ×3,
  `#3486`. Three failures, **all A/B-verified as pre-existing on the merge
  base** (byte-identical failure text with and without this change):
  `issue-1700` `--target wasi` marshalling, and `issue-1320-standalone`
  `arr.entries()` ×2.
