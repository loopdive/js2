---
id: 6447
title: "standalone: `Array.prototype.concat`/`sort` on an `any`-typed receiver answer `undefined` — the closed-method dispatcher has no `$__vec_base` arm for the pure producer methods, so every Temporal property-bag entry point (`from(bag)` / `compare(bag,·)` / `equals(bag)` / `with(bag)`) dies with `Cannot read properties of undefined (reading 'sort')`"
status: done
assignee: ttraenkler/dev-5383-s10
sprint: current
priority: high
horizon: m
goal: standalone
parent: 5383
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-13
completed: 2026-09-13
loc-budget-allow:
  # 2026-09-13 (#6447) — the MECHANISM is the new module
  #   `src/codegen/dyn-array-producers.ts`, deliberately not the god-file. What
  #   lands in closed-method-dispatch.ts is only the two wirings, and neither
  #   can move:
  #     reserve (+14)  the helper must be minted at RESERVE time, because the
  #       fill is only allowed to READ `funcMap` (#1719) — minting from the fill
  #       would append a defined func mid-finalize under every reader that
  #       already baked an index. The gate that decides whether to mint is the
  #       same `(methodName, arity)` the dispatcher is keyed by, so it has to
  #       sit next to the #2927/#3098 gates it mirrors.
  #     fill (+43)     the `$__vec_base` brand arm wraps `current`, which is a
  #       local `Instr[]` accumulator private to this loop. There is no seam to
  #       hand it to another module without handing over the accumulator.
  #   Most of the +57 is rationale, and it is load-bearing in a way a reader
  #   cannot re-derive: it records that the arm's answer for a NON-vec receiver
  #   comes from `__extern_method_call`, whose own comment says it returns
  #   `undefined` for every non-`$Object` brand — i.e. the thing this arm exists
  #   to stop being the answer. Someone who trims that note will read the arm as
  #   an optimisation and "simplify" it away, and the regression it reopens is
  #   silent wrong data (an empty array), not a crash.
  - src/codegen/closed-method-dispatch.ts
func-budget-allow:
  # 2026-09-13 (#6447) — `fillClosedMethodDispatch` +39, the `$__vec_base`
  #   producer arm. It belongs to THIS function for the same reason #2927's
  #   mutator arm does, four lines above it: the arm is a wrapper around the
  #   `current` chain this function builds, and its position in that chain
  #   (UNDER the closed-struct arms, so a user object with its own `concat` wins)
  #   is only checkable next to the arms it is ordered against.
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
coercion-sites-allow:
  # 2026-09-13 (#6447) — `__arrprod_sort_cmp` grows the vocabulary by exactly
  #   two tokens, `__extern_toString` +1 and `__unbox_number` +1, and both are
  #   CALLS INTO the coercion engine's runtime entry points, not a fresh
  #   ToString/ToNumber matrix. They are §23.1.3.30 SortCompare's own two
  #   coercions and there is no third:
  #     step 5  ToString(x) / ToString(y) for the default (no-comparator) order
  #             → `__extern_toString`, which `array-methods.ts` documents as
  #               "the SAME runtime primitive `emitToString`'s dynamic branch
  #               wraps" and already calls for this exact question on the TYPED
  #               default-sort path (`compileArrayDefaultToStringSort`, #3579).
  #     step 4  ToNumber(comparefn(x, y))
  #             → `__unbox_number`, guarded by `__typeof_number` so a
  #               non-numeric answer reads as 0 rather than being unboxed
  #               blindly.
  #   The alternative the gate is protecting against — re-deriving the order
  #   inline — is what this deliberately does NOT do: the dynamic-receiver arm
  #   asks the same two helpers the typed arm asks, so the two lanes cannot
  #   answer `["10","9"].sort()` differently. Routing instead through
  #   `coerceType` is not available here: the operands are runtime externrefs
  #   inside a minted helper body with no AST node and no static `ts.Type`,
  #   which is the case the runtime primitives exist for.
  - src/codegen/dyn-array-producers.ts
---

## Problem

