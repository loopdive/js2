# Promise checkpoint cycle-cut validation

Local worktree: codex-5883-cycle-main9c-20261002. Published PR5883 remains
e946127595242f2b186c184ce3c2aa25ddbe7c8a, not modified by these runs.
Pending merge incorporates exact main9c6d0b1e6bcfeec689afcddf70bf55f21fb12412;
before repairs, source/scripts matched failed merge-groupcda603a664d1dc115b327da64e26c9e30d3569c3.

## Measured evidence

- Unchanged import-cycle checker, run7635/child7261: exit0, no input changes.
- Full graph comparison44896: base697/295, failed699/296, repaired697/294
  (largest SCC/codegen-to-IR edges). Exactly the two extracted Promise owners
  leave the SCC; no members added. All other directory metrics unchanged.
  No baseline or workflow update. Full graphs retained in
  .tmp/5883-cycle-comparison-20261002.json.
- Checkpoint48392/child8685: exit0,11suites99/99, no input changes. Includes
  all original92 rows and seven additive service controls. Raw log, full native
  result JSON, invocation, before/after pins and terminal record retained under
  .tmp/5883-cycle-checkpoint-tests-20261002. These are local receipts, not embedded
  copies in this document. Do not claim source IR execution from legacy-backed
  Pop cases; their outcome traces explicitly retain that distinction.
- Canonical34492/child9110: exit1, exactly two getter number-versus-literal0
  diagnostics, no input changes. Original failure retained. D applied only
  two return annotations, now create-context SHA256
  a1cc840501c4a5152eb07e9af4adeb06fffdd51652952259a16835312d46ecaf.
- Constructor independent measurement4545/64200: unchanged failed-queue tree
  and repaired tree each add exactly10 types and zero functions. Full serialized
  module states before and after construction compare exactly equal, not only
  counts. Inputs are identical service-context source/options. Raw JSON retained
  in .tmp/5883-context-before-20261002.json and context-after equivalent; runner
  5883-context-baseline-20261002.mts records constructor hash per arm. This checks
  emitted module state, not an allocation/performance benchmark.

Independent reviewers C and A cleared production mechanical forwarding and the
strengthened21-provider construction guards respectively. Missing-service
refusal, late spies, actual-context forwarding and separate service records
remain covered. Original seven new test identities retained.

## Still required

Canonical rerun89397/child9492 exited0 with unchanged inputs. Post-annotation
protocol/service/diagnostic run12292/child9628 passed18/18 with unchanged inputs.
Format/check normal publication hooks, inspect current remote
main/head/queue status, and publish through existing PR5883 without force or
queue bypass. Preserve frozen old worktree. No full migration, legacy retirement,
broader401-population or end-to-end IR completion claim follows from this slice.

## Subsequent publication blocker

Normal function-budget gate99279 rejects the inline service installation at
565>514. Two private record constructors reduce it to516>514 (gate54309),
still failing. Canonical55698 on that private-constructor version passes with
unchanged inputs; formatting passes. Parent amended the plan to extract only
the existing cohesive linked-package/namespace initialization into a same-module
helper with explicit map-identity/default/order tests. D owns that pending change.
No budget exception or baseline change. The99/99 and18/18 results above are
earlier checkpoints, not final-source validation; repeat acceptance after this
last extraction. B worktree independently remains held for runtime/preservation
failures. Nothing from this repair has been committed, pushed or landed yet.

## Final source validation before publication

Private linked-state extraction passed independent review. Final constructor
SHA2568d8bed475e6d1bcc1fea16577774f6ae90fe4befed05b17b347e627ae3adff47;
formatted service test7e8cfa2898023515d9e0293bd9f76731a7ad003401207918d426719c9730e4c9.
Run60065: canonical child11927 exit0; tests child11994 exit0,104/104 across11
suites, including prior92, seven service controls, five linked-state controls.
All monitored inputs unchanged. Final cycle76203/child12948 exit0, SCC697,
codegen-to-IR294, no baseline change. Formatting and function budget pass.

Actual-main1a160821 LOC check exposed that the default merge-base check borrowed
issue6651's context-types grant. This PR's own issue3518 now declares the exact
intentional four-line type-only service-interface wiring. Actual-base LOC and
function checks76919 both pass; no function allowance or shared baseline edit.

Archive5883-cycle-validation-exact-20261002.json.txt embeds17 exact invocation,
terminal and native-result streams with lengths/SHA256/gzip-base64. It separately
records21 hashes for local-only raw logs/input manifests. Original failures stay
distinct. Latestmain1a160821 differs from tested9c only in CLAUDE.md; refreshed
PR head remains e946, no unresolved review threads and no queue entry.
Commit/hooks, final docs-only main merge, push and protected CI remain pending.
