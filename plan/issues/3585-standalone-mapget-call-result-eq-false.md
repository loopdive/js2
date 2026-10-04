---
id: 3585
title: "Standalone: `m.get(k) === lit` false in direct call-result position (true via a local); an any-keyed Map poisons even typed Maps module-wide"
status: in-progress
sprint: current
created: 2026-07-25
updated: 2026-09-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: Map, equality
goal: standalone-gap
related: [2773, 2141, 2040, 3053]
origin: "2026-07-25 Fable substrate/async review (plan/agent-context/fable-substrate-async-review-2026-07-24.md), probe s2h/s2i"
assignee: "ttraenkler/codex-3585-map-result-equality"
branch: "codex/3585-map-result-equality"
loc-budget-allow:
  - src/codegen/binary-ops-typed-dispatch.ts
func-budget-allow:
  - src/codegen/binary-ops-typed-dispatch.ts::compileTypedBinaryDispatch
---

# Standalone: Map.get result compared in direct call-result position answers false

## Problem (verified on main 7652f0337, target: standalone)

Comparing a `Map.get()` call result **directly** against a numeric literal
answers `false`, while routing the identical value **through a local** answers
`true` — in the same module, same map, same key:

```ts
export function test(): number {
  const a: any = { v: 1 };
  const arr: any[] = [a];
  const m = new Map<any, number>();
  m.set(a, 7);
  let code = 0;
  if (m.get(a) == 7) code += 1; // direct loose  — FALSE (wrong)
  if (m.get(a) === 7) code += 2; // direct strict — FALSE (wrong)
  const g = m.get(a);
  if (g == 7) code += 10; // local loose  — true
  if (g === 7) code += 20; // local strict — true
  if (arr.length === 1) code += 100;
  return code; // node/gc: 133 · standalone: 130
}
```

**Silent wrong answer** — no trap, no refusal. `if (map.get(k) === v)` is an
extremely common idiom, so the blast radius is large.

### Module-composition sensitivity (worse)

The presence of an **any-keyed Map elsewhere in the module** poisons even a
fully **typed** `Map<object, number>`:

```ts
export function test(): number {
  const a: any = { v: 1 };
  const m = new Map<any, number>();
  m.set(a, 7); // ← any-keyed map present
  const m2 = new Map<object, number>();
  const plain = { v: 2 };
  m2.set(plain, 3);
  const g = m2.get(plain);
  let code = 0;
  if (g === 3) code += 1; // via local  — true
  if (m2.get(plain) === 3) code += 10; // direct strict — FALSE (wrong)
  if (m2.get(plain) == 3) code += 100; // direct loose  — FALSE (wrong)
  return code; // node/gc: 111 · standalone: 1
}
```

In **isolation** (no any-keyed Map in the module) the typed-map version passes
(probe s2c: 111110 everywhere). So which reader/eq path `m2.get` takes is
decided by unrelated module contents — a representation-coherence violation of
exactly the #2773 class: the call-result-position value reaches the eq lowering
in a different representation than the local-materialized one, and the
module-wide carrier selection shifts when an any-keyed Map exists.

Not IR-related: identical divergence with `experimentalIR: false`.

Host (gc) lane is correct in all variants. `m.has(...)` is correct; arithmetic
on the value (`(g as number) + 0 === 7`) is correct — only the ==/=== lowering
against the direct call result is wrong.

## Ownership and bounded scope (2026-09-28)

The live claim is the slice-specific
`3585:direct-result-equality` record for
`ttraenkler/codex-3585-map-result-equality` on
`upstream/issue-assignments`. The older bare `3585` record remains untouched:
it names the July `issue-3585-toplevel-throw` vacuity lane that was renumbered
to #3592, not this Map equality repair.

This implementation may modify only:

- `src/codegen/binary-ops-typed-dispatch.ts`;
- one focused standalone regression test; and
- this issue record.

It must not alter `map-runtime.ts`, `binary-ops.ts`, IR lowering, collection
storage, or introduce a host equality import. An overlap review found the
other-machine IR PR #6205 in `binary-ops.ts`, not the owned typed-dispatch
leaf.

The reviewed issue-scoped LOC allowance covers the exact `+101` lines in
`binary-ops-typed-dispatch.ts`: wrapper unwrapping, oracle-classified receiver
recognition, and the narrow raw-`anyref` equality dispatch extracted into a
small helper for readability. The paired function allowance covers only the
remaining `+15` lines in `compileTypedBinaryDispatch` for that helper call. No
allowance covers checker/oracle expansion, coercion-site growth, baseline
change, or the separately unresolved nullish behavior.

## Current source audit (2026-09-28; source hypothesis, not a runtime verdict)