Under `--target standalone`, a call to an `Array.prototype` method on a receiver
whose static type is `any` is lowered through the closed-method dispatcher
`__call_m_<name>_<arity>` (`src/codegen/closed-method-dispatch.ts`). That
dispatcher carries native brand arms for

- the callback family (`map`/`filter`/`forEach`/`find*`/`every`/`some`/`reduce*`) — #3098/#4394,
- the in-place mutators `push`/`pop` — #2927,
- the collection methods (`get`/`set`/`has`/`add`/`delete`/`clear`) — #3309,

and for everything else it falls through to `__extern_method_call(recv, "<name>",
args)`. That helper's own comment states the gap outright
(`src/codegen/object-runtime.ts`, `__extern_method_call`):

> Non-`$Object` brands ($Vec/string/Map/Set instance methods on a genuinely-`any`
> receiver) are the Slice-4 brand arms — **they return undefined here for now**

So the pure Array PRODUCER/QUERY methods have no answer at all on a compiled
array reached through an `any` binding. Measured host-free in a single
standalone module (`.tmp/s10/single6.mjs`, receiver `["b","a"]` reached through
a function parameter):

| method on an `any` receiver | standalone |
| --- | --- |
| `map`, `filter`, `join`, `indexOf`, `push`, `[...n]`, `Array.from(n)` | correct |
| `concat`, `slice`, `reverse`, `sort`, `includes`, `splice`, `flat` | **WRONG** |

`concat` is the load-bearing one: it answers an object that is neither the
concatenation nor an Array (`typeof === "object"`, `Array.isArray === false`,
`.length === 0`, indexing traps), and inside the compiled Temporal provider it
answers `undefined` outright.

### Why this is the Temporal lane's largest bucket

The polyfill's `PrepareCalendarFields` (minified `tn`) is

```js
function tn(e,t,n,r,o){ const i=Xt(e).extraFields(n), a=n.concat(r,i); … a.sort(); … }
```

`n` is an `any` parameter, so `a` is `undefined` and `a.sort()` raises
`TypeError: Cannot read properties of undefined (reading 'sort')`. Every
property-bag entry point goes through it. Measured through the shipped linked
path (`.tmp/s10/reduce2.mjs`, provider `dc43b7a43e0bd370`, `cacheHit=true`):

| probe | S9 base |
| --- | --- |
| `Temporal.PlainDate.compare({y,m,d}, d2)` | throws `reading 'sort'` |
| `Temporal.PlainDate.from({y,m,d})` | throws `reading 'sort'` |
| `Temporal.PlainDate.from({y,monthCode,d,calendar})` | throws `reading 'sort'` |
| `zdt.equals({y,m,d,timeZone})` | throws `reading 'sort'` |
| `plainDate.with({year})` | throws `reading 'sort'` |
| `Temporal.PlainDate.from("1976-11-18")` (control) | no throw |
| `Temporal.Duration.from({hours:1})` (control) | no throw |

## Attribution table (S10 census — bucket → root cause → terminal)

Buckets are the S9 linked three-family sample
(`.tmp/s10ref/{pd-link-clean,du-link,zdt-link}.tsv`).

| bucket | rows | root cause | terminal / site |
| --- | --- | --- | --- |
| `Cannot read properties of undefined (reading 'sort')` | 24 (PD 8, Du 4, ZDT 12) | **A** — `any`-receiver `concat` answers `undefined` | `__call_m_concat_2` → `__extern_method_call` (no `$__vec_base` arm) |
| `calendar must be string in canonicalizeCalendarEra` | 21 (PD) | **A** (the `from(bag)` rows) — the `from` result is not a `PlainDate`, so the harness's `date.calendarId` reads `undefined` | same |
| `Cannot read properties of undefined (reading 'equals')` | 6 (ZDT) | **A** | same |
| `Cannot convert undefined or null to object` | 18 (ZDT) | **B** — `Object.getOwnPropertyDescriptor(<provider>.prototype, k)` across the link | NOT this issue — see residual below |

NOT root-caused to A, measured and kept as residuals:

