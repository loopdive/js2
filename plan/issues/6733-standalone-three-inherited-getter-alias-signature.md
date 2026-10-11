---
id: 6733
title: "standalone: three.js stops at a program-ABI invariant — inherited class-instance getter alias disagrees with its canonical signature"
status: done
sprint: Backlog
created: 2026-09-28
updated: 2026-09-29
completed: 2026-09-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [1599, 6667]
loc-budget-allow:
  # 2026-09-29 (#6733): +23 for `retypeCallableAlias`, the only way to move a
  # slotless alias draft and its structured contract together — both maps are
  # private session state, so the method cannot live in a satellite module.
  - src/codegen/program-abi-session.ts
---

# #6733 — three.js standalone: inherited getter alias signature mismatch

## Problem

Surfaced by [#1599](https://js2wasm.loopdive.com/dashboard/issue.html?slug=1599-json-standalone)
Phase 2: once `JSON.stringify(groups)` in `BufferGeometry.toJSON` compiles in
standalone, the three 0.185.1 standalone-dynamic lane
(`npx tsx scripts/generate-npm-compat-report.mjs --only three --no-write --perf-only --lane standalone-dynamic`,
~400 s to the error) stops at a program-ABI invariant instead of the JSON
refusal:

```
Codegen error: inherited class callable ir-class:v1:…three.core.js:root:declaration:0000000000000010 /
ir-unit:v1:…three.core.js:ir-class%3A…declaration%3A0000000000000009:class-instance-getter:0000000000000001
disagrees with its exact canonical signature (at src/codegen/program-abi-class-callable-planning.ts:823:17)
```

The throw is the `alias-signature-mismatch` invariant: the child class
(declaration 16) inherits a getter from declaration 9, and the canonical, the
alias draft and the live function do not share one callable type contract.

## Evidence that #1599 did not cause it

A/B on the #1599 branch with the only class-touching part of that change (the
`__get_member_toJSON` reservation) disabled produced the identical diagnostic.
The rest of #1599 adds runtime helper functions only. On the parent the
compile never reached this pass: codegen refused `JSON.stringify` first.

## Next steps

- Reduce: extract declarations 9 and 16 of `build/three.core.js` (the first
  inheriting class pair with an instance getter) into a two-class fixture and
  compile it `--target standalone`.
- Compare the three signatures at the throw site (`canonicalSignature`,
  `aliasSignature`, `liveSignature`) — the comment above the check names the
  `super.value` getter receiver `ref 14` vs `ref 1` remap as a known hazard.

## Implementation Plan

Executed as written.

1. **Reduce.** The first mismatch is `RenderTarget` (root declaration 9) getter
   `depthTexture` (instance getter ordinal 1, JSDoc `@type {?DepthTexture}`)
   inherited by `WebGLRenderTarget` (declaration 10). `DepthTexture` is declared
   much later in `three.core.js`. Two-class fixture with the later class moved
   after the child reproduces the exact throw; the same shape reproduces for a
   TS method whose return type names a later class.
2. **Diagnose.** Instrumenting the throw site: `canonicalSignature` and
   `liveSignature` return `ref_null $DepthTexture`, `aliasSignature` returns
   `externref`. Collection types the getter while `DepthTexture` has no struct
   yet (externref); the child collects right after and raises its slotless
   Program-ABI alias with that provisional type; class-body compilation (and
   the IR pre-emission `finalizeForwardClassCallableAbis` pass) then re-types
   the parent function. Nothing moved the alias.
3. **Fix.** One retype entry point, `retypeProgramAbiClassCallable`
   (`program-abi-class-callable-planning.ts`), used by every site that re-types
   an inheritable class member: the method/getter/setter re-resolution in
   `class-bodies.ts` and `setFinalClassCallableType` in
   `class-callable-abi.ts`. It sets `func.typeIdx` and asks the registry to
   move every inherited alias observation of that function to the live
   signature through the new `ProgramAbiSession.retypeCallableAlias`, which
   only accepts an unsealed, locator-free callable alias and replaces its draft
   `intent.signature` and structured contract together.
4. **Invariant kept.** The `alias-signature-mismatch` check is untouched; it
   still rejects any alias whose contract differs from the canonical without a
   recorded retype.

## Resolution

Fixed as planned. Regression test
`tests/issue-6733-inherited-forward-ref-accessor-alias.test.ts` (TS
getter/setter/methods naming a later class through child + grandchild, and
the three.js JSDoc getter shape): parent 0/2, fix 2/2.

Scoped standalone test262 (129 files: `language/statements/class/{subclass,super,accessor-name-inst}`
plus the getter/setter/accessor/inherit/super/prototype files of `class/definition`
and `class/`): parent 100 pass / 28 fail / 1 compile_error, fix identical, same
non-pass set — no losses.

JS-host control: compiles that succeeded on the parent are byte-identical with
the fix (playground `benchmarks.ts` and two class fixtures, `gc` and
`standalone`); the reduced fixtures and `three.core.js` under `gc`, which threw
this same invariant on the parent, now compile. three upstream MathUtils suite
(JS host) 17/18, unchanged.

three 0.185.1 standalone-dynamic lane (2026-09-29):

- before: `compile-error` — this invariant
  (`... declaration:0000000000000010 / ... declaration:0000000000000009:class-instance-getter:0000000000000001 disagrees with its exact canonical signature`).
- after: compiles; next blocker is `optimization-error`, filed as
  [#6752](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6752-standalone-three-wasm-opt-popping-from-empty-stack):
  `wasm-opt -O4 did not produce the measured artifact: wasm-opt -O4 failed: [parse exception: popping from empty stack (at 0:8674212)]`

## Acceptance criteria

- The reduced fixture compiles standalone and the getter returns the base
  value through the subclass.
- The three standalone-dynamic lane moves past this invariant (record the next
  error here).
