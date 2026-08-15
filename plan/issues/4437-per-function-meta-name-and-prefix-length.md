---
id: 4437
title: "ES5 standalone: per-function meta carrier — `name` as an own property + §15.1.5 `length` VALUE"
status: in-progress
assignee: ttraenkler/claude-es5-standalone
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function-objects, property-descriptors, own-properties
goal: standalone-gap
related: [2896, 3468, 4010, 4098, 4194, 4241, 4390, 4436]
umbrella: 2860
loc-budget-allow:
  # The minimal wiring a new subsystem module needs. All new logic is in the two
  # new modules (`function-instance-meta.ts`, `function-instance-meta-arms.ts`);
  # what lands in these three is 25 lines of frontmatter-style field docs, 8
  # lines of two extra native locals, and 2 lines threading one argument.
  - src/codegen/context/types.ts
  - src/codegen/object-runtime.ts
  - src/codegen/closures.ts
func-budget-allow:
  # +8 lines: two extra `registerNative` locals (`fnmeta` on `__builtinfn_get_meta`
  # / `__builtinfn_delete`, and on `__builtinfn_push_ownnames`). Appended LAST so
  # `fillBuiltinFnMeta`'s by-index reads of locals 2..5 are untouched. A local has
  # to be declared where the native is registered; there is no other site.
  - src/codegen/object-runtime.ts::ensureObjectRuntime
---

# #4437 — Per-function metadata carrier (`name` + §15.1.5 `length`)

The R1/R2 slice `plan/issues/4436-function-instance-own-properties-residual.md`
left unowned. #4436 made `length` a genuine own property of a user function
instance by answering every reflective surface from the `$arity` closure-header
slot; this closes the two residuals it recorded as **one** slice, because they
need the same substrate.

## Before-state (measured on this branch's base `f5e2fa6`, `--target standalone`)

Not inherited from the baseline artifact — every figure below is from a run of
`.tmp/run-one.mts` (the real `runTest262File`) on `f5e2fa6` sources, restored
from the `.tmp/base/*` copies captured at the first edit.

| read on `function f(a,b){}` / `function g(x=42,y){}` | base   | spec  |
| ---------------------------------------------------- | ------ | ----- |
| `f.name` (STATIC fold, typed receiver)               | `"f"`  | `"f"` |
| `f["name"]` (DYNAMIC key — what `verifyProperty` uses) | absent | `"f"` |
| `f.hasOwnProperty("name")`                           | false  | true  |
| `Object.getOwnPropertyDescriptor(f, "name")`         | undef  | desc  |
| `Object.getOwnPropertyNames(f)` ∋ `"name"`           | false  | true  |
| `g["length"]` (reflective)                           | **2**  | **0** |

`g`'s `length` is the R2 row: `$arity` is the DECLARED FORMAL COUNT (2), while
§15.1.5 ExpectedArgumentCount is a PREFIX count that stops at the first
defaulted/optional parameter (0). The static fold was already correct — the
divergence was that the reflective read answered `$arity`.

## Root cause

One cause, two symptoms: **a user closure has no per-DECLARATION data slot.**

`$arity` is per-instance and holds one number, and that number is already spoken
for — `closure-exports.ts` widens an under-applied dispatch to
`max(n, $arity)`, so lowering it to the §15.1.5 value would stop padding omitted
arguments (pinned: `issue-4437.test.ts` "keeps `$arity` as the DISPATCH arity").
`name` has no slot at all. So R1 and R2 are the same missing thing: a second,
independent carrier for the two values a function object must *reflect*, as
distinct from the one value it *dispatches* on.

## What shipped

Two new modules, split along the compile-time / runtime seam:

- **`src/codegen/function-instance-meta.ts`** — the WRITE side. Mints the nominal
  `$__fn_instance_meta { externref name; i32 length }` struct, grows a `$fnmeta`
  slot on closure structs, interns one lazily-initialized module global per
  distinct `{name, length}`, and resolves §10.2.9 `name` (including
  NamedEvaluation) + §15.1.5 `length` from the declaration.
- **`src/codegen/function-instance-meta-arms.ts`** — the READ side. The
  `__fninst_meta(fn) -> externref` resolver body (one `ref.test` arm per
  registered family) and the three instruction shapes the reflective arms use.