- **B — gOPD across a link boundary.** `Object.getOwnPropertyDescriptor(
  Temporal.ZonedDateTime.prototype, "day")` throws
  `Cannot convert undefined or null to object` (`.tmp/s10/reduce3.mjs`). The
  18-row `branding.js` / `prop-desc.js` family is exactly this. It is the #5406
  class (link-boundary MOP), needs a `__js2wasm_link_*` descriptor terminal, and
  is a slice of its own.
- **C — `x instanceof <provider class>` through an `any` parameter** answers
  `false` where the same test on a directly-bound local answers `true`
  (`.tmp/s10/reduce.mjs`, `instanceof via any param` = 0). Independent of A.
- **D — a closure whose sibling returns a differently-typed array fails Wasm
  validation**: two arrow members in one object literal, one returning `[]` and
  one returning `["era"]`, produce
  `type error in fallthru[0] (expected (ref null 41), got (ref null 0))`
  (`.tmp/s10/single2.mjs`, `concat(r, reg(k).f(n))`). Single-module,
  standalone, no link needed.

The boundary is NOT at fault for the reads the S9 buckets appeared to implicate:
`date.calendarId` and `date.year` read through an `any` PARAMETER both answer
correctly across the link (`.tmp/s10/reduce.mjs` rows 1, 2, 4), and
`zdt.equals(zdt)` answers `true`. That is the finding that redirected this slice
away from #5406 and onto the dispatcher.

## Implementation Plan

Fix **A**, on the standalone-codegen side; the polyfill source is not touched.

1. **New module `src/codegen/dyn-array-producers.ts`** (not the god-file;
   classified in `scripts/compiler-boundaries.json`). It exports
   `DYN_ARRAY_PRODUCER_METHODS`, a form predicate, and
   `ensureNativeArrayProducer(ctx, methodName)` which mints
   `__arrprod_<name>(recv: externref, args: externref /* $ObjVec */) -> externref`.
   Bodies run on the SAME array-like substrate the #3098 HOF loops and the
   #4394 generic mutators already use (`__extern_length`, `__extern_get_idx`,
   `__extern_set`, `__extern_is_array`, `__extern_toString`,
   `__extern_is_undefined`, `__objvec_new`/`__objvec_push`,
   `__apply_closure`), so the arm serves a `$ObjVec` and an array-LIKE receiver,
   not only a concrete `__vec_<k>`.

2. **Members in this slice: `concat` and `sort`.** They are the two on the
   attributed path and they compose — after `concat` is fixed the polyfill's very
   next statement is `a.sort()`, which is broken in the same way. `slice`,
   `reverse`, `includes`, `splice` and `flat` are the same defect and are
   written down (with the reduction above) rather than fixed here; each needs
   its own species/hole semantics review.
   - `concat` — §23.1.3.1 without `@@isConcatSpreadable`: build a fresh
     `$ObjVec`, append the receiver's elements, then per argument append its
     elements when `__extern_is_array` says so and the argument itself
     otherwise.
   - `sort` — §23.1.3.30: in-place stable insertion sort through
     `__extern_get_idx`/`__extern_set`; `undefined` elements sort last; the
     comparator is `arg0` through `__apply_closure` when callable and the
     ToString order (`__extern_toString` + `__str_compare`) otherwise. Returns
     the receiver. Insertion sort is O(n²) and that is deliberate: this arm is
     reached only by an `any`-receiver sort, never by the typed path (which
     keeps its Timsort).

