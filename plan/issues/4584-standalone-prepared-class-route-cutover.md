---
id: 4584
title: "Bypass the legacy class-body walker for exact Prepared standalone classes"
status: in-progress
created: 2026-08-21
updated: 2026-08-30
priority: critical
feasibility: medium
reasoning_effort: high
task_type: refactor
area: compiler, codegen, ir
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
parent: 3518
depends_on: [1231, 3522, 4522, 4579, 4583]
related: [1231, 3090, 3518, 3522, 3792, 4522, 4579, 4583]
origin: "The Classes corpus is 11/11 IR-owned but still physically enters compileClassBodies for Animal and Dog."
files:
  - src/codegen/prepared-class-body-cutover.ts
  - tests/issue-4584-standalone-prepared-class-cutover.test.ts
  - plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md
  - plan/issues/4522-ir-kill-switch-inventory-r9.md
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

## 2026-08-30 — retire the temporary route rollback

The Prepared class route has now survived its one-release observation window.
The next checkpoint retires its temporary environment rollback without
weakening any of the exact eligibility, identity, ABI, or optimization checks
that made the original cutover safe.

This is a route-policy retirement, not a class-codegen deletion. Unsupported
classes continue to use the direct class walker. The production predicate is
generic: every named top-level standalone class with an explicit constructor
becomes unconditionally Prepared when all of its executable members, class
identity, layout, callable ownership, heritage, constructor wrapper, and
staged-body correlations satisfy the existing whole-class predicate.
`Animal`/`Dog` is the pinned certification witness, not a name-based boundary.

### Grounded current state

At `main` `275216c74c7299ea07a72c8d5479f7e1a477000c`, the temporary rollback has
one production reader, at the start of
`tryCorrelateFullyPreparedStandaloneClassBodies` in
`src/codegen/prepared-class-body-cutover.ts`. Removing that guard leaves the
following fail-closed predicate unchanged:

- standalone WasmGC only, not host GC and not WASI;
- exact named top-level class declaration identity;
- no nested class, class expression, computed member, property initializer,
  unsupported parameter property, builtin/Promise-backed class, or other
  residual syntax;
- exact class layout, allocator owner, Program ABI callable owner, heritage,
  constructor wrapper, terminal-unit, and staged-body correlation;
- atomic publication only after the complete class validates.

The old focused rollback control is non-vacuous: setting the former key to its
disabled value brings back exactly the `Animal` and `Dog`
`compileClassBodies` roots while retaining byte-identical output. That control
must be grounded before the reader is removed, then replaced by an external
stale-key arm that proves the candidate ignores the former key. The final
candidate must contain no spelling of the retired identifier in `src`,
`tests`, `scripts`, or `plan`; this section must therefore be rewritten to
say “former Prepared class-route rollback” in the implementation commit.

The live standalone corpus denominator is **22,056 source bytes / 5 cases /
5 sources / 2 classes / 47 units / 38 terminal units / 9 owned support units /
0 unowned support units / 19 derived units**. The older 37-terminal completion
wording above is historical evidence and must be corrected when this
retirement lands.

### Exact implementation scope

The implementation owner may change only:

1. `src/codegen/prepared-class-body-cutover.ts` — delete the single
   environment guard; do not alter the remaining correlation predicate.
2. `tests/issue-4584-standalone-prepared-class-cutover.test.ts` — replace the
   tracked rollback test with exact route, stale-external-key, direct-control,
   census, and mutation-resistant assertions.
3. This issue — record the grounded A/B result, final live denominators, and
   remove the retired key spelling.
4. `plan/issues/4522-ir-kill-switch-inventory-r9.md` — remove exactly the
   Prepared class-route row and decrement the live R9 denominator only after
   rebasing onto the Math-switch retirement checkpoint.
5. `plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md` — add a
   dated retirement receipt with the same exact census.

Do not edit `declarations.ts`, Program ABI/session/publication files, class
lowering, the selector/type-propagation layer, or multi-source orchestration.
Those paths are owned by the concurrent R4, #3525, object-shape, and callable
work. `src/codegen/class-bodies.ts`,
`src/codegen/class-constructor-wrapper.ts`, and
`src/codegen/declarations.ts` are read-only dependencies for this slice, not
active ownership.

The shared #4522 inventory edit is serialized in this exact landing order:

1. the Math-switch retirement lands;
2. the object-shape rollback retirement rebases onto it and lands;
3. this Prepared class-route retirement rebases onto both and then edits the
   #4522 and #3518 inventories.

Implementation may be developed against the production/test files in
parallel, but its inventory receipts and final pushed SHA must be rebuilt after
both prerequisites. Never resolve the shared-document overlap by dropping a
newer retirement row.

### Four-arm retirement proof

Ground the exact `Animal`/`Dog` fixture before source edits and run both
`optimize: false` and `optimize: true`:

| Arm | Build | Expected physical class roots | Purpose |
| --- | --- | --- | --- |
| A | grounded main, former key absent | none | default-on Prepared baseline |
| B | grounded main, former key externally disabled | exactly `Animal`, `Dog` | positive instrument control |
| C | candidate, former key absent | none | retired default route |
| D | candidate, former key externally disabled | none | stale-key no-op proof |

The old key must be supplied only by the external test command for arms B and
D; no tracked candidate file may retain its spelling. Before deleting the
reader, persist an evidence row for every grounded-main arm and optimization
setting containing the source SHA, command, environment arm, Wasm bytes and
SHA-256, WAT bytes and SHA-256, imports, exports, canonical IR outcomes,
physical class roots, module validity, and runtime trace. Repeat the same table
on the candidate. At each optimization setting, A/B/C/D must be byte-identical
and WAT-identical. The physical-root projection is deliberately compared
separately because arm B alone must contain `Animal` and `Dog`; A/C/D contain
none. All four arms must otherwise have exact-equal canonical outcome,
import/export, validity, and runtime projections.

