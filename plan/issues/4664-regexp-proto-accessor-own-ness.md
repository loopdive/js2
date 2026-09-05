---
id: 4664
title: "ES5 standalone: a deleted RegExp.prototype ACCESSOR is resurrected by the member CSV — 3 rows, same defect #4491 T9 closed for `constructor`, one member-kind over"
status: in-review
sprint: current
created: 2026-08-24
updated: 2026-08-24
priority: medium
horizon: m
feasibility: medium
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: regexp
goal: standalone-gap
assignee: ttraenkler/codex
related: [4654, 4491, 3875, 2885]
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/registry/imports.ts
origin: "split out of #4654 part B by the lane that fixed part A. Root cause below is MEASURED, not suspected — the lane located the exact predicate and the exact restriction that hides the delete."
---

## Problem

Three rows. `RegExp.prototype` is the receiver, not an instance:

```
built-ins/RegExp/prototype/global/S15.10.7.2_A9.js       __re.hasOwnProperty('global') must be false
built-ins/RegExp/prototype/multiline/S15.10.7.4_A9.js    ... 'multiline'
built-ins/RegExp/prototype/ignoreCase/S15.10.7.3_A9.js   ... 'ignoreCase'
```

```js
var __re = RegExp.prototype;
assert.sameValue(__re.hasOwnProperty('global'), true);    // passes
assert.sameValue(delete __re.global, true);               // passes
assert.sameValue(__re.hasOwnProperty('global'), false);   // FAILS
```

The runner attributes two of the three to `at L14`; that is a heuristic artifact.
The assertion **message** ("must return false") is authoritative and is L16 in all three.

## Root cause (measured in the #4654 lane)

`__nproto_hasown` (`src/codegen/native-proto-own-props.ts`) answers `1` for **any**
key present in the brand's `$memberCsv`, and `global` / `ignoreCase` / `multiline`
are in `REGEXP_PROTO_STRING_MEMBERS`. The seeded-member ladder that consults the
**mutable companion** — the one #4491 T9 extended to cover `constructor` — is
restricted to `kind === "method"`, because `ensureNativeProtoCompanionSeeder`
deliberately does not seed accessors.

So the delete succeeds and is then unobservable: nothing on the `hasOwnProperty`
path can ever see it for an accessor-kind member.

Structurally this is the **same defect #4491 T9 closed for `constructor`**, one
member-kind over.

## Why this is filed rather than fixed

Widening the ladder means touching `ensureNativeProtoCompanionSeeder` to seed
accessors. **A prior attempt at exactly this flipped #2885** — the record lives in
`src/codegen/native-proto.ts`. That is why this is a separate issue with its own
canary requirement rather than a rider on #4654.

## Implementation Plan

1. **Read the prior-attempt record first** in `ensureNativeProtoCompanionSeeder` /
   `src/codegen/native-proto.ts`, and state in your report how your approach differs
   from the one that flipped #2885 — or decline with the measurement.
2. **Establish a #2885 canary on BOTH arms before writing any fix.** The failure mode
   this issue guards against is a regression in a *different* issue, so a sweep that
   does not include #2885's rows cannot see it. Run the canary on the base arm first
   so you have a real before-state (file-copy A/B, capture `.tmp/base.ts` at the first
   edit).
3. Widen the companion consult so a deleted **accessor** member is observable:
   either seed accessor-kind members into the mutable companion, or add an
   accessor-aware deleted-key set that `__nproto_hasown` consults before answering
   from `$memberCsv`. Prefer whichever does **not** change what a non-deleted
   accessor read returns.
4. **Check #3875 first if the root moves.** #3875 is "reflection routes disagree on
   built-in prototype properties". If the real root turns out to be #3875's rather
   than this ladder's, hand it back **with evidence** instead of patching here.

## Acceptance

- The three rows above pass in standalone.
- **#2885 measured green on both arms** — this is the gate, not a nice-to-have.
- Blast-radius sweep per `plan/method/es5-standalone-agent-brief.md`: this touches a
  shared prototype-reflection helper, so the sweep covers the native-proto consult's
  call sites, not just `built-ins/RegExp`.
- Zero regressions, with contention-suspect rows re-run serially before they are
  reported as flips.

## Sol refinement — implementation-ready accessor tier (2026-08-24)

