---
id: 5370
title: "Typed-array carriers are not faithful at the host boundary: `ArrayBuffer.isView()` answers false for a compiled carrier, a host-built typed array loses its brand crossing in, and `new Uint8Array(<host typed array>)` builds an EMPTY carrier"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-12
completed: 2026-09-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-12 (#5370): the two inbound answers live in `resolveImport`'s own
# arms — the `__arraybuffer_isView` import factory and the `extern_get`
# `.constructor` chain. Neither can move out of that function: the import
# factory IS the dispatch, and the `.constructor` arm has to sit ahead of the
# generic vec arm it corrects. The table and all reusable logic moved to
# `src/runtime/typed-array-host-brand.ts`, which took `src/runtime.ts` NET
# NEGATIVE (19725 → 19722) and left only the 10 dispatch lines below.
func-budget-allow:
  - src/runtime.ts::resolveImport
---

## Problem

Three defects found while writing #5362's regression test, all pre-existing
on `main` and none fixed there (#5362 only made `_wrapForHost` honour the
`__register_typed_array` brand on the way *out*):

1. `ArrayBuffer.isView(u8)` from compiled code answers `false` for a compiled
   typed-array carrier (Node: `true`).
2. A host-built typed array **loses its brand crossing in** through
   `__vec_from_extern_<N>`: it arrives as a plain vec, so a later crossing
   out re-emits a plain `Array` — the exact shape that made
   `SubtleCrypto.importKey` reject in #5362.
3. `new Uint8Array(<host typed array>)` builds an **empty** carrier
   (`DataError: Zero-length key is not supported` from the next host call).

hono's remaining `cookie.test.ts` failures (11/35 after #5362) and every
WebCrypto / `TextEncoder` / `Buffer`-adjacent library path cross this
boundary in both directions.

## Acceptance criteria

1. Three probes match Node: `ArrayBuffer.isView(new Uint8Array(3)) === true`
   in compiled code; `f(hostU8)` where `f` is compiled and returns its
   argument to a host `ArrayBuffer.isView` check answers `true` with the
   contents intact; `new Uint8Array(hostU8).length === hostU8.length` with
   equal contents.
2. Regression test under `tests/`, untyped `.js` two-file fixtures, one case
   per defect, failing on the parent and passing with the fix, exact counts
   both ways, anti-vacuity control (a plain array literal is still a plain
   `Array` on both sides).
3. A/B at one HEAD over all 17 suites, per file — hono `cookie.test.ts` is
   expected to move; nothing regresses.
4. Standalone lane status recorded (these are host-boundary defects; the
   standalone lane should be byte-identical).

## Implementation Plan

1. **Measure first, post-#5362.** Run the three probes on current `main`
   (standalone `.mjs`, `compileAndRunUpstreamModule`, untyped `.js`): the
   #5362 fix may already have flipped (1). Record exact results.
2. **(1) `isView`**: find how the call is lowered — a static builtin arm
   answering `false` for a struct (grep `isView` in `src/codegen` and
   `src/runtime.ts`), or a host call whose argument crossed without the
   brand. Fix at the arm that answers.
3. **(2) crossing in**: in `__vec_from_extern_<N>` (host side, `src/runtime.ts`)
   the host knows `ArrayBuffer.isView(src)` and the constructor name → typed
   kind; register the brand (`__register_typed_array`, the kind #5362's
   instrumentation showed as `taKind`) on the produced carrier. Check the
   element copy keeps the element type (Uint8 vs Float64).
4. **(3) `new Uint8Array(hostTA)`**: find the TypedArray constructor lowering
   (grep `Uint8Array` in `src/codegen/typed-array*.ts` / `builtins`) and its
   host-object arm — it likely reads `length` through a route that answers
   `0` for a host typed array. Route it through the crossing-in path from
   step 3 (copy + brand).
5. Regression tests; A/B; one PR. Growth allowances for `src/runtime.ts` in
   this issue's frontmatter with the reason, as #5362 did.

## Dispatch

Model: **opus**. Three located defects in known arms; the only design point
is where the brand is registered on the way in.

## Resolution

Landed 2026-09-12. Two of the three reported defects were still live; the third
was already repaired by #5675's follow-up and is now pinned rather than claimed.

### Measured first, post-#5675 (the plan's step 1)

Probed on `cf82f78d6d` through `compileAndRunUpstreamModule` with untyped `.js`
two-file fixtures — the same lane the dogfood worker uses, because the plain
`instantiateWithRuntime` lane builds a HOST TypedArray for the same source and
reports a false pass (#5362's finding, re-confirmed here):

| reported defect | status on the parent |
| --- | --- |
| (1) `ArrayBuffer.isView(compiled carrier)` | **partly live.** The statically typed form answers `true` — codegen folds it at compile time. Through an UNTYPED (`any`) parameter it answered `false`, and so did a genuine HOST typed array. |
| (2) host typed array loses its brand crossing in | **live.** `new TextEncoder().encode("abc")` returned through a compiled function whose inferred return type is `Uint8Array` read back as `constructor.name === "Array"`. |
| (3) `new Uint8Array(<host typed array>)` builds an EMPTY carrier | **already fixed.** Length and contents correct on the parent. Kept as two pinned cases in the regression test, not claimed. |

### Mechanism

Three arms, all host-lane, no codegen touched:

1. **`__arraybuffer_isView` was asked the wrong question.** The argument reaches
   the import as the RAW WasmGC carrier (`extern.convert_any` — no marshalling),
   and `ArrayBuffer.isView` of an opaque struct is `false` whatever the struct
   holds. It now re-asks through `_wrapForHost`, the mirror every other host API
   already sees: a branded carrier presents as a real `Uint8Array`, an ordinary
   vec as a plain Array. So the answer cannot drift from what the next host call
   observes.
2. **The brand now crosses IN.** `_copyWasmStructSidecar` is the bridge every
   cross-representation copy already runs (the `__vec_from_extern_<N>`
   materializer, the direct coercion path, the vec projector). It carried the
   ordinary-property sidecar and not the typed-array brand, so a host
   `Uint8Array` narrowed into a fresh `$Vec` became indistinguishable from
   `[1,2,3]`. It now carries the brand too — the SAME small integer
   `__register_typed_array` records, so an adopted brand and a compiled-origin
   brand are one mirror path downstream, not two. It is deliberately a no-op
   when the source carries no brand.
3. **`.constructor` stopped contradicting the mirror.** A branded carrier fell
   into the generic `__is_vec` arm and answered %Array% while `_wrapForHost` was
   handing host APIs a real `Uint8Array`. It now answers its own constructor
   (sandbox-resolved, like the %Array% arm), ahead of the vec arm.

The table and all reusable logic live in the new
`src/runtime/typed-array-host-brand.ts`; moving `_COMPILED_TYPED_ARRAY_CTORS`
there took `src/runtime.ts` **net negative** (19725 → 19722), so the #4401
`runtimeTsLines` ceiling and the LOC gate pass without an allowance. Only
`resolveImport` needed one (+10) — see the dated note in the frontmatter.

### Counts both ways

`tests/issue-5370-typed-array-carrier-host-boundary.test.ts`, 10 cases:

* parent: **7/10** — the three that fail are `isView` of a compiled carrier
  through an `any` parameter (`not-view`), `isView` of a host typed array on
  the same route (`not-view`), and the narrowed carrier's constructor
  (`Array`).
* with the fix: **10/10**.

Anti-vacuity is explicit and green on BOTH sides: a plain array literal
travelling the identical routes still reads as a non-view whose constructor is
`Array`. A fix that branded every vec would fail those cases on the fix side.

### Standalone lane

**Byte-identical, by construction.** The change set touches
`src/runtime.ts` and one new `src/runtime/` module and no file under
`src/codegen/` or `src/ir/`, so no emitted Wasm changes in any lane. All three
arms are host-lane-only besides: the `__arraybuffer_isView` import does not
exist without a JS host (standalone answers §25.1.4.1 host-free through
`isViewRefTestInstrs`), the sidecar bridge is reserved only when
`!standalone && !wasi && semanticProviders !== "native-first"`, and the
`.constructor` arm lives in the `extern_get` host import.

### A/B — 17 suites, one HEAD (`cf82f78d6d`), per test file

Base = that HEAD with `src/runtime.ts` reverted to its upstream content (file
copies only, never the shared stash stack); fix = this branch. Same machine,
same caches, suites run one at a time.

| suite             | base        | fix         |  Δ  |
| ----------------- | ----------- | ----------- | --- |
| webpack           | 16/16       | 16/16       |  0  |
| three             | 17/18       | 17/18       |  0  |
| clsx              | 32/32       | 32/32       |  0  |
| cookie            | 63740/63740 | 63740/63740 |  0  |
| lodash            | 59/62       | 59/62       |  0  |
| redux             | 67/82       | 67/82       |  0  |
| axios             | 202/231     | 202/231     |  0  |
| stylelint         | 108/108     | 108/108     |  0  |
| tailwindcss       | 13/13       | 13/13       |  0  |
| jsdom             | 6/6         | 6/6         |  0  |
| styled-components | 9/9         | 9/9         |  0  |
| uuid              | 75/75       | 75/75       |  0  |
| marked            | 16/30       | 16/30       |  0  |
| moment            | 10/10       | 10/10       |  0  |
| prettier          | 105/151     | 105/151     |  0  |
| jest              | 335/356     | 335/356     |  0  |
| hono              | 258/324     | 258/324     |  0  |

**Per file, not one row moved** — no regressions, and no improvements either.
That is the honest headline, and it contradicts the dispatch expectation, so it
is worth being precise about why.

`hono src/utils/cookie.test.ts` stayed at **24/35**. It was named as the
expected mover and it is not one: its 11 remaining failures were diagnosed by
probe rather than assumed, and NONE of them is this defect.

- **9** are one line — `String.fromCharCode(...new Uint8Array(signature))`
  (`cookie.ts:48`). Measured: the host ArrayBuffer's `byteLength` reads 32,
  `new Uint8Array(hostAb).length` is 32, and the bytes match — only the SPREAD
  collapses, to exactly one element, so every signature serializes as `AA==`
  (base64 of a single zero byte). Filed as #6421; it is the third site of the
  argument-list idiom #5361 and #6411 already removed elsewhere.
- **1** is a spurious `Max-Age=0` emitted for an absent `maxAge` option.
- **1** is both.

So the shapes this issue fixes — `isView` through an `any` parameter, and a
narrowed carrier's `.constructor` — are simply not asserted by any of the 17
suites. The change is correctness-only, proven by the regression test's exact
counts both ways; the A/B's job here was to bound the blast radius of branding
on the way in, and it does: zero rows moved in either direction.

### Residuals

- **#6415** — `const f = ArrayBuffer.isView; f(x)` still answers `false` for
  every carrier on the JS-host lane (measured identical before and after this
  change). The host-lane first-class value read bails out of the shared closure
  (`builtin-value-read.ts`: `if (!noJsHost(ctx)) return null`) and never reaches
  the import this PR corrected, so the two spellings of one predicate disagree.
  Deliberately left out of scope: routing it through the standalone `ref.test`
  chain would make a plain array read as a view on the host lane, which is worse
  than the bug.
- **#6421**, **#6422**, **#6423** — found by the probes here, none of them on
  this path. See the PR body.
- The brand adoption rides on `_copyWasmStructSidecar`, which also serves the
  vec→vec ELEMENT-TYPE projector. Propagating an existing brand there is
  consistent with that path's own premise ("at the JavaScript level it is still
  the same Array object"), but it is the one place this change could over-brand.
  The 17-suite A/B is the evidence that it does not.

