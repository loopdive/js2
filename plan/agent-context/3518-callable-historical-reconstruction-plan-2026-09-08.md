# Callable historical reconstruction plan

Astra High specification; implementation and verification pending.

The three failures are explained by the callable changes—not by lost historical source. Use a **checked inverse of the approved additions**, then apply the original receipt hashes. Do not merely update declaration counts or exempt changed bodies.

## Measured reconstruction changes

Against parent HEAD `2b9cb408c18446361fcf9837045067d1fd97c642`:

- Manifest implementation: **85 → 82 local declarations**; three ReferenceError records moved or became imports.
- Callable declarations: **5 → 7 declarations**.
- Intrinsic-support: **37 → 37 local declarations**; its input interface and implementation overload changed. Historical verifier reconstruction still produces **41/24**.
- Manifest data contract: **67/38 → 71/40 declarations/types**.
- `RuntimeManifestBuilder`: **35 → 36 members**, solely one additional overload; body-bearing methods remain 16.

The last two also affect existing adjacent ledgers, although they are not the three reported failures.

## 1. Extend the shared helper with explicit inverses

In [ir-historical-runtime-reconstruction.ts](/private/tmp/js2-3518-native-callables-integration-20260908/tests/helpers/ir-historical-runtime-reconstruction.ts), keep separate, independently literal **current owner order** and **historical output order**.

Every inverse must:

1. Locate an exact source-qualified declaration/member/overload.
2. Require the approved new syntax, documentation, occurrence count and neighboring statements.
3. Authenticate the removed/replaced addition against a separately pinned delta receipt.
4. Apply only the specified inverse.
5. Compare the reconstructed output against the existing historical hash.

Missing, duplicated, reordered or unfamiliar additions must fail. No permissive filtering, sorting, Git fallback or whole historical source replacement.

### Manifest implementation inverse

Reconstruct these original zero-based positions:

- **5 — `REFERENCE_ERROR_DECLARATION`:** restore the historical lookup-alias syntax only after validating the live canonical lookup’s exact ReferenceError branch, binding literal and returned declaration. This was an alias, not the object initializer now located in callable-declarations.
- **6 — `REFERENCE_ERROR_SIGNATURE`:** use its live canonical initializer; reverse only the approved export modifier and newly added JSDoc.
- **67 — `REFERENCE_ERROR_RUNTIME_PROVIDERS`:** use the live relocated declaration and original documentation unchanged.

Require the exact value-import routes and the explicit value re-export of `REFERENCE_ERROR_RUNTIME_PROVIDERS` from manifest to callable-declarations. Reject type-only substitutions, renamed bindings, wrong targets, duplicate definitions and star forwarding.

For the remaining live manifest declarations, reverse exactly:

- The native-async spread in `RUNTIME_PROVIDERS`.
- The corresponding additions in `FEATURE_SET` and `PROVIDER_ID_SET`.
- The `NativeAsyncCallableRuntimeFeature` overload.
- The leading `nativeAsyncProviderMismatch` declaration/check inside `#indexProviders`’ provider loop.
- The `nativePolicyMismatch` declaration/check after `candidates` in `#selectProvider`.

Do not replace either whole private method. Preserve all other bodies, private initializers, member order and documentation.

Historical output remains **85/38**, hash `3abe53ca…6f478`.

### Intrinsic-support inverse

Reverse five precisely located edits:

- Remove only the documented optional `builtinDemands` interface member.
- Remove the initial `assertNativeAsyncCallableDemands` guard.
- Restore the exact previous ReferenceError-scanner condition from the approved feature-restricted condition.
- Remove the explicit builtin-demand policy/request loop.
- Collapse the exact `attached` declaration → guarded assertion → return sequence back into the original return expression.

Leave all three `prepareIrRuntimeManifest` overload records and their individual ordinals intact. Preserve the existing semantic-prefix/provider-suffix verifier reconstruction, including its original combined JSDoc.

Historical output remains **41/24**, hash `eea4525b…2e8d7`.

## 2. Cover the adjacent ledgers now

These need the same shared reconstruction, not independent ad-hoc exceptions:

- [runtime-data-contract-seam.test.ts](/private/tmp/js2-3518-native-callables-integration-20260908/tests/issue-3518-runtime-data-contract-seam.test.ts): reconstruct manifest contracts before applying the original **67/38** receipt. Reverse only the four new native-async declarations, the two union additions and the `standalone-clock-zero` implementation arm. Preserve the original `e7d1bd5d…6841e` hash and **135 moved / 224 retained / 118 functions** totals.
- [provider-verification-ownership.test.ts](/private/tmp/js2-3518-native-callables-integration-20260908/tests/issue-3518-provider-verification-ownership.test.ts): consume normalized historical declarations for manifest, callable-declarations and intrinsic-support. Callable reconstruction removes the two relocated additions and reverses only the exact native fallback to historical `undefined`.

For class receipts, **reparse the reconstructed declaration**. Changing `row.text` while retaining the current `row.node` would leave the extra overload in member counts/hashes.

