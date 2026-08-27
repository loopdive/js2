---
id: 4770
title: "Compiled class constructors lose dynamic own `name` descriptors (ES2015, 1 row)"
status: in-progress
sprint: current
created: 2026-08-27
updated: 2026-08-27
assignee: ttraenkler/codex-4770-function-name-length
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
loc-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
es_edition: es6
language_feature: function-properties, descriptors
goal: core-semantics
related: [2175, 4265, 1632, 4436, 4437, 3429]
origin: "ES2015 failure bucketing against the merged baseline, 2026-08-27"
---

# #4770 — compiled functions have no own `name` / `length`

## Historical checkpoint plan (superseded by the reduced scope below)

The claimed cohort is the measured 85-row floor in the official ES2015
standalone population (11,704 rows): 66 `name` descriptor/value rows and 19
`length` descriptor/value rows. The implementation is split into two
independently testable seams so a host-lane metadata change cannot alter the
already-passing standalone closure carrier:

1. Port the existing per-function `$fnmeta` carrier and resolver from the
   standalone-only gate to the host lane, then make descriptor, own-key,
   `hasOwn`, dynamic-read, and delete paths agree on the same metadata while
   preserving sidecar overrides and tombstones.
2. Repair the compile-time literal-key descriptor fold for class constructors
   (`name`, `length`, and `prototype`) so `Object.getOwnPropertyDescriptor`
   converges with the already-correct `Reflect` mirror path.
3. Pin each seam with exact Test262-shaped probes and both-lane controls;
   retain the existing standalone function metadata as a non-regression lane.

The first pushed checkpoint records this plan and the exact baseline command
before any production source change. The PR remains draft until both seams,
full focused controls, and current-main/CI gates are complete.

## Reduced scope and measured handoff (Codex, 2026-08-27)

The original function `name`/`length` hypothesis is not the shipped scope. The
claimed-base edition map had `ES2015` at index 2; upstream's metadata
refresh moves that label to index 3 without changing the population. Its 11,778
labels include 74 `intl402/` rows excluded by the maintained official runner,
leaving the exact 11,704-row denominator. Filtering that cohort leaves exactly
one row for this defect: `test/language/statements/class/name.js`.
The nearby class-expression row is untagged and is not counted in this cohort.

The maintained `harness-flip-probe.ts` was run with the pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`, LLVM18, and a maximum of
two local workers. The exact local A/B outputs are
`/private/tmp/4770-exact-base-host.jsonl`,
`/private/tmp/4770-final2-host.jsonl`,
`/private/tmp/4770-exact-base-standalone.jsonl`, and
`/private/tmp/4770-final2-standalone.jsonl`. The two final lanes were run in
parallel with one worker each, preserving the two-worker cap.

- Host lane: baseline `fail: 1`; after `fail: 1`; partition `unchanged: 1`,
  `fail -> pass: 0`, `pass -> fail: 0`.
- Standalone lane: baseline `fail: 1`; after `pass: 1`; partition
  `fail -> pass: 1`, `pass -> fail: 0`. The flipped row is exactly
  `test/language/statements/class/name.js`.
- The standalone function/class/redefinition controls (`4770-fn.js`,
  `4770-class.js`, and `4770-debug-redef.js`) are `pass: 3` after the reduced
  implementation. The class control retains literal `name`, `length`, and
  `prototype` descriptor coverage.
- The cumulative reduced checkpoint is five files: three source files,
  this issue record, and one focused regression test (450 additions and four
  deletions against the claimed base).

The implementation is deliberately standalone-only. `fillClassObjectNameArms`
adds identity-guarded native MOP arms for a compiled class-object singleton's
dynamic `name` key, including descriptor flags, read, own checks,
enumerability, setter refusal, and the existing instance tombstone screen.
The compact literal-key fold in `compileBuiltinStaticCall` remains only to keep
the already passing class control for `name`, `length`, and `prototype`; it does
not widen the claimed dynamic cohort or alter host behavior. The broad
closure/function metadata prototype was discarded from the final source diff.

Focused regression coverage is in
`tests/issue-4770-class-name-descriptor.test.ts`; it uses parameterized dynamic
keys and checks the descriptor, read, write, enumerable, and delete behavior.
The focused Vitest test passes. A full TypeScript check still reports the
repository's pre-existing missing `@types/node` diagnostics; no diagnostics
were introduced in the changed helper or call-site code after filtering those
known errors.

Handoff: keep PR #5056 draft with `hold` and `mergeQueueEntry: null`. Do not
mark ready or enqueue until the reduced checkpoint is pushed, rebased onto
current `main`, and its CI is green/mergeable.

Post-#5065 current-main verification merged upstream tip
`2a7548ca819248df332986cde2cff81e65042bff` without rewriting history at
`36b3e1b99c1d2f8446eb0f1cc15acb73d46d9917`. The exact rerun remains host
**0/1 pass** (`fail: 1`, unchanged) and standalone **1/1 pass**; focused
#4770 coverage remains green. Final artifacts are
`.tmp/4770-final-post5065-host.jsonl` (SHA-256
`5f6d8001e8ace1428424c0416a48c7180d3f7b104e660abdbbc0e675ede79757`)
and `.tmp/4770-final-post5065-standalone.jsonl` (SHA-256
`2ea832f2b69f6d78c260bed65fde618b406c49728217e470c65254cc5d791f68`).
The remaining landing gates are the evidence commit's normal hooks and
refreshed upstream CI/CLEAN verification.

## Post-merge revalidation (Codex, 2026-08-27)

The branch was updated without rebasing by fetching `upstream/main` at
`03ebf325013a241d5609a457fbdfea78bdf48ee2` and merging it as
`726995d0df1937f097ce46aa99bc94586e4cdf4a`. The reduced PR delta against
that current main remains five files (three source files plus this issue record
and the focused test), 450 additions and four deletions.

The exact one-row probes were rerun after that merge with the maintained
runner, LLVM18, and the pinned artifact directory
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`. Its reproducibility hashes
are `qjs-abi.json`
`0aab187dade1dfc988d5054bc54b4b04f2ad14dae0fb897b4b660b5d8bb028a9` and
`libquickjs.wasm`
`073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`.
The final host and standalone JSONL outputs are
`/private/tmp/4770-merge-host.jsonl` and
`/private/tmp/4770-merge-standalone.jsonl`.

