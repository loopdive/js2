---
id: 2916
title: "[SUBSTRATE][ARCH] Standalone native instanceof operator + isPrototypeOf residual (~31 leaky-PASS conversions)"
status: in-progress
assignee: ttraenkler/claude-es5-standalone
updated: 2026-08-15
loc-budget-allow:
  - src/codegen/expressions/identifiers.ts
sprint: current
created: 2026-07-01
priority: medium
horizon: l
feasibility: hard
model: fable
fable_role: spec
reasoning_effort: high
task_type: feature
area: codegen
language_feature: instanceof
goal: standalone
related: [2702, 2740, 2605, 1325, 1536c, 2188, 2907, 799]
origin: "2026-07-01 — sr-tail2 escalation: leaky-PASS conversion cluster, substrate REPLACEMENT (native OrdinaryHasInstance), not a leaf swap"
---

# #2916 — Standalone native `instanceof` operator + `isPrototypeOf` residual

## Claim status: UNCLAIMED and AVAILABLE — take this issue freely

> **As of 2026-07-31 08:55:03Z the `issue-assignments` record for #2916 reads
> `status: released`.** The issue is unclaimed. Nothing is in flight and nothing
> is half-implemented.
>
> Groundwork landed in **PR #3881** — measured scope, counted baseline, tiered
> acceptance, the confirmed #2580 M3 dependency, and both leak sites. The
> deliberate stopping point was _before_ the Slice B/C substrate, because a
> stranded `OrdinaryHasInstance` tri-state is how a wrong `true` ships.
>
> **Historical note, resolved — do not act on it.** Earlier on 2026-07-31 this
> file carried a warning that the claim record was stale and stuck at
> `in-progress`. That warning was itself wrong. The departing agent's release
> **did** land at 08:55:03Z; one of the attempts it reported as failed had in
> fact written the record. It trusted its own error output instead of reading the
> record back, then wrote a note explaining that a ref could not be fixed which
> had already been fixed. Compounding it, `pre-dispatch-gate.mjs` tested
> `assignee` alone and ignored `status`, so a **released** record still printed
> `CLAIMED by …` — that gate defect is fixed in **#3901**. Three separate readers
> were misled for ~6 h. Read the record, not the prose:
> `gh api "repos/loopdive/js2/contents/2916.json?ref=issue-assignments"`
> (quote the URL — zsh globs the `?`).

## RE-GROUNDED 2026-07-31 — scope is narrower than filed; the headline figure is stale

> **The "~31 leaky-PASS conversions" figure in the title is SUPERSEDED.** It is
> kept visible rather than deleted so nobody re-derives it, but it must not be
> used to size this work or to measure acceptance. Two of the three filed leak
> shapes no longer reproduce.
>
> Measured on current `main`, `--target standalone`, reading the module's
> **import list** (a compile-time property — the right instrument for a leak
> question; #3885's hazard concerns host _evaluation_ of `Object.*` statics, not
> the import list). Control: a plain module with no `instanceof` emits
> `imports=0`.
>
> | shape                                            | filed leak                | measured 2026-07-31                   |
> | ------------------------------------------------ | ------------------------- | ------------------------------------- |
> | `a instanceof Array` (builtin-name RHS)          | `env::__instanceof`       | **clean** — Slice A                   |
> | `a instanceof C` (user-class RHS)                | —                         | **clean**                             |
> | Error family                                     | —                         | **clean** (already native)            |
> | RHS resolves to no class/struct                  | `env::__instanceof_dyn`   | **never observed**                    |
> | `a instanceof K`, `K` an `any`-typed local       | `env::__instanceof_check` | **LEAKS**                             |
> | `x instanceof K`, `K` a fn-valued param          | —                         | **LEAKS** `__instanceof_check`        |
> | `a instanceof holder.K` (property access)        | —                         | **LEAKS** `__instanceof_check`        |
> | `a instanceof mk()` (call result)                | —                         | **LEAKS** `__instanceof_check`        |
> | `C.prototype.isPrototypeOf(a)` (static receiver) | (paired residual)         | **clean**                             |
> | `p.isPrototypeOf(a)`, `p` a dynamic receiver     | —                         | **LEAKS** `env::Object_isPrototypeOf` |
>
> **The residual is TWO host imports, not three:**
>
> 1. **`env::__instanceof_check`** — every dynamic-RHS `instanceof` shape. Four
>    surface variants, one import, one root cause (`identifiers.ts:1247`/`1252`).
> 2. **`env::Object_isPrototypeOf`** — `isPrototypeOf` on a **dynamic** receiver
>    only; the static `C.prototype.isPrototypeOf(a)` form is already clean.
>
> `env::__instanceof` and `env::__instanceof_dyn` were not observed on any probed
> shape.
>
> **A correction to this re-grounding's own first pass**, recorded because it is
> the same class of error the issue text made: an initial probe tested only the
> _static_ `C.prototype.isPrototypeOf(a)` form, saw it clean, and concluded
> `isPrototypeOf` was fully fixed. It is not — the dynamic-receiver form leaks.
> One shape is not the surface.
>
> **Acceptance must therefore be set on counted rows, not on the stale
> estimate** — see the re-grounded acceptance criteria at the end of this issue.

## Problem (verified on `main` `f350ba855`, 2026-07-01 — see RE-GROUNDED above)

Under `--target standalone` the dynamic `instanceof` operator leaks an
unsatisfiable `env::__instanceof*` host import, so the module cannot instantiate
host-free and fails the standalone floor. This is a **leaky-PASS cluster**: the
test passes in JS-host mode (the host provides `__instanceof`), but standalone
emits the import and dies at instantiation.

Confirmed by probe (`--target standalone`, `.tmp/probe_name.ts` / `probe_inst.ts`):

| Source shape                                                | Leaked host import        |
| ----------------------------------------------------------- | ------------------------- |
| `a instanceof Array` (any LHS, builtin-name RHS)            | `env::__instanceof`       |
| `a instanceof C` (any LHS, `any`-typed RHS identifier)      | `env::__instanceof_check` |
| `a instanceof C` where RHS resolves to no class/struct name | `env::__instanceof_dyn`   |

Because the host import is **entirely absent** in standalone, making `instanceof`
native does not swap one leaf — it **REPLACES §13.10.2 InstanceofOperator /
§7.3.20 OrdinaryHasInstance for the entire dynamic surface**. The native
tri-state must reproduce enough of the host `_instanceofResult`
(`src/runtime.ts:2322`) to not regress the full leaky-PASS surface (well beyond
the ~12 sampled / ~31 estimated).

Spec'd **together with the `isPrototypeOf` residual** because they share one
proto-chain-walk substrate.

## Background — three entry points, one already-native model

The `instanceof` binary op is intercepted in `expressions.ts:1137`:

- `resolveInstanceOfRHS` unresolved → `compileHostInstanceOf`
  (`identifiers.ts:1297`).
  - simple builtin/user-name RHS → string-name path, leaks `__instanceof`
    (`identifiers.ts:1465`).
  - non-identifier / dynamic RHS → `emitDynamicInstanceOf`
    (`identifiers.ts:1247`), leaks `__instanceof_check` (`identifiers.ts:1252`).
- resolvable RHS → `compileBinaryExpression` → `binary-ops.ts:364` →
  `compileInstanceOf` (`typeof-delete.ts:782`); unresolved `className` leaks
  `__instanceof_dyn` (`typeof-delete.ts:790`).

