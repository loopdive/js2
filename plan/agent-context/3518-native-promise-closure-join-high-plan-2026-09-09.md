# Native Promise / closure producer join — frozen High specification

Base: 794ba37c84169944bec1d39ee9c218b96efe0940 (PR #5778).
Implementation owner: Euclid. Parent owns boundary census and publication.

Exactly two implementation paths:

- src/backend/wasmgc/resources/native-promises.ts
- tests/issue-3518-native-promise-resources.test.ts

Replace independent raw closureRoot/settleMetadata dependencies with
`closures: NativeClosureReservations` and `settleMetadataRequestId: string`.

Authenticate the exact issued pack and same transaction using the existing
requireNativeClosureReservations before any Promise allocation. Select
exactly one metadata row by request ID. Require key promise:settle, name "",
public length1, metadata ID equal to metadata type index, genuine signature
binding membership, exact externref-to-empty signature, and lifted canonical
root identity. Do not require minimumArgumentCount1 or equal lazy-observer
snapshots. Preserve first-signature root selection and legitimate repeated
requests selecting the same cached binding.

Retain exact pack, selected binding and copied request ID in the existing
Promise owner. Reauthenticate before fills/body construction and derive root
and metadata operands from that retained selection. Remove local duplicate
closure-field schema. Keep Promise-owned capture subtype, copied five
metadata fields plus capture field5, fourteen functions, six globals,
reservation/fill order and resolve-to-resolveValue routing unchanged.

No new registry, allocator, public selector, raw-token fallback, closure
producer/body changes, or external P/C changes are authorized in this slice.

Preserve all24 existing tests and actual16-owner/33-call preparation/replay
axes. Add positive-first genuine-pack, alternate-first-signature, repeated
binding and lazy-arity controls. Copied/foreign/stale/wrong-request negatives
must leave preallocation populations unchanged. Test fill reauthentication
against the genuine missing-dependency frontier, not fabricated complete
dependencies. Replace fake root/metadata fixture allocations with genuine
ordered closure producer requests; do not keep both allocations.

Full fill, complete carrier inventory, native-family execution, public
cutover and ABI30's unresolved planningSealed witness remain open. This
producer join does not establish those acceptance conditions.
