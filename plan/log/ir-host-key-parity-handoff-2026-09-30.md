# IR migration host-key parity handoff — 2026-09-30

## Scope and sequencing

The legacy path stays operational until the complete IR path is tested equal.
Only verified upstream main merges count as delivery. This slice repairs the
legacy oracle; it does not grant native Object/Number providers or authorize
retirement. Issues remain in plan/issues; claims use upstream issue-assignments.

Worktree: /private/tmp/js2-ir-host-utf8-literal-keys-20260930.
Branch: codex/3518-host-utf8-literal-keys-20260930.
Fresh upstream/base: c72cb7bee008b28531ea2879f0fe7a02971bc64a.
Claims: 3518:host-utf8-literal-key-parity-20260930 and
3518:host-coercion-get-abrupt-20260930, held by their matching
ttraenkler/codex owners. Keep held until actual main delivery.

## Implementation and measured evidence

Static property keys passed to actual host operations use existing immutable
host string imports, including lossless lone-surrogate imports and module-start
use. Native-first, standalone and WASI retain native carriers. Evaluated keys
still execute their expression. Deferred member dispatch reserves host key
imports before capturing method-cache globals; fill does not mint imports.

Ordinary host/proxy property Get during coercion propagates the original throw.
Only the raw opaque carrier bypasses direct JS Get and uses the existing
sidecar/export fallback. The old classifier's arbitrary external proxy limits
remain; they are not proved solved by this slice.

Exact-main and final direct suite: 30/47 before, 47/47 after, 17 measured
fail-to-pass and zero pass-to-fail. Both runs have zero skipped and unhandled
errors. Original Number712 source SHA256 remains
c0550b99175c0eb61afa7d5d110a287f3fe90e9fc8e581c6d58a19fe0a971ba9.
Fresh instances/two runs verify host/standalone and UTF16/UTF8, Unicode/NUL/
surrogates, data/method/accessor separation, module start, setter/getter effects,
evaluated numeric keys, fixed/spread call bridges and original abrupt identity.
Additional actual host controls cover thrown number/object/TypeError/RuntimeError
identity, proxy Get order, fallback order and real raw Wasm method dispatch.

Removing only reserve-time member-get host key registration makes the new UTF8
cache control fail WebAssembly validation: immutable global #27 cannot be
assigned. UTF16 remains passing. All source/test bytes were restored and the
complete 47-case repaired suite passes. Pattern exclusions in the mutation run
are reported separately, not claimed as a complete green suite.

TS7 and LOC/function/oracle/coercion/tag/inventory/dead-export gates pass
after the review-driven reservation edit, with frozen sources and no drift. No exemption, baseline reseed, timeout increase or hook bypass.
Inventory remains architecture-incomplete and the helper is unmigrated debt.

## Preserved failures and outstanding IR work

Five neighboring suites measured 156/157 with zero skipped/unhandled errors.
The single failure is the historical frontend policy assertion expecting one
contracts-only root/floor1, while main already declares three roots/floor3.
Exact-main boundary run reproduces the same sole failed assertion: 124/125 pass, zero skipped/unhandled. The assertion is preserved.
The final four semantic suites pass32/32 after the reservation repair,
zero skipped/unhandled and frozen source/test hashes unchanged.

A broader class/prototype identity diagnostic fails in both host encodings; its
source and validation7/8 reports remain in .tmp/host-key-parity. The delivered
cache control proves repeated-read identity, distinct values, invocation and
module counter, and does not claim C.prototype equality.

The preserved native Number integration is in
/private/tmp/js2-ir-public-number-712-20260928. It has 56 pending paths, separate
from this slice. After verified delivery merge current main there and rerun the
unchanged public oracle; it last passed only4/9, with seven pre-emission native
provider/physical gaps. The canonical issue contains the native Object realm
dependency plan. Full Object.prototype population, ToObject factories including
StringExotic, complete NumberFromValue bindings and authenticated physical/ABI/
consumer joins remain required. Do not turn Get status2 into absence or erase
@@toPrimitive gaps without real prototype population/effects evidence.

Verified earlier main deliveries remain PR6273 ToObject body (e63424f) and
PR6276 wrapper storage (1c38da1); neither proves the full native provider graph.

## Operating safeguards

Preserve the dirty canonical checkout and all other prepared work. A read-only
peer reviewed the key/global capture sites; root owns integration/publication.
13 open PRs/all789 file entries and authoritative claims were refreshed before
edits. Preserve disjoint PR5753/5784 collection/boundary blocks and PR5911/5748
runtime blocks. Refresh base/exact head before protected queue admission.

Local evidence is .tmp/host-key-parity in this isolated worktree. Test262 is a
verified independent checkout at b363f29d3c43c626dc852744ad64a0b48a003693,
56970 tracked files and clean status; other worktree links were left intact.
Use one nice10 4GB worker, normal signed hooks, Thomas author and accurate
Codex/model trailers. Complete claims only after main ancestry/content checks.
