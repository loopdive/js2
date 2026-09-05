---
id: 5316
title: "ES2015 standalone proxy — r4: §10.5 descriptor-model invariants, Reflect.set receiver, [[Construct]] NewTarget forwarding"
status: in-progress
sprint: current
created: 2026-09-04
updated: 2026-09-04
priority: high
horizon: xl
feasibility: hard
model: opus
reasoning_effort: medium
task_type: conformance
area: codegen, runtime
language_feature: proxy, reflect
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [5196, 5140, 1355, 2046, 3371, 4444]
loc-budget-allow:
  # 2026-09-04 r4 plan: the §10.5 descriptor-model validators are NEW emitted
  # natives (one per trap, ~40-120 lines each of instruction building) and go
  # in the new module object-runtime-proxy-invariants.ts; the receiver-
  # threaded [[Set]] goes in the new object-runtime-ordinary-set.ts; the
  # existing files grow by dispatch wiring only.
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-runtime-proxy-invariants.ts
  - src/codegen/object-runtime-ordinary-set.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-runtime.ts
  - src/codegen/reflect-target-guard.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/native-construct.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-09-04 r4 step 1: `registerProxyInvariantValidators` is ONE function
  # only in the TypeScript sense — its body is seven independent
  # `registerNative` calls, one per §10.5 trap, each an instruction-building
  # block that shares nothing but the local emitter helpers (isAbsent /
  # hasField / truthyField / loadTargetDesc) declared above them. Splitting it
  # would mean re-threading those 13 baked funcIdx + the shared
  # `throwInvariant` factory through seven signatures, which buys no
  # comprehension and multiplies the double-remap hazard the module header
  # documents. `ensureProxyRuntime` grows only by the registration call, the
  # `validateTrapResult` splice helper and the per-arm wiring.
  - src/codegen/object-runtime-proxy-invariants.ts::registerProxyInvariantValidators
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
coercion-sites-allow:
  # 2026-09-04 r4 step 1: the two hits are `__is_truthy` and the `__host_eq`
  # fallback arm of `ensureExternStrictEqHelper`. Neither hand-rolls a
  # coercion matrix — §10.5 states its invariants literally in terms of
  # ToBoolean (`If <trapResult> is true`) and SameValue (`SameValue(V,
  # targetDesc.[[Value]])`), and these are the same two helpers the #5140
  # target-independent half already calls for exactly those two spec
  # operations. The preferred `__object_is` is used when present; `__host_eq`
  # is only the last fallback, mirroring `buildOwnKeysDispatch`.
  - src/codegen/object-runtime-proxy-invariants.ts
---

## Problem

After #5196 r3 (PR #5576, merged 2026-09-04), the ES2015 standalone census
(baseline promoted from that merge, 10,131 / 11,704) still has **134 non-pass
rows in `built-ins/Proxy` + `built-ins/Reflect`**: 112 `fail`, 22
`compile_error`. Three mechanisms account for 75 of them, and all three live
in the proxy runtime (`src/codegen/object-runtime-proxy.ts` and the modules the
r2 plan reserved beside it):

