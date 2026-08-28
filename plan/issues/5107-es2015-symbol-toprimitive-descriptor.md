---
id: 5107
title: "Standalone Symbol prototype toPrimitive descriptor"
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
priority: medium
horizon: s
feasibility: medium
task_type: conformance
area: codegen
language_feature: Symbol.prototype[Symbol.toPrimitive]
es_edition: 2015
goal: standalone-mode
sprint: current
assignee: "ttraenkler/codex-es2015-next-lane-a"
related: [4743, 4776]
files:
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/native-proto-own-props.ts
  - tests/issue-5107-symbol-toprimitive-descriptor.test.ts
  - tests/test262-restore-builtins.ts
  - plan/issues/5107-es2015-symbol-toprimitive-descriptor.md
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/native-proto-own-props.ts
func-budget-allow:
  - src/codegen/native-proto-own-props.ts::registerNativeProtoHasOwn
---

# 5107 — standalone Symbol prototype toPrimitive descriptor

## Scope and baseline evidence

The implementation branch starts at upstream `main` commit
`caeaa2e1cf2aa225297c53076d27f97c8449a527`. The fresh authoritative baseline
JSONL snapshot was fetched on 2026-08-28 from the maintained baseline source;
the exact row carries oracle version 13 and the honest lane in both snapshots.

Claimed row:

```text
test/built-ins/Symbol/prototype/Symbol.toPrimitive/prop-desc.js
```

Baseline verdicts (the test is reached and runs under both strictness modes):

| lane | snapshot row timestamp | verdict | diagnostic |
| --- | --- | --- | --- |
| JS-host | 28.8.2026, 00:44:49 | pass | — |
| standalone | 28.8.2026, 00:58:11 | fail | `Test262Error: Symbol() should be an own property` |

This is a one-row residual selected after the requested neighboring Reflect
row was rechecked: `test/built-ins/Reflect/Symbol.toStringTag.js` is already
standalone-pass and is covered by the existing namespace metadata plan. The
current row has no exact path mention in an existing plan.

## Problem

In standalone mode, `Symbol.prototype[Symbol.toPrimitive]` is not exposed as
an own property with the ES2015 descriptor `{ writable: false,
enumerable: false, configurable: true }`. The host lane's primordial Symbol
prototype supplies the property, while the native-symbol standalone carrier
does not currently present the corresponding prototype metadata to
`verifyProperty`.

The fix must preserve the well-known-symbol identity and the existing native
Symbol value/`valueOf` behavior. It must not broaden generic ToPrimitive
coercion or alter unrelated Symbol prototype methods.

## Implementation plan

1. Trace the standalone Symbol prototype construction/read/descriptor paths
   and identify the narrow missing `@@toPrimitive` own-property metadata seam.
2. Add the smallest standalone-only metadata or descriptor arm at that seam,
   using the existing native Symbol key mapping and canonical descriptor
   flags. Keep host behavior and generic Symbol coercion byte-stable.
3. Add focused regression coverage for the claimed Test262 row plus exact
   descriptor, identity, read, and deletion controls. Verify that deletion
   does not make an inherited or synthetic property appear as an own property.
4. Run paired authoritative host and standalone rows with repeats and
   controls using no more than two workers; record exact counts, transitions,
   and scoped type/lint/oracle gates here before handoff.

## Acceptance criteria

- The claimed row is pass in both host and standalone lanes.
- Standalone descriptor flags and `Symbol.toPrimitive` identity match the
  Test262 expectations, including own-property and delete controls.
- The paired run has exactly one standalone fail-to-pass transition, zero
  pass-to-fail transitions, zero compile errors/timeouts/skips, and repeat
  determinism.
- No new standalone host imports are introduced and no unrelated Symbol
  ToPrimitive coercion behavior changes.
- The branch contains one focused regression test, this md-only plan, and one
  compliant upstream PR when all local gates are complete.

## Implementation

