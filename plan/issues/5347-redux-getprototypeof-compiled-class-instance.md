---
id: 5347
title: "Object.getPrototypeOf on a COMPILED class instance answers Object.prototype — redux isAction 0/1, plus the `vm` gap and a compiler hang, from #5325's residuals"
status: done
assignee: ttraenkler/senior-dev
sprint: current
created: 2026-09-05
updated: 2026-09-06
completed: 2026-09-06
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-06 — the whole mechanism lives in two NEW subsystem modules
# (src/codegen/class-instance-proto.ts, src/runtime/compiled-class-prototype.ts).
# What lands in the two god-files is the irreducible wiring: one import plus a
# two-line call in each. In `runtime.ts` the call site cannot move — the answer
# has to be given INSIDE the `__getPrototypeOf` arm, after the explicit-link /
# Object.create / fnctor checks and before the `__is_data_struct` default, so
# the ordering IS the fix (identical argument to #5325's, one arm later). In
# `codegen/index.ts` the emitter must be invoked from both the single-source and
# the multi-source finalize sequences, at the same point as its `Object.create`
# twin, which is +4/+3 lines split across the two drivers.
loc-budget-allow:
  - src/codegen/index.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/runtime.ts::resolveImport
---

## Problem

#5325 fixed `Object.getPrototypeOf` for the WasmGC **builtin** carriers (Date,
Array, …) when the receiver arrives as a parameter, and moved redux 60 → 64.
Its measured residuals, none fixed there:

1. **Compiled class instance → `Object.prototype`.** `isPlainObject(new (class
   A { type = 'x' }))` still answers `true` because `getPrototypeOf(<compiled
   struct>)` cannot see the class's prototype object — it needs a
   **codegen-side discriminator** mapping the struct's type index to its
   class prototype carrier, which the host-side `__getPrototypeOf` import
   (`src/runtime.ts` ~13920) does not have. `redux test/utils/isAction.spec.ts`
   is 0/1 on exactly this.
2. **`import vm from 'vm'` is unmodelled.** `vm.runInNewContext(...)` is a
   silent no-op; `isPlainObject.spec.ts` asserts the cross-realm case first
   and is 0/1 regardless of (1). This is a host-shim gap and almost certainly
   **wont-fix** for the compiler — record the verdict, do not implement `vm`.
3. **`Object.setPrototypeOf` on an array literal** never reaches
   `__host_set_struct_proto`; the query answers `Array.prototype` instead of
   the assigned prototype. Pinned as a residual in #5325's test.
4. **A compiler hang** (>900 s) on a `getPrototypeOf` chain-walk written
   inline in a test-body arrow; the same walk in an imported `.mjs` compiles
   in ~7 s. Reproducible, not chased.

Separately, redux is at **61/82** on clean main — down 3 from #5325's
post-merge 64 via `combineReducers` identity failures. That regression is
being bisected under its own dispatch; **do not attribute it here**.

## Acceptance criteria

1. `getPrototypeOf(new C())` for a compiled class `C` answers `C.prototype`
   (identity-equal to the class object's `.prototype` carrier); `isAction`
   0/1 → 1/1.
2. Regression test failing on parent, passing with fix, untyped `.js`
   two-file fixtures; includes the #5325 builtin cases as a no-regression
   control and the `setPrototypeOf`-on-array residual pinned (flip it if you
   fix it).
3. Verdict on (2) recorded in this file with the evidence; (4) reproduced
   once with the source shape and timing recorded, or re-filed.
4. A/B at one HEAD, 17 suites, per test file (anchors in #5338; redux
   anchor is **61/82**).
5. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. Read #5325's fix in `src/runtime.ts` (`__getPrototypeOf`, the
   `isDataStruct` branch) and `src/codegen/class-proto-object.ts` — the
   compiler already mints a per-class prototype carrier for `C.prototype`
   reads and `instanceof`. The missing piece is the **reverse map** at the
   host boundary: given a wrapped struct, which class minted it.