The current merged standalone artifact (workflow run `32681482355`, baseline
`0534ed4`) confirms these are still exactly three of the 145 ES5 non-passes at
**8,884 / 9,029**. The earlier plan identifies the right storage boundary but
leaves two materially different fixes open. This refinement chooses the
coherent one and defines the stop conditions.

### Decision: seed the real accessor descriptor only after the two read paths agree

Do not add a hasOwn-only deleted-key side table. It would make
`hasOwnProperty` report deletion while `[[Get]]`, gOPD, own-key enumeration,
and redefinition still observe the immutable CSV surface. The issue is a MOP
coherence defect, so all own-property views must share one state.

The target design is:

1. isolate and fix the #2885 inline-vs-materialized getter divergence;
2. seed the accessor into the existing mutable proto companion as an accessor
   descriptor;
3. let the existing companion tombstone/redefinition machinery become the
   authority for get, hasOwn, gOPD, delete, and own-key enumeration;
4. retain the immutable CSV only as the pristine fallback for an unseeded
   brand/member.

If Stage 1 cannot make the existing companion descriptor path answer the
pristine intrinsic correctly without a new representation, stop and record the
two traced paths. Do not ship a one-surface tombstone table as a fallback.

### Stage 0 — establish the two-arm canary before editing

On current `origin/main`, compile one module containing all of these forms so
they share the same intrinsic and companion demand state:

- inline `RegExp.prototype.global`;
- `const p: any = RegExp.prototype; p.global`;
- `Object.getOwnPropertyDescriptor(RegExp.prototype, "global").get.call(RegExp.prototype)`;
- the same getter called on `/x/g`;
- a wrong receiver, which must throw a catchable `TypeError`;
- `hasOwnProperty`, gOPD, `Object.getOwnPropertyNames`, and `delete` before and
  after the target operation.

Record WAT/function routes for both reads. The historical note says the inline
form diverged while a local/materialized read remained correct; prove that on
this head rather than inheriting the old diagnosis. Run the full #2885 suite on
the untouched base and save exact result counts.

### Stage 1 — unify pristine accessor invocation

The accessor closure produced by
`ensureStandaloneNativeMethodClosure(ctx, RegExpBrand, "global", "getter")`
must implement one rule regardless of the source spelling:

- `this === RegExp.prototype` returns `undefined` for these legacy accessors;
- a branded RegExp instance returns the flag boolean;
- every other receiver throws a catchable `TypeError`.

Make the static/inline fold and the runtime companion invocation delegate to
that same semantic core, or make the static arm decline once the accessor is
materialized. Do not duplicate a second `SameValue(this,
%RegExp.prototype%)` test. Preserve evaluation order and do not replace a
catchable error with `ref.cast`/`unreachable`.

Likely files are `src/codegen/regexp-standalone.ts` (the RegExp getter body),
`src/codegen/native-proto-value-read.ts` or the current inline member-read
dispatcher, and `src/codegen/native-proto.ts`. Stage 0 decides the exact pair;
do not edit all reader sites speculatively.

### Stage 2 — seed accessor descriptors into the existing companion

Extend `ensureNativeProtoCompanionSeeder` for getter-kind members using
`__defineProperty_accessor`, not `__defineProperty_value`. The descriptor flags
are the existing accessor encoding documented beside the seeder:
`(1<<4)|(1<<5)|(1<<2)` = enumerable/configurable specified plus configurable
true, i.e. `{ enumerable:false, configurable:true }`. The getter is the
identity-stable native getter closure; the setter is absent.

Generalize the current `seededNativeProtoDataMembersByBrand` authority list to
an explicit seeded-own-member list that includes seeded methods, constructor,
and accessors. Every consumer must ask that one list before an immutable
CSV/constructor shortcut. Do not make a getter look like a data method and do
not place symbol-keyed members into the string companion.

The companion must remain demand-gated by `ctx.protoMemberDirty` and actual
materialization of the brand. Re-read helper/function indices after accessor
helper registration; the current seeder parks pre-runtime brands for this
reason. Every repeated finalize branch gets a fresh instruction tree.

### Stage 3 — prove one authoritative MOP state

For each of `global`, `ignoreCase`, and `multiline`, the focused test must prove:

1. pristine hasOwn is true, gOPD reports an accessor with `{e:false,c:true}`,
   and the pristine read has the correct value;
2. delete returns true;
3. after deletion, hasOwn is false, gOPD is undefined, own names omit the key,
   and a read follows the ordinary prototype chain/miss instead of resurrecting
   the CSV member;
