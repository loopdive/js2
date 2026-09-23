# Native Ryū D2 implementation checkpoint

Canonical tables, mulShift, digits and to-buffer builders now serve the actual
legacy adapter and the issued native resource pack. This checkpoint preserves
the complete original donor, including helper order, comments and unused locals.
The legacy independent inverse/power cache branches generate only missing tables.
Symbolic declarations preserve the six interleaved resources; allocation and
completion use the existing physical ledger and authentic string dependency.

## Validation and review

High approved the final R2 manifest; final relay: "R2 remains approved;
publication is not blocked on my review."

- Vitest 60138: exit 1, 23/39; sixteen positive inverse failures.
- Vitest 44897: exit 1, 38/39; alias mutant construction anchor failure.
- Vitest 9786: exit 0, 39/39 (24 ownership, 15 resources), 16.26 seconds.
- TS7 39393: exit 0, unfiltered tsconfig.ts7.json.
- Normal commit 15457: exit 1, test regex spacing lint; no commit created.
- Vitest 16996: exit 0, 39/39, 16.95 seconds after the equivalent regex
  spelling change from two literal spaces to ` {2}`. Production unchanged.

Focused runs used 2 GiB Node/fork caps, one fork and no file parallelism.
TS7 used NODE_OPTIONS=--max-old-space-size=2048, GOMEMLIMIT=2GiB and
GOMAXPROCS=1. No failed run was discarded or counted as acceptance.
The final manifest SHA256 is
`dfdf52a8f84e9af025f9e7efdfaaa7a5c3d5aa02c0ac51c199e006be2ff034fb`.
The donor source SHA256 remains
`053b4b0b4e6e3c600b4eccde3e68f507780dc12ad23ee8852541ffc052373724`.

The inverse checks all builder prefixes/final returns and private headers,
removes only the authenticated relocation separator, and reverses explicit
writer binding arguments by AST position. Positive-first mutants exercise local
shadowing, extra execution, default parameters, imports, arithmetic and order.
Missing-fill and late-reservation negatives use independent transactions.
Actual legacy cold and partial-cache populations match the original donor.
Resource execution includes finite/nonzero issue1537 corpus values, mulShift
probes, multi-result digits, two instances and imported-global offsets.

## Scope and integration

Validated source base was 7291f717833e3dba676b9f719f865a3eab9aaff3.
Before publication the worktree fast-forwarded to
56d9922bc85a0bf1ffb105746b5926a3f0dca9a6; all ten R2 hashes were rechecked
unchanged. The nine inherited parent files are not Ryū-authored changes.

Full formatter integer-fastpath variants, nonfinite/zero handling, genuinely
decoded prepared support and the full async consumer remain separate mandatory
integration obligations. These resource tests do not certify full acceptance,
public cutover, boundary activation or direct-codegen retirement. Boundary
activation remains parent-owned. No production arithmetic or registration
change was needed after High review; only scoped formatting and test repairs.
