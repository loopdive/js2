---
id: 4584
title: "Bypass the legacy class-body walker for exact Prepared standalone classes"
status: done
created: 2026-08-21
updated: 2026-08-21
priority: critical
feasibility: medium
reasoning_effort: high
task_type: refactor
area: compiler, codegen, ir
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
parent: 3518
depends_on: [3522, 4579, 4583]
related: [3090, 3518, 3522, 3792, 4579, 4583]
origin: "The Classes corpus is 11/11 IR-owned but still physically enters compileClassBodies for Animal and Dog."
files:
  - src/codegen/class-bodies.ts
  - src/codegen/class-constructor-wrapper.ts
  - src/codegen/declarations.ts
  - src/codegen/prepared-class-body-cutover.ts
  - tests/issue-4584-standalone-prepared-class-cutover.test.ts
  - plan/issues/4584-standalone-prepared-class-route-cutover.md
---

# #4584 — bypass the legacy class-body walker for exact Prepared standalone classes

## Problem

Prepared IR already installs all ten source bodies in the standalone Classes
example before declaration routing. The declaration pass nevertheless calls
`compileClassBodies` for both `Animal` and `Dog`. That legacy visit does not
emit their bodies, but it remains a physical AST-codegen dependency whose only
work for this exact component is validating and correlating the Prepared slots.

The cutover must not infer whole-class readiness from names or from a partial
member set. Unsupported, nested, expression, host-backed, builtin, and other
residual class families must retain the established walker.

## Scope

- Add one atomic, exact-identity transaction for named top-level standalone
  class declarations with explicit constructors.
- Require every constructor, method, getter, and setter body to be both skipped
  and preserved by Prepared IR, backed by the exact nonempty Program ABI
  callable and the class's exact allocator-owned Program ABI struct layout.
- Reuse the canonical constructor-wrapper builder to authenticate the `_init`
  source owner plus the `_new` function's exact handles, signature, local,
  default-field operands, `struct.new`, parameter forwarding, and tail-call.
- Stage all correlation results, then publish them only after the entire class
  validates. Mixed classes return to the legacy walker without mutation;
  post-certification mismatches fail closed.
- Keep `compileDeclarations`, nested/class-expression routing, module/static
  initialization, method-trampoline finalization, and generic direct class
  support unchanged.

## Non-goals

- Retiring implicit constructors, nested classes, class expressions, Promise
  subclasses, externref-backed/builtin classes, or multi-source class routing.
- Treating a clean class route as proof that direct class codegen can be deleted
  globally. The #3090 reachability and #3792 optimization-retirement evidence
  remain required.
- Claiming the five-case #4583 corpus is the complete standalone denominator.

## Acceptance criteria

- [x] Default standalone Prepared compilation records no
      `compileClassBodies` entry for `Animal` or `Dog`.
- [x] `JS2WASM_PREPARED_CLASS_ROUTE_CUTOVER=0` restores both legacy correlation
      visits and produces byte-identical binary and WAT output.
- [x] All ten exact class terminals remain `terminal-ir`; the cutover changes
      physical routing only.
- [x] The WasmGC host lane and a mixed unsupported class retain their legacy
      class walker.
- [x] Existing class preparation/runtime/ABI, Promise-subclass, audit, corpus,
      typecheck, formatting, LOC, function, and optimization-ledger gates pass.

## Measured checkpoint

Before the cutover, the unoptimized exact standalone Classes artifact is
42,174 bytes (`sha256:8e9990ade8988a0534bfeac0b5fce051a9ef1044c43bba68f05366a3db242caf`)
and its 280,015-character WAT hashes to
`b908781aa7592441a71b78ed9349d2ee37caa13c35283473285e55d622e10e6d`.
The candidate and kill-switch control retain those exact hashes; only the two
physical class-root audit rows disappear. This is local slice evidence, not a
global direct-class implementation retirement claim.

The kill switch is temporary for one release and must be removed with its
control after the route has survived the broader standalone cutover matrix.

## Completion evidence

- The focused cutover, full #3522 class compile-once, physical-route audit, and
  Promise-subclass controls pass 69/69 after integrating current `main`.
- A deliberately malformed `Animal_new` wrapper fails the exact preflight and
  does not retry through the poisoned direct class walker.
- Both strict IR-only lanes remain 37/37 IR with zero legacy, unsupported, or
  invariant terminal outcomes. The five-case physical corpus retains its exact
  5-source / 47-unit / 37-terminal / 19-derived denominator.
- The strict physical corpus now reports only the two Async timer-shim entries;
  the former `Animal` and `Dog` `compileClassBodies` roots are absent.
- Typecheck, Prettier, Biome, LOC, function, oracle, fallback, dead-export, and
  optimization-ledger checks pass. No budget or optimization decision was
  weakened for this route cutover.
