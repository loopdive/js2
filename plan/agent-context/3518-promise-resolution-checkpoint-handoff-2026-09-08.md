# Promise resolution checkpoint integration

Base: physical-vector PR #5764, commit
`49871a81a48185ceead22b99891fb51911c47822`.

The resolution worker's first snapshot passed TS7 and24 preservation tests,
but High review identified two blockers: collection depends on a historical
Git object absent from shallow checkouts, and settle-closure controls compare
opcodes without fully authenticating operands. The worker is repairing both;
the first result is retained as limited evidence, not publication acceptance.

Default controls must be self-contained with authenticated donor receipts or
checked reconstruction. No skip or CI history-depth workaround substitutes
for those controls. Closure comparisons must preserve complete instructions,
vary field/type/settlement coordinates independently, and reject wrong-field
and wrong-target mutations after accepted positives.

Legacy thenable-job fallback behavior remains compatibility-only. A completed
native resource pack must supply the real apply-closure binding that invokes
captured then. Builder flags and numeric coordinates do not establish complete
inventory authentication or same-module resource provenance.

The four frozen resolution production files are now integrated. Parent
verified each source against the worker manifest and both existing donor
targets against the exact historical base before applying the patches.
Post-copy SHA256 values match the frozen source identities. The repaired
tests and final review are still pending; no composed test pass is claimed.
The exact
vector public-comparison source archive and reproducibility handoff are
included so that prior preservation evidence does not exist only in scratch
files. Full Promise/frame/timer/string execution and retirement remain open.

Boundary integration now explicitly activates both new native Promise modules
and extends deletion, forbidden-edge and unknown/unresolved-edge controls to
them. All prior activation records and allowed edges were independently
verified unchanged. Historical digest literals are preserved with their
offsets adjusted for one new activation record. Current edge-count assertions
still await measurement; no inventory or expanded-suite pass is claimed.

Composed TS7 passed in session76934. Focused closure measurements found75
modules and263 resolved edges (176 type-only,87 runtime), with empty error,
unknown, unresolved, forbidden and transitive-violation lists. The first two
focused runs failed only the stale current-count assertions; those assertions
now use the measured counts. Historical digest literals remain unchanged.
The full161-test boundary suite and49-test preservation suite are now running;
no full composed pass is claimed yet.

High review approved the repaired self-contained donor and complete-operand
controls; production identities remain unchanged. The composed suite43514
is still live and reports a failure. Static inspection found the independent
unique-module assertion still expects73 while the complete population now
contains75. Preserve the terminal result before correcting and rerunning;
do not describe the currently running suite as passing.

Run43514 exited1 after95.70s:209/210 tests passed across two files. The only
reported failure was the unique-module count (actual75, stale expected73).
The assertion was corrected to75 without changing implementation, controls,
or historical hashes. Full rerun5973 is live; retain the failed result above.

Rerun5973 subsequently exited0:210/210 tests passed across2/2 files in96.37s,
with no reported skips or unhandled errors. This supplies the complete
composed boundary/preservation verdict. Public source/runtime comparison and
whole-family native execution remain separate, unproven obligations.

Publication hook47941 passed lint and LOC budgets but rejected the extracted
resolution function at306 lines against the300-line function threshold.
Independent AST measurement found299 lines/21 top-level statements in the
original donor and306 lines/17 statements in the extracted function. The
canonical field-order guard and explicit resource interface cross the size
threshold; this is not evidence of additional resolution behavior. Review
of a safe split versus an issue-scoped allowance is pending. No baseline or
hook bypass was applied, and no commit was produced by the failed attempt.

Parent resolved the threshold by extracting the canonical field-order guard
into a private resource-validation helper. The destructuring RHS invokes it,
so validation still precedes every resource property read and instruction
construction. The instruction sequence is unchanged. The builder is now300
lines; no allowance or baseline change was added. Function-budget validation
passed; post-split TS7 and preservation tests run in session34924. This changes
the composed resolution module hash from the worker's frozen v2 snapshot.