- **`src/codegen/function-instance-props.ts`** (#4436's module) — extended, not
  duplicated. `length` now consults `$fnmeta` FIRST and falls back to `$arity`;
  `name` is a new arm on the same `closureKeyArm` guard, so it moves in lockstep
  with `hasOwnProperty` / `gOPD` / `getOwnPropertyNames` / `delete` / the
  `__extern_set` refusal, exactly as `length` already did.

Mint sites wired: `method-trampolines.ts::ensureFuncClosureSingleton` (the
canonical cached value of a top-level function declaration),
`funcref-as-closure.ts` (both the capture-carrying and the plain path), and
`arrow-phases.ts::mintClosureStructTypes` (arrows + function expressions).

### Four things that were load-bearing and are easy to get wrong

1. **A bare `i32` id is NOT a sound discriminator, and neither is
   `[externref, i32]`.** WasmGC canonicalizes structurally — field names are ours
   alone and never reach the binary — so `ref.test <family>` also matches any
   unrelated struct with the same shape and supertype. A trailing `i32` collides
   with the constructible wrapper's `__constructible` (a `function f(){}` value
   would read `1` as a metadata id and answer some other function's `name`);
   `[externref, i32]` collides with a closure capturing one reference and one
   number. The slot therefore holds a `(ref null $__fn_instance_meta)`: a
   nominal type user source can never produce, so the family test is sound by
   construction rather than by a layout argument. This is the same problem
   #2896's `bfnid` solves, one level up.
2. **The metadata struct references NO other type.** `computeRecGroups`
   (emit/binary.ts) merges every type between a definition and its
   forward-referenced target into one rec group, which would perturb the #2514
   canonical runtime rec-group boundary. `name` is an `externref` rather than a
   `(ref $anystr)` for exactly that reason — and it is also precisely what
   `__builtinfn_get_meta` returns, so the read is a bare `struct.get`.
3. **Allocate DERIVED, report the BASE.** Where the base struct is shared across
   functions (the per-signature wrapper), the slot needs a subtype — but the
   value's reported static type stays the base. `emitCachedFuncClosureExternref`
   documents why: a `ref.cast` to a MORE derived type TRAPS on a value stored as
   the base, and two callers routinely disagree about the `constructible` flag
   over one cache global. Widening is safe; narrowing is a live `illegal cast`.
   A capture-carrying struct is already per-closure, so it grows the slot in
   place and no type identity changes at all.
4. **`length` falls back, `name` does not.** A closure whose mint site is not yet
   wired keeps #4436's `$arity` answer for `length` (never loses the property)
   and declines for `name` (absent — never a *wrong* name). That asymmetry is
   what makes the remaining residuals safe to leave: class/object methods report
   no `name` rather than a guessed one.

### One leak this found and fixed

Publishing `decl.name.text` made `built-ins/Function/instance-name.js` report
`"__new_function_474"` — `eval-inline.ts` splices `new Function(…)` in as a real
parsed declaration under a generated name. §20.2.1.1.1 says the answer is
`"anonymous"`; detecting it by SOURCE FILE (`EVAL_SOURCE_FILENAME`) rather than
by name text avoids coupling to a template literal in another module. That file
now passes.

## Verification

### Target population — the FULL bucket, before and after, both runs my own

90 files: every corpus entry failing `"name should be an own property"` (74) ∪
every `*length-dflt.js` (16). Run with the real `runTest262File`,
`--target standalone`, on base `f5e2fa6` and on this branch.

| | before | after |
| --- | ---: | ---: |
| pass | **0** | **42** |
| fail | 90 | 48 |

**42 flips, 0 regressions.** Flipped: `language/{statements,expressions}/{function,generators}/{name,length-dflt}.js`,
`arrow-function/{name,length-dflt}.js`, `async-{function,arrow-function,generator}/name.js`,
`built-ins/{AsyncFunction/instance-has-name,Function/instance-name}.js`, and the
whole `fn-name-{fn,arrow,gen,cover,lhs-cover,lhs-member}` family across
`statements/{const,let,variable}`, `expressions/assignment` (incl. `dstr/`) and
`statements/for-of/dstr/`.

### Remaining failure buckets in that population (all outside this slice)

| count | bucket | why not here |
| ----: | ------ | ------------ |
| 22 | `name should be an own property` | class values, class/object METHODS, and builtin function objects (`eval`, `Proxy.revocable`, `Promise` resolve/reject functions, `Iterator.zipKeyed`, `TypedArray`) — different mint sites, see residuals |
| 8 | `length descriptor value should be 0` | all eight are class/object METHODS + setters (`{statements,expressions}/class/{,gen-,static-}method-length-dflt.js`, `object/method-definition/*`, `object/setter-length-dflt.js`) |
| 9 | wrong `name` VALUE (`[test262]`, `id`, `[method]`, …) | computed / symbol-keyed NamedEvaluation — a runtime key, not resolvable at the mint site |
| 3 | `Cannot convert undefined or null to object` | unrelated pre-existing defects in those files |

### Controls — 140 currently-PASSING files, sampled by stride

Pool 11,029 passing standalone entries under
`language/{statements,expressions}/{function,arrow-function,generators,object,class}`
∪ `built-ins/{Function,Object/{getOwnPropertyNames,getOwnPropertyDescriptor,keys,defineProperty},Array/prototype/{map,filter},Reflect}`
∪ `language/statements/for-of`; every 78th taken.

**138/140 pass.** The two failures
(`arrow-function/syntax/early-errors/arrowparameters-cover-no-duplicates-binding-array-1.js`,
`object/method-definition/generator-param-redecl-const.js`) were A/B'd against
the pristine base copies and fail IDENTICALLY there — stale baseline entries,
not regressions.

### Vitest

- `tests/issue-4437.test.ts` — new, 19 tests.
- `tests/issue-4436.test.ts` — its two DELIBERATELY-PINNED residual assertions
  are flipped to the spec answer, in place, with the reasoning at the site.
  #4436 pinned them precisely so this change could not happen silently.
- Green: `issue-2896`, `issue-3468-closure-own-props`, `issue-4010`,
  `issue-4194-instance-expando`, `issue-4241-carrier-bag-slot`,
  `issue-4098-error-expando`, `es5-standalone-function-semantics` — 145/145.
- `tests/equivalence/**` (host lane) — everything here is `ctx.standalone`-gated,
  so host output is unchanged by construction; run to confirm.

### Gates

`typecheck`, `check:oracle-ratchet` (+0/+0), `check:stack-balance`,
`check:ir-fallbacks`, `check:func-budget` all OK. `check:loc-budget` needs the
three allowances in this file's frontmatter (see the comment there).
`check:godfiles` fails with **11 regressions on the pristine base too** —
identical list, A/B-verified; pre-existing drift, not this change.

## Residuals, with owners

| id | residual | why it is not fixed here | owner |
| -- | -------- | ------------------------ | ----- |
| **R1** | Class and object-literal **METHODS** carry no `$fnmeta` — 8 `*-method-length-dflt.js` + several `name` files. | `ensureMethodClosureSingleton` / `emitObjectMethodAsClosure` take a method NAME and funcIdx, not a declaration node, so the §15.1.5 walk has nothing to read; and method `name` has spec subtleties this slice does not measure (`get `/`set ` prefixes §10.2.9, symbol keys `[Symbol.iterator]` → `"[Symbol.iterator]"`, class-field vs method). Because `name` declines rather than guessing, leaving it is SAFE — those files report no `name` instead of a wrong one. | **unowned — next slice of #2860** |
| **R2** | Computed / symbol-keyed NamedEvaluation: `({ [test262]: function(){} })` should name the function from the runtime key. 9 files. | The key is a runtime value; the mint site has only the AST. Needs a runtime `SetFunctionName` on the closure's `$fnmeta` (a mutable slot, or a bag write) rather than a compile-time constant. | **unowned** |
| **R3** | A CLASS value's `name` (`language/{statements,expressions}/class/name.js`). | A class value is not a funcref-wrapper closure; different carrier entirely. #4436's bucket map already calls the class own-property stratum separate. | **unowned** |
| **R4** | Builtin function objects still missing `name`: `eval`, `Proxy.revocable`'s revoker, `Promise` resolve/reject functions, `Iterator.zip*`, `TypedArray`. | These are #2896's substrate (`ensureBuiltinFnMetaType`), not a user closure — each needs its own meta type registered at its own materialization site. | **unowned** |
| **R5** | `f.hasOwnProperty("prototype")` is still false; `propertyIsEnumerable` on a closure expando returns false. | Adjacent own-property surfaces on function instances; inherited unchanged from #4436's R5. | **unowned** |
| **R6** | `new function f(){ this.p = 1; }` (INLINE function expression as the `new` callee) traps. | #4436's R3, a construct-path defect unrelated to own properties. | **unowned** |
| **R7** | The STATIC `<fn>.name` / `<fn>.length` fold does not observe a runtime `delete`+rewrite: after `delete f.length; f.length = 5`, the fold answers `2` while the dynamic read answers `5`. | Pre-existing and NOT caused here — **A/B'd against the pristine base copies: identical numbers (fold 2, dynamic 5) on `f5e2fa6`.** The fold is a compile-time answer for a typed receiver; making it defer would need a "this receiver may have been mutated" analysis. Found while writing this issue's tests, which is why the write-refusal test asserts the DYNAMIC read (the surface `verifyProperty` uses). | **unowned** |
| **R8** | Two same-named nested function declarations in DIFFERENT enclosing scopes alias to one closure value: `outer(){function f(){return 1}}` / `outer2(){function f(){return 2}}` yields `p === q` and `q() === 1`. | Pre-existing and NOT caused here — **A/B'd: identical on `f5e2fa6`.** `nestedFnClosureArtifacts` / the `__fn_closure_<key>` cache key off the bare source NAME; `ensureFuncClosureSingleton` has a `$n` disambiguator (#4133) for the top-level case but the nested path does not. A correctness bug well beyond own properties — surfaced by a metadata test, worth its own issue. | **unowned — file separately** |
