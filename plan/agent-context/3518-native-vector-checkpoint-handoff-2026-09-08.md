# Physical vector checkpoint

Base: PR #5763, commit `6ed68535323e0756c3a0b15dde18fd480ad7fc9f`.

The isolated checkpoint composes twelve physical-vector implementation and
test files from the earlier native-vector-consumer worktree. An independent
byte comparison reported twelve matches and zero mismatches. The published
logical and historical-reconstruction changes are inherited from the base,
not replaced by older snapshots. Existing worktrees remain untouched.

## Implementation

The checked physical-plan entry authenticates prepared input before deriving
vector resource requirements. Backend resources use the same physical module
reservation ledger, shared array/carrier identities, exact provider bindings,
and per-use nullability. The consumer reserves and binds the canonical
grow/store helper before filling its body. Legacy adapters call the same
extracted body and descriptor builders.

Three compiler-boundary modules are activated without widening allowed edges.
The async physical refusal remains: this checkpoint does not materialize the
Promise/frame/timer/string family or establish direct-codegen retirement.

## Evidence carried forward and pending checks

The prior combined tree passed TS7 and all31 vector-resource tests. Inventory
reported73 modules and259 edges (174 type-only,85 runtime), with zero errors.
Its boundary run passed152/153; one negative mutation was a no-op because it
assigned the already-existing layer. The corrected control now changes the
layer and proves the digest changes before expecting rejection. Its focused
rerun passed5/5 controls; the complete corrected153-test rerun is still pending.

The extraction worker passed42/42 body/donor tests. Those test files were
copied exactly. Public compiler comparison is still being validated: a sparse
fixture did not exercise the grow/store helper, so that run cannot establish
complete path coverage. The worker retains it and adds a positive fixture.

Fresh composed-tree TS7, resource/boundary tests, the worker's final comparison,
and High review are required before this checkpoint is published. No new
composed-tree test pass is claimed by this handoff.

## Subsequent measured results

Public comparison revision2 controller82714 and both children exited0.
The record reports14/14 equal pairs,28 compilation rows,56 expected calls,
and zero raw differences across bytes, WAT and resource order. Emitted-path
checks cover dense externref/f64, both hole-fill arms and packed branding;
both populations report no coverage gaps. Five negative controls reject
dropped rows, wrong roots, altered bytes, altered values and changed outcomes.
The baseline is the unchanged explicit-recursive-group checkpoint2b9cb408c1;
the candidate is the frozen grow/store extraction worker, not this composed
consumer. These results prove donor preservation, not full async execution.

Composed checkpoint session10660 passed TS7 and entered the four-suite run
(resource, complete boundary, body and donor tests). The suite is still live;
no terminal verdict is claimed yet.

Session10660 subsequently exited0: TS7 passed, then226/226 tests across4/4
files passed in100.20s. This includes the complete corrected153-test boundary
suite,31 vector-resource tests,22 body tests and20 donor tests. No skipped
tests or unhandled errors were reported. This supersedes the pending suite
status above, not the limits on full async execution or retirement.

High review approved the unchanged twelve implementation/test files after
these results, finding no remaining blocker within physical-vector scope.

The public-comparison worker identified a further instrumentation limit:
WAT omits some type declarations, so its positional type lookup is incorrect
for some non-core helpers. The raw equality of fourteen pairs and56 values
remains measured; the lookup is not general type-provenance proof. A tracked
reproducibility handoff is being prepared. Resource identity evidence comes
from the explicit reservation implementation and focused resource tests,
not from extrapolating that positional lookup.