**The model to generalize already exists.** `compileHostInstanceOf` has a
`noJsHost(ctx)` **native inline branch** for the Error family
(`identifiers.ts:1394–1462`): it `ref.test`s the value against `$Error_struct`,
reads a discriminating field (builtin `$tag` fieldIdx 0, or per-class brand
fieldIdx 4 — #2188), and emits `i32.const 0/1` with **zero host imports**.
`#2605` did the same for native collections in `compileInstanceOf`
(`typeof-delete.ts`, `ref.test $Map`). `#1325` supplies the negative-tag
registry (`builtin-tags.ts`). This issue extends that native inline model from
{Error-family, Set/Map} to **all builtins reached dynamically**, plus a native
`__instanceof_check` / `__instanceof_dyn` for the fully-dynamic RHS.

`isPrototypeOf` is **already native** host-free: `__isPrototypeOf`
(`object-runtime.ts:2758`, in `OBJECT_RUNTIME_HELPER_NAMES`
`object-runtime.ts:8447`) walks `$Object.$proto` (fieldIdx 0) with `ref.eq` per
level. It is wired for the common method-call / borrowed-call forms
(`calls-closures.ts:418`, `calls.ts:4887`). The **residual** is the diffuse
generic host-method fallback (e.g. `Function.prototype.isPrototypeOf` reached
through the generic extern-method resolver, entangled with `Function.prototype`
/ `bind` value-rep) — that path does not reach the wired native helper and still
leaks. It shares the `$Object.$proto` walk with the instanceof substrate.

## Implementation Plan

### Root cause

`ensureLateImport` (`late-imports.ts:382`) has native routing for
`UNION_NATIVE_HELPER_NAMES` / `OBJECT_RUNTIME_HELPER_NAMES` (line 438) but
**none for `__instanceof*`**, so those names fall through to
`addImport(ctx, "env", name)` (line 470) — a host import that is unsatisfiable
standalone. The dynamic `instanceof` codegen has a native inline branch only for
the Error family; every other builtin / dynamic RHS reaches the host path.

### The crux sr-tail2 flagged — `target.prototype` off a constructor externref

A fully-reflective `OrdinaryHasInstance` needs `Get(C, "prototype")`. Standalone
has **no `.prototype` on the constructor carrier**: `#2907`'s well-known-global
carriers are empty `$Object` singletons (its own follow-up notes
"`.name`/`.prototype` on the Error-family carriers … returns `undefined`"). And
user-class instances are heterogeneous WasmGC structs with **no uniform proto
slot** (only the `$Object` open-object struct and native-collection instances
carry `$proto` at fieldIdx 0).

**Mitigation — specialize on the compile-time-known RHS instead of a runtime
`.prototype` read.** In the string-name path the RHS ctor name is a **codegen
constant** (`ctorName` at `identifiers.ts:1338`). So do NOT emit a generic
runtime `__instanceof(value, ctorName)` — emit an **inline native membership
test specialized to the known `ctorName`**, exactly as the Error-family branch
already does. This sidesteps `.prototype` entirely for the dominant leak
(`__instanceof`), is tractable, and is byte-inert for gc/host (gated
`noJsHost(ctx)`). A reflective `.prototype` read is only needed for the residual
fully-dynamic `__instanceof_check` (RHS an arbitrary runtime value) — scope that
as the harder, smaller slice (below).

### Slice A — generalize the native inline string-name branch (bulk of ~31)

**File: `src/codegen/expressions/identifiers.ts`**

- In `compileHostInstanceOf`, BEFORE the `__instanceof` late-import
  (line 1465), extend the existing `noJsHost(ctx)` native branch (currently
  gated on Error-family only at line 1394) to a general
  `emitNativeBuiltinInstanceOf(ctx, fctx, expr, ctorName)` that dispatches on
  the known `ctorName`:
  - `Object` → universal-object membership: the value `ref.test`s as ANY GC
    struct that is a real object (object literal / class instance / `$Object` /
    `$Vec` / closure / `$Error_struct` / native collection). Reuse the
    `tryStaticInstanceOf` §1729 rule (`identifiers.ts:1164`) but at runtime for
    an `any` value: emit `ref.test` against the object supertype (`anyref` that
    is not i31/primitive). Primitives (i31, boxed number/bool) → 0.
  - `Function` → native closure membership: `ref.test` against closure struct
    types (`ctx.closureInfoByTypeIdx` keys), mirroring the host `__is_closure`
    arm (`runtime.ts:2427`). This is the #1992 case (currently hardcoded false).
  - `Array` → `ref.test ctx.vecBaseTypeIdx` (the `$__vec_base` supertype,
    `registry/types.ts`), so every `$Vec` element-typed subtype matches.
  - `Error` / `*Error` → keep the existing field-0 tag / field-4 brand check
    (lines 1394–1462); refactor into the shared helper.
  - `Map`/`Set`/`WeakMap`/`WeakSet` → `ref.test ctx.mapTypeIdx` (per #2605;
    carry forward its documented cross-type-imprecision caveat).
  - `Date` / `RegExp` / `Promise` / `ArrayBuffer` / `DataView` → `ref.test`
    against their backing struct type idx (see `ctx.dvWindowTypeIdx` etc.; add
    accessors where missing). Where a native backing struct does not yet exist
    (TypedArray views share `$Vec` with plain arrays — the #2893 brand gap),
    **defer to #2893/#2872's brand** rather than emit a false positive; return a
    conservative refusal-or-0 with a `#2916` cite, never a wrong `true`.
  - Unknown / unsupported builtin RHS → keep the current behavior guarded so it
    only refuses/zeroes under `noJsHost`, never regressing gc/host.
- Every arm normalizes the LHS: `any.convert_extern` (if externref) → store
  anyref local → `ref.test` (never traps on null/primitive) → `if` → tag/field
  compare. This is the exact shape of the Error branch — factor it into one
  helper taking `(structTypeIdx, discriminator?)`.

### Slice B — native `__instanceof_check` / `__instanceof_dyn` (fully-dynamic RHS)

**Files: `src/codegen/expressions/identifiers.ts` (`emitDynamicInstanceOf`,
line 1247), `src/codegen/typeof-delete.ts` (`compileInstanceOf` dyn arm,
line 790), plus a new `ensureInstanceofRuntime(ctx)` (co-locate with
`ensureObjectRuntime` in `object-runtime.ts`).**

- Emit native WasmGC `__instanceof_check(anyLHS, anyRHS) -> i32` and
  `__instanceof_dyn` (same body) as **DEFINED** functions (no import → no index
  shift, same invariant as the object-runtime helpers). Register their names in
  a native-helper set consulted by `ensureLateImport`
  (`late-imports.ts` — mirror the `OBJECT_RUNTIME_HELPER_NAMES` routing at
  line 438 so the existing call sites resolve to the native funcIdx unchanged).
- Native tri-state body (0/1/2), reproducing the tractable subset of
  `_instanceofResult`:
  1. RHS classification: if RHS is a **native constructor carrier / class
     object** whose identity maps to a known builtin tag or user-class id via a
     runtime brand (`$ClassMeta` / the #2188 brand, or the #2907 carrier once it
     carries a ctor-id), dispatch to the Slice-A membership walk keyed on that
     tag. If RHS is a **closure** (IsCallable via `ref.test` closure struct) but
     carries no resolvable `.prototype`/brand, conservatively return `0` (matches
     the host dynamic-path §7.3.20-step-3 conservative `false`, `runtime.ts:2385`
     — NOT a throw, to preserve `primitive instanceof Function(...)` → false).
  2. RHS is a **non-callable object** with an OWN `@@hasInstance` opt-in → `2`
     (throw). Custom `@@hasInstance` DISPATCH is out of scope for the first cut
     (standalone values rarely carry it); document the gap and return the
     conservative branch, never a wrong `true`.
  3. RHS is a genuine **primitive / null / undefined**: dynamic path returns `0`
     (mirror `runtime.ts:2352`), NOT `2` — the statically-primitive-RHS throw is
     already handled at codegen (`identifiers.ts:1310–1334`).
- `emitInstanceofThrowGuard` (`identifiers.ts:1224`) already turns the `2`
  sentinel into a wasm-thrown `TypeError` — reuse it unchanged.

### Slice C (same substrate) — `isPrototypeOf` generic-host-method residual

**Files: `src/codegen/expressions/calls.ts` (~4830 generic extern-method arm),
`src/codegen/expressions/calls-closures.ts:418`.**

- Route the generic host-method fallback for `isPrototypeOf` (the
  `Function.prototype.isPrototypeOf` / borrowed-generic form that currently
  bypasses the wired native helper) to the **existing native `__isPrototypeOf`**
  (`object-runtime.ts:2758`) instead of a host import. Confirm the receiver is
  normalized to `$Object`-anyref before the proto-walk; where the receiver is a
  non-`$Object` struct with no `$proto` field, the walk correctly returns 0
  (matches host for a value not in the chain).
- The proto-walk over `$Object.$proto` fieldIdx 0 is the **shared substrate**
  with Slice B's user-class membership — extract it into one internal
  `emitProtoChainWalk(targetLocal, curLocal)` helper reused by both.

### Wasm IR pattern (Slice A — `a instanceof Function`, native)

```wasm
local.get $a
any.convert_extern            ;; externref -> anyref
local.tee $any
ref.test $__closure_base      ;; ctx.closureInfoByTypeIdx supertype
;; leaves i32 0/1 (no host import, no throw for a callable RHS name)
```

### Edge cases

- LHS null / undefined / primitive (i31, boxed number/bool) → every arm 0
  (ref.test on a non-matching type is 0, never traps).
- `x instanceof Object` for a `$Vec` / closure / `$Error_struct` → 1 (§1729
  universal-object rule; these are all real objects).
- `x instanceof Function` for a WasmGC closure → 1 (#1992 fix; currently false).
- Cross-type collection assertion (`set instanceof Map`) — carry the #2605
  documented `$Map`-shared imprecision; do not silently regress.
- TypedArray views (`u8 instanceof Uint8Array`) — brand-gated (#2893/#2872);
  defer, never emit a false positive against `$Vec`.
- Statically-primitive RHS (`x instanceof 1`) — unchanged, throws at codegen
  (`identifiers.ts:1310`).
- gc/host mode: every new arm gated `noJsHost(ctx)` / the native-helper set —
  gc/host must be **byte-identical** (assert with a small compile-diff probe,
  per #2907's methodology).

### Regression-risk mitigation

- **Byte-inert for gc/host**: all changes behind `noJsHost(ctx)` /
  `ctx.standalone || ctx.wasi` gates; the host `__instanceof*` path is untouched
  when a JS host is present.
- **The static path already resolves the common cases** (`tryStaticInstanceOf`,
  `identifiers.ts:1105`) — native codegen only affects the DYNAMIC residual, so
  the blast radius is the any-LHS / dynamic-RHS subset.
- **Never emit a wrong `true`**: where a builtin's native backing struct is
  ambiguous (TypedArray/`$Vec`) or the RHS identity is unresolvable, return the
  conservative `0` / `2`, never a false positive — a false `true` is a
  correctness regression, a false `false` is only a missed conversion.
- **Full `merge_group` validation required** (substrate replacement, broad
  impact — per `project_broad_impact_validate_full_ci`): do NOT gate on a scoped
  sweep. Watch the standalone floor and the `built-ins/*` + `language/*`
  merge-shard reports.

### Corpus-verify plan

- Leak-probe (per #2907 methodology) over `test/language/expressions/instanceof/`
  (~43 files, local sweep was 28 pass / 15 fail #2740) + the `built-ins`
  `isPrototypeOf` / `Function/prototype` families, `--target standalone`, count
  `env::__instanceof*` / host-method leaks → 0.
- Confirm `net_per_test > 0`, ratio < 10%, no bucket > 50 on the standalone
  shard before enqueue.
- Regression control: verify `x instanceof Error/TypeError` (already native,
  #1536c/#2188) and native-collection instanceof (#2605) stay green.

### Split recommendation

**Split into two dev slices, spec'd together (shared proto-walk substrate):**

- **Slice A** (medium, byte-inert): generalize the native inline string-name
  branch — captures the dominant `__instanceof` leak (bulk of ~31). Land first.
- **Slice B + C** (large, harder): native `__instanceof_check` /
  `__instanceof_dyn` fully-dynamic tri-state + the `isPrototypeOf` generic
  residual, sharing `emitProtoChainWalk`. Depends on Slice A landing.

## Acceptance

> **RE-GROUNDED 2026-07-31 — baseline counted BEFORE implementing**, so the
> result cannot be rationalised afterward. Population and ceiling below are
> measured row counts, not the superseded "~31" estimate.
>
> **READ THE TIERING FIRST — test262 rows are the SECONDARY metric here, not the
> deliverable.** `goal: standalone`, under umbrella #2860. The deliverable is
> **import elimination**. A leaked `env::__instanceof_check` means standalone
> mode is _not actually standalone_ for any program using `instanceof` with a
> dynamic RHS — ordinary code, not an edge case. The product claim is "JS host
> optional"; an import that fires on ordinary `instanceof` falsifies that claim
> **regardless of how many conformance rows move**. Anyone sizing this by row
> count is measuring the wrong thing.

### PRIMARY acceptance — binary, and the actual deliverable

Both imports gone, verified **per shape** rather than on one sample:

- `env::__instanceof_check` absent for **all four** dynamic-RHS variants:
  any-typed local · fn-valued param · property access · call result.
- `env::Object_isPrototypeOf` absent for the dynamic-receiver form.
- The already-clean shapes stay clean: builtin-name RHS, user-class RHS, Error
  family, and static `C.prototype.isPrototypeOf(a)`.

This either holds or it does not. **If it fails, stop and report — do not pursue
rows.** The import is the thing.

### SECONDARY acceptance — rows, expected ~4, ceiling 24

Quoted **with** its decomposition so `≤24` cannot be read as the target: of the
24 leaky-PASS rows, only **4** carry a `host_import_leak` signature. Out of
scope: 8 `runtime-eval`, 3 TypeError-not-thrown, 3 null/undefined conversion,
3 `compile_error`, 6 assorted.

**A row that stops leaking but still fails is a NEW FINDING, not a shortfall.**
Removing an import makes a module _instantiate_; it must then still produce the
right answer. Such a row is a second defect wearing the first one's clothes —
report it as its own observation rather than counting it against this issue.

**Measured baseline** — host baseline vs standalone baseline, joined on `file`:

| population (path-matched)           |   rows |
| ----------------------------------- | -----: |
| `instanceof` / `Symbol.hasInstance` |     56 |
| `isPrototypeOf`                     |     10 |
| **total population**                | **66** |

| leaky-PASS (host `pass`, standalone not-`pass`) |   rows |
| ----------------------------------------------- | -----: |
| `instanceof`-ish                                |     22 |
| `isPrototypeOf`                                 |      2 |
| **addressable CEILING**                         | **24** |

**The ceiling is 24, but the leak-attributable subset is far smaller.** By
standalone failure signature, only **4** of the 24 carry
`host_import_leak: standalone target emitted host imports`. The rest fail for
causes this issue does not address:

|     n | standalone signature                                          | addressed here?           |
| ----: | ------------------------------------------------------------- | ------------------------- |
|     8 | `Import "js2wasm:runtime-eval"`                               | no — eval, separate issue |
| **4** | **`host_import_leak: … emitted host imports`**                | **yes**                   |
|     3 | `Expected a TypeError to be thrown`                           | unlikely                  |
|     3 | `TypeError: Cannot convert undefined or null to object`       | unlikely                  |
|     3 | `compile_error` (S11.8.6_A6_T3, A2.4_T3, primitive-prototype) | no                        |
|     6 | assorted single assertion failures                            | unknown                   |

**So the honest expectation is ~4 rows directly, ≤24 as an absolute ceiling** —
and "leaking ≠ flipping": removing the import makes a module _instantiate_, after
which it still has to produce the right answer.

### Criteria — how each tier is evidenced

The two tiers are stated above; these are the verification rules that apply to
them. Correctness constraints bind **both** tiers.

- **Primary evidence:** per-shape import-list assertion, on all four dynamic-RHS
  variants and the dynamic-receiver `isPrototypeOf` form — not on one sample.
  A single-shape probe is what let the original scope statement stand wrong, and
  what made this re-grounding's own first pass miss `isPrototypeOf`.
- **Secondary evidence:** A/B the 24 ceiling rows, reporting `before → after`
  **per row** rather than a net. Both lanes; a control that must hold under any
  spec version; **discard the run if the control fails**; state harness, lane,
  and both commit SHAs on every comparison.
- **Correctness (binds both tiers, and outranks both):** no wrong-`true`
  regression in the `instanceof` / `isPrototypeOf` corpus. A native tri-state
  that answers `true` too eagerly is **worse than the leak it replaces** — a
  leak fails loudly at instantiation, a wrong `true` passes silently.
- gc/host byte-identical (compile-diff probe).
- `merge_group` net: **subtract #3884's ~20 phantom `compile_timeout` credits
  before reading it.** With an expected effect of ~4 rows the phantom credit is
  roughly **five times the signal**, so an unadjusted net here is pure noise —
  not a weak positive, no information at all. This must be stated in the PR
  description, not just computed.

## Implementation Notes — Slice A landed (sendev-instanceof, 2026-07-01)

**Scope delivered: Slice A only. Slice B + C deferred (escalated to lead — NOT
churned).**

### Why this split (root-cause + measure-first)

Confirmed by broad standalone sweep (196 instanceof-using tests): the leak is
dominated by `env::__instanceof` on the _string-name_ path (~30 files), with a
smaller `__instanceof_check` fully-dynamic-RHS tail (~7). Crucially, the 12
leaky-PASSES _inside_ the `instanceof`/`isPrototypeOf` test directories are ALL
the hard cases — `symbol-hasinstance-*` (@@hasInstance dispatch, spec-declared
out-of-scope), `primitive-prototype`/`prototype-getter` (the reflective
`Get(C,"prototype")` crux sr-tail2 flagged), and non-callable-RHS `TypeError`
throws. Slice A converts NONE of those; they need Slice B's reflective
`.prototype` path, which is only tractable once the ctor-carrier grows a real
`.prototype`/brand (#2907 follow-up). Attempting a partial `__instanceof_check`
here is the "partial/wrong instanceof" graveyard, so it was deliberately left to
a follow-up rather than churned.

### What Slice A does (`src/codegen/expressions/identifiers.ts`)

On the `noJsHost` string-name path in `compileHostInstanceOf`, BEFORE the
`__instanceof` late-import, dispatch on the compile-time-known `ctorName` to an
inline native `ref.test` membership test
(`nativeBuiltinInstanceOfTypeIdxs` + `emitNativeInstanceOfMembership`):
`Array`→vec subtypes (`vecBaseTypeIdx` ∪ `vecTypeMap`), `Function`→closure root
structs (#1992), `Map`/`Set`/`WeakMap`/`WeakSet`→`mapTypeIdx` (#2605 shared-$Map
imprecision carried), `Number`/`String`/`Boolean`→wrapper structs. Error-family
keeps its existing native branch untouched. Any builtin not modeled here
(`Object`, `Date`, `RegExp`, `Promise`, `ArrayBuffer`, …) or an unresolvable
non-builtin ctor falls to a conservative `0` — a _missed conversion_, never a
wrong `true`. The host `__instanceof` import is NEVER emitted under `noJsHost`.

### Why this is regression-safe (the airtight part)

1. The `noJsHost` string-name branch _currently always leaks_ `__instanceof` →
   the module cannot instantiate standalone → **every reaching test already
   fails**. A native answer can only CONVERT a failing test, never regress a
   passing one (a standalone-passing test cannot contain a leaking instanceof).
2. gc/host is **byte-identical**: the branch is gated `noJsHost(ctx)`; verified
   with a 6-program binary-SHA compile-diff (branch == baseline, all match).
3. `ref.test` uses _type_ indices, which are rec-group / dead-elim stable — no
   funcidx-ordering hazard (cf. `dyn-read.ts:287`). No late-import shift added.

### Measured

Synthetic corpus: `__instanceof` leaks 21→2 (the 2 residual are Slice-B
`__instanceof_check`). Runtime correctness verified standalone: `[]`/Map/Set/
WeakMap → true, closure → true (#1992), primitive/null/non-matching → false,
Error-family preserved. Real-corpus dynamic-LHS conversion confirmed
(`RegExp.prototype.exec(...) instanceof Array`, an `any`-typed result, flips
sa-fail→sa-pass; baseline fails). Note: many statically-typed `instanceof Array`
sites were already resolved by `tryStaticInstanceOf`, so the _net_ Slice-A yield
is the dynamic-LHS residual; the `new Number()`-wrapper cases do NOT convert
because `new Number(x): any` collapses to a boxed primitive (a separate
representation gap, #1111/#2503), not `$WrapperNumber` — kept in the set but
harmless (never a wrong `true`). Authoritative conversion count = `merge_group`
`net_per_test`.

### Deferred to follow-up (NOT in this PR)

- **Slice B**: native `__instanceof_check`/`__instanceof_dyn` fully-dynamic
  tri-state (reflective `.prototype`, non-callable-RHS throw). Needs the
  ctor-carrier `.prototype`/brand infra (#2907 follow-up) first.
- **Slice C**: `isPrototypeOf` generic-host-method residual (1 leaky-PASS in the
  corpus) — shares Slice B's proto-walk substrate; deferred with B.
- **Slice A tails**: `Object` (needs a struct-minus-boxed discriminator to avoid
  a wrong `true` on boxed primitives), `Date`/`RegExp`/`Promise`/`ArrayBuffer`
  membership (readable backing-struct idxs not yet wired), TypedArray brand
  (#2893/#2872).

## Reconciliation note (shepherd, 2026-07-01)

Landed slice: **Slice A** standalone native `instanceof` builtin membership (PR #2418). Issue stays `in-progress` for the remaining instanceof/isPrototypeOf slices.

## Implementation Plan (Fable, 2026-07-18) — Slice B/C unblocked: the branded intrinsic-carrier substrate now has a concrete design

### Verify-first state (current main + in-flight)

The Slice-A deferral said B/C wait on "ctor-carrier `.prototype`/brand infra
(#2907 follow-up)". That substrate now has all its raw parts on main — they
just aren't connected:

- **Ctor carriers exist and are identity-stable** but are _unbranded, empty_
  `$Object`s: the #2907 namespace/Error carriers
  (`src/codegen/builtin-static-globals.ts`, `SUPPORTED_STATIC_PROPS`) and the
  #3006 per-name `__builtin_ctor_<Name>` singletons
  (`BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` `:79`,
  `emitBuiltinConstructorIdentity` `:119` — lazy `__new_plain_object` behind a
  null-guard). At runtime nothing distinguishes the `Set` carrier from the
  `Map` carrier or from a user object.
- **Native proto objects exist**: the #2175 `$NativeProto` brand registry
  (`native-proto.ts`, `tryEnsureNativeProtoBrand` + `emitLazyNativeProtoGet`)
  materializes `<Builtin>.prototype` as a real value with member glue.
- **User-class `[[Prototype]]` links**: #2580 M3 (in-progress, `sd-2580`) is
  landing the `$Object.$proto` walk substrate; Slice B's user-class arm and
  Slice C consume it — predecessor-stack on it, do not invent a parallel walk.
- **#2917 slice 1 (PR #3324)** made subclass instances REAL native backings
  (no wrapper) and explicitly delegates "dynamic `instanceof Sub` + sibling
  discrimination" to this issue's Slice B.

### B0 — the `$BuiltinCtor` branded carrier (the shared substrate; also serves #2651 M3)

Replace the plain `$Object` allocation in the identity-carrier sites with a
**subtype**:

```
$BuiltinCtor <: $Object { …$Object fields…, (field $ctorBrand i32) }
```

- `ctorBrand` = the SAME brand id space `native-proto.ts` already assigns
  (`tryEnsureNativeProtoBrand`), so one number keys both "which builtin am I"
  and "which `$NativeProto` is my `.prototype`". `%TypedArray%`
  (`BUILTIN_BRAND_BASE+3`, glue already registered per #2651 M1) fits with no
  new machinery — this struct IS the intrinsic-constructor VALUE #2651 M3
  needs `Object.getPrototypeOf(Int8Array)` to return.
- Being an `$Object` subtype, every existing object-runtime native
  (`__extern_get/set`, freeze/seal, `Object.keys`) accepts it unchanged
  (they take `(ref $Object)` / `ref.test $Object` — a subtype passes). The
  carriers stay extensible expando objects exactly as today.
- Allocation: a sibling `__new_builtin_ctor(brand: i32)` beside
  `__new_plain_object` (object-runtime.ts); `emitBuiltinConstructorIdentity`
  and `emitBuiltinNamespaceObject` push the brand const. **No `ref.func`
  operand** → keeps the const-free lazy-init shape (the funcidx-shift
  immunity the #3006 comment documents).
- **Registration discipline**: the struct type is registered by the same
  `ensureObjectRuntime` slot (reserve up-front; type indices are
  rec-group/DCE-stable — the same argument Slice A already relies on).

Two finalize-spliced read arms on the branded carrier (reserve/fill, the
`fillBuiltinFnMeta` pattern in `object-runtime.ts`):

1. **`.prototype`** — `__extern_get` gains a front arm: receiver
   `ref.test $BuiltinCtor` and key == "prototype" → `emitLazyNativeProtoGet`
   glue for `ctorBrand` (returns the `$NativeProto` externref). This is what
   makes the DYNAMIC read (`const C: any = Set; C.prototype`) resolve — the
   syntactic `<Builtin>.prototype` fast path is untouched.
2. **`.name`** (cheap, same arm) — the builtin name string per brand
   (§10.2.9); `.length` optional follow-up via the same per-brand table.

Own-property semantics: the arm must be **miss-gated the other way** — an own
sidecar prop set on the carrier (`Set.prototype = x` is non-writable per spec,
but expandos like `Set.foo = 1` are legal) keeps working because the arm fires
only for the exact keys it owns and only when no own entry shadows them
(check the `$props` hash first, mirroring the #2963 method-arm's own-read-
first discipline).

### Slice B — native `__instanceof_check` / `__instanceof_dyn` (re-spec on B0)

The 2026-07-01 Slice-B sketch stands structurally (native DEFINED tri-state
helper, `ensureLateImport` native routing, `emitInstanceofThrowGuard` reuse);
B0 fills the hole that made it intractable. RHS classification ladder inside
the helper (first hit wins):

1. `ref.test $BuiltinCtor` → read `ctorBrand` → dispatch to the Slice-A
   membership test **by brand at runtime** (a `br_table`/if-chain over the
   same `nativeBuiltinInstanceOfTypeIdxs` arms Slice A emits inline for
   static names — extract the arm bodies into per-brand helpers so both
   sites share one implementation).
2. RHS is a **user-class constructor object** → resolve its class id (the
   #2188/`$ClassMeta` brand or the class-object representation current at
   build time) → `Get(C, "prototype")` → the #2580 M3 `$proto`-chain walk on
   the LHS (`emitProtoChainWalk`, shared with Slice C).
3. RHS is a **closure** with no resolvable brand → conservative `0`
   (unchanged rationale: matches host `runtime.ts:2385`).
4. RHS non-callable object → `2` (throw via `emitInstanceofThrowGuard`);
   primitives/null/undefined → `0` at the dynamic path (the static-primitive
   throw stays at codegen). `@@hasInstance` dispatch remains out of scope —
   documented gap, conservative branch, never a wrong `true`.

Also route the residual **`instanceof Sub`-dynamic** case #2917 delegated
here: a subclass RHS resolves through arm 2 when the subclass has a
`$proto`-linked prototype object; where the instance backing carries no proto
slot (real `$Vec`/`$Date` backings — the #2917 accepted cost), the walk
answers `0` for the SUBCLASS while arm 1 answers `1` for the BUILTIN — which
is exactly the `combined instanceof Set === true` /
`instanceof MySet === false` split #2622's rows assert. A wrong `true` is
forbidden; a missed subclass `true` (e.g. `s1 instanceof MySet` on a bare
backing) is a recorded limitation until a branded backing exists (see #2622's
`$MapSub` — its `classId` field slots into arm 2 as a fast pre-check).

### Slice C — `isPrototypeOf` residual (unchanged from the 2026-07-01 spec)

Rides `emitProtoChainWalk` from Slice B step 2; route the generic
extern-method fallback to the existing native `__isPrototypeOf`. No changes
to the earlier sketch beyond using the #2580 M3 walk.

### Ordering / risk

- **B0 first** (S–M, byte-inert until an arm fires; carriers change struct
  type but no consumer reads their exact type today — verify with
  `prove-emit-identity` + the #3006 identity tests).
- **Slice B** after B0 AND after #2580 M3 lands (predecessor-stack for arm
  2); arm 1 alone (builtin RHS) is landable before #2580 M3 if split.
- **Slice C** with/after B.
- Every rule from the 2026-07-01 plan's regression-mitigation section stands
  (never wrong-`true`; `noJsHost` gating; full `merge_group`; leak-probe
  corpus). Coordinate with #2651 M3 (consumes B0 — do not let sd-2651 mint a
  parallel carrier) and #2622 (consumes the arm-1/arm-2 split above).

---

## PARTIAL LANDING 2026-08-08 — Slice C done, Slice B step 1 + step 4 done

A slice of this issue landed as part of the **ES5-standalone-90 WP5** sweep
("remove the instanceof / isPrototypeOf host-import leaks"). It does **not**
close the issue: the reflective `Get(C, "prototype")` off an arbitrary runtime
callable — Slice B's crux — is still unimplemented, and is what the remaining
8 leaking files need.

### Measured before / after (`--target standalone`, module import list)

Source: the ≤ES5 failure census `.tmp/es5-buckets.json` (2026-08-07 baseline),
re-probed file by file on this branch.

| host import                | files gated before | still leaking after | now PASS |
| -------------------------- | ------------------ | ------------------- | -------- |
| `env::Object_isPrototypeOf` | 9                  | **0**               | 3        |
| `env::__instanceof_check`   | 10                 | 8                   | 2        |

The 6 `isPrototypeOf` files that no longer leak but still fail moved from
`host_import_leak` (unsatisfiable module) to honest `assertion_fail` on
*unrelated* assertions (`x.constructor.prototype`, `new Object.prototype.constructor`,
the `$proto` seeding gap below).

### What landed

- **Slice C — `isPrototypeOf` residual.** New `src/codegen/native-is-prototype-of.ts`.
  Both dispatchers that can reach the method now share one answer: the #2994
  static folds, then the WasmGC-native `$Object.$proto` walk (`__isPrototypeOf`).
  The TYPED-receiver path (`compileExternMethodCall`, extern.ts) previously had
  neither and always emitted `env::Object_isPrototypeOf`, because `Object` is
  the ROOT extern class and every extern class inherits its prototype methods —
  so the leak fired on any receiver the checker typed as an interface. Two new
  folds: `X.prototype.isPrototypeOf(v)` where `v`'s type IS the builtin instance
  interface `X`, and `Object.prototype.isPrototypeOf(b)` where `b` is a
  single-assignment binding provably holding a fresh object.
- **Slice B step 4 (non-callable RHS ⇒ TypeError)** and **the builtin-alias
  case**. New `src/codegen/native-ordinary-instanceof.ts`. §7.3.20 step 1 now
  throws in wasm when the RHS is a provably non-callable object, and
  `var OBJECT = Object; x instanceof OBJECT` resolves the builtin behind the
  alias so the Slice-A builtin dispatch is not skipped.
- Regression test: `tests/es5-standalone-instanceof.test.ts` (10 cases, each
  asserting BOTH the answer and a zero-import binary).
- `tests/issue-2994.test.ts`'s "does NOT mis-fold" case was rewritten: its
  proof of "not folded" was the PRESENCE of `env::Object_isPrototypeOf`, which
  is exactly the leak being retired. It now proves the same property by the
  answer (`0`) plus a zero-import binary.

### What is still open (the 8 remaining `__instanceof_check` files)

1. **`obj instanceof FACTORY`, `FACTORY` a runtime `Function(…)` value** —
   `S15.3.5.3_A2_T2/T5/T6`, `_A3_T1/T2` (5 files). Needs Slice B's reflective
   `Get(C, "prototype")` off an arbitrary callable. Deliberately left on the
   host import rather than answered wrongly.
2. **`(OBJECT = Object, {}) instanceof OBJECT`** — `S11.8.6_A2.4_T1/T3`
   (2 files). The RHS binding's static type is `number` (its declared
   initializer), so the alias rule cannot see the builtin; a union-based fold
   would be unsound.
3. **`S11.8.6_A6_T4`** (1 file) — its `instanceof MyFunct` arm leaks because
   `tryEmitNativeUserCtorInstanceOf` (#3962) requires `ctx.topLevelFunctionNames`,
   which holds only for function DECLARATIONS, not `var F = function(){}`. Note
   the file would still fail after that: its CHECK#3 needs
   `instanceof Object` on a `$Object`, which `nativeBuiltinInstanceOfTypeIdxs`
   deliberately does not model.

### Adjacent gap found while measuring — the `$proto` seeding, not instanceof

`F.prototype.isPrototypeOf(new F())` answers **0**, and so does
`__PROTO.isPrototypeOf(__monster)` after `__FACTORY.prototype = __PROTO`
(`S13.2.2_A1_T1/T2`, `S8.6.2_A1` CHECK#2.2/#3.2). The chain walk is correct;
the instance's `$Object.$proto` is simply not seeded from the per-fnctor
prototype global except for #2660-S3a-approved reconstructions, and a fnctor
value is not an `$Object` so it cannot be stored in `$proto` at all. That is
#2660 M3 substrate work, which this issue already names as a predecessor.

### 2026-08-08 — the 8 `S15.3.5.3_A1_T*` "regressions" were an INSTRUMENT ARTIFACT, not this change

A scoped standalone validation run on the integration branch reported
`S15.3.5.3_A1_T1 … T8` as pass→fail against the partial landing above, all with

```
TypeError: dynamic code evaluation is not supported in this standalone build
(no js2wasm:runtime-eval interpreter linked — tracking: #2928)
```

**They are not regressions.** A/B measured with the real instrument
(`runTest262File`, `--target standalone`) at `a8bbc0d7` (base) vs `4c2c4448`
(this work), all eight files:

| runtime-eval tier                                | base    | this change |
| ------------------------------------------------ | ------- | ----------- |
| INTERPRETER (`TEST262_FULL_RUNTIME_EVAL=1`)      | 8× PASS | 8× PASS     |
| REFUSAL (the default when the full cache is cold) | 8× FAIL | 8× FAIL     |

Both sides move together on both tiers. The delta is the TIER, not the commit.

**The quoted error text is itself the tell.** That sentence is emitted by the
REFUSAL provider, which `selectCachedRuntimeEvalProvider` announces on stderr as
"fast local diagnostic only, **NOT CI-comparable**". Comparing a refusal-tier run
against a baseline captured on the interpreter tier turns every eval-dependent
test into a phantom regression — and `assembleOriginalHarness` injects a
`$262.evalScript` shim containing a direct `eval` into EVERY assembled test, so
the eval-dependent set is large, not exotic.

**Before attributing an eval-shaped standalone regression to a compiler change:**

```bash
node scripts/build-runtime-eval-provider.mjs        # ~3 min, once (cached)
TEST262_FULL_RUNTIME_EVAL=1 <run the lane>          # authoritative, CI-comparable
```

Without the env var the lane silently selects REFUSAL even when the full
provider is cached (`TEST262_FULL_RUNTIME_EVAL` is an explicit opt-in, not a
cache-presence check), and the single stderr announcement is easy to lose in a
long log. Read the `runtime-eval tier:` line before trusting a pass→fail list.

`tests/es5-standalone-instanceof.test.ts` now pins the compile-level property
those eight files depend on — the §7.3.20-step-1 non-callable rule must DECLINE
for a `Function(…)`/`new Function(…)`-valued RHS — across all three declaration
spellings, so the real hazard is caught in the fast lane instead of only in a
lane that has the interpreter linked.

---

## SLICE B LANDED 2026-08-15 — the fully-dynamic RHS is host-free (`native-dynamic-instanceof.ts`)

`env::__instanceof_check` is **gone from every dynamic-RHS shape**. The residual
arm `emitDynamicInstanceOf` now calls a DEFINED native tri-state helper
(`__instanceof_dynamic`) instead of the host predicate. `emitInstanceofThrowGuard`
is reused unchanged — the helper returns the SAME 0/1/2 contract the import did.

### PRIMARY acceptance — met, measured per shape (not on one sample)

Instrument: `compile(src, { target: "standalone" })`, reading the module's
`imports` list. Verified against the standalone baseline JSONL first — the raw-file
import probe reproduces the baseline's `compile_error` set for
`language/expressions/instanceof` **exactly** (same 11 files), so it is the same
instrument CI applies.

| shape                                            | before                    | after     |
| ------------------------------------------------ | ------------------------- | --------- |
| `a instanceof K`, `K` an `any`-typed local       | `env::__instanceof_check` | **clean** |
| `x instanceof K`, `K` a fn-valued param          | `env::__instanceof_check` | **clean** |
| `a instanceof holder.K` (property access)        | `env::__instanceof_check` | **clean** |
| `a instanceof mk()` (call result)                | `env::__instanceof_check` | **clean** |
| `o instanceof (o = 0, Object)` (comma expr)      | `env::__instanceof_check` | **clean** |
| `p.isPrototypeOf(a)`, `p` a dynamic receiver     | clean (Slice C, 08-08)    | clean     |
| builtin-name RHS · user-class RHS · Error family | clean                     | clean     |
| static `C.prototype.isPrototypeOf(a)`            | clean                     | clean     |

Corpus sweeps on this branch:

- `language/expressions/instanceof` — **43 files, 0 leaking** (was 11 leaking).
- The **59 files that name `env::__instanceof_check` as their SOLE host import**
  on the 2026-08-15 standalone baseline — **0 leaking, 0 compile-refused,
  0 invalid Wasm** (each binary was `WebAssembly.compile`d). Of those 59, **20
  actually still leak on this branch's base**; the other 39 are stale baseline
  entries already clean before this change (see SECONDARY acceptance).
- gc/host **byte-identical**: sha256 of the compiled binary matched base on all
  10 probe shapes (file-copy A/B on `identifiers.ts`). That is a SAMPLE, and it
  is stated as one; what makes it a general claim is structural — the call site
  is behind `noJsHost(ctx)`, which is exactly `ctx.wasi || ctx.standalone`
  (`js-errors.ts:29`), so no gc/host compile can reach the new code at all. The
  10 shapes are chosen to exercise every dispatch arm, i.e. they test the GATE,
  not the population.

### The answer table, and why each arm is the least-wrong one available

Full rationale in the module header of `src/codegen/native-dynamic-instanceof.ts`.

| RHS at runtime                           | answer       | basis                                                                                     |
| ---------------------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| `null` / `undefined`                     | 0            | host dynamic-path parity (`runtime.ts:2353`); keeps `S15.3.5.3_A1_T1…T8` at `false`         |
| callable, OWNS a `prototype` property    | §7.3.20 full | an own-property read on a real `$Object` is authoritative: present-but-non-object ⇒ 2, else the `$proto` chain walk decides |
| callable, no modelled `prototype`        | 0            | prototype not modelled — **the documented residual**                                        |
| anything else, incl. genuine primitives  | 0            | there is no SOUND runtime primitive test in this backend — see "no wrong throws" below      |

Three design points worth keeping:

1. **IsCallable is asked of `__typeof_function`, not of a snapshotted type list.**
   That native is finalize-corrected (`typeof-natives-finalize.ts`), so it sees
   every closure root and every branded carrier regardless of where in the module
   the `instanceof` site lowers. A membership snapshot taken at build time is the
   order-dependence #4276 documents; this helper cannot inherit it.
2. **The brand bit is read DIRECTLY** (`$Object.flags & OBJ_FLAG_CALLABLE`) rather
   than through `buildBuiltinBrandTestArm`, whose emptiness depends on whether any
   carrier had been branded YET — and the helper is minted at the FIRST dynamic
   site, which can precede every carrier.
3. **The `prototype` arm is gated on `__hasOwnProperty`, not on `Get` returning
   something.** `Get` returning nothing has two causes the spec treats oppositely:
   the program set `F.prototype = undefined` (§7.3.20 step 5 ⇒ TypeError), or the
   backend does not model a `prototype` on that carrier (⇒ nothing is known). The
   own-property probe separates them.

### No wrong throws — the measurement that changed the design mid-flight

The first cut threw (tri-state `2`) whenever the target was not classifiable as an
object, per §13.10.2 steps 1/4. **That is unsound in this backend.** An unmodelled
builtin constructor is lowered to a boxed-primitive carrier, so the shared
classifiers answer **`typeof Int8Array === "boolean"`** (probe-verified on this
branch) — every "is the target a primitive" predicate built on them mistakes a
real constructor for a primitive.

Caught by the corpus sweep, not by reasoning:
`built-ins/TypedArrayConstructors/ctors/object-arg/iterator-is-null-as-array-like.js`
went from the host's `false` to `TypeError: Right-hand side of 'instanceof' is not
callable` at `assert(typedArray instanceof TypedArray)`. A wrong THROW is
observable in a `catch` and passes/fails tests for the wrong reason; a wrong
`false` is only a missed conversion. The arm was removed.

**Nothing provable was lost.** A statically-primitive RHS and a provably
non-callable object RHS both still throw at codegen, one dispatch step earlier
(`compileHostInstanceOf`'s §13.10.2-step-1 fold and `tryEmitNonCallableRhsThrow`),
where the evidence is the static TYPE rather than a runtime representation the
backend gets wrong. Both shapes are pinned in
`tests/es5-standalone-instanceof.test.ts`, along with the `Int8Array` regression
pin for the misfire itself.

**Follow-up worth filing separately:** `typeof Int8Array === "boolean"` under
`--target standalone` is a real bare-value representation gap (the TypedArray
constructors have no `__builtin_ctor_*` carrier, unlike the #3006/#4223 set). It
is not caused by this change and is not fixed by it, but any future runtime
primitive/callable predicate will trip on it exactly as this one did.

Index-space discipline: `mintDefinedFunc` + `pushDefinedFunc` in one call, so the
handle is stable-regime (shifter-immune) and the body's baked callee indices are
walked by the ordinary late-import body shifter. **Nothing is minted at finalize**
(the #4221 hazard).

### SECONDARY acceptance — rows

**+3 conversions, 0 regressions.** The live population is **20 files, not 59** —
that correction is the last one on this issue and it came from applying the
provenance habit to my own headline number.

The 59 came from the 2026-08-15 baseline, which records them as `compile_error`
`host_import_leak`. Compiled on THIS BRANCH'S BASE, only **20 still emit
`env::__instanceof_check`**; the other 39 are already import-free (stale entries,
resolved by earlier slices). So 39 of the 59 were never mine to convert.

| the 20 that genuinely leak on base | after |
| ---------------------------------- | ----: |
| **pass**                           | **3** |
| fail                               |    17 |

The three: `built-ins/Promise/prototype/finally/subclass-species-constructor-{reject,resolve}-count`
and `language/expressions/instanceof/S11.8.6_A2.4_T3`. All three leak on base ⇒
CI scores them `compile_error` ⇒ pass-after is a genuine conversion.

**`built-ins/Array/fromAsync/this-constructor` is NOT a conversion** and was
counted as one in the first cut. It does not leak on base, and A/B measurement
shows it PASSES on base and on branch. It is a stale baseline entry that my
change cannot touch — the code only fires where the import would have been
emitted.

Why the first cut got it wrong: I measured the 59 only AFTER, then attributed
every pass to the change because the baseline said they were all `compile_error`.
The baseline was the artifact; "all 59 leak" was the figure inherited from it.
The fix is one extra run — the same corpus on base — and it is the run that turns
"4 files pass now" into "3 of them pass BECAUSE of this".

**Scope note — the first cut of this table reported 24 `skip` and was NOT
CI-comparable.** The local runner's DEFAULT scope excludes proposals, so 21
Temporal files and 3 source-phase-import files came back `skip`. **CI does not
skip them**: the standalone baseline records all 24 as `compile_error` with the
`env::__instanceof_check` leak, which is only possible if they ran. Re-measured
under `TEST262_INCLUDE_PROPOSALS=1` they all `fail` (Temporal is not implemented
at all — `ReferenceError: Temporal is not defined`), so the conclusion is
unchanged, but the tally now matches the lane that scores it.

Worth generalising, because it is the same shape as the two other instrument
traps recorded on this issue: **a `skip` in a local run is a statement about the
LOCAL scope filter, never evidence that CI skips the file.** Read the baseline's
recorded status for that file before treating a skip as "not counted". (Same
trap, different guise: `CLAUDE.md`'s skip list names `top-level-await` as a
feature skip and `shouldSkip` has no such branch — flagged by the #4433 lane,
which nearly dismissed four real regressions on it.)

**`language/expressions/instanceof` (43 files).** The before/after *answer* runs
are **byte-identical** — every one of the 11 previously-refused files produces
exactly the answer the host `__instanceof_check` produced. That is the
correctness evidence: the native tri-state reproduces the host's observable
behaviour on this corpus, it does not merely stop leaking.

(The one diff that DID appear between the two intermediate corpus runs was the
`%TypedArray%` wrong throw described above, and the fix restored exact host
parity there too — a single line changed back to `Expected true but got false`.)

Also green on this branch: all **8 equivalence shards**
(`scripts/equivalence-gate.mjs`, "No new equivalence regressions"), and
`tests/es5-standalone-instanceof.test.ts` (20),
`tests/issue-3962-native-user-instanceof.test.ts`,
`tests/issue-4276-instanceof-object-family.test.ts`, `tests/issue-2994.test.ts`.

### Was the 59-file population itself a hiding filter? Checked — no, but it exposed a stale scale claim

The conversion count came from the **59 sole-leak** files, which is a FILTER: the
baseline also lists **1,501 files naming `env::__instanceof_check` alongside other
imports**, excluded on the assumption "they keep leaking the others, so they can't
convert". That assumption was never measured, and it is derived from the
baseline's error STRINGS rather than from compiling on this branch's base — so if
another lane eliminated a co-occurring import after the baseline was captured, the
file is effectively sole-leak now and this change converts it. That would be a
conversion the count MISSES.

Measured: 150-file deterministic sample (seed 20260815) of the 1,501, compiled on
branch and on base.

| | branch | base |
| --- | ---: | ---: |
| zero-import | 131 | 131 |
| still leaking | 19 | 19 |
| **still emitting `__instanceof_check`** | **0** | **0** |

Output byte-identical between the two trees. **Two findings:**

1. **The filter hid nothing attributable to this change** — zero delta on the
   sample, so 59 stands as the population this change converts.
2. **The baseline's co-leak population is materially STALE, and the "1,560 files
   name it" figure must not be quoted as scale.** Not one sampled file still
   emits `__instanceof_check` on current main; earlier slices (#2998, #3962,
   Slice A, #4276) resolve those sites statically now. Corrected in the module
   header, which had quoted 1,560.

The check was worth running for the second finding alone, and the reasoning that
would have skipped it — "those files keep leaking anyway, it wouldn't move the
number" — is exactly the reasoning that keeps an unexamined filter alive.

### The WASI half of the gate, measured rather than inferred

`noJsHost` is `ctx.wasi || ctx.standalone` (`js-errors.ts:29`) — **two** targets,
and the test262 lane measures only the first. The "cannot regress a passing test"
argument was therefore verified for standalone (leak guard + baseline) and merely
INFERRED for WASI ("an unsatisfiable `env::` import cannot instantiate under
wasmtime"). That inference is sound but it is not a measurement, and a WASI unit
test can assert compile-time properties without ever instantiating — so the
inference does not even cover the shape most likely to notice.

Measured instead. All **199 test files that compile with `target: "wasi"`**, run
on this branch and on base (file-copy revert of `identifiers.ts`), comparing
sorted failing-test NAMES rather than counts:

| batch          | base | branch | name-set diff |
| -------------- | ---: | -----: | ------------- |
| files 1–67     |   49 |     49 | **identical** |
| files 68–199   |   55 |     55 | **identical** |

104 pre-existing failures (linear-IR families unrelated to this issue), **zero
delta**. The WASI lane is inert to this change, as measured.

### Deliberately left, with reasons

- **A closure RHS answers `false`, not the spec's `true`/TypeError.** A standalone
  function value is a WasmGC closure-wrapper struct and its prototype object lives
  in a per-fnctor module global keyed by the COMPILE-TIME symbol name
  (`fnctor-prototype.ts`); there is no runtime edge from the value to that global.
  Probe-verified on this branch: a dynamic `k["prototype"]` read answers
  `undefined` for a `function` declaration, a `var F = function(){}` and a `class`
  alike. So `S15.3.5.3_A2_T2/T5/T6` (want a TypeError for a non-object
  `F.prototype`) and `_A3_T1/T2` (want a chain-walk `true`) keep failing.
  Answering `2` would assert "F.prototype really is a non-object" and `1` would
  assert membership — neither is known, and both are worse than a missed
  conversion. Closing this needs the #2660 M3 closure→prototype substrate.
- **`@@hasInstance` dispatch** — unchanged, still out of scope
  (`symbol-hasinstance-*`, 4 files).
- **`instanceof Object` on a `$Object`** — #4276's lane, deliberately untouched
  (`S11.8.6_A1`, and `S11.8.6_A6_T4` CHECK#3 which blocks that file regardless).
- **The §13.10.2 step 1/4 TypeError for a RUNTIME non-object / non-callable RHS**
  — see "no wrong throws" above. Statically provable cases still throw.

### What is left to close this issue

Slice B's substrate is in place; the issue stays `in-progress` because the
closure arm is still conservative. **Exactly one dependency remains**: a runtime
edge from a closure value to its prototype object (#2660 M3). With it, the
`ownedPrototypeOrdinaryHasInstance` arm applies unchanged to closures and the
`S15.3.5.3_A2_*` / `_A3_*` family becomes answerable.

> **UPDATE 2026-08-15 — #2660 M3 LANDED; this dependency is CLOSED. The
> `S15.3.5.3` family is NOT, and the reason is three separate other defects.**
>
> `src/codegen/closure-prototype-edge.ts` supplies the edge
> (`__closure_proto_of`, an identity-keyed match against the
> `__fn_closure_<name>` / `__class_<Name>` singletons, answering the SAME
> prototype object the `[[Prototype]]` seeding uses). This module's callable arm
> now (a) does the own-`prototype` read for a NON-`$Object` callable — a closure,
> whose own props live in the #3468 bag — and (b) falls through a hasOwn miss to
> the edge instead of returning 0, and (c) consults the edge on the NOT-callable
> tail too, because a class value is `typeof "object"` here.
>
> Measured, `--target standalone`, whole `language/expressions/instanceof`
> directory A/B through file-copy reverts: **24 → 26 pass, zero regressions**,
> every other row byte-identical.
>
> | file | result | if still failing, the blocker is |
> | --- | --- | --- |
> | `S15.3.5.3_A2_T2` | **fail → pass** | — |
> | `S15.3.5.3_A2_T6` | **fail → pass** | — |
> | `S15.3.5.3_A2_T5` | fail | `new <Function(src) value>` evaluates to **null**, so §7.3.20 step 3 returns `false` before the prototype read. Runtime-eval lane (#2928/#4242). |
> | `S15.3.5.3_A3_T1` | fail | same, plus `FACTORY.prototype.type=1` on a value with no compile-time prototype global. |
> | `S15.3.5.3_A3_T2` | fail | `Object.prototype.isPrototypeOf({})` is `false` on base AND branch — the plain-object `$proto` → `Object.prototype` link (#4172 slice 2 / #4160). |
>
> The own-`prototype` half was verified to work on a `Function(src)` callable in
> isolation (`hasOwnProperty(FF,"prototype")` is `true` after a write), so the
> three residual files are not blocked by anything in this module. The
> "documented residual" paragraph above and in the module header — *a closure RHS
> answers `false`* — no longer holds for a closure that owns a `prototype` or has
> a compile-time prototype global; it does still hold for a runtime-eval callable
> with neither.
>
> Full write-up, including the split-brain root cause (one property, two disjoint
> stores) and the gc/host byte-identity evidence, in
> `plan/issues/2660-fnctor-instance-dynamic-use-escape-gate.md` § "M3 — the
> closure → prototype runtime edge".

An earlier revision named the expression-statement elimination as a second
blocker for that family. It is not — see the correction below.

### Adjacent defect found while measuring — real, but it does NOT gate the A2/A3 family

**A bare `lhs() instanceof rhs();` expression STATEMENT at TOP LEVEL is
eliminated whole, including both operands' side effects.** Reproduced with a
builtin RHS (which never reaches this substrate) and on base `identifiers.ts`, so
it predates Slice B. Filed and fixed as #4433, which found the real scope is much
broader than `instanceof`: at top level every non-assignment binary operator, the
conditional operator, array/object literals and parenthesised compositions
dropped their operands' effects (`a() + b();` → neither call ran).

**CORRECTION — an earlier revision of this section claimed the elimination was a
*second* reason `S15.3.5.3_A2_T2/T5/T6` cannot pass. That was wrong**, and it is
worth recording *how* it was wrong because the mistake is cheap to repeat. The
measurement behind it was taken at TOP LEVEL; the three test files spell the
operator inside a `try`, and that difference is decisive —
`collectDeclarations` keeps a top-level `TryStatement` **wholesale** (the
control-flow arm, `declarations.ts` ~L2131), so its body lowers through the
ordinary in-function path, which has always compiled operands. Generalising a
top-level result to an inside-`try` context without re-measuring is the entire
error.

Re-measured on this branch with the counting probe (`order.length` after
`lhs() instanceof rhs()`, `lhs`/`rhs` both appending a marker):

| placement                    | operands evaluated |
| ---------------------------- | -----------------: |
| bare statement at top level  |                  0 |
| **inside a top-level `try`** |              **2** |
| inside a function            |                  2 |

Independently confirmed by the #4433 lane with the exact T2 shape instrumented
(base = fixed = 101: LHS runs, `instanceof` answers false instead of throwing),
and T2/T6 fail with the identical `#1.1: O is not an object` message before and
after that fix.

**So `S15.3.5.3_A2_T2/T5/T6` are blocked by the closure-RHS prototype residual
ALONE.** One thing to fix, not two.

The order-of-evaluation regression test in
`tests/es5-standalone-instanceof.test.ts` still binds its result, because it
probes the bare top-level form deliberately and this branch predates #4433.

### Instrument note for the next measurer

`runTest262File`'s ORIGINAL-HARNESS lane does **not** apply
`standaloneHostImportError` (the guard has a single call site, in the legacy
wrapper lane). A leaking module therefore still RUNS locally with the host
supplying the import, while CI records it as `compile_error`. A local pass/fail on
a leaking file is an upper bound on the host answer, **not** the verdict CI
scores. This is what makes the identical before/after answer runs above meaningful
rather than vacuous — and it is a trap for any "these tests pass locally" claim.

**Every A/B above reverted through `.tmp/identifiers.base.ts`, and that artifact
was verified byte-identical to base commit `88ff8c4` (`diff` against
`git show 88ff8c4:…`), not assumed.** One diff validates the whole chain — the
WASI 199-file run, the 59-file base sweep, the 150-file sample, the gc/host
shas, and the `%TypedArray%` wrong-throw diagnosis all rest on that one file
being what it claims to be.

**Operational rule, better than "always measure the before-state": make the
before-state CHEAP before you start.** Capture the revert copy at the FIRST
edit, when it costs one `cp` (CLAUDE.md's file-copy A/B pattern). Whether the
before-run happens turns out to depend less on discipline than on its price at
the moment you face it: the 11-file directory A/B got run because it was cheap,
the 59-file one got skipped because it was a corpus compile and the baseline was
sitting right there claiming to already know the answer.
