# Native string/value demand collector checkpoint

Base: 31e4e232eb16804afc1577055d33d1c6530c0e22, PR #5781.
Claim: 3518:native-string-value-demands, verified upstream for
ttraenkler/codex-native-string-value-demands.

The new pure collector preserves the complete ordered owner, buffer and
instruction census across original and selected projection views. It includes
semantic and prepared async states, empty buffers, repeated shared occurrences,
all intrinsics and literal demands. It borrows original allocation metadata
rows, resolves aliases, preserves unknown payloads and distinguishes absent
properties from present undefined. Only new containers are frozen.

It grants no acceptance authority, chooses no provider, allocates no resources
and mutates no ABI. Complete program authentication still belongs to checked
consumer acceptance. No existing production module is changed by this leaf.

High review required local schema/sealed/reconciliation checks, independent
exact occurrence assertions, and a non-number intrinsic/provider identity
control. All three repairs are implemented and approved at these SHA-256s:

- Source: 6e9b08cd6240796e21560a38483130c33251b3c2760913cab38915997ac2eda3
- Test: 8ac9d5655b1f9fbf17e5f11cfc1679d008b569cd44e78130f4403bd810493133

Validation history is retained: session 28540 exited 1 with 36/38 because a
scalar source call was genuinely inlined, invalidating a fixture assumption.
Original scalar/string cases remain; original/decoded recursive source cases
now independently assert real const/binary/call occurrence sequences.
Session 56859 passed 40/40; TS7 session 94302 exited 0; final formatted revision
session 77634 passed 40/40 in 10.64 seconds. All runs were sequential, bounded
to 2 GiB, one fork, without file parallelism. No physical execution is claimed
by recursive source preparation or decoded replay.

The production caller remains the forthcoming native consumer integration.
Its full contract is published in PR #5782; the acceptance-time declaration
amendment further requires shared symbolic producer recipes before allocation.
Public cutover, all required native families, strict closure and direct-codegen
retirement remain open. P/C paused async drafts are unchanged.

The integration checkpoint also registers the new module as mandatory clean
ir-program ownership, raising that layer's minimum from 15 to 16. A new
activation record is prepended; all previous records and allowed edges remain
unchanged. The boundary suite includes the new module in its exact census,
deletion controls and forbidden-import controls. The first boundary run
(65847) passed 236/237; its sole failure measured the expanded import census
at 345 rather than the prior 337. The exact census is now pinned at 95 modules,
222 type-only imports and 123 runtime imports. All unresolved, unknown,
forbidden and transitive-violation populations are empty in this bounded graph.
Targeted session 41555 passed all 5 selected controls (236 deliberately skipped).
Final composed session 60265 passed 281/281: 241 boundary controls and 40
collector tests in 164.53 seconds. Historical records and allowed edges were
also compared directly to HEAD and are unchanged. This bounded closure is not
the strict whole-compiler closure proof, which remains open.

Commit attempt 79963 stopped at the normal lint hook's noDelete rule in the
sparse-array negative fixture. The test-only repair uses Reflect.deleteProperty
and explicitly verifies the property is absent; assigning undefined would not
preserve the sparse-array control. Source remains at the reviewed hash above.
Final test SHA-256 is
785804c014102a1e9ef0fabfd0024c24b5d61d6f43e450d875e561ba506108ef.
Post-repair session 55549 passed 40/40 in 10.30 seconds.
