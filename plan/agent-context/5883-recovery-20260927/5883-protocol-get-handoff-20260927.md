# Lane B: captured iterator protocol Get — source-only handoff

## Current freeze receipt

Lane B is **FROZEN, source-only, unmeasured** after the IterRec identity-storage
and explicit-Receiver extension. Reinspection confirms the source hashes below
and the byte-identical prior receipt; no additional code changes were needed.
Targeted textual diff checks pass. All 32 focused cases remain unexecuted.
Singer now owns the serialized compiler slot; the Huygens slot references below
describe the earlier extension receipt, not current permission to execute.

Dependencies before acceptance:

1. Parent installs early `ensureIteratorProtocolGetRuntime(ctx, activeFctx)`
   registration and the LAST `finalizeExternGetReceiverEntry(ctx)` call in both
   compilation pipelines, after all read prependers/overlay fills.
2. Parent integrates the frozen Huygens vector storage slice and supplies its
   default-prototype/cycle providers. B has not inspected or incorporated that
   separate patch; prerequisite 2 below describes the unchanged B base.
3. Parent integrates A/C/production drive and existing carrier/member/prototype
   fills, then measures compilation, receiver behavior, zero imports, focused
   controls, preservation controls and budgets under the serialized slot.

No remaining assigned B source edit is identified by this inspection. This is
an integration handoff, not a passing runtime receipt. Per user coordination,
main sync found no new changes (`2a58b9fe` included in parent `18f1`); B did not
perform a merge or change its base. Old compiler retirement still requires full
IR equivalence. No compiler/tests/typecheck, commits, push or merge performed.