3. **Wiring, mirroring #2927/#3098 exactly.** `reserveClosedMethodDispatch`
   calls `getOrRegisterVecBaseType` + `ensureNativeArrayProducer` at RESERVE
   time (append-only defined funcs; #1719 — the fill only READS `funcMap`), and
   `fillClosedMethodDispatch` wraps the existing `current` in a
   `ref.test $__vec_base` arm that builds the fixed args into an `$ObjVec`
   (`buildFixedArgVec`, already used by the bottom arm) and calls the helper.
   The arm sits UNDER the closed-struct arms, so a user object with its own
   `concat`/`sort` still wins; a non-vec receiver falls through unchanged.

4. **Order preservation.** The arm is gated on `ctx.standalone` (and the
   `$__vec_base` registration), so `--target gc` cannot reach it; a standalone
   module with no dynamic `concat`/`sort` call never reserves the dispatcher and
   is byte-identical. Verified by a byte A/B over a fixed corpus × {gc,
   standalone}.

5. **No rollback sites.** Nothing here compiles speculatively, so
   `snapshotSpeculative`/`rollbackSpeculative` are not involved and the
   `speculative-rollback` gate stays green.

## Acceptance

- `n.concat(r, i)` and `n.sort()` on an `any`-typed receiver answer correctly in
  a single standalone module (the census probe flips WRONG → ok).
- The five property-bag probes above stop throwing `reading 'sort'`.
- The three linked Temporal families are re-measured S9 → S10 with 0 `pass→fail`.
- A must-not-move standalone sample over `built-ins/Array/prototype/**` and
  `built-ins/Object/**` shows 0 `pass→fail`.
- Byte A/B: every `gc` artifact identical.

## Result (2026-09-13) — all five acceptance criteria met

| criterion | result |
| --- | --- |
| `concat`/`sort` on an `any` receiver correct in a single standalone module | **MET** — `.tmp/s10/single6.mjs`: `concat(r)`, `concat()`, `sort` flip WRONG → ok; `map`/`filter`/`join`/`indexOf`/`push`/spread/`Array.from` unchanged-ok |
| the five property-bag probes stop throwing `reading 'sort'` | **MET** — `.tmp/s10/reduce2-{base,new}.out`: `compare(bag,·)`, `from(bag)`, `equals(bag)`, `with(bag)` go from code 1 (`reading 'sort'`) to code 6 (no throw); the two controls that never threw still do not |
| three linked Temporal families, 0 `pass→fail` | **MET** — 122 → **139** of 360 (PlainDate 55→62, Duration 35→38, ZonedDateTime 32→39), 17 `fail→pass`, **0 pass→fail**, `reading 'sort'` bucket 24 → 0 |
| must-not-move standalone samples, 0 `pass→fail` | **MET** — `built-ins/Array/prototype/**` 79/40/1 → 79/40/1 and `built-ins/Object/**` 106/14 → 106/14, **0 flips in either** |
| byte A/B, every `gc` artifact identical | **MET** — 17 shapes × {gc, standalone}: all 17 `gc` sha256-identical; on standalone exactly `dynConcat`, `dynSort`, `dynSortCmp` move |

Two things the measurement settled that the plan only assumed:

- **The correctness witness had to be identity, not length.** `a.length === 3`
  passes on an empty-but-right-sized carrier, which is close to what the base
  tree actually produced for some element kinds. The regression test asserts
  `a[0]/a[1]/a[2]` by value for that reason.
- **The arm's ORDER is observable and is asserted.** `a user object with its OWN
  concat still wins over the vec arm` passes on BOTH trees — it is not a
  before/after witness, it is the guard against someone hoisting the brand arm
  above the closed-struct arms in a later refactor, where it would start
  shadowing user methods.

Base measurement for the regression test, by file-copy revert of
`src/codegen/closed-method-dispatch.ts` with `dyn-array-producers.ts` parked
(`.tmp/s10/t6447-base.out`): **7 of 9 fail on the base tree**, 9 of 9 pass on
this one. The two that pass on both are the order guard above and the residual
PIN — by construction, since neither describes something this slice changes.

One gate reported red and is NOT a regression: `npx vitest run` on
`tests/issue-5383-standalone-temporal-provider.test.ts` exits 1 with
`Error: [vitest-worker]: Timeout calling "onTaskUpdate"` while reporting
`81 passed | 3 todo`. Measured on the BASE tree by file-copy revert
(`.tmp/s10/g-5383only-base.out`): byte-for-byte the same outcome — same 81
passed, same unhandled error. It is that suite's own RPC timeout under a heavy
collect, pre-existing and unrelated.
