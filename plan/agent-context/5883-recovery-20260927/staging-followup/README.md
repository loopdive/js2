# Unwired ownership, demand and materialized staging recovery

Data-only preservation for held PR5883. No source or test file in this PR is
changed by this archive; the .ts.txt files are not executable integration.
The old compiler remains mandatory until full implementation and equivalence.

## Exact source and measurements

Nine source/test copies were compared byte-for-byte with the owned integration
tree after copying. Restore emission-ownership.ts.txt to
src/codegen/context/emission-ownership.ts; the other three non-test modules to
src/codegen/; each issue-*.test.ts.txt to tests/, removing the final .txt suffix.
Do not overwrite an existing newer implementation without comparing it.

Parent integration HEAD:18f1bd831312b3f5805f1e176388aac449c2d389 plus the owned
dirty implementation. Frozen staging hashes:

- staging-instr.ts:3deaa2901a28cb51874d8435a45e4c8ae73f5241c34db52bf6b8324b7a648176
- staging-census.ts:2b0c36d6a1c7039aead39a535e7bfcf924a29e6ff49438b97f84001a4b5369ed
- staging test:70d9dd3d965672595ea514f1068cd08b03367b1f6f4bd101ff849a12d13d0e0d
- emission ownership:264db2d47c2f592d222f670cf9abe4b8263f8ed3e6e8b50b0fef56bbfdd702be

Parent handle68046 completed exit0:75/75 tests across all five copied test
files (ownership21, review19, authenticated6, demand8, staging21).
Then TypeScript7 completed exit0 over the entire src tree AND the staging
test, including its negative @ts-expect-error assertions. The temporary config
extended tsconfig.ts7.json, set rootDir to repository root, disabled emission
and incremental output, included src/**/*.ts plus the staging test, and excluded
node_modules/dist/website. This closes the test-typechecking gap noted in the
preserved earlier agent receipt; it does not turn metadata tests into runtime
or end-to-end IR evidence.

## Current landing and blocker evidence

PR6182 has published merge6670264762a294f502753c67e318edde38dc10ef containing
maina421ef493d. Main-based String13/comma8/existingcomma5 passed26/26 after
the merge (92601); normal push37597 passed, including numeric IR18/18.
Its inventory helper is explicitly unmigrated. The original boundary suite's
124/125 result is preserved: the frontend policy mismatch also exists on main.
CI is pending; neither this checkpoint nor a merge to a stack base counts as
delivery to main. Subsequent main d6e24933 changes nine benchmark artifacts only.

PR6181 original TypedArray comparison: exactbase2a58 versus headbed38,
four base Wasm executions pass; four head executions throw at instantiation.
All8 compile/validate with zero imports. Constructor native4/4 passes;
TypedArray.from native4/4 fails the original0vs2 assertion on Node22.23.2.
That engine discrepancy is not waived. Actual saved WAT shows both consumers
reading original mutable backing during conversion; real deletion exposes it.
Repair must independently drain the actual iterator before conversion,
preserving live length/index reads during iteration and array-like distinction.

Class O2 diagnostic: identical saved marker binary traps at function4 0x63dd
under both trace-confirmed Liftoff and TurboFan. Native control returns7;
imports are empty. No recompile/reoptimization occurred. This rules out a
Liftoff-only explanation, not compiler/optimizer defects. Original class
acceptance populations and all diagnostic failures remain binding.

## Next work and ownership

Huygens owns coherent TypedArray consumers/provider repair in isolated copies.
Singer owns class exception/identity repair. Curie owns closed BigInt field
layout/initializer preservation; parent owns dynamic writes/Reflect, Mendel
class producer dependencies. Explicit native scalar and callable ABIs remain.
Hume owns the typed pending-recipe and edit/relocation contract; Russell's
materialized tree is tested but unwired. The copied BigInt IR/ABI spec and
staging review are source contracts, not passing runtime claims.

No pending operation, opaque callback, placeholder Wasm instruction, runtime
activation, second ownership arena, retirement waiver or changed gate is
introduced. Independent manifests do not prove operand identity, source-root
closure, cross-body alias freedom or semantic equivalence. Those obligations
remain prerequisites to wiring and to finishing the migration.
