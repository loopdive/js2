# PR5753 class-field provenance: producer-only handoff

Implementation dispatch: Codex GPT-6 Astra Low. Parent owns integration and
publication. No push, PR creation, merge, runtime ownness consumer, or static
presence implementation is included. The 124 class-regression population remains
unfixed and unwaived by this dependency.

Specification: [High's native-own plan](5753-class-native-own-repair-2026-09-15.md).
Only its released producer prerequisite is implemented.

## Exact checkout and change

- Worktree: `/private/tmp/js2-5753-class-provenance-20260915`.
- Branch: `codex/5753-class-provenance-20260915`.
- Base: `cb07815129e65312bc8f02675644146318e1ce49`.
- Production: `class-bodies.ts`, `class-layout-registration.ts`, new
  `class-field-provenance.ts`. One new test and one additive inventory record.
- Existing declaration lookup was factored without changing its last-declaration
  policy. The collector observes admitted source names before BOTH parent/own
  duplicate short circuits. Completed-layout registration resolves those facts
  to the selected actual parent/own FieldDef objects.
- Records are weakly scoped by context and completed StructTypeDef. Reads require
  current module type ownership, the current structFields array, and exact field
  membership. They do not authorize a same-shaped clone or foreign context, even
  when the foreign context is handed the original physical objects.
- Inheritance copies evidence into each layout's own record; conflicting derived
  observations do not mutate the parent or sibling record. Public/private and
  synthetic collisions are ambiguous. Missing inherited provenance is unknown.
  Root dynamic-prototype reuse of a source `__proto__` slot is also ambiguous.
- This records source facts, NOT runtime presence, descriptor flags, constructor
  identity, ABI receipts, or persisted ownership. No existing visibility predicate,
  structInsertionOrder, context fields, or IR schema was changed.

## Zero-runtime-diff proof

Node `v22.23.2`, direct source compilation, standalone, semantic providers `auto`.
Before source: unchanged cb checkout
`/private/tmp/js2-5753-queue-failure-20260915`; after: this producer tree.

Instrument retained at `.tmp/class-provenance-output-proof.mts`, SHA256
`4ae917af4861232ef323b35f96dae7652383149d5848bb5ad58bbabf2126ea63`.
Run: `node --import tsx .tmp/class-provenance-output-proof.mts`.
Raw receipt: `.tmp/full-output-proof.log`.

Result: **9/9 byte-exact binaries AND complete generated-module data equal**.
The instrument compares actual decoded binary buffers, not only hashes; compares
the entire generated module serialization, including Maps/Sets and bigint data;
rejects unexpected function/symbol values; and floors the nonempty denominator.
No sections are omitted from the final module comparison. Compilation must
succeed on both sides. Binary options are allowJs, fileName `test.js`, sourceMap,
sourceMapUrl `test.wasm.map`, skipSemanticDiagnostics, standalone, auto providers.
Separate complete-module comparisons use generateModule with standalone,
auto providers, experimentalIR and sourceMap on both sides.

Cases: ordinary declaration/constructor assignment; public `$`/`__public`;
private field/method; inheritance; no-class demand control; all three original
full-harness fixtures, including the first fixture's additional strict assembly.

Binary lengths and SHA256 (identical before/after):

```text
ordinary 22863 fa3f3b58d8f044e5ea1d7ded80fbea0f48ea7a4599793cc7ab348675d57fe817
public-prefix 22761 fdf594d49699241731cd0e25414891f3a960bc10796d2dd665773ce83f9aba83
private 49709 723b5db631399dd13c21f36acf34e0c7006125a366d12d8929c09bf9c34903a7
inheritance 23195 43f142548e511e8dd523c13e86662f9aedc4691c9272011da51d59aaae8720d3
no-class-demand 22625 696417baa342ffef316fe3a2bef41b91f27cb7d0dfc371f4b7e498053c9d6c6f
multiple-definitions-private-field-usage.js 461778 3aee6d671cd825c3db8629af582a9384a11c1bfe970a66c2ddfed49cca3fed21
multiple-definitions-private-field-usage.js:strict 461611 51c970dbbc7ce72344677afa0dfaf37190af86ab34a888e152a78738e115bf3e
redeclaration.js 456255 8b2463f382370c84e5a6bee37f452352d5b07d9f9729b2d3920c545acdc936ff
field-definition-accessor-no-line-terminator.js 353458 104ced549dd92e5ca3c5bc686559edb80643945d8223e9e9fd613655b820090e
```

The receipt also records every assembled-source and full-module SHA256.
Production source hashes at this validation:

```text
class-bodies.ts 69cbe50f5c089a4af19bf3278e443dfea20a64c33d52d33163f5206995823fce
class-layout-registration.ts 987c0acc2dbbb6715c26b51b17da041dc9998e3cd90080eb4d6991d373eb3072
class-field-provenance.ts ddb8c555d6bfb1217e55d725e1bf72c66b028083f172658c401393f865ed413f
```

## Original runtime controls: unchanged failures, not fixes

CI's original honest in-Wasm harness, Node22 (not CI Node25 parity), standalone
and auto providers. `TEST262_CHUNK_INDEX=0`, `TEST262_CHUNK_TOTAL=1`,
`TEST262_ORACLE_MODE=honest`; run `pnpm exec vitest run tests/test262-chunk-dynamic.test.ts`.
Final filter is the three complete `test/language/expressions/class/elements/`
fixture paths, pipe-separated in `TEST262_PATH_FILTER`.

- Before log `.tmp/original-three-before.log`: 3 total, 0 pass, 3 assertion
  failures, 0 compile errors, 0 skips; 23.63s total.
- After log `.tmp/original-three-after-ready.log`: same counts and exact three
  errors; 20.15s total. A separate assertion compares the three error strings.
- `foo doesn't appear as an own property on the C constructor`.
- `y does not appear as an own property on C constructor`.
- `C instance has an own property $`.

The fresh worktree initially lacked generated compiler/runtime bundles. Attempts
in `.tmp/original-three-after.log` and `.tmp/original-three-after-built.log`
failed worker setup and are NOT runtime evidence. The first also selected six
paths because its substring filter was too broad. Both are retained, excluded
from denominators, and allowed to terminate without killing processes. Built
both official `build:compiler-bundle` and `build:runtime-bundle` entries locally
before the valid exact-three run. No fixture or expected behavior was changed.

## Checks and remaining limits

Focused producer tests passed 21/21 and exercise real collector registrations, duplicate and
inherited observations, private/public order collisions, synthetic collisions,
foreign/replaced/removed membership, unknown parent provenance, and retained
registration across the actual speculative rollback. See
`tests/issue-5753-class-field-provenance.test.ts` and
`.tmp/provenance-tests-final.log` for the final denominator.

Typecheck and IR layering passed. Inventory is valid with errors empty;
architectureComplete remains false. Both LOC/function gates were also run with
`LOC_GATE_BASE=cb07815129e65312bc8f02675644146318e1ce49` to avoid borrowing any
broader PR allowance. The collector shrinks; no allowance or budget baseline
changes, compression, or comment removal. Normal commit hooks remain enabled.

Native constructor/prototype discrimination and static own-presence/mutation
closure remain unreleased. This commit is safe to compose only as a producer
dependency, not to advertise as repairing the class regression or to release
suppression-only runtime handling. No Tesla, Volta, or Planck files were edited.