1. **§10.5 descriptor-model invariants — 50 rows, all `Test262Error: Expected a
   TypeError to be thrown but no exception was thrown at all`.** #5140 shipped
   the *target-independent* half (getPrototypeOf / setPrototypeOf /
   isExtensible / preventExtensions, expressible with `__object_isExtensible`,
   `__getPrototypeOf`, `__is_truthy` and strict equality — see the comment
   block at `object-runtime-proxy.ts` ~L408 "(#5140) §10.5 post-trap invariant
   validation"). The DESCRIPTOR half — the rules that need the target's own
   property descriptor — was "deferred to #1355 slice G" and never landed: a
   trap may currently report a non-configurable property as absent, define an
   incompatible descriptor, delete a non-configurable key, hide keys from
   `ownKeys`, or return a primitive from `construct`, and the proxy returns the
   trap's answer as-is.

   | trap directory | rows |
   | --- | ---: |
| `built-ins/Proxy/defineProperty` | 14 |
| `built-ins/Proxy/getOwnPropertyDescriptor` | 9 |
| `built-ins/Proxy/construct` | 7 |
| `built-ins/Proxy/ownKeys` | 4 |
| `built-ins/Proxy/deleteProperty` | 3 |
| `built-ins/Proxy/get` | 2 |
| `built-ins/Proxy/has` | 2 |
| `built-ins/Proxy/set` | 2 |
| `built-ins/Proxy/getPrototypeOf` | 1 |
| `built-ins/Proxy/preventExtensions` | 1 |
| `built-ins/Proxy/setPrototypeOf` | 1 |
| `built-ins/Reflect/has` | 1 |
| `built-ins/Reflect/construct` | 1 |
| `built-ins/Reflect/apply` | 1 |
| `built-ins/Reflect/get` | 1 |

2. **`Reflect.set(target, key, value, receiver)` — 15 `compile_error` rows**
   ("Reflect.set with an explicit receiver argument is not yet supported in
   --target standalone (#2046)", refusal at
   `expressions/call-namespace-static.ts` ~L1106). `__reflect_set` writes the
   data-property subset on `target` itself and has no receiver slot. #2046's
   Codex checkpoint PR #5397 (2026-09-01, NOT mergeable, `dirty` against
   main; diff saved at `/home/user/js2/.tmp/wave4/pr5397-2046-reflect-set-receiver.diff`)
   stalled on exactly the piece this lane owns: "the current ordinary-source
   admission cannot soundly exclude Proxy prototypes reached through aliases
   and prototype mutation … keep draft until … coordinated Proxy runtime
   support exists." The receiver-threaded [[Set]] is the r2 plan's
   `object-runtime-ordinary-set.ts` (OrdinarySet with receiver, §10.1.9.2),
   with the proxy's `set` trap as one arm of the same dispatch — so it is
   built HERE, where the proxy runtime is, not in the namespace-static caller.

3. **Proxy [[Construct]] NewTarget forwarding — 10 `compile_error` rows**
   ("standalone Reflect.construct cannot preserve an arbitrary distinct
   NewTarget", refusal at `call-namespace-static.ts` ~L1940). These are the
   rows of #3371's "Proxy carrier slice (rows 20-29)": `Reflect.construct(P,
   args, NT)` on a proxy must call the `construct` trap with `newTarget` (and,
   absent a trap, forward to `Construct(target, args, newTarget)`), then apply
   §10.5.13 step 10 (non-Object result → TypeError). #3371's other 23 rows are
   the separate reflect lane's; this lane owns the proxy arm because it is a
   [[Construct]] dispatch inside `object-runtime-proxy.ts`.

Everything else in the cluster (37 `fail` rows: handler-is-context
descriptors, `ownKeys` result arrays, revocable edge cases, ...) is recorded,
not claimed; measure it in step 0 and leave the list in the report.

### Rows

§10.5 invariants (50):

- `test/built-ins/Proxy/construct/return-not-object-throws-undefined-realm.js`
- `test/built-ins/Proxy/deleteProperty/targetdesc-is-configurable-target-is-not-extensible.js`
- `test/built-ins/Proxy/ownKeys/not-extensible-new-keys-throws.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-not-compatible-descriptor-realm.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-not-compatible-descriptor-not-configurable-target-realm.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-invalid-descriptor.js`
- `test/built-ins/Proxy/deleteProperty/targetdesc-is-not-configurable.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/result-type-is-not-object-nor-undefined.js`
- `test/built-ins/Proxy/getPrototypeOf/instanceof-target-not-extensible-not-same-proto-throws.js`
- `test/built-ins/Proxy/construct/return-not-object-throws-null-realm.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-not-compatible-descriptor.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-not-configurable-writable-desc-not-writable.js`
- `test/built-ins/Proxy/construct/return-not-object-throws-boolean-realm.js`
- `test/built-ins/Proxy/get/accessor-get-is-undefined-throws.js`
- `test/built-ins/Proxy/has/return-false-target-not-extensible.js`
- `test/built-ins/Proxy/has/return-false-targetdesc-not-configurable.js`
- `test/built-ins/Proxy/construct/return-not-object-throws-number-realm.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-undefined-not-configurable-descriptor-realm.js`
- `test/built-ins/Proxy/preventExtensions/trap-is-missing-target-is-proxy.js`
- `test/built-ins/Proxy/ownKeys/not-extensible-missing-keys-throws.js`
- `test/built-ins/Proxy/set/target-property-is-accessor-not-configurable-set-is-undefined.js`
- `test/built-ins/Proxy/construct/trap-is-not-callable-realm.js`
- `test/built-ins/Proxy/construct/return-not-object-throws-string-realm.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/result-is-undefined-targetdesc-is-not-configurable.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-configurable-desc-not-configurable.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/result-type-is-not-object-nor-undefined-realm.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-not-configurable-targetdesc-is-configurable.js`
- `test/built-ins/Proxy/set/target-property-is-not-configurable-not-writable-not-equal-to-v.js`
- `test/built-ins/Proxy/get/not-same-value-configurable-false-writable-false-throws.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/trap-is-not-callable-realm.js`
- `test/built-ins/Proxy/setPrototypeOf/trap-is-missing-target-is-proxy.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-not-configurable-not-writable-targetdesc-is-writable.js`
- `test/built-ins/Proxy/defineProperty/null-handler.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-undefined-target-is-not-extensible-realm.js`
- `test/built-ins/Proxy/defineProperty/trap-is-not-callable-realm.js`
- `test/built-ins/Proxy/ownKeys/return-all-non-configurable-keys.js`
- `test/built-ins/Proxy/deleteProperty/trap-is-null-target-is-proxy.js`
- `test/built-ins/Proxy/defineProperty/trap-is-undefined-target-is-proxy.js`
- `test/built-ins/Proxy/construct/return-not-object-throws-symbol-realm.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-undefined-not-configurable-descriptor.js`
- `test/built-ins/Reflect/has/target-is-not-object-throws.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-undefined-target-is-not-extensible.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-not-configurable-targetdesc-is-undefined.js`
- `test/built-ins/Proxy/ownKeys/return-not-list-object-throws-realm.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/result-is-undefined-target-is-not-extensible.js`
- `test/built-ins/Reflect/construct/target-is-not-constructor-throws.js`
- `test/built-ins/Reflect/apply/arguments-list-is-not-array-like.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-not-compatible-descriptor-not-configurable-target.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-configurable-desc-not-configurable-realm.js`
- `test/built-ins/Reflect/get/target-is-not-object-throws.js`

`Reflect.set` receiver (15):

- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-in-bounds-receiver-is-not-typed-array.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-out-of-bounds-receiver-is-not-object.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-valid-index-reflect-set.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-canonical-invalid-index-reflect-set.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-out-of-bounds-receiver-is-proto.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-out-of-bounds-receiver-is-not-typed-array.js`
- `test/built-ins/Reflect/set/return-false-if-target-is-not-writable.js`
- `test/built-ins/Reflect/set/symbol-property.js`
- `test/built-ins/Reflect/set/different-property-descriptors.js`
- `test/built-ins/Reflect/set/set-value-on-accessor-descriptor-with-receiver.js`
- `test/built-ins/Reflect/set/set-value-on-data-descriptor.js`
- `test/built-ins/Reflect/set/receiver-is-not-object.js`
- `test/built-ins/Reflect/set/creates-a-data-descriptor.js`
- `test/language/statements/with/set-mutable-binding-idref-compound-assign-with-proxy-env.js`
- `test/language/statements/with/set-mutable-binding-idref-with-proxy-env.js`

Proxy [[Construct]] NewTarget (10):

- `test/built-ins/Proxy/construct/call-parameters-new-target.js`
- `test/built-ins/Proxy/get-fn-realm.js`
- `test/built-ins/Proxy/construct/trap-is-undefined.js`
- `test/built-ins/Proxy/construct/trap-is-null.js`
- `test/built-ins/Proxy/get-fn-realm-recursive.js`
- `test/built-ins/Proxy/construct/trap-is-null-target-is-proxy.js`
- `test/built-ins/Proxy/construct/trap-is-undefined-proto-from-cross-realm-newtarget.js`
- `test/built-ins/Proxy/construct/trap-is-undefined-target-is-proxy.js`
- `test/built-ins/Proxy/construct/trap-is-missing-target-is-proxy.js`
- `test/built-ins/Proxy/construct/trap-is-undefined-no-property.js`

## Implementation Plan — r4 (2026-09-04, Fable)

**Step 0 — inventory (measured, both trees).** Put the 75 paths above in
`.tmp/5316-rows.txt` and run them `--isolate --standalone` on a
`git archive origin/main` base tree and on the lane worktree; record status +
error per row. Also run the enclosing control corpus — every ES2015 row under
`test/built-ins/Proxy` and `test/built-ins/Reflect` (523 rows; #5196 r3
measured 382 pass on the same corpus before its merge, expect ≈ that plus
this wave's) — and keep the list of currently-passing rows: none may be lost.
Read `object-runtime-proxy.ts` end to end first, then
`object-runtime-descriptors.ts` (the standalone attribute model:
`__getOwnPropertyDescriptor`-family natives, the descriptor struct/record
shape, `IsCompatiblePropertyDescriptor` if it exists — grep
`ValidateAndApplyPropertyDescriptor` / `isCompatible`), and the #5196 r2 plan
section "2026-09-01 r2 residual plan" for the module layout it reserved.

**Step 1 — descriptor-model invariants (§10.5.5–§10.5.13), in a NEW
`object-runtime-proxy-invariants.ts`.** One native per trap, each taking
`(p: $Proxy, key, trapResult…)` and either returning the validated result or
throwing the existing `invariantMsg` TypeError (reuse `throwInvariant` /
`invariantMsg` from the #5140 block — do not mint a second message). Wire each
into the corresponding `build…Dispatch` arm in `object-runtime-proxy.ts`
AFTER the trap call, in spec order (trap result first, then
`target.[[GetOwnProperty]](P)`, then the checks). Spec step lists, which the
implementation must follow literally:

- `getOwnPropertyDescriptor` (§10.5.5 steps 9-17): result must be Object or
  undefined; `targetDesc = target.[[GetOwnProperty]](P)`; undefined result ⇒
  targetDesc must be undefined, or configurable AND target extensible;
  Object result ⇒ `ToPropertyDescriptor`, `CompletePropertyDescriptor`,
  `IsCompatiblePropertyDescriptor(IsExtensible(target), resultDesc,
  targetDesc)` must be true; `resultDesc.[[Configurable]] === false` ⇒
  targetDesc must exist and be non-configurable, and (step 17.b) if resultDesc
  has `[[Writable]] === false` then targetDesc.[[Writable]] must be false.
- `defineProperty` (§10.5.6 steps 9-16): falsy trap result ⇒ return false (no
  throw); `targetDesc = target.[[GetOwnProperty]](P)`; `settingConfigFalse =
  Desc has [[Configurable]] and it is false`; targetDesc undefined ⇒ target
  must be extensible and settingConfigFalse must be false; else
  `IsCompatiblePropertyDescriptor(extensible, Desc, targetDesc)` must hold,
  settingConfigFalse ⇒ targetDesc non-configurable, and (16.b.ii) a data
  targetDesc that is non-configurable and writable with `Desc.[[Writable]] ===
  false` is a TypeError.
- `has` (§10.5.7 step 9): falsy result ⇒ targetDesc, if present, must be
  configurable and target extensible.
- `get` (§10.5.8 step 10): non-configurable non-writable data targetDesc ⇒
  result must `SameValue` the target value; non-configurable accessor with
  undefined [[Get]] ⇒ result must be undefined.
- `set` (§10.5.9 step 9): truthy result over a non-configurable non-writable
  data targetDesc ⇒ value must SameValue; over a non-configurable accessor
  with undefined [[Set]] ⇒ TypeError.
- `deleteProperty` (§10.5.10 steps 11-13): truthy result ⇒ targetDesc must be
  absent or configurable, and (ES2020+, step 13) target must be extensible.
- `ownKeys` (§10.5.11 steps 7-23): `CreateListFromArrayLike(result, «String,
  Symbol»)` — non-key element ⇒ TypeError; duplicates ⇒ TypeError; every
  non-configurable target key must appear; if target is non-extensible every
  target key must appear AND nothing else.
- `construct` (§10.5.13 step 10): non-Object trap result ⇒ TypeError. (The
  NewTarget forwarding itself is step 3.)

The target's own descriptor MUST come from the standalone attribute model
(the same native `Object.getOwnPropertyDescriptor` lowers to), and when the
target is itself a `$Proxy` it must go through that proxy's own
`getOwnPropertyDescriptor` dispatch (recursion, not a field read). Every
emitter is a factory returning a fresh `Instr[]` (the finalize funcIdx walk
double-remaps a shared array — see the #5140 comment). Control probes (node
oracle, compiled standalone, `imports === []`): each invariant with (a) a
plain extensible target, (b) a `Object.preventExtensions` target, (c) a
target with a non-configurable data property, (d) a non-configurable accessor,
(e) a proxy-of-proxy target — and for each, the trap answering both the
compliant and the violating value. 

**Step 2 — receiver-threaded [[Set]] (`Reflect.set` 4-arg), in a NEW
`object-runtime-ordinary-set.ts`.** Implement §10.1.9.2 OrdinarySetWithOwnDescriptor
as a native `__ordinary_set_with_receiver(O, P, V, Receiver)`: walk O's own
descriptor; data ⇒ if non-writable return false; if Receiver is not an Object
return false; `existingDesc = Receiver.[[GetOwnProperty]](P)`: accessor ⇒
false, non-writable ⇒ false, else `Receiver.[[DefineOwnProperty]](P, {[[Value]]:
V})`; absent ⇒ `CreateDataProperty(Receiver, P, V)`; accessor ⇒ setter absent
⇒ false, else `Call(setter, Receiver, «V»)`; own descriptor absent ⇒ recurse
on `O.[[GetPrototypeOf]]()` — and when that parent is a `$Proxy`, dispatch
its `set` trap with the ORIGINAL receiver (this is the arm PR #5397 could not
prove around; here it is one branch of the walk). Then replace the refusal at
`call-namespace-static.ts` ~L1106 with a call to it (the 3-arg form keeps its
current lowering; only the 4-arg form routes here), keeping the existing
Object-target TypeError guard and `ToPropertyKey` order (target guard →
ToPropertyKey → set). The `with`-statement rows in the list reach this
through the proxy-environment path (`language/statements/with/
set-mutable-binding-idref*-with-proxy-env.js`) — measure whether they flip for
free; do not build a `with` arm for them.

**Step 3 — Proxy [[Construct]] NewTarget forwarding.** In
`object-runtime-proxy.ts`'s construct dispatch add a NewTarget parameter: trap
present ⇒ `Call(trap, handler, «target, argArray, newTarget»)` then the step-10
check from step 1; trap absent/undefined/null ⇒ `Construct(target, args,
newTarget)` — which, for a proxy target, recurses, and for an ordinary
constructor must construct with the FORWARDED newTarget (its prototype
selection comes from `newTarget.prototype`). Then in
`call-namespace-static.ts` ~L1930-1950, before the "cannot preserve an
arbitrary distinct NewTarget" refusal, add the arm: when the target value is a
`$Proxy` at runtime (a `ref.test` on the evaluated target — no source-shape
proof needed, this is a runtime dispatch), call the new construct native with
the evaluated newTarget. Non-proxy targets keep the existing behaviour (the
refusal for unresolvable NewTarget stays for them; the reflect lane #3371
owns those). `get-fn-realm*.js` rows expect the realm of the innermost
non-proxy target for the default prototype — with one realm this is
`Object.prototype` of the module; make sure a proxy-of-proxy chain resolves
through to it.

**Order-preservation constraints.** Programs that never construct a
`$Proxy` must be byte-identical to base on every target (`--target
standalone`, host, wasi) — verify with a Proxy-free probe module. The
#5140 half's behaviour and error message do not change. `Reflect.set` with
3 arguments is byte-identical to base.

## Acceptance criteria

- The 75 listed rows: every one `pass` under `--isolate --standalone` on the
  lane tree, or explicitly given up in the report with the mechanism named
  (a given-up row is still a measured row).
- Control corpus (`built-ins/Proxy/**` + `built-ins/Reflect/**` ES2015): zero
  rows lost against the base tree, measured the same way.
- `tests/issue-5316-r4-invariants.test.ts`, `-receiver.test.ts`,
  `-construct-newtarget.test.ts`: kept rows pinned + the node-parity probe
  matrices above; all green at the CI fork heap.
- All gates green bare and against `origin/main`; typecheck; lint.
- Proxy-free programs byte-identical to base on standalone, host and wasi.

## Lane protocol (applies to every step above)

- **Worktree only.** Work in the worktree the workflow gave you; branch from the
  merge-base you were spawned on and `git pull --no-rebase --no-edit origin main`
  before the first source edit. `git merge` is hook-blocked in the repo root;
  `git pull --no-rebase` is not. Link `node_modules` and `test262` DIRECTLY to
  `/home/user/js2/node_modules` and `$(readlink -f /home/user/js2/test262)` (no
  symlink chains through sibling worktrees). Copy
  `/home/user/js2/.test262-cache/quickjs*` into the worktree's `.test262-cache/`
  and run `node scripts/build-quickjs-eval-provider.mjs` there, or every
  eval-dependent row fails fast with "quickjs provider is not built" and hides
  both wins and regressions.
- **Measure, do not predict.** Every row you claim flips is run with
  `npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone` on BOTH
  a `git archive origin/main` base tree and the lane tree; the enclosing control
  corpus named in the plan is re-run the same way and every base-pass row must
  still pass. A `compile_timeout` under load is re-run alone before it counts.
  Name the artifact and the time for every number you write down.
- **The failure family to hunt for is "a working program now throws."** Every
  confirmed regression across the last four waves was a "provable" predicate
  resolving by NAME or by declaration shape without a single-assignment /
  shadowing proof. Decline to base unless the proof holds under reassignment,
  destructuring, loop heads, parameters, `eval`/`with` and shadowing — and
  never let a new arm change the answer of a program that worked on base.
- **Node is the oracle, but the engine differs.** CI runs node 25; this
  container runs node 22 (a node 25 lives at
  `/home/user/js2/.tmp/wrap/node25/cache/_npx/8758e404b5eed2f3/node_modules/node/bin`).
  A pin that asserts node's answer must probe the running engine, not assert a
  fixed value, when the two disagree (sloppy-function own `caller`/`arguments`
  is the known case).
- **Do not touch the other team's territory:** the generator carrier (#2864,
  every `__gen_*`/`__create_generator` row), the promise/microtask carrier
  (#2867), and built-in method reflection (#2175 — `length.js`/`name.js`/
  `prop-desc.js`/`not-a-constructor.js` rows and the
  "`Object.prototype.toString` / `Function.prototype.call` is not yet
  implemented in --target standalone" rows). Leave those rows out of your
  claims and your acceptance list; record them as gated.
- **Gates before every commit, chained:** `node scripts/check-loc-budget.mjs &&
  node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs
  && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`, then
  again with `LOC_GATE_BASE=$(git rev-parse origin/main)`; plus
  `pnpm run -s check:speculative-rollback` (a raw `fctx.body.length = n`
  rollback outside `context/speculative.ts` fails CI — use
  `withSpeculativeCompile`/`probeCompiledType`), `check:stack-balance`,
  `check:codegen-fallbacks`, `check:any-box-sites`, TS7 typecheck
  (`node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`)
  and `pnpm run -s lint`. Growth grants go in THIS issue's frontmatter
  (`loc-budget-allow` / `func-budget-allow`) with a dated rationale; never edit
  `scripts/*-baseline.json`. New codegen type queries go through `ctx.oracle`.
- **Tests:** `tests/issue-<id>-r4-*.test.ts` pin every kept row through
  `runTest262File(file, "issue-<id>", 60_000, "standalone")` plus node-parity
  probes compiled with `compile(source, { target: "standalone", allowJs: true,
  skipSemanticDiagnostics: true })`, asserting `result.imports` is `[]`. Run
  them at the CI fork heap, single fork:
  `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 npx vitest run tests/issue-<id>*.test.ts
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
  --dangerouslyIgnoreUnhandledErrors`.
- **Commits:** author stays the repo's configured identity; subject ends with
  ` ✓`; `SKIP_SLOW_PRECOMMIT=1`; never `--no-verify`; trailers
  `Model: Claude Opus 5 Medium`, `Co-Authored-By: Claude Opus 5
  <noreply@anthropic.com>`. Commit each step separately with the measurement
  in the body. Do NOT push, open a PR, or enqueue — the integrator merges the
  lane branch, validates the combined tree and opens the PR.
- **Report** (your final message): the per-step row table (base → lane, kept /
  given up), the control-corpus result, gate status, the worktree path and head
  sha, and every residual with its mechanism.

