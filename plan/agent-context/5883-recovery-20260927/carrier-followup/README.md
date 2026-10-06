# Carrier preparation recovery checkpoint

Evidence and source patch as data only; no runtime activation in this PR.
Apply `early-carrier.patch` after the preserved failed reference-request patch.
All original fixtures and prior failures remain authoritative.

Instrumented current-parent source proved that a correct wide literal and
externref expectation reached lowering before carrier types existed. Early
registration fixes six cases: 29/49 -> 35/49, zero lost passes. Native49/49,
compilation49/49, zero imports49/49. Runtime handle6411 exited1 because fourteen
cases still fail. See exact source-hash pairs and raw outputs in the receipt.

Parent integrated the identical tested file hash
`07490912920174bf9219e96d9c6f695fdc102b87cd82ede0567a8a5652acc3b9`.
Parent `pnpm typecheck` handle14976 completed exit0. This supersedes the
agent result document's statement that parent typecheck was still pending.

Remaining comma-expression, closed-object storage, wide provider, override
and shadowing failures are not waived. This is neither full-width preservation
nor IR equivalence or old-compiler retirement approval. PR5883 stays held.