2. Two viable designs; pick by measurement: (a) the host import consults a
   struct-type-index → prototype-carrier table exported from the module
   (there is precedent in `buildShapePropFlagsTable` / `__member_kind_<key>`
   sidecars); (b) `__getPrototypeOf` on a data struct calls back into a
   compiled `__proto_of_struct` dispatcher that `ref.test`s per class — the
   closed-dispatch pattern in `closed-method-dispatch.ts`. (b) is
   standalone-friendly; (a) is cheaper. Check `dynamic-proto.ts` first —
   part of this may exist for `__proto__` reads.
3. Reduce with a negative control; WAT; fix; regression test.
4. Record the `vm` verdict and the hang repro in this file.
5. A/B; one PR.

## Dispatch

Model: **opus**. Requires choosing between two codegen designs with
standalone-lane implications.

## Implementation

New codegen export **`__class_instance_proto(externref) -> externref`**
(`src/codegen/class-instance-proto.ts`), consulted by a new host-side helper
(`src/runtime/compiled-class-prototype.ts`) from the `__getPrototypeOf` arm in
`src/runtime.ts` — **after** the explicit `setPrototypeOf` link, the
`Object.create` record and the fnctor instance→ctor link, and **before** the
`__is_data_struct` default. That is one arm past where #5325 stopped, and the
position is the fix: each earlier check is a *more specific* answer for the same
receiver, and the later default is what was flattening the class instance to
`%Object.prototype%`.

### Which design, and why the plan's (a) is not actually a design

The plan offered (a) a struct-type-index → prototype-carrier table the host
consults, or (b) a compiled dispatcher that `ref.test`s per class. **(a) is (b)
plus an indirection, not a cheaper alternative.** WasmGC structs are opaque to
JavaScript and there is no "give me this value's type index" operation, so the
host would first have to call a compiled `ref.test` cascade to learn the index,
then index a table to get a carrier it still could not materialize. The
`buildShapePropFlagsTable` precedent does not transfer: that table is keyed by a
*property name the host already holds*, not by a runtime value's identity. (b)
collapses both steps into the one function that has to exist either way, so (b)
is what landed.