Keep the historical builder’s 35-member/four-overload receipt. Add a separate current assertion for 36 members/five overloads and unchanged initializer order. Preserve the independent **253/143** ledger.

Capability-schema receipts need no change. Historical 40/44 graph populations must not grow to include the new canonical modules.

## 3. New delta controls must precede historical acceptance

Require the actual new sources: six core constants and the current 21-declaration native-callables module. Pin their reviewed ordered declaration/documentation receipts separately, including the parent-approved nullable argument correction—not the superseded worker body.

Add live mutations proving rejection of:

- Every removable addition being deleted, duplicated, reordered or changed.
- Wrong feature/provider spread, dependency or policy-check arguments.
- Native validation moved after provider indexing/selection.
- Changed overload parameter/return type.
- Changed builtin-demand optionality, owner input or attachment assertion.
- ReferenceError initializer/signature/provider mutation or broken forwarding.
- Changes outside normalized spans, including old private initialization and verifier documentation.
- Missing canonical files.

Each negative must start from a successfully accepted current positive and assert its edit actually changed source. Otherwise an existing reconstruction failure can falsely “validate” every negative.

The positive check and mutation construction must execute **outside** the
closure passed to `toThrow`. In particular, when `mutation(...)` checks the
baseline, first assign `const changed = mutation(...)`, then assert rejection
of the verifier called with `changed`. Otherwise either a failed baseline or
an ineffective mutation can satisfy the expected exception. Apply the same
rule to wrapper helpers that construct mutations indirectly.

## 4. Clock/vector coordination

Implement the callable inverse against the reviewed pre-clock composition first. **Do not add a generic allowance for future clock helpers or vector demands.**

After those workers freeze, add separately reviewed inverses in reverse composition order:

`final live source → pre-clock/vector callable source → historical source`

Until that exact follow-up exists, changed declarations or bodies should continue failing. Label these tests “historical receipt after checked extension reconstruction,” not “all current bodies unchanged.”

Exact test-only owner map: the shared helper plus the three test files above and [historical-runtime-reconstruction.test.ts](/private/tmp/js2-3518-native-callables-integration-20260908/tests/issue-3518-historical-runtime-reconstruction.test.ts). No production changes are needed for this repair.

No tests or writes performed; the reported **55/58** failure remains the current execution evidence.

## 5. Final High review and exact clock/vector follow-up

Review of frozen pre-clock/vector rev1 found only the mutation-setup defect
described above; original receipts, documentation, order and denominators
remain intact. Rev1 validation11005 passed 470/470, but the corrected controls
and final composition require new validation.

Use explicit versions, never existence-based selection:

`final live → pre-vector clock → pre-clock callable → historical`

Keep independently literal declaration orders for current and intermediate
views. Reconstruct only fields needed by historical consumers, never replace
complete source with saved blobs.

### Vector inverse

- `intrinsic-support.ts`: reverse only the vector import, documented optional
  `vectorDemands`, entry assertion and policy/request loop.
- `runtime/callable-declarations.ts`: restore exact native-only fallback and
  remove its vector import.
- `runtime/contracts/manifest.ts`: authenticate/remove four vector declarations
  and two union additions: 75/42 becomes 71/40 declarations/types.
- `runtime/manifest.ts`: reverse three vector spreads, vector overload,
  provider-mismatch coalescing and vector-policy fallback. Reverse the reviewed
  import consolidation exactly, retaining type/value distinctions and order.
  Builder 37 members/six overloads becomes 36/five.

### Clock inverse

In `intrinsic-support.ts`, authenticate and reverse:

- `projectStandaloneAsyncStateInstr`: copy-on-write mapper, allocation guard,
  and own-property site handling.
- `attachProviders`: added parameter and attachment/projection mapping.
- `prepareIrRuntimeManifest#2`: post-freeze provider authentication,
  runtime-state mapping and fourth attachment argument.
- Exact clock import addition.

Leave overload records 0/1 unchanged. Require the resulting view to pass the
pre-clock callable receipts before applying the historical inverse.

### Mandatory independent current-extension receipts

- Core vector owner: 10 declarations/five functions, plus eight value forwards
  and one type forward in its historical facade.
- Vector callable owner: 12 declarations/six functions including constructor.
- All three current clock-validation functions.
- Exact vector caller/demand/error-handling additions in
  `program-runtime-abi.ts` and `runtime-program-manifest.ts`.

Each reversible span needs exact source-qualified identity, approved text and
documentation, unique occurrence and unchanged neighbors. Add positive-first
deletion, duplication, movement and semantic-change controls, with setup outside
the expected rejection closure. Cover lost vector census/callers/policy checks,
clock witness/provider authentication, allocation rejection, positive-zero/site
handling, projection wiring, missing owners and changed type/value forwarding.
Continue checking unchanged private initialization and old verifier docs.

Preserve original 135/224/118, independent 253/143, historical builder 35/four,
and historical 40/44 graph populations. Current activation and six/ten/twelve
evidence stay separate. Reviewed composed join SHA256:
`6d404c97436249e65be69d40dc961e284eb2f4900ec184e645aa45486ea0a1d6`.
