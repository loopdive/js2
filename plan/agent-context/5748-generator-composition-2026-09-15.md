# PR5748 generator composition checkpoint

Parent base: `4335a57cc7718bbb0d75ef7c1ad4506efefab8f7`.
Integrated worker commits: `3036d59462a85801d524fd6f93f7766229ac2186`,
`7ddcdaac301bdff31ed17d5e1bdb5b9edf4f12ff`, and
`6a1c87be79478e28b6207d99d57b6357dbfb2ec1`.

The final followup repairs callable writes in loops/destructuring/initialized
script var declarations and rejects generator-object facts for ordinary async
wrappers. Exact lexical value resolution preserves real shadows and uninitialized
var declarations. High independently accepted the followup with 77/77 checks.
The original relocation checkpoint remains immutable; only three deliberately
repaired function fingerprints change in the followup, not the other seven.

Parent combined validation: seven files, 204/204 assertions passed. These include
two diagnostic observations of known wrong host-delegation outcomes, so this is
not 204 conformance successes. Original semantic fixtures and guards remain.
TypeScript7 passed; layering is 87 against the unchanged 90 ceiling. Compiler
inventory passed with 1453 tracked modules, no errors, architectureComplete=false.
An initial unsupported checker --help invocation exited2; the actual inventory
command subsequently passed. No allowance or baseline was changed by this repair.

Current upstream main `aafae4c03c` subsequently merged cleanly into source
checkpoint `76c14b6de4`. The composed ten-file run passed270 assertions with one
existing skip, retaining the two diagnostic known-wrong observations.
TypeScript7, layering87/90 and the coercion-site gate passed. Normal commit/push
and remote CI still govern publication to the existing PR5748 head.
It is not merged or ready for guard removal. The A0
array-presence helper is retained, but array ownership/prototype semantics remain
unfinished. No A1 runtime writer is released by this checkpoint.

Validation command: VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048,
vitest single fork and no file parallelism, covering issue-5398 generator-call-
planning, planning-extraction, inliner-frames, extraction-contracts,
host-delegation-completion; issue-5399 vec-own-index-export; issue-5393
guard-adversarial. Existing original failures and worktrees are preserved.