At upstream `27d215fb9e52c28c2ea7bc38d1fc27c63fe7a227`, native
`Map.prototype.get` deliberately returns `{ kind: "anyref" }` from
`tryCompileNativeMapMethodCall`; `$MapEntry.F_VALUE` and `__map_get` use that
same carrier. That storage/result contract is intentional and stays unchanged.

`compileTypedBinaryDispatch` currently defines its reference arms only for
`ref` and `ref_null`. A direct `Map.get()` `anyref` compared with a native
string ref therefore misses the mixed-reference bridge and can reach the strict
fallback that drops both operands and emits a constant. The retained diagnostic
trace for `m.get(1) !== "valid"` showed `call $__map_get; drop; i32.const 1`.
This explains that string shape, but does **not** yet prove the historical
numeric loose/strict failures take the same route.

The existing native-first semantic pieces are reusable: the forced-honest
`ensureAnyFromExternHelper` classifier preserves wrapped `$AnyValue` values and
classifies numeric, boolean, native-string, and eqref values by tag;
`__any_strict_eq` and `__any_eq` implement the corresponding strict and loose
comparisons. A raw `ref.eq` expansion is not sound: it would lose numeric
value equality and native-string content semantics.

## Frozen baseline receipt (2026-09-28)

The source oracle ran under Node `v24.19.0`, terminal exit `0`, from the
ignored fixture SHA-256
`255e4b3e2d0c2abd2cc77a47e281d4d67d68ff236b7b5b0e4e93326f9e6c86c3`.
It returned the expected `133`, `111`, string `5`, object `15` (including
reversed operands), and nullish `63`/`1023` control values.

The initial standalone matrix used fixture SHA-256
`b6f2d90b456deae15fcff6fa314895b517804a40b1bacecc818e3302fe7d37af`
with explicit Node 24, one Vitest fork, and a 4-GiB parent/fork heap. Its
terminal exit was `1` (`7` failing rows, `1` passing typed-string control); the
log SHA-256 is
`09fd255ec7a007701cd7a47cf706fa9baab87d78b4c8a5aab20765fe6bf9f3bc`.

- Original numeric direct/local: `130`, expected `133`; composition: `1`,
  expected `111`.
- Direct object identity: `14`, expected `15`; reversed direct object operands:
  `12`, expected `15`.
- The typed-string-only control passed, so it does not stand in for the
  mixed-value case.
- Nullish direct controls returned `42`, expected `63`.
- Both the combined mixed-value source and its string-only split compiled with
  `success: true` but produced invalid Wasm. `WebAssembly.compile` reports
  `f64.eq[1] expected type f64, found local.get of type anyref` in the direct
  function. These are compiler-invalid failures with no runtime result, not
  fixture infrastructure failures.

The combined invalid source remains an acceptance row; the split sources only
localize its direct string and nullish portions.

## Candidate partial receipt and nullish boundary (2026-09-28; not a full fix)

The owned typed-dispatch candidate was SHA-256
`c57e53d9daa64a1aa36ae24f0ae70e2b0b7d4b37b61ad24328a771e70399aa6f`.
The then-current focused fixture was SHA-256
`bb918119d197f6d64f0e08f10e37bc287d2e75abcd0cc0593ce80ae59daf93c5`;
the later WAT-target assertion cleanup has a separately recorded fixture hash
and needs a fresh matched run before it can replace this historical receipt.
The candidate focused command exited `1` with four passing and four failing
rows; log SHA-256:
`0b2fdfc43115a9308041e44a91757f5999ab0f8fc68452b48ea6225b8ec06c98`.

- Both original numeric programs, the direct object identity rows (including
  reversed operands), and the typed-string positive passed at their expected
  runtime values. The unannotated mixed-string source now validated and
  instantiated, so the prior `f64.eq(anyref, f64)` compiler-invalid failure is
  gone for that slice.
- The candidate does **not** repair direct Map-result nullish comparisons:
  `nullishAndTypeMismatch()` returned `2`, not `3`; the combined source returned
  `687`, not `1023`; and the split nullish source returned `42`, not `63`.
  In the combined value, the passing bits are the string comparisons and the
  three `!==` rows; the missing bits are absent `=== undefined`, stored
  `undefined === undefined`, and stored `null === null`. These remain explicit
  red acceptances, not a Map-storage conclusion.
- A one-test candidate WAT diagnostic (terminal `0`, 13.21 s) retained log
  SHA-256 `24053f43baa61a1b1a5d0369dee449c5dd8f685a37458e33428309dc50c87e0c`.
  Its temporary runner-visible copy, SHA-256
  `1d8ece7cb90a4429813c0e2ff9803cefbb91012282c71ac596f65517644123bd`,
  was removed after the run. The printed `$nullishMapResults` body has six
  repeated direct-result routes of `call 79; drop; i32.const 0/1` after map/key
  setup (with `call 82` used for initialization). It contains no observed
  reference-equality or null-test instruction. Because that diagnostic printed
  function bodies rather than the full callable inventory, numeric `79` is not
  claimed as an independently named WAT symbol; source establishes that native
  `Map.get` emits its helper and returns `anyref`.