4. redefining the key as a data property or a new accessor restores all views
   coherently;
5. a same-named inherited entry is visible to ordinary `[[Get]]` but never to
   the own-only views.

Add controls for seeded data methods and `constructor` so widening the authority
list does not regress #4491 T9. Include the exact #2885 inline/local canaries and
the `%TypedArray%.prototype.{buffer,byteLength,byteOffset,length}` descriptor
rows named in the historical warning.

### IR, conditional emission, and validation

At least one deletion/redefinition caller must be genuinely IR-compiled with no
post-claim error; the companion/native runtime is shared between IR and legacy
callers. A legacy-only static fold does not complete this issue.

Required gates:

- exact three-row base/head A/B through the authentic standalone harness;
- all current ES5 RegExp rows, plus #2885/#3875/#4491 native-proto suites;
- native-proto method mutation/deletion and descriptor families;
- standalone and non-standalone focused controls;
- TS7/TS5, formatter, `git diff --check`, IR fallback/shape, LOC/function/
  coercion/helper/index budgets, and the conditional-emission oracle.

Modules with no accessor reflection/deletion demand must not gain accessor
closures, companion entries, helpers, globals, or index-space drift. Report
the exact emitted-size/helper delta for one pristine RegExp module and one
unrelated module.

### Dispatch contract

This three-row slice is ready for a Luna-max implementer in its own latest-main
worktree. The agent owns the smallest Stage-0-proven reader/getter files,
`native-proto.ts`, `native-proto-own-props.ts`, and a new focused
`tests/issue-4664-*.test.ts`. It must not change the RegExp parser/VM, dynamic
pattern support, Test262 skip logic, or unrelated object-property semantics.

## Implementation result — 2026-08-24

Originally implemented against `origin/main` at
`a71d6e8c5ede68be9deada25f8eb5386cde080c4`, then transplanted cleanly and
re-reviewed against `778e4ae0f4c58562551b8de7172e1d02dfeb86d8` before landing.
The three measured standalone rows now pass together through the authentic
Test262 harness:

- `built-ins/RegExp/prototype/global/S15.10.7.2_A9.js`
- `built-ins/RegExp/prototype/ignoreCase/S15.10.7.3_A9.js`
- `built-ins/RegExp/prototype/multiline/S15.10.7.4_A9.js`

The implementation seeds getter-kind native-prototype members into the existing
mutable companion with `__defineProperty_accessor` and the §17 accessor flags.
The seeded-own authority map now covers methods, accessors, and a materialized
`constructor`, so `[[GetOwnProperty]]`, `hasOwnProperty`, own-key enumeration,
delete, and redefinition all observe one descriptor state. No parallel RegExp
tombstone table was added.

Two representation seams were required to make that widening sound:

1. Getter metadata subtypes have a dedicated zero-argument accessor-receiver
   classification. `__call_accessor_get` therefore threads the original
   receiver, while the historical directly-called closure form does not lose
   its first supplied argument. `.call(thisArg)` remains receiver-aware.
2. The lazy native-prototype singleton global map now lives on `CodegenContext`
   and participates in late import-global index fixup. Finalize-time seeding can
   no longer read a stale cached global index.

The old #2175 tests that treated a plain `RegExp.prototype.global` read as the
getter function itself were migrated to the actual ECMAScript surface: plain
reads invoke the accessor, while reflective calls obtain
`Object.getOwnPropertyDescriptor(...).get` and bind the receiver with `.call`.
This is a test correction, not a compatibility carve-out; the prior internal
getter-closure leak contradicted the #2885 canary and the property semantics this
issue closes.

Evidence on the final working tree:

- focused #4664 + #2885: 12/12 pass;
- corrected #2175 accessor/read controls: 4/4 pass;
- all three exact Test262 rows: 3/3 pass in one exnref-enabled child process;
- wrong/prototype/instance receiver matrix: 31/31;
- dynamic post-delete reader is genuinely IR-compiled (`reader` only), with no
  post-claim errors;
- unrelated `/x/g.global` emits no native-prototype seeder/getter closure;
- emitted-Wasm identity oracle: 60/60 `(file,target)` records byte-identical to
  the untouched base;
- TS7, TS5, IR fallback, issue, LOC/function/coercion budgets, formatter, and
  `git diff --check` pass.

The RegExp parser/VM, dynamic pattern grammar, Test262 skip policy, and
non-standalone host path remain unchanged.