The Symbol native-prototype glue now advertises the well-known-symbol
sentinel `@@3` (`Symbol.toPrimitive`) alongside its existing string methods.
The standalone companion seeder boxes that sentinel into the identity-stable
native `$Symbol` carrier, so dynamic reads, own checks, descriptors, writes,
and deletes all consult one mutable proto-index entry. Its seed uses the
existing `{ writable:false, enumerable:false, configurable:true }` flag word,
while ordinary native-prototype methods retain their writable defaults. The
closure metadata maps the compiler sentinel to the ECMAScript function name
`[Symbol.toPrimitive]` and keeps the spec length `1`.

The own-property lowering has a symbol-key arm keyed by the carrier ID and
delegates presence/enumerability to the existing companion object view. It is
standalone-gated and does not alter host mode or generic ToPrimitive dispatch.

The focused regression contains two mandatory self-contained standalone
compiler controls (descriptor/identity/name/length and replacement/deletion)
and two corpus-backed exact-row cases. Corpus-backed cases are guarded only
by `existsSync(test262/harness/assert.js)`, so a checkout without Test262 still
executes the product controls. The host Test262 runner snapshot also now
includes `Symbol.prototype`: Test262's configurable `verifyProperty` probe
deletes the entry during its sloppy pass, and the snapshot restores the host
intrinsic before the strict rerun. This is test-realm hygiene, not a product
runtime fallback; the direct controls instantiate host-free standalone Wasm
with an empty import object.

## Test results

On the corpus-present worktree, the focused Vitest file passed **4/4**:

- exact host row: 1/1 pass (including strict rerun)
- exact standalone row: 1/1 pass
- self-contained descriptor/identity control: 1/1 pass
- self-contained mutation/deletion control: 1/1 pass

The corpus-absent temporary-root validation passed **2/2 mandatory controls**
and skipped only the two corpus-backed cases. TypeScript 7 typecheck passed;
Biome lint passed with no error diagnostics; Prettier check and
`git diff --check` passed; oracle-ratchet reported no checker-usage growth
(`getTypeAtLocation +0`, `ctx.checker +0`). A repeated corpus-present focused
run also passed **4/4** with the same per-case counts, for **8/8 total
focused assertions across two runs**. There were no compile errors, timeouts,
or unexpected skips.

## Refreshed-upstream verification (2026-08-28)

After the implementation checkpoint, the branch fetched upstream `main` at
`18785a67c6682b9fc41d3a220a6b88f3f42dc59e` and synchronized with a normal
merge commit `3853284e9c59dc00caf0e662431100f1218dfb2e`. The refreshed branch
has no uncommitted changes and remains limited to the reserved plan, the
three native-prototype codegen files, the focused regression, and the one
Symbol-prototype test-realm snapshot entry.

The refreshed focused corpus-present run passed **4/4** with
`TEST262_WORKERS=2` and `COMPILER_POOL_SIZE=2`: exact host **1/1**, exact
standalone **1/1**, descriptor/identity **1/1**, and mutation/deletion **1/1**;
there were zero compile errors, timeouts, or skips. The corpus-absent
temporary-root shape was rerun after the refresh and passed **2/2 mandatory
controls**, skipping only the two exact-row cases. The earlier 35-second
Vitest timeout under concurrent repository activity was an infrastructure
timeout only; the explicit 180-second reruns completed successfully.

The implementation checkpoint is `a0b66b42ecba9575c87a39e85a2050bf36b5c729`;
the refresh merge is intentionally non-rewriting. Final PR handoff must push
this branch without force and create exactly one PR against `loopdive/js2:main`.

## Handoff

Worktree: `/private/tmp/js2-es2015-next-lane-a-20260828`

Branch: `codex/es2015-next-lane-a`

Tracking is intentionally md-only; no GitHub issue is created for this lane.

Implementation and validation are complete. The validated implementation
checkpoint is `a0b66b42ecba9575c87a39e85a2050bf36b5c729`, the current-main sync
merge is `3853284e9c59dc00caf0e662431100f1218dfb2e`, and the refreshed evidence
checkpoint is `bebfbbb97c601d29951035ece2f5da0e19d5e2d8`. The branch is ready for
its single non-draft upstream PR; no additional product work remains in this
lane.