The source boundary agrees with the emitted observation. The nullish arm in
`binary-ops.ts` invokes `compileNullishObservedExpression` before typed binary
dispatch. For this direct `m.get(...)` **call** that helper itself falls through
to generic `compileExpression` (its special boxed route is only for a
`PropertyAccessExpression`), returning raw `anyref`; `binary-ops.ts` has no
`anyref` nullish arm and reaches its generic `drop; i32.const` fallback. The
existing `property-nullish-read.ts` helper is therefore a possible future
normalization seam only after separate ownership/design review, not a change
made or proven by this direct-result equality slice. `binary-ops.ts` remains
held and unmodified.

## Receiver-provenance guard (2026-09-28; focused controls measured)

The direct-result predicate uses the existing
`ctx.oracle.builtinReceiverOf(receiver) === "Map"` boundary rather than a raw
`ctx.checker` query or the receiver spelling. An oracle result of `undefined`
is a deliberate decline. This retains an ordinary alias whose *type* is
oracle-classified as `Map`, while leaving a source-defined `class Map` and an unrelated
`.get()` on their existing lowering paths.

The focused regression adds two controls alongside the original eight rows:

- a `const alias = m` oracle-classified-Map positive, requiring runtime result `3` and
  the emitted direct-call body to reach `__extern_strict_eq`; and
- a source-defined `class Map` negative, requiring runtime result `1` with no
  emitted `__map_get` helper.

Those controls establish alias preservation and source-class shadow safety;
they do **not** establish a general project-`.d.ts` provenance rule.
`TypeOracle.declarationsOf(receiver)` describes the receiver binding (for
example `alias` or `m`), not the symbol declarations of its resolved type, so
it cannot prove that a type named `Map` comes from the standard library.
No binding-declaration source is used as a substitute for that missing fact.
If a future repair needs that distinction, it requires a separately reviewed
oracle type-symbol provenance fact and its own controls; this leaf keeps an
unknown result on the existing path.

## Oracle-guard candidate receipt (2026-09-28; partial result)

The current oracle-only typed-dispatch source is SHA-256
`56141a4f181385bfe6a33f5ff340fc13029aad6f0f827c91374073ab79ef6225`.
The final focused fixture is SHA-256
`948a8a2e5035b694b0e91e217ae893cdb1bd12718c5300f97c9919594e5c2936`.
Under Node `v24.19.0`, one Vitest fork, and 4-GiB parent/fork heaps, the
candidate command exited `1`: seven rows passed and the three retained
nullish rows failed. The terminal log is
`.tmp/3585/candidate-focused-v5.log`, SHA-256
`fa5090d3072038859c109d51845b66ff90966527306ffa0a811648c5233654b4`.

- Both original numeric programs, typed-string control, direct object controls
  (including reversed operands), and the mixed-string direct result pass.
- The new mixed-seed `const alias = m` control answers `3`; its direct function
  names the emitted `__extern_strict_eq` target by numeric WAT call identity.
  The source-defined `class Map` control answers `1` and its module contains
  no emitted `__map_get` helper.
- The retained failures are unchanged: `nullishAndTypeMismatch()` answers `2`,
  not `3`; the combined mixed program answers `687`, not `1023`; and
  `nullishMapResults()` answers `42`, not `63`. They remain visible acceptance
  failures outside this owned non-nullish equality boundary.

An immediately preceding v4 control run used a typed
`Map<number, string>` alias. It answered its runtime value correctly but did
not name `__extern_strict_eq`, because that source selected a typed
native-string route rather than the raw-`anyref` route this repair owns. That
instrumentation mismatch was not treated as a product result: v4 exited `1`
with six passes/four failures, and its retained log SHA-256 is
`04c3fa8130f556af3987a87338271149a407b9d75d640c1cac32592d9324e09c`.
V5 changed only the alias control to a mixed-seed Map, kept all original eight
rows, and supplied the relevant raw-carrier WAT evidence.

After v5, explanatory comments were revised from an ambient/native wording to
the precise oracle-classified wording, followed by mechanical formatter
wrapping. Those intervening documentation-only bytes were source SHA-256
`525d1be9b2106bc406371acb13ca68c232d258ada891cca424410b831a96684b`;
the v5 receipt continues to name its exact pre-comment/pre-format hashes.