Date: 2026-09-27. Worktree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-protocol-get-20260927`.
Branch: `codex/5883-protocol-get-20260927`. Inspected HEAD remains
`608be80f6beef338665fdcdb834e7d9b9f20b925`; this lane has not merged upstream.

**Status: source-only extension implements prerequisites 1 + 3, NOT acceptance-ready.**
General vector prototype storage (prerequisite 2) remains parent-owned and blocked
on this base. Do not treat it as optional or wire
the admitted production mode as complete while they remain missing. No compiler,
typecheck, tests, commit, push, or merge was run. Formatting and textual diff
inspection only. Parent retains the serialized compiler slot. No old-compiler
retirement or IR-equivalence policy changes.

## Owned files changed

- `src/codegen/iterator-protocol-get.ts` (new): exports
  `ensureIteratorProtocolGetRuntime(ctx, fctx)`. Reserves and emits
  `__iterator_protocol_get(receiver, key) -> externref`, plus its explicit-target
  internal helper. Returns values unchanged, including null/undefined. No
  callability test, iterator normalization, method dispatch, or legacy-cache read.
- `src/codegen/iterator-proto-next.ts`: IterRec own-bag presence probe followed
  by family prototype lookup with the original Receiver. Uses the existing
  explicit receiver local, initialized at common entry.
- `src/codegen/object-runtime.ts`: only imports and explicit-receiver
  entry/wrapper work. No class ownness/static implementation changes. Exports
  `finalizeExternGetReceiverEntry(ctx)`; exception-tagged reads now restore both
  one-shot globals before rethrowing the same JS exception. No catch-all traps.
- `src/codegen/expressions/proto-override.ts`: opt-in intercepted assignments
  publish to canonical `__extern_set`, preserving historical cache writes and
  returning a local holding the once-evaluated RHS across reentrant setters.
  Variable-held callables and noncallables use the same write. Deletes use the
  canonical `__delete_property`, retain its boolean, and preserve legacy cache
  side effects. Actual Symbol.iterator uses `__box_symbol(1)`, never a string.
- `src/codegen/instance-props.ts`: registered IterRec joins the identity-bag
  carrier predicate; an exact IterRec delete arm delegates to the same bag.
- `src/codegen/dynamic-proto.ts`: explicit third Receiver parameter for
  `__struct_proto_get`, its sole call site, and its recursive Reflect forwarding.
- `tests/issue-5883-iterator-protocol-get.test.ts`: 16 cases parameterized over
  all/race = **32 cases, 0 executed**. No skips, xfails, or helper export roots.

## Reader/store contract

The facade consults the vector descriptor overlay FIRST (late-spliced), then
carrier-bag own presence, then the actual prototype provider. A getter returning
undefined is a hit. It never selects a private override global by recency.

The vector overlay is NOT the expando bag: `__defineProperty_value/accessor`
use `__vec_overlay_lookup`, whereas ordinary expandos use `__vec_bag_lookup`.
`fillIteratorProtocolGetRuntime(ctx)` adds the overlay lookup after its existing
owner mints that helper, using `__obj_find` for presence and
`__reflect_get_receiver(overlay, key, originalReceiver)` for values/accessors.
It is called by the final receiver-entry hook. It only splices fresh instructions;
it does not reconstruct a previously shifted body or register late imports.

Native prototype reads use `__protoidx_norm_key` plus `__protoidx_get_k` and the
same seeded companion that assignment, defineProperty, and deletion use. A
tombstone continues to the parent; the static builtin-method ladder is not
allowed to resurrect the deleted property. The intrinsic values/@@iterator
alias exists only in initial seeding. The historical alias selector remains
unchanged for real legacy consumers; the new path never consults it.

Closed next/return/done/value reads use reserved finalized member readers for
the original receiver, including method values and native-generator result
boxing. Native generator frames use their existing ordinary prototype view,
retaining Receiver separately (including Proxy forwarding). Other reads use
the repaired explicit-receiver reader.

## Required parent integration hooks

1. Call `ensureIteratorProtocolGetRuntime(ctx, activeFctx)` during dependency
   registration BEFORE source-body/module-init emission (not merely when the
   first Promise call is lowered). It reserves stable handles before recursive
   dependency registration, flushes with the active caller, and emits once.
   Failed registration retains an unreachable reservation and refuses a later
   attempt to silently treat it as emitted.
2. In BOTH index.ts pipelines, call `finalizeExternGetReceiverEntry(ctx)` after
   **all** property-reader prependers and vector overlay fills, before optimizer
   or DCE passes. The IterRec fill invokes it once already; the final call is
   still mandatory because later fills prepend additional arms. Repeated calls
   move the existing preamble and protocol dispatch block rather than rebuild.
3. Keep existing member-get, generator-protocol, carrier-bag, array singleton,
   and prototype-companion finalization. They supply late carrier coverage.
4. A calls the facade with native string keys and boxed well-known symbol 1.
   Parent supplies C/live VALUES and the production drive. This lane neither
   exports Wasm test helpers nor edits A/C/drive/legacy combinators.

The entry pass consumes the active bit before any prepended arm can invoke user
code. It repairs explicit receiver operands in prepended Reflect/proxy forwards.
In opt-in modules it routes only protocol names (plus `values`) for vectors,
IterRec, native prototypes, and generator views through the semantic provider.
Other keys, especially vector indices/length, retain their existing providers.

## Blocking missing shared capabilities — exact writer/reader seams

### 1. IterRec own property storage (required P14) — implemented, unmeasured

`instanceCarrierTypeIdxs` now explicitly admits registered `__IterRec`, without
widening `isUserDeclaredStruct` or exposing physical record fields. All storage
is the existing identity-keyed `__closure_bag_ensure/lookup` pair.

Consumer inventory (source inspection, not execution):

- `instance-props.ts`: assignment via `__instance_prop_set` uses shared
  `__extern_set_decide`/`__extern_set_own`; get/method-call and gOPD/tombstone
  helpers share lookup. B's IterRec read uses own presence and explicit Receiver.
- `carrier-bag-define.ts`: `sharedBagCarrierTest`,
  `defineCarrierBagEnsureInstrs`, `isDefineCarrierInstrs`, and
  `definePropertiesCarrierBagArm` admit the predicate for value/accessor defines.
- `carrier-bag-visibility.ts`: instance arm selects that same lookup for
  `__carrier_bag_of`, own presence, descriptors and bag-key visibility.
- `object-integrity-carrier.ts`: `__integrity_bag` selects that same ensure for
  preventExtensions/seal/freeze and their predicates.
- `reflect-target-guard.ts`: common object-target admission uses the predicate.
- Important correction to the prior proposed fix: `__carrier_bag_delete` does
  NOT generally consume the instance predicate. Its exact generator/anonymous
  inventory excludes IterRec. `fillInstanceProps` therefore prepends an exact
  IterRec arm to `__delete_property`, looking up (never allocating) the identity
  bag, returning true for absent bags and delegating existing bags to ordinary
  descriptor-aware deletion. A named appended local makes installation
  idempotent. No changes to carrier-bag-delete.ts or private field enumeration.

### 2. General vector runtime prototype writes (required custom-prototype case)

`vec-proto-link.ts::fillVecProtoLinkArms` returns before installing its
`__object_setPrototypeOf` and `__getPrototypeOf` arms unless its private
`state.linked` set contains an extends-Array class. An ordinary vector with only
`Object.setPrototypeOf(source, proto)` therefore lacks that paired capability.
Even when installed, `prependSetPrototypeOfArm` clears the bag's `$proto` for
null/non-$Object values, and the reader treats that as default Array.prototype;
it cannot represent explicit null as distinct from an unset link.

Minimal proposed shared change: register paired writer/reader arms for admitted
protocol modules even without a class installation; add a presence/null marker
beside the existing bag `$proto` link. `__getPrototypeOf` must return explicit
null distinctly and the exact supplied prototype for ordinary supported links.
Retain extensibility/cycle checks and define an explicit representation for
non-$Object prototype carriers rather than coercing them to default Array.
The B facade calls this actual prototype provider; it does not infer a prototype
from a vector brand. Do not integrate that call as proof of capability before
the writer/reader pair is fixed. The ordinary custom-prototype witness is in
the focused tests.

### 3. Receiver-aware dynamic class prototype helper — implemented, unmeasured

The ABI is now `__struct_proto_get(target,key,receiver) -> externref`.
Repository source inventory finds exactly one emitted call: the marked-root arm
prepended to `__extern_get` in `fillDynamicProtoHelpers`. It passes the captured
`explicitReceiver` local, not the transient global or target parameter. All
root arms forward `__reflect_get_receiver(proto,key,receiver)`; private scratch
locals shifted from 2/3 to 3/4. Registration has three externref parameters.
Other references are documentation, registration and lookup, not consumers.
No host import/export or independently reserved signature exists.

The fill refuses a missing explicit-Receiver seam rather than using the old
two-argument path. After prepending it runs `finalizeExternGetReceiverEntry`,
so one-shot state is consumed before user getters. The parent's final call
after ALL prependers remains mandatory. Both existing compilation pipelines
already call `fillDynamicProtoHelpers`; no index.ts changes in this lane.

## Source-order inspection and execution boundary

`declarations.ts` already retains exact Array iterator assignments under
`arrayIteratorMaybeOverridden`, and `shouldKeepBuiltinReceiverWrite` retains
builtin prototype assignments under `protoNamedDirty || protoIndexDirty`.
No missing keep hook was demonstrated by execution (execution is prohibited),
so B has NOT edited declarations.ts/builtin-write-keeps.ts. The top-level
before/after replacement case is a required parent execution gate, including
the variable-held callable form. Early protocol registration is mandatory.

Remaining measurements belong to the parent: compile/type/stack validity,
zero-import receipts, 32 focused cases, actual production reachability,
original twelve sources unchanged, preservation/legacy-cache controls, and
source/function budgets. Formatting success is not any of these measurements.

No edits were made to Curie/Huygens/A/drive files or frozen
`promise-combinators.ts`. No commits or other Git mutations were made.

## Frozen prior receipt and extension delta

The original receipt is retained byte-for-byte at
`plan/agent-context/5883-protocol-get-handoff-20260927-prior.md`.
SHA-256: `21e32ddd77ba4b45c5a90149d245b40dd903b7195e378d7bc753569e1493f4d5`.
Its three-blocker status is historical; sections 1 and 3 above supersede it.
The prior four B implementation files are unchanged by this extension.

Extension tracked diff against base: `instance-props.ts` +38/-3;
`dynamic-proto.ts` +31/-18 (69 insertions, 21 deletions total). The focused test
file and receipts remain untracked source artifacts, as before; no staging.
Post-format source SHA-256:

- `instance-props.ts`: `9fe0453e6c607d9aecacd7002b8b941d466e01db50dfedcabcc5ab4646c91a3f`
- `dynamic-proto.ts`: `97f0087fc174075324eaea586630863de8752836a3bc4ff0d0e7207a392d3e56`
- focused tests: `7ba9060d3351ca3c7fe37d68c4919eece925d58e6e7e6e6d2b5283c77b49ecfc`

Targeted `git diff --check` passes for tracked owned sources. A whole-tree
attempt encountered the sandbox-denied unrelated Acorn Wasm LFS clean filter;
no LFS configuration or artifact was changed. `vec-proto-link.ts` is unchanged.

New focused controls cover own IterRec next getter returning undefined or
throwing (no inherited fallback/close); own return data undefined, getter
undefined and throwing getter (original abrupt completion wins); assignment,
define, read, delete, identity separation, no private own keys, freeze and
preventExtensions; two dynamically linked classes with nested throwing Reflect
reads, ordinary reads after the throw, explicit Receiver and trap-absent Proxy.

No compiler, test runner, typechecker, standalone JS fixture, commit, push or
merge was run for this extension. Huygens retains the compiler slot. Old compiler
retirement remains blocked until full IR equivalence. Formatting/textual checks
do not establish stack validity, behavior, zero imports or acceptance.
