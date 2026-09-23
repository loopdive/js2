# Main-synced class repair checkpoint

## Publication scope

Existing upstream PR: https://github.com/loopdive/js2/pull/5753.
The remote head inspected before composition is
`b13d89b36209b2820bc87bf5496db3b6ee10155c`.
The isolated integration branch includes verified loopdive/js2 main
`3acb2c85b9d8a313bbd46f045344d00c4dd317f3` via normal merge
`fb51db5d232a47b47fab00d3e2e498315d799521`.
The user's dirty root checkout was not merged, stashed, or edited.

Reviewed class deletion/redefinition repair `b7f457c0fee1783c3457884c36019aef1e869f4a`
is composed as `1bc507b0b9` after that merge. Its five-file scope authenticates
class receiver and actual bag identity, retains the deleted entry, and treats
its marker as semantic absence during descriptor validation. Refusal leaves
storage unchanged; successful redefinition gets fresh defaults and sequence.
No static class presence/ownness consumer is activated.

## Evidence and limits

The author's final normal checks report60 behavioral correctness checks,
32 direct-storage checks, and4 separately labeled baseline comparisons.
Those four comparisons are NOT conformance passes. Original executable
JavaScript assertions remain available with `CLASS_DELETE_ASSERT_ORIGINAL_JS=1`:
ordinary literal deletion returns3 rather than1; public class keys after growth
returns4080 rather than404080, identically before/after at O0/O2.
The full source hashes and paired receipts are in the adjacent retained-delete
handoff. No fixture or existing assertion was removed or relaxed.

The integration main-hotspot controls pass5/5 in
`.tmp/main-sync-hotspot-controls.log`. Combined class/array/WeakMap verification
completed normally with158 checks in four files (exit0) in
`.tmp/main-sync-class-composition.log`:60 class behavioral checks,32 storage
checks,4 labeled baseline comparisons, and62 existing class/array/WeakMap
checks. This is154 non-diagnostic checks plus4 preserved-failure comparisons,
not158 conformance passes. TypeScript7 and budget checks pass; their logs are
`.tmp/main-sync-typecheck.log`, `.tmp/main-sync-loc.log`, and
`.tmp/main-sync-functions-corrected.log`. The first function-budget command
used a nonexistent script name; that failure is retained, not counted as proof.

The integration rerun with original JavaScript assertions completed normally
with the four expected failures (two sources at O0/O2),92 unselected tests,
and no unhandled errors: `.tmp/main-sync-original-failures.log`, exit1.
The exact wrong answers remain3 versus1 and4080 versus404080. This is explicit
preservation evidence, not a green run or removal of either open obligation.

## Remaining work and ownership

- PR5753 stays on hold. Its published CI is green and review threads resolved,
  but full Test262 shards were skipped. The historical137 losses remain the
  release population; focused successes do not clear the full floor.
- Parent Error/Proxy changes are unpublished in the separate queue-failure
  worktree. Setter undefined completion is fixed in4 original cases, but the
  single-worker combined run has54/62 passing and8 real assertion failures.
  Do not copy that incomplete patch into this checkpoint.
- Wegener: class ownness/static-presence next plan, preserving original losses.
- Rawls: genuine Symbol wrapper and actual call-dispatch dependency evidence.
- Tesla: computed generators; both yielding-receiver controls still fail.
- Planck: only reviewed externref-backed nonempty pop storage read; numeric
  method selection and length-setter activation remain held.
- Volta: compiler/array lifecycle factoring. PR5748 has a single verified
  inventory-file conflict with current main; integrate after its patch is ready.
- Nash: High-effort architecture reviews; parent remains sole integration owner.

Do not merge the experimental spike or treat inventory validity as compiler
closure/retirement proof. All delivery must reach loopdive/js2 main through the
protected queue, with ancestry and content checked afterward.