The subsequent readability extraction produced source SHA-256
`9b86c06137d527b1b290d6a3df8627b66609e8b4c91e6a8a69c88cce1e967e76`
with the unchanged test file SHA-256
`e57e1ee4c5785d3631256d62487d60794eefc7ef2dd940a9c7984aacee56d476`.
It was re-run under the same Node 24 one-fork/4-GiB configuration: terminal
exit `1`, seven passing rows, and the same three explicit nullish failures.
The v6 helper-refactor log SHA-256 is
`d76134f473348bc35955f554c9211df78f4faa8039fcf46b59f06c0519ef97b2`.
The plan file at that run was SHA-256
`9e31d570657425ec07c21428108d0183efed07da5d9e8bd7849430b0db6cff38`;
the later plan edits record the reviewed budget allowances and this receipt.

## Implementation and evidence plan

1. **Freeze the before-state.** Use a current Node 24 source oracle and a
   standalone compiler/Wasm fixture at `27d215f` for both historical numeric
   programs (direct versus local, and the any-keyed-map composition case), plus
   direct typed-string equality, an unannotated mixed-value Map whose direct
   string loose/strict comparisons run in both operand orders, explicit
   missing/stored-`undefined`/stored-`null` distinctions, and object identity
   controls in both operand orders. Record the precise result and emitted
   equality route for every case; historical `133`/`111` values are acceptance
   expectations, not a substitute for this baseline.
2. **Repair only the direct `anyref` equality boundary.** In
   `binary-ops-typed-dispatch.ts`, recognize only a direct oracle-classified
   native `Map.prototype.get()` expression whose compiled value is raw
   `anyref`, under the native-first standalone/WASI lane. Normalize that result
   through the existing strict/loose helper boundary. Do not simply include
   `anyref` in `leftIsRef`/`rightIsRef`, claim a name-only `Map`, infer standard
   library provenance from a receiver binding declaration, or broaden to
   another producer's `anyref` expression.
3. **Add one focused regression file.** It must keep both original numeric
   acceptance programs and their local-materialization positives, and add the
   string constant-fallback reproducer plus the mixed-value, nullish, and
   object-identity controls above. Each assertion must compile, instantiate,
   and observe the exported runtime value; the WAT evidence must positively
   show the direct mixed result reaches the native loose/strict equality
   helpers, not merely omit the old `drop; i32.const` fallback.
4. **Validate as a matched A/B.** Run the byte-identical fixture against the
   clean `27d215f` baseline and candidate under the same standalone harness,
   with Node version, source/fixture hashes, command, terminal exit status, and
   positive controls recorded. Run the focused regression file and proportionate
   equality controls afterward. Do not claim full Map or Test262 conformance
   from this bounded evidence.

The issue remains in progress until both original numeric acceptance programs
and their positive local controls have a measured candidate result. If either
remains red, record the residual rather than closing this issue.

The current typed-dispatch candidate is only the direct non-nullish equality
repair. The recorded nullish residual requires its own source-boundary and
ownership decision; it must not be hidden by weakening this fixture or treated
as repaired by the Map carrier work.

## Historical suspected area

Standalone Map carrier value read (collections codegen) returning an
externref/boxed rep in expression position, vs the any-eq / tag-5 classifier
path (`src/codegen/any-eq-helpers.ts`, `any-helpers.ts` tag5 emit) not
unboxing that rep. The local-assignment path forces an unbox via rep
inference, which is why the local variant works.

## Acceptance

### 2026-09-28 upstream-merge checkpoint

The source checkpoint `c63dcf845b585e9a4ede52f18002d13d4c55d676` was merged
normally with upstream main `45ce4a8e207742df5ca3888c0a458e8a48ee1655`.
At merge revision `f84bbc4acb2ca0f3c9e40e3afc429e16c948530f`, the focused
Node 24.19.0 / one-fork / 4 GiB run (retained session `53167`) terminated
exit 1 after 15.06 seconds: **7 pass / 3 fail**, with unchanged nullish values
2 versus 3, 687 versus 1023, and 42 versus 63. No assertion was removed.
The subsequent publication commit adds documentation only to that tested tree.

Source SHA-256: `9b86c06137d527b1b290d6a3df8627b66609e8b4c91e6a8a69c88cce1e967e76`.
Fixture SHA-256: `e57e1ee4c5785d3631256d62487d60794eefc7ef2dd940a9c7984aacee56d476`.
Log: `.tmp/3585/root-post-main-focused.log`, SHA-256
`8511775589b04223cc2b132f0661518a404162eb7f9f09e0f8932517220e0637`.
This remains an unfinished draft checkpoint, not closure of the issue or a
claim that the original mixed-Map Test262 failure is fixed.

- Both probes above return the node value (133 / 111) under
  `target: "standalone"`.
- The mixed-value direct sources validate and instantiate; no `f64.eq(anyref,
  f64)` failure remains, and the WAT names the native strict/loose equality
  helpers for the direct mixed-string route.
- Add both as standalone regression tests (direct-position and
  module-composition variants), retaining the direct object and nullish rows.