- Host: `fail: 1`, with exact transition `fail -> fail: 1`; the existing
  descriptor-attribute failure remains host-only.
- Standalone: `pass: 1`, with exact transition `fail -> pass: 1` against the
  claimed baseline. The row is exactly
  `test/language/statements/class/name.js`.
- The three standalone function/class/redefinition controls remain `pass: 3`
  in `/private/tmp/4770-merge-controls.jsonl`.
- `tests/issue-4770-class-name-descriptor.test.ts` passes under Vitest with one
  worker. PR #5056 remains draft with `hold` and `mergeQueueEntry: null`; the
  normal push is still pending because the environment refused source egress
  to the unverified private `fork` remote.

## What is confirmed

Every compiled function shape is missing BOTH own properties, and the accessor
reads fall back to wrong values rather than throwing — so the gap is silent.
Measured on current `main` through the runner's own `wrapTest` (probe reads the
descriptor and reports it via `Test262Error`, so the runner's verdict is the
evidence):

| shape | `getOwnPropertyDescriptor(f, "length")` | `f.length` |
| --- | --- | --- |
| `function* (x) {}` | MISSING | 0 |
| `function* g(a, b) {}` | MISSING | 0 |
| `{ m(a,b,c) {} }.m` | MISSING | 0 |
| `function plain(a, b) {}` | MISSING | 0 |
| `(a) => {}` | MISSING | 0 |
| `class C { m(a, b) {} }` (proto method) | MISSING | 0 |

`name` is the same, and worse in one case:

| shape | `getOwnPropertyDescriptor(f, "name")` | `f.name` |
| --- | --- | --- |
| `function plain(a,b) {}` | MISSING | `undefined` |
| `var anon = function () {}` | MISSING | `undefined` |
| `const cg = function* () {}` | MISSING | `undefined` |
| `{ m(a) {} }.m` | MISSING | `undefined` |
| `class C { m() {} }` (proto method) | MISSING | `undefined` |
| `class C {}` (the class itself) | `w=true e=true c=true` | `"C"` |

Spec (§20.2.4.1 / §20.2.4.2, via SetFunctionName / SetFunctionLength) requires
`{ writable: false, enumerable: false, configurable: true }` for both. The class
row is the only one that HAS `name`, and all three of its attributes are wrong.

