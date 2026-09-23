# Promise getter capture integration

Base: PR #5766, `5118637e0e9b34291465230428447e511958faa1`.

Parent inspected and applied Hilbert's two-file resource adaptation from
`/private/tmp/js2-3518-promise-lookup-resources-20260908`.
It reserves and fills the new two-result lookup separately from the existing
one-result classifier, joins the captured-then binding into resolution, and
asserts the full ordered14-function reservation population. Existing24 resource
tests remain; the worker's initial21-control report was stale, not a deletion.

This integration is intentionally incomplete until Pauli's canonical/codegen
getter fix is copied after review. No composed typecheck or execution is
claimed. The resource adaptation requires the new canonical lookup export.
No tests should be launched against this partial composition.

Pauli's first isolated run passed TS7 and56/56 tests (49 preservation controls,
7 default-mode runtime cases). Parent requested the same7 cases explicitly in
both direct and experimental-IR modes, with semantic diagnostics enabled.
Those results, the final source manifest, High review and an independent public
comparison are still required. The historical public baseline remains intact.

The resource pack still requires actual primitive, string/error, closure and
object materializers. Primitive and string/error implementation now run in
disjoint Astra Low worktrees under the persisted High plan. This checkpoint
does not authorize removing async admission, strict closure or retirement gates.

Parent subsequently integrated all six Pauli TS files with exact final-manifest
SHA256 matches and the handoff. Worker6839 passed63/63 (49 preservation plus
14 runtime, seven in each explicit IR mode); composed parent38918 passed TS7
and87/87 across3 files in23.82s, including24 resource controls.

High approved the production getter behavior but requested additional historical
signature and actual-object-finalization negatives. Pauli owns those test-only
additions. No complete proof-suite approval is claimed before that repair.

The composed function-budget gate rejected two newly oversized functions:
resolve303 and resource fill302 lines. Parent extracted the resolution peel
prelude and microtask reservation projection into private helpers, preserving
instruction/order semantics without an allowance. The size gate now passes.
Session96871 is the post-refactor TS7 and87-test rerun; no terminal result yet.

Session96871 subsequently exited0: composed TS7 and87/87 tests passed in22.78s.
The two helper extractions therefore retain the exercised behavior. Pauli has
since frozen two additional signature/fill proof cases (51 preservation controls
total), not yet integrated or executed here. Those are the next validation step.

Worker49086 subsequently passed TS7 and65/65 tests (51 preservation and14
runtime) in17.61s. Parent integrated its exact test hash and retained raw
receipts under plan/agent-context. High approved all nine adapter/signature
mutants, but identified that expected lookup bodies still come from the same
builder. Pauli is adding independent capture-body expectations and mutations
for capture, null returns and getter/field targets. That final proof condition
remains before publication; no production correction was requested.

The final independent whole-body oracle is integrated at test SHA256
`a241f8bab9e21d1e80aa8a2d538a016010af9041b90b78385941553880e8ab7a`.
High reviewed and approved its literal result pairs, capture-before-conversion,
exact reads, accessor/field ordering and null-getter fallthrough, plus four
positive-first live builder mutants. No scoped review blocker remains.
Final composed session31410 (TS7 plus259 tests) is live, not yet a pass.

Session31410 subsequently exited0: TS7 and259/259 tests across4 files passed
in117.47s (52 preservation,14 runtime,24 resource,169 boundary). No skips were
reported. This closes the requested scoped tests and boundary regression;
the separately pinned public comparison has now been launched.

Public controller94830 exited0. Both children exited0; candidate24/24 rows
met independent semantics with zero gaps, and baseline retained the exact20
known discrepancies. All14 controls passed; repair acceptance is true, raw
preservation and both-arm semantic equality false. All48 compiles,96 instances
and184 observations completed. The compact result with hashes and terminals
is retained in3518-promise-repair-public-result-2026-09-08.json. This public
measurement covers Pauli's frozen source, not the later parent helper/resource
composition; the259 composed tests provide that separate scoped evidence.

Normal commit86944 exited1 before creating a commit: formatting/lint passed,
but the file-size gate rejected async-scheduler4682 versus4665 and
closed-method-dispatch2066 versus2054. No hook bypass or allowance was used.
Staged work remains intact. Parent requested a focused legacy adapter-module
extraction for reservation/finalization, preserving canonical ownership and
the frozen public candidate. That refactor and its scoped validation remain
before committing/opening this checkpoint. The prior execution evidence is
retained rather than relabeled as a pass for future source changes.

Parent extracted the ordered peel/lookup reservation and predicate/lookup
finalization into `src/codegen/promise-thenable-lookup.ts`. The scheduler
retains classifier reservation before the helper and publishes its flag after;
the dispatch driver retains early guards, peel filling and inventory collection.
The new adapter imports canonical bodies, never the reverse. Both file and
function budget gates now pass, without allowances. Pauli owns test adaptation
to the extracted functions; post-extraction execution is still pending.

Pauli returned the adapted test at SHA25672c10f112b76cbd7beed1812b11182e80eacd0e3fad2bf5822f2385d44382e30.
It evaluates authentic driver/helper declarations together while retaining52
controls and13 mutants. The wrong-type mutation uses the valid in-scope peel
type rather than an undefined variable. Original donor and public candidate
remain unchanged. New legacy module classification is explicitly unmigrated,
not clean; full inventory now reports1244 unmigrated,77 clean,5 adapters and
zero errors. No dependency allowance or activation history was relaxed.
Session12541 is the post-adapter TS7,90-test and focused-closure validation;
its terminal remains pending.

Session12541 subsequently exited0: TS7 and90/90 affected tests passed in25.46s;
the focused closure test then passed1/1 (168 unrelated controls deliberately
filtered, not claimed rerun). The earlier full169 boundary population remains
recorded separately. Parent inspected the actual adapter/test diff; final High
review of this size-only extraction is requested while publication proceeds.