The exact nine-line runtime trace, at both `optimize: false` and
`optimize: true`, is:

1. `name  = Rex`
2. `age   = 4`
3. `breed = Labrador`
4. `Rex makes a sound — woof!`
5. `renamed: Rex Jr.`
6. `rex instanceof Dog    = true`
7. `rex instanceof Animal = true`
8. `Animal.kingdom() = Animalia`
9. `Dog.kingdom()    = Animalia (canine)`

Compile the same source once more with `experimentalIR: false` as an
observational direct control. It must retain the same runtime result and public
import/export surface, but its binary is not required to equal the Prepared
artifact. This proves semantic fallback without preserving a production
rollback reader.

### Exact Prepared and exclusion census

The eligible fixture must publish exactly these ten terminal names, with
unique source-qualified unit IDs and no missing, duplicate, or foreign rows:

- `Animal_new`
- `Animal_get_name`
- `Animal_set_name`
- `Animal_get_age`
- `Animal_speak`
- `Animal_kingdom`
- `Dog_new`
- `Dog_speak`
- `Dog_get_breed`
- `Dog_kingdom`

Compare a canonical sorted projection containing display name, unit kind, unit
ID, source ID, source file, terminal disposition, outcome kind/code/stage,
prepared component ID, and emitted-body flags. Every eligible row must have
exact source-qualified identity and disposition joins and exactly:

- `unitKind: "class-member"`;
- `kind: "emitted"`;
- `stage: "patch"`;
- no `code` property;
- `terminal-ir` disposition;
- `legacyBodyEmitted: false` and `irBodyEmitted: true`.

No eligible terminal may enter `compileClassBodies`. The oracle must reject a
wrong source ID/file, unit ID/kind, disposition, outcome kind, stage, code, or
body flag; missing, duplicate, and foreign terminal rows; and a mismatched
prepared-component join. A positive reordered-input mutation must canonicalize
to the same projection and digest.

Add an independent, non-`Animal`/`Dog` eligible-class control (for example a
top-level `Counter` with an explicit constructor and ordinary method). Poison
its direct class body, require its exact Prepared terminal/outcome joins, and
prove that it also has no physical `compileClassBodies` root. This prevents a
fixture-name-specific implementation from satisfying the retirement.

Retain or add bounded controls proving the walker still owns:

- an unsupported parameter-property class;
- a computed member name;
- a property initializer;
- a nested class declaration;
- a class expression;
- a scoped same-name class;
- an implicit constructor;
- a Promise/builtin-backed class;
- the host `gc` lane;
- the WASI lane.

The malformed `Animal_new` wrapper plus poisoned direct emitter remains a
required fail-closed mutation: once the exact route starts certification, a
post-certification mismatch must fail rather than retry through direct class
codegen. Keep every exclusion independent so computed names are not conflated
with initializers and nested declarations are not conflated with expressions.

### Optimization-preservation contract

Retiring the rollback must not trade away any legacy optimization. The
Prepared path must continue to show:

- byte/WAT identity between grounded default and candidate default/stale-key
  arms at both optimization settings;
- typed `struct.get` and `struct.set` for class fields;
- exactly one direct call in `Animal_speak` and exactly two direct calls in
  `Dog_speak`;
- exactly one `Dog_speak` call target named `Animal_speak`, preserving the
  direct-super call shape;
- exactly one required `ref.cast` in `Dog_speak`, and no `ref.test` there;
- no `__extern_get`, `__extern_set`, `any.convert_extern`,
  `extern.convert_any`, `call_ref`, `call_indirect`, or box/unbox helper in any
  certified class body;
- no reachable poisoned direct body for eligible classes;
- unchanged route and runtime behavior for every exclusion control.

Binary difference from the `experimentalIR: false` direct control is neither
required nor forbidden; route ownership, public behavior, and the typed WAT
contract are the acceptance evidence.

### Required validation and landing

Under a finite, non-negative one-minute load strictly below logical cores
minus two, using an archive-backed `TMPDIR`, run at least:

- `tests/issue-4584-standalone-prepared-class-cutover.test.ts`
- `tests/issue-3522-ir-class-compile-once.test.ts`
- `tests/issue-3522-ir-nested-class-expression-ownership.test.ts`
- `tests/issue-3522-nested-implicit-constructor.test.ts`
- `tests/issue-4646-samename-class-shared-body.test.ts`
- `tests/issue-2623-promise-subclass-identity.test.ts`
- `tests/standalone-cutover-audit.test.ts`
- `tests/standalone-ir-cutover-corpus.test.ts`
- TS7 and TS5 typechecks, IR layering/fallback/kind-neutrality/IR-only gates,
  targeted lint/format/diff checks, and the relevant standalone optimization
  ledger;
- `pnpm run check:standalone-ir-cutover-corpus`;
- `pnpm run check:ir-optimization-retirement`;
- `pnpm run check:dead-exports`;
- `pnpm run check:ir-adoption`;
- `pnpm run check:oracle-ratchet`.

Run the exact nine-line standalone trace at both optimization settings. Before
commit, prove the retired identifier is absent from every tracked repository
file with a repository-wide `git grep` that exits with zero matches; do not
limit the proof to selected directories.

Immediately before committing, run both LOC and function-growth ratchets.
Keep every precommit and prepush hook enabled. The implementation commit must
be signed, pushed as a regular PR when mergeable, and receive a fresh
independent Sol review bound to the exact pushed SHA before readiness or queue
entry. Any byte change after that review invalidates the approval.