## Blast radius

**~85 ES2015 rows** in the merged baseline, all reporting one of two shapes:

- `name descriptor value should be X; name value should be X; name descriptor
  should not be writable; …` — **66 rows**
- `length descriptor should not be writable; length descriptor should be
  configurable` (and, where the arity is also read, `length descriptor value
  should be N`) — **19 rows**

Distribution of the `name` family:
`language/expressions/assignment` 19 · `language/statements/for-of` 14 ·
`language/expressions/object` 12 · `const`/`let`/`variable` 15 ·
`language/statements/class` 2 · plus singletons in `generators`,
`GeneratorFunction/name.js`, `function`.

Not counted above: an unknown further share of the generic
`Expected SameValue(«X», «X»)` bucket (504 rows) and the 11-row
`Cannot convert undefined or null to object [in verifyProperty()]` bucket, which
is `verifyProperty` choking on a missing descriptor — e.g.
`built-ins/ArrayIteratorPrototype/next/name.js`. So ~85 is a FLOOR, not the
total.

## Why it is not a small fix — the specific blocker

> **Superseded in part (2026-08-27).** Facts 1 and 2 below still hold. Fact 3's
> claims about the CLASS object — "does not reach `_readOwnDescriptor`",
> "`registered=false`", "`w=true e=true c=true`" — were measured on the
> literal-key read, which never calls the runtime at all. See "M2" below for
> the three routes that actually answer it. The instruction to reuse
> `resolveStaticFunctionName` / `countSpecLength` is also superseded — see M1b.

