# Unicode source diagnostic, 2026-10-08

Executed unchanged canonical main845 production at test-only HEAD
`3fee634ae67f23f57085ce6b792e584cd78e85ac`, source tree
`953f74f80cf2f8085b8e1c93489fcdd357929b37`. This is a diagnostic of the
canonical baseline, not a new qualification of PR6575's bounds candidate.
The recorded source fixtures use dynamic indices `(1,2)` and compare the result
of `"ax".slice(start,end)` or `"éx".slice(start,end)` to `"x"`. Native JS expects1.

Four actual compile/validated-Wasm/runtime observations were retained:

- Direct ASCII: returns1, matching native.
- Direct Unicode: returns0, differing from native1.
- IR-enabled ASCII: actual report admits `run`, no rejections, returns1.
- IR-enabled Unicode: actual report admits no functions, rejects `run` with
  `string-evidence-unsupported` / ASCII encoding proof required for a
  `utf8-guaranteed` constant result. Retained legacy fallback returns0.

Thus the two ASCII controls pass the same instrument, and the legacy Unicode
defect is measured. This is **not** evidence of a Unicode function accepted by
IR and producing a wrong answer. IR's current refusal remains correct until
the representation, UTF-16/surrogate semantics, source admission, runtime and
genuine caller wiring are all implemented. No widening of admission is granted.
No target policy is classified as native by this diagnostic. The future native
Prepared route and no-JS-host admission remain A-owned, unpublished dependencies.

The first runner invocation was blocked on tsx's local IPC socket before any
compilation. Its original raw log is retained; the approved second invocation
completed exit0 and records all four outcomes and unchanged source custody.
Exit0 means diagnostic collection completed, not that all four semantic
expectations passed. Full runner, raw logs and input hashes are retained;
binaries are recorded by hash/validity, not full byte witnesses or equality proof.
No production, fixture, hook or protection changed.
