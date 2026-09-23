# Native async integration decisions after producer composition

Base checkpoint: #5794 at 721cd33a828c89cfc04c851b011f910b76a4d2c5.
These decisions preserve the complete async-family objective and do not grant
acceptance to an incomplete resource population.

Publication update: the D1 source-support transport is now preserved in non-draft
PR #5797 at efe352fee8afc3feb6a28c34d00fc658dc1fb205, with normal hooks and the
post-refactor 55/55 targeted tests passing. The latest D1 contract is in that PR;
the older uncommitted copy in this worktree is not the authoritative version.
The closure/timer proposal below still names missing implementation interfaces.
Lane E extraction remains unaccepted: its first real execution run passed 56/84,
with 28 mixed-UTF8-rope illegal-cast failures under diagnosis. No failed cases
were removed and no full prepared async execution or retirement is certified.

## Closure scheduling

The existing closure producer reserves its complete request sequence atomically.
The delay donor requests its zero-argument wrapper after Promise allocation.
Moving every closure request ahead of Promise resources would change the donor's
cross-producer allocation order. A second closure pack would also create another
root/cache authority. Neither is the approved integration strategy.

The next contract must support staged reservation under one producer-owned
root/cache and a single prevalidated complete declaration sequence. It must
permit the exact Promise prerequisite prefix, then Promise resources, then the
delay suffix, preserving observer and cache-hit order. No final issued pack may
pretend an unfinished sequence is complete. Euclid is specifying the concrete
cursor/currentness/failure APIs; this does not alter Hilbert's current frozen
declaration checkpoint or authorize concurrent edits to its producer.

## Timer publication

Keep typed publication obligations alongside the existing ABI authority. Tables
and elements must not masquerade as function slots. The ledger already supports
reserving the two tables and manifest global, then creating the element and
exports after reservation freeze. This phase separation is approved, with exact
per-space order, field/initializer values, dispatcher identity and the original
ordered export-family alias algorithm preserved. Do not claim that the legacy
mixed append sequence is literally unchanged across these phases.

The complete predecessor export occupancy must be planned and rechecked; aliases
cannot be derived from a smaller mutable set at fill. Timer capability constants
should have one pure owner at `src/runtime/contracts/timer-capability.ts`, with
the original `src/timer-capability-contract.ts` retaining one-way compatibility
reexports. This proposed placement needs additive parent boundary coverage and
an explicit implementation assignment; no constant duplication or allowed-edge
relaxation is authorized.

## Remaining tracking contract gap

Promise configuration explicitly distinguishes disabled rejection tracking from
tracking. The canonical combinator builder supports the disabled case, whereas
the initial frame handoff requires a mark-handled binding unconditionally. The
current await builder accepts a legacy numeric sentinel. This discrepancy must
be resolved in a typed configuration contract before frame admission. Do not
invent a no-op mark function, silently select disabled, or pass a missing binding
as evidence of a complete native pack. Active tracking still requires its actual
resource owner and implementation.

## Formatter ownership release

The paused producer owner's `.tmp/3527-p-handoff.md` explicitly releases the
eleven paths enumerated in the D1 transport census for separate-worktree work
after the High specification is frozen. Parent read that release directly.
It covers the typed runtime-support batch, once-only frontend preparation,
joint allocation capture, existing ABI validation and lossless codec replay.
It excludes paused schema-v2 adoption, async attachments, source-population or
startup changes, runtime catalog/ABI-class expansion, backend parsing and the
separate scratch-reference prerequisite. Existing paused files remain preserved.

These are implementation decisions and ownership evidence, not execution proof.
Declaration tests, full prepared-family execution, source-free replay and public
direct-codegen retirement remain separate requirements.