The machinery to COMPUTE both values already exists and is already spec-correct.
`src/codegen/expressions/calls.ts` has `resolveStaticFunctionName` (including the
NamedEvaluation rule that a named function expression's inner name wins) and
`resolveStaticFunctionLength` → `countSpecLength` (§20.2.4.2: formals before the
first default/rest/destructured parameter). Both were written for #1632a and are
used ONLY to bake `nameHint`/`lengthHint` into a `__bind_function` call site.

What is missing is a way to get that per-function metadata to a RUNTIME value.
Three facts bound the design:

1. **`ClosureInfo` carries no source identity.** `src/codegen/context/types.ts:348`
   has `structTypeIdx`, `funcTypeIdx`, `returnType`, `paramTypes` and a handful
   of booleans — no name, no declaration node. So nothing downstream can recover
   which source function a closure came from.
2. **`__closure_arity` is TYPE-granular, not per-function.**
   `collectClosureArityEntries` (`closure-exports.ts:1721`) dedupes by
   `funcTypeIdx` and dispatches with a `ref.test` chain, because arity is a
   property of the signature. Two source functions with the same signature are
   indistinguishable through it — which rules it out for `name` outright, and
   makes it wrong for `length` exactly where the failing rows live (a default
   parameter changes spec length but not wasm arity: `function* (x = 42) {}` must
   report `length === 0`).
3. **The read-back path is ready for it — for CLOSURES, and only for closures.**
   `_readOwnDescriptor` (`src/runtime.ts:5894`) is the single source for both
   `Object.getOwnPropertyDescriptor` and `getOwnPropertyDescriptors`, and already
   has per-shape arms (vec, sidecar, class proto-/static-method allowlists with
   spec flags at 2a/2b). **Verified by instrumentation:** a
   `getOwnPropertyDescriptor(f, "name")` on a compiled closure DOES reach it —
   all five function shapes in the first table hit the arm — so a closure arm
   placed just before step 3 is a confirmed insertion point once the metadata
   exists.

   **The class object does NOT reach it.** The same instrumented run shows the
   `class C {}` read never enters `_readOwnDescriptor` at all; its descriptor is
   produced somewhere else (the `_wrapForHost` mirror / proxy path around
   `runtime.ts:7954`, where `Object.defineProperty(fnTarget, "name", …)` already
   passes spec-shaped attributes). So the class row and the closure rows need
   TWO different insertion points, and the class one has to be located first.

   An arm keyed on `_classNamesByObj` was written and measured against this: the
   class descriptor was unchanged (`w=true e=true c=true`), and the probe showed
   `registered=false` for every receiver that did arrive. Reverted. Do not
   re-attempt it from `_classNamesByObj` in `_readOwnDescriptor` — find the
   mirror path instead.

## Investigation results (2026-08-27) — the two design-deciding measurements

Both questions the "candidate designs" section left open are now MEASURED, and
the answers change the shape of the work: **this is a PORT, not a design.**
Every source edit made to instrument was reverted (`git status` clean under
`src/`); the probes live in `.tmp/probe/` and were run through
`runTest262File`, including its `target: "standalone"` fourth argument.

### M1 — closure struct types are per-SIGNATURE, so design B is dead

Dumping `ctx.closureInfoByTypeIdx` at the `fillFunctionInstanceProps(ctx)` call
in `src/codegen/index.ts` for a module of same-signature functions:

| source | closure struct types registered |
| --- | --- |
| `function f1(a){} function f2(a){} function f3(a){}` (all escaping) | **2** — `__fn_wrap_0_struct` (idx 12) + `__constructible_fn_wrap_1_struct` (idx 14) |
| 12 functions: 3 decls, 2 fn-exprs, 2 arrows, 1 defaulted decl, 2 object methods, 2 capturing closures | **6** — the ten capture-free ones collapse onto 2 wrapper types per signature family |

The collision is by construction, not by luck:
`getOrCreateFuncRefWrapperTypes` caches on
`sigKey = <paramKinds>-><resultKinds>`
(`src/codegen/closures/funcref-wrapper-types.ts:84`, stored at `:136`), and
`getOrCreateConstructibleFuncRefWrapperTypes` does the same at `:160`. **Two
source functions get distinct closure struct types only when at least one
CAPTURES** — a capture subtype is minted per closure SITE
(`__closure_<n>_struct`, `mintClosureStructTypes` /
`registerClosureBindingInfo`, `src/codegen/closures/arrow-phases.ts:752`,
`:1372`); the two capturing closures in the 12-function module did get distinct
indices (21, 27).

Every shape in this issue's failure tables is capture-free. So a
`__closure_meta` keyed on the struct type index would answer one function's
`name` for another's — design **B is rejected on measurement**, for the same
reason `__closure_arity` is (`collectClosureArityEntries` dedupes by
`funcTypeIdx`, `src/codegen/closure-exports.ts:1721`).

### M1b — the carrier design B was reaching for ALREADY EXISTS, and works

**#4437 shipped design C**: a `$fnmeta` slot on the closure struct holding a
`(ref null $__fn_instance_meta)` = `{ name externref, length i32 }`, one
interned module global per `<length>:<name>`, resolved at runtime by the
`__fninst_meta(externref) -> externref` native
(`src/codegen/function-instance-meta.ts`,
`src/codegen/function-instance-meta-arms.ts`,
`src/codegen/function-instance-props.ts`). It is **standalone-only** — three
early returns gate it:

- `ensureFnMetaSubtype` — `src/codegen/function-instance-meta.ts:200`
- `fnInstanceMetaOf` — `src/codegen/function-instance-meta.ts:321`
- `reserveFunctionInstanceProps` / `fillFunctionInstanceProps` —
  `src/codegen/function-instance-props.ts:152` and `:197`

Measured on the SAME probe file, same runner, one flag apart
(`.tmp/probe/fn.js`):

| shape | host lane (today) | standalone lane (today) | spec |
| --- | --- | --- | --- |
| `function plain(a,b){}` | name `undefined`, len `0`, both descs MISSING | `name="plain" len=2`, both `w=false e=false c=true` | ✅ |
| `var anon = function(){}` | MISSING | `name="anon" len=0`, spec flags | ✅ |
| `var gen = function*(x){}` | MISSING | `name="gen" len=1`, spec flags | ✅ |
| `var arrow = (a)=>a` | MISSING | `name="arrow" len=1`, spec flags | ✅ |
| `{ m(a,b,c){} }.m` | MISSING | `name="m" len=3`, spec flags | ✅ |
| `function withDef(x, y=42){}` | MISSING | `name="withDef" len=1`, spec flags | ✅ |

The default-parameter row is the one design B provably cannot reach, and
standalone already gets it right — `expectedArgumentCountOfParams`
(`src/codegen/function-expected-argument-count.ts:60`) is §15.1.5, and
`fnInstanceNameOf` (`src/codegen/function-instance-meta.ts:256`) is §10.2.9
NamedEvaluation including the CoverParenthesized and `new Function`→`"anonymous"`
subtleties. **Do not reuse `resolveStaticFunctionName` /
`countSpecLength` (`calls.ts:2084` / `:2153`) as the issue previously
instructed** — they are the older #1632a `__bind_function`-hint pair; the
#4437 pair is the one already wired to the closure MINT sites, which is where
the metadata has to be captured.

### M2 — THREE different paths answer `getOwnPropertyDescriptor(C, "name")`

Instrumented `_readOwnDescriptor`, the `__getOwnPropertyDescriptor` host
import, and both function-mirror `getOwnPropertyDescriptor` traps, then read a
compiled `class C {}` four ways (`.tmp/probe/cls*.js`):

| read | route | answer |
| --- | --- | --- |
| `Object.getOwnPropertyDescriptor(C, "name")` — **literal key** | **never leaves wasm** — compile-time fold, `src/codegen/expressions/call-builtin-static.ts:2502`, miss branch at `:2762`–`:2784` | **`undefined`** |
| `Object.getOwnPropertyDescriptor(C, k)` — **dynamic key** | host import (`src/runtime.ts:13087`) → `_isWasmStruct` true → `_readOwnDescriptor` (`:5883`) → **arm 1, the sidecar arm** (`:5965`) | `{v:"C", w:true, e:true, c:true}` |
| `Object.getOwnPropertyDescriptors(C)` | same, per key: `name` → sidecar desc; `length` and `prototype` → **`undefined`** | partial |
| `Reflect.getOwnPropertyDescriptor(C, "name")` | class-ctor mirror proxy trap, **`src/runtime.ts:8086`**, inside `_makeClassCtorMirrorForHost` (`src/runtime.ts:7935`) | **`{v:"C", w:false, e:false, c:true}` — already spec-correct** |

Three consequences, each of which contradicts something previously recorded
here:

1. **The class row's root cause is CODEGEN, not the runtime.** The failing
   test262 rows use a string-literal key, and that fold answers `undefined`
   with no host call at all. This is also why the reverted `_classNamesByObj`
   arm in `_readOwnDescriptor` "changed nothing": on the literal-key path there
   is no runtime call to intercept. The arm was not wrong, it was unreachable.
2. **`_classNamesByObj.has(C)` is `true`**, measured on the dynamic-key path.
   The recorded `registered=false` came from receivers arriving on some other
   read, not from the class object on its own descriptor read.
3. **The recorded `w=true e=true c=true` is the dynamic-key answer**, and it is
   an artifact: the class object has a SIDECAR `name` entry written as an
   ordinary `[[Set]]` (traced: `__module_init` → `env::__extern_set` →
   `_safeSet` → `_sidecarSet(C, "name", "C")`, emitted by the #3429 boundary
   stamp `maybeStampCompiledFunctionArgName`,
   `src/codegen/expressions/helpers.ts:694`). Default sidecar flags are exactly
   `w/e/c = true`.

Also measured: the class is broken **identically in the standalone lane**
(`gOPD(C,"name")` MISSING, `hasOwn` true, `gOPN` = `length,name,prototype`), so
the class slice is lane-independent and does **not** ride on the #4437 port.

Independently confirmed (matches the earlier record): every closure shape DOES
reach `_readOwnDescriptor` through the host import, even with a literal key —
the fold declines for a closure receiver because `resolveStructName` finds no
struct. So the host-lane closure insertion point is confirmed available.

## Chosen design — port #4437's `$fnmeta` carrier to the host lane (design C), plus a separate codegen fix for the class

Rejected: **B** (M1: struct types are per-signature). Rejected: **A**
(a registration host import per closure ALLOCATION — a closure minted in a loop
pays it every iteration, it needs a standalone twin that #4437 already has, and
it would be a third metadata carrier next to `$fnmeta` and `_wasmStructProps`).

Chosen: **C, by ungating what exists.** The metadata is per-DECLARATION and
interned into one module global per `<length>:<name>`, so closure creation
costs one `global.get`-guarded push and zero host calls; the values are already
measured spec-correct on six shapes; and the host lane only needs a way to
*read* the carrier, which `__fninst_meta` already is.

## Implementation Plan

Two INDEPENDENT slices. S1 (closures) is the ~85-row bulk; S2 (class) is small,
lane-independent, and separately verifiable. Do not couple them.

### S1 — host-lane `name` / `length` on closures

1. **Ungate the mint side.** Replace the bare `ctx.standalone` early returns
   with a predicate that also admits the host/gc lane:
   - `src/codegen/function-instance-meta.ts:200` (`ensureFnMetaSubtype`)
   - `src/codegen/function-instance-meta.ts:321` (`fnInstanceMetaOf`)
   The mint call sites need no change — they already pass `decl` and splice the
   field+operand pair together: `arrow-phases.ts:797` / `:920`,
   `method-trampolines.ts:417` / `:916` / `:1176`,
   `funcref-as-closure.ts:463` / `:591`. **Verify byte-neutrality first**: on
   the host lane these sites currently receive `undefined` from `fnMetaSlot`
   and take the no-slot path, so the ungate changes closure struct LAYOUT for
   every user function. Expect `equivalence-gate` movement and check the
   funcref-wrapper root/subtype `ref.cast` sites still resolve (the subtype
   redeclares the base's fields verbatim, so index-based `struct.get` is safe
   by construction — confirm, don't assume).
2. **Ungate the resolver and EXPORT it.**
   `src/codegen/function-instance-props.ts:152` (`reserveFunctionInstanceProps`)
   and `:197` (`fillFunctionInstanceProps`). The `FNINST_META`
   (`__fninst_meta`) reserve at `:172`–`:183` sets `exported: false` — the host
   lane needs it exported so `runtime.ts` can call it off the instance
   `exports`. Everything else `fillFunctionInstanceProps` fills
   (`__fninst_bag_owns`, `__fninst_tombstone`, and the splices into the #2896
   `__builtinfn_*` helpers) is standalone substrate; **do not ungate those** —
   scope the host-lane ungate to the `$fnmeta` slot, the family registry, and
   the `__fninst_meta` resolver body (`fnMetaArms(ctx).fillResolver`,
   `src/codegen/function-instance-meta-arms.ts:50`).
3. **Runtime read arm** — `_readOwnDescriptor`, `src/runtime.ts:5883`. Insert
   AFTER the delete-tombstone check and AFTER arm 1 (sidecar), BEFORE arm 3
   (`_structHasOwnFieldName`, `:6051`), following the shape of arms 2a/2b
   (`:6032` / `:6047`): for `prop === "name" | "length"`, call
   `exports.__fninst_meta(obj)`; on a non-null result return
   `{ value, writable: false, enumerable: false, configurable: true }`.
   Ordering is the correctness point — a user `f.name = 1` or
   `Object.defineProperty(f, "name", …)` lands in the sidecar and must still
   win, and `delete f.name` must still tombstone.
4. **Make the sibling surfaces agree, in the same change.** `propertyHelper.js`
   `verifyProperty` runs `delete` → `hasOwnProperty` → re-read, so a descriptor
   without the others fails every row it was meant to fix (#4010's law, and
   #4055's -684 park is the receipt):
   - `_wasmStructHasOwn` — `src/runtime.ts:3949`
   - `__getOwnPropertyNames` import — `src/runtime.ts:13122`
   - the dynamic `f[key]` read and the delete path
   - `_wrapWasmClosureUnknownArity`'s `_wasmStructProps` name/length stamp
     (`src/runtime.ts:1911`, stamp at `:2062`) — this is a THIRD carrier today,
     fed by the #3429 boundary stamp. Once `__fninst_meta` exists on the host
     lane, `_wasmStructProps` should defer to it rather than compete, or the
     two will disagree for any function the #3429 stamp did not reach.
5. **Standalone must not regress.** Every edit above is either behind the
   widened predicate or additive to `runtime.ts` (which standalone does not
   use). Re-run the same `.tmp/probe/fn.js` with `target: "standalone"` and
   confirm the six rows are unchanged.

### S2 — the class object's `name` / `length` (lane-independent)

6. **Codegen**: `src/codegen/expressions/call-builtin-static.ts`, the
   `Object.getOwnPropertyDescriptor` arm at `:2502`. In the miss branch at
   `:2762`, the existing `isMethodLookup` carve-out already falls through to
   the dynamic host import for registered class methods. Extend the same
   carve-out to `name` / `length` / `prototype` when the receiver resolves to a
   class (`ctx.classSet` / `classStaticOwnPropertyNames`,
   `src/codegen/class-static-metadata.ts:44`, which already declares
   `CLASS_CONSTRUCTOR_OWN_KEYS = ["length","name","prototype"]`). Anything else
   keeps answering `undefined`.
   - Alternative worth pricing first: synthesize the spec descriptor inline at
     the fold instead of falling through — the class name is a compile-time
     constant, so this needs no host call and works on both lanes. Prefer this
     if the descriptor-object construction helper is already available there
     (`__create_descriptor` is used a few lines above at `:2745`).
7. **Runtime**, only if step 6 falls through rather than synthesizing: give the
   class object's `name` / `length` sidecar entries spec flags instead of the
   default data flags. `__register_class_object` (`src/runtime.ts:12039`)
   already receives the class object and already seeds
   `_classObjectOwnPropertyNames` with `["length","name","prototype", …]`, and
   `__register_class_static_method` (`:12084`) is the precedent — it sets
   `_getSidecarDescs(classObj).set(name, _SC_DEFINED | _SC_WRITABLE | _SC_CONFIGURABLE)`.
   Use `_SC_DEFINED | _SC_CONFIGURABLE` for `name`/`length` (§10.2.9:
   `w=false e=false c=true`). `_classNamesByObj` already holds the name
   (`_registerClassCtorHandler`, `src/runtime.ts:5722`).
8. **Nothing to do for `Reflect.getOwnPropertyDescriptor`** — the mirror trap
   at `src/runtime.ts:8086` is already spec-correct. Use it as the oracle the
   other two paths must converge on.

### Verification

9. Re-run `.tmp/probe/fn.js` and `.tmp/probe/cls*.js` on BOTH lanes, then a
   small `scripts/run-test262-paths.mts --isolate` slice over the two families
   (`*/fn-name-*.js`, `*/name.js`, `*/length.js` under
   `language/expressions/assignment`, `language/statements/for-of`,
   `language/expressions/object`). Keep slices small — do not run the suite.

### Explicitly unresolved

- **Which codegen site emits the class object's `__extern_set(C, "name", "C")`.**
  Traced to `__module_init` at runtime, and the #3429 stamp
  (`src/codegen/expressions/helpers.ts:694`) is the strong candidate — its own
  doc says "FunctionDeclaration only (not … classes)", yet `class C {}` gets
  stamped, so either `ctx.topLevelFunctionNames` includes classes or a second
  site does it. Not chased further because S2 step 7 fixes the FLAGS regardless
  of the writer; chase it before assuming the sidecar entry is always present.
- **Cost of the S1 ungate on closure struct layout.** Every host-lane user
  closure grows a `$fnmeta` slot (one ref field) and its allocation grows one
  interned `global.get`. Not measured. Price it before committing to the
  ungate-everything form — a narrower opt-in (only for declarations whose
  metadata is ever read reflectively) is not obviously possible, since the read
  is dynamic.
- **Whether the ~85-row estimate holds.** It was a floor derived from error
  strings; not re-derived here.
- **`length` on the class object**: `_readOwnDescriptor(C, "length")` and
  `(C, "prototype")` both answer `undefined` today on the dynamic path (only
  `name` has a sidecar entry). S2 step 7 must seed all three, not just `name`.

## Acceptance criteria

- [ ] Every shape in both tables above reports `{w:false, e:false, c:true}` with
      the spec value
- [ ] `function* (x = 42) {}` reports `length === 0`; `function* (x, y = 42) {}`
      reports `1` (the default-parameter case the wasm arity cannot express)
- [ ] The 66-row `name` family and 19-row `length` family pass
- [ ] No regression in the existing `.name`-read fast paths — the compile-time
      `.name` static resolver (`property-access.ts`) and the #1632a
      `__bind_function` hints must keep agreeing with the new own property
- [ ] Standalone lane **unchanged** — it already passes all six closure shapes
      (measured 2026-08-27, see M1b); the risk here is regression, not absence
- [ ] `Object.getOwnPropertyDescriptor(C, "name")` agrees with
      `Reflect.getOwnPropertyDescriptor(C, "name")` (today they disagree — the
      former is `undefined`, the latter is already spec-correct), and `length`
      and `prototype` on the class object are no longer `undefined`

## Notes

Reproduce any row in this issue with a test262-shaped probe under `.tmp/` run
through `runTest262File` — the runner's `wrapTest` is what makes `verifyProperty`
and the `Test262Error` channel available, and judging by anything else is how
#4764 shipped a regression.