`dynamic-proto.ts` was checked first as the plan asked. It already contains this
shape — `__struct_proto_read` is a per-class, most-derived-first `ref.test`
cascade prepended into `__getPrototypeOf`. It is **not reusable here**: it is
gated on `ctx.standalone` AND a non-empty `ctx.dynamicProtoClasses` (only classes
the #802 prescan proved to be proto-MUTATION receivers), and in standalone
`__getPrototypeOf` is a native compiled function, not the host import this issue
is about. The reusable precedent turned out to be
`object-create-class-instance.ts` (#5239) instead — same gate shape, same
class-struct iteration, and the same reference-identity discrimination described
next.

### The three `$ClassName`-typed values

`ref.test $C` matches three distinct runtime objects, not one — which is exactly
why #5325 declined this arm:

| value | answer |
| --- | --- |
| a genuine instance (`new C()`) | `C.prototype` |
| the prototype singleton (`__proto_<C>`) | decline |
| the class-object singleton (`__class_<C>`) | decline |

The two singletons reuse the `$ClassName` struct type by construction
(`emitLazyProtoGet` / `emitLazyClassObjectGet`), so they are separated by
**reference identity against their globals**, guarded so no `ref.cast` can see a
null or foreign carrier. Declining for the prototype singleton is load-bearing,
not tidiness: answering `C.prototype` for `C.prototype` makes
`getPrototypeOf(p) === p`, and redux's `isPlainObject` — the very function this
issue is about — walks `while (getPrototypeOf(proto) !== null)`. That would be an
infinite loop in a package already in the corpus. Declining returns null, which
the host reads as "no answer" and follows with its existing `__is_data_struct`
default, i.e. today's behaviour for both singletons, unchanged.

Arms are emitted **most-derived first** (by inheritance depth): a derived class
declares its parent as `superTypeIdx`, so `ref.test $Base` succeeds for a
`$Derived` instance.

### Materialization, and why `__register_prototype` is called from here too

The prototype global is lazily initialised by whichever `C.prototype` read runs
first — and in the shape this issue is about there is none: redux's
`class Action { type = '…' }` is only ever constructed. So the dispatcher builds
the singleton with the same defaulted-fields prologue `emitLazyProtoGet` uses,
and makes the same `__register_prototype(proto, csv)` call. Skipping that call
would leave the host's method-name allowlist unset for a singleton this path
minted, so a later `Object.getOwnPropertyNames(C.prototype)` would enumerate the
class's **instance field** names instead of its methods — a silent wrong answer
whose value depends on which of the two paths happened to run first. Asserted by
`greeterProtoOwnKeys` in the regression test. The CSV globals are interned in a
first pass, before any global index is baked, because interning a string
constant inserts an IMPORTED global and shifts the index space (the #4618
hazard).

### Cost and gating

Byte-identical output for standalone/WASI and for any host-mode module that
never reaches the `__getPrototypeOf` import. Both halves of that gate were
measured on real modules, not asserted:

| module | dispatcher emitted | before | after |
| --- | --- | --- | --- |
| generated redux `isAction.spec.ts` (declares a class, asks the host) | **yes** | 272,393 | 272,625 (+232, +0.09 %) |
| generated redux `isPlainObject.spec.ts` (asks the host, no class) | no | 277,259 | 277,259 |
| generated hono `request.test.ts` (classes, no host prototype query) | no | 647,859 | 647,859 |
| generated hono `http-exception.test.ts` | no | 289,708 | 289,708 |
| all six `check:dogfood-validation` packages | no | — | byte-identical |

Where it IS emitted, the runtime cost is one `ref.test` cascade per
`__getPrototypeOf` MISS — a path only a reflective query on a *dynamic* receiver
reaches, since every foldable argument shape is answered at compile time with no
host call at all.

## Measurements

At `upstream/main` `0f4bc7a1ca`, A/B by reverting `src/codegen/index.ts` +
`src/runtime.ts` to their parent contents (file-copy A/B, no `git stash`).

**The query itself**, two-file untyped `.js`, receiver through a call boundary:

| | before | after |
| --- | --- | --- |
| `getPrototypeOf(new Action()) === Action.prototype` | 0 | **1** |
| `getPrototypeOf(new Action()) === Object.prototype` | 1 | **0** |
| `getPrototypeOf(new Derived()) === Derived.prototype` | 0 | **1** |
| `isPlainObject(new Action())` | true | **false** |
| `getPrototypeOf(Action.prototype) === Object.prototype` | 1 | 1 |
| `isPlainObject({a:1})` | true | true |
| `getPrototypeOf(Derived.prototype) === Base.prototype` | 0 | 0 (residual) |

**Regression tests**, untyped `.js` two-file fixtures:

| | before | after |
| --- | --- | --- |
| `tests/issue-5347-getprototypeof-compiled-class-instance.test.ts` | 4/11 | **11/11** |
| `tests/issue-5325-getprototypeof-wasmgc-carriers.test.ts` | 6/7 | **7/7** |

The #5325 file carried this residual as an explicit pin ("asserted so the day a
class discriminator lands, this line has to change with it"); both of its
class-instance assertions now read the other way, and its header records one
remaining residual instead of two. The new file keeps #5325's Date / Array /
closure / two-hop cases as the no-regression control.

**redux upstream suite**, same HEAD, one suite at a time:

| | before | after |
| --- | --- | --- |
| redux total | 66/82 | **67/82** |
| `test/utils/isAction.spec.ts` | 0/1 | **1/1** |

The moved assertion is `isAction.spec.ts` #7, `new Action()` — recorded before as
`assertion 7 toBe: boolean:true != boolean:false`, `null` after. No other redux
file moved. (The 66/82 baseline is this HEAD's; #5325 measured 64/82 and this
issue was filed against 61/82, so main moved twice underneath both figures.)

`isPlainObject.spec.ts` stays 0/1 and **not** because of anything above — see the
`vm` verdict next.

## Residual (2) — `import vm from 'vm'`: wont-fix for the compiler

Measured, not assumed. Compiled two-file fixture:

| probe | result |
| --- | --- |
| `vm === null \|\| vm === undefined` | `false` |
| `typeof vm` | `"undefined"` |
| `vm.runInNewContext('fromAnotherRealm = {}', sandbox)` | does not throw; `sandbox.fromAnotherRealm` is still a `boolean` |

`vm` is on `import-resolver.ts`'s node-builtin list, so the import resolves to an
ambient `any` and the call is a silent no-op. That is exactly the suite's
observed failure: `isPlainObject.spec.ts` assertion 1 is
`isPlainObject(sandbox.fromAnotherRealm)`, the sandbox value is still the
initial `false`, and `isPlainObject(false)` is correctly `false` — reported as
`assertion 1 toBe: boolean:false != boolean:true`, identical before and after
this change.

**Verdict: wont-fix as a compiler feature.** Honouring `runInNewContext` means a
second ECMAScript realm inside the compiled module — a fresh global object, a
fresh set of intrinsics, and compiling source at runtime. The first two are what
the test actually asserts (cross-realm `isPlainObject` is *the* case that needs
two distinct `%Object.prototype%` identities), and the third is the runtime-eval
provider's territory, not this issue's. A JS-host shim could satisfy it in
`platform: node` only, which would make the answer depend on the host and give
standalone no path at all. `isPlainObject.spec.ts` stays 0/1 by design.

One by-product worth its own line, not chased here: `typeof vm` is `"undefined"`
while `vm === undefined` is `false`. Those two disagree for an unmodelled
node-builtin import; that is a separate (small) inconsistency in the ambient-`any`
lowering, filed nowhere yet.

## Residual (4) — the reported >900 s compiler hang: NOT reproducible, re-filed

Four faithful reconstructions, each compiled in its own process under a 240–600 s
deadline at this HEAD:

| shape | result |
| --- | --- |
| the walk imported from another module (the reported FAST shape) | ok, 0.4 s |
| the walk inline in a top-level function | ok, 0.3 s |
| the walk inline in a nested arrow | ok, 0.3 s |
| the walk inline in a test-body arrow (the reported HANG shape) | ok, 0.4 s |

…and then the same four against the **real generated 940-line redux harness
file** (`.redux-upstream-suite-generated/test/utils/isPlainObject.spec.ts`),
which is what the original observation was made on:

| variant | result |
| --- | --- |
| H0 — as generated (walk imported from `isPlainObject.mjs`) | ok, 2.8 s |
| H1 — walk moved to a top-level function in the spec file | ok, 4.0 s |
| H2 — walk written inline in the `it(...)` arrow | ok, 3.5 s |
| H3 — H2 plus a 21-receiver `getPrototypeOf` fold matrix in the same arrow | ok, 3.4 s |

The reported ~7 s for the imported shape is also not reproduced (2.8 s here), so
the machine or the compiler has moved. **Re-filed rather than recorded**: the
original probe file was not preserved, and without it the shape cannot be pinned
down further. If it resurfaces, keep the exact source — the four variants above
rule out "inline in a test-body arrow" as the trigger on its own.


## Gates

All green locally at this HEAD, each run bare (never piped — a piped gate reports
the pipe's status):

- `check-loc-budget` · `check-func-budget` · `check-coercion-sites` — the two
  god-file growths are granted in this file's frontmatter with the rationale
  above; nothing else grew.
- the 13 `quality` ratchets: `ir-dialect`, `ir-kind-neutrality`, `jstag-seam`,
  `ir-layering`, `ir-fallbacks`, `host-import-policy`,
  `standalone-ir-cutover-corpus`, `dead-exports`, `oracle-ratchet`, `pushraw`,
  `harness-compile-budget`, `ir-adoption`, `stack-balance`.
- `check:dogfood-validation` — 6/6 packages compiled, 6/6 validated.
- **all eight `equivalence-gate` shards** — "No new equivalence regressions" on
  every one (24 known-failures in baseline, unchanged).
- Typecheck (`tsc --noEmit -p tsconfig.ts7.json`) clean.

Targeted regression sweep beyond the two files above, run individually and
compared against the parent compiler where anything failed: `instanceof`,
`issue-3962-native-user-instanceof`, `issue-802-dynamic-proto-class`,
`issue-2580-m3-protochain`/`-protoextend`, `issue-3768-object-create-proto-validation`,
`issue-4515-in-prototype-chain`, `issue-5280-class-parent-null-heritage`,
`issue-4295-runtime-user-class-method-dispatch`, `issue-3995-hono-class-boundary`,
`issue-4450-class-meta`, `host-proxy-promise-class-regressions`,
`issue-5237-cross-module-class-members`, `classes`, `class-methods`,
`class-expression`, `issue-4563-carrier-bag-prototype-walk`,
`issue-3520-class-shape-identity`, `issue-3520-class-shape-type-identity`,
`issue-5239-object-create-class-prototype`, `issue-5242-class-value-construct-bridge`,
`issue-4628-class-value-prototype`, `issue-4618-host-class-ctor-bridge`,
`issue-4616-fnctor-getprototypeof`, `issue-3037-cs1c-getprototypeof-carrier`,
`issue-1472-es5-getprototypeof`, `issue-1364a`/`b`, `issue-4770-class-name-descriptor`,
`issue-5162`, `issue-5169`, `issue-5191`, `issue-5195`, `issue-5213`, `issue-846`,
`prototype-chain`. Every failure observed reproduces identically on the parent
compiler (`prototype-chain` and `issue-1472`/`issue-5162` standalone arms fail on
this box either way; `issue-4276-instanceof-object-family` OOMs locally either
way). No test flipped from pass to fail.

## Cross-package A/B

17 npm upstream suites, **both runs at the same HEAD** (`upstream/main`
`0f4bc7a1ca`), one suite at a time, `before` = `src/codegen/index.ts` +
`src/runtime.ts` reverted to their parent contents. Every suite exited 0 in both
runs. Compared per test FILE as well as per package (`.tmp/abdiff.mjs`).

| package | before | after |
| --- | --- | --- |
| webpack | 16/16 | 16/16 |
| three | 17/18 | 17/18 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| lodash | 53/62 | 53/62 |
| **redux** | **66/82** | **67/82** |
| axios | 200/231 | 200/231 |
| stylelint | 108/108 | 108/108 |
| tailwindcss | 13/13 | 13/13 |
| jsdom | 6/6 | 6/6 |
| styled-components | 9/9 | 9/9 |
| uuid | 75/75 | 75/75 |
| marked | 9/30 | 9/30 |
| moment | 10/10 | 10/10 |
| prettier | 101/151 | 101/151 |
| jest | 335/356 | 335/356 |
| hono | 220/324 | 220/324 |

**Exactly one test file moved in the whole corpus**: redux
`test/utils/isAction.spec.ts`, 0/1 → 1/1. Every other package reports the same
per-file split before and after. In particular axios `validator.test.js` did
**not** move — both of its tests fail with `assertion 1 instance mismatch` in
both runs.

Two dispatch anchors did not match this HEAD and were re-measured rather than
assumed: redux is **66/82** here (anchor said 63–64) and hono is **220/324**
(anchor said 244). Both of my runs agree with each other, which is what the A/B
turns on; the anchors were taken on an older main. hono prints its `admitted`
headline, contrary to the note that it does not.
## Residuals left open by this change

1. `getPrototypeOf(<Derived>.prototype)` answers `%Object.prototype%` rather than
   `Base.prototype` (§15.7.14 step 6). The prototype singleton declines in the
   dispatcher, so the parent link is a separate change. It changes no WALK
   outcome — the chain still terminates at `%Object.prototype%` and still is not
   `Derived.prototype` — which is why it was left out rather than bundled in.
   Pinned in the regression test.
2. `getPrototypeOf(<class value>)` answers `%Object.prototype%` rather than
   `%Function.prototype%`. The class-object singleton reuses the `$ClassName`
   struct type, so the dispatcher must decline it by identity or a class passed
   as a parameter would report its own `.prototype`. Unchanged from before.
   Pinned.
3. `Object.setPrototypeOf` on an ARRAY literal — inherited verbatim from #5325,
   restated in the new test because that file is now the one that would notice.
