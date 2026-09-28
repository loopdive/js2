# PR5748 String(BigInt) clean-merge resolution proposal — NOT APPLIED

2026-09-27. Source-only authorization after first validation and slot return. Parent owns compiler/hooks. No tests, compiler, typecheck, merge, commit or push run here. Only the two explicitly authorized formatting changes were applied. First receipt and logs remain immutable.

## Exact source subjects

PR parent `60fb42a20c0c71e1f273527571170e38da9e5d1e`; upstream parent `7443ab4826fde65b72f875e0af12337a35520932`; merge base `aafae4c03c1fe2811d6ccfd30008326157281cca`. Merge remains uncommitted. Read-only diff against `5ad533^{commit}` confirms only six npm benchmark/website artifacts differ from upstream pin, no compiler source. No new merge attempted.

Compared both parents' call-identifier source and base-to-parent diffs, actual merged helpers, import demand registration and original test source. Upstream wide operand fix is commit `1780de0f653344c1992c5997cc5dd7fff5f5864c` (PR6182, corroborated by its full `5883-bigint-string-carrier-checkpoint-20260927.md`). Short `7443` became ambiguous against tree objects; comparison was repeated with its full commit ID, without mutation.

## Smallest proposed semantic edit

Delete only the PR-added early five-line i64 block (including its trailing blank line) in `src/codegen/expressions/call-identifier.ts`, currently lines1437–1441. Keep upstream's later `emitI64ToStringCall`/`emitStringBuiltinNumberResult` arm unchanged. This is a proposal for review, not an applied source patch:

```diff
@@
-      if (argType?.kind === "i64") {
-        // #5399: String(BigInt) must format the integer before console sees it.
-        return emitToString(ctx, fctx, argType, { kind: "bigint" }, "string");
-      }
-
       if (argType?.kind === "i32") {
```

No assertion, widened union, suppression, provider retry, duplicated compilation or moved formatter call. Do not remove the late upstream arm merely to satisfy narrowing. Keep the `emitToString` import: other live arms still use it. Do not change PR's separate coercion-engine addition under this narrow resolution.

## Why this is the smallest defensible composition

1. The PR parent adds the early unconditional i64 return to fix raw or rounded BigInt String output. Main independently adds the late i64 handler. Each parent has only its own new arm; the clean text merge contains both. The early return excludes i64 at the later comparison, directly explaining first TS2367. It also bypasses upstream's more specific handler.
2. `compileStringConversionArgument` (unchanged) preserves PR6182: for oracle-proven standalone native BigInt it prepares union/wide carriers and flushes late import shifts **before** compiling the operand once with externref expectation. Proven host BigInt also gets externref expectation; other types retain existing behavior. Replacing this helper with the old PR `compileExpression` call would lose wide literal bits before formatting. The companion comma right-operand expectation propagation in binary-ops.ts must also remain unchanged.
3. PR's `emitToString` native i64 arm in coercion-engine.ts directly ensures `bigint_toString`, flushes shifts, emits the exact narrow formatter and unwraps the native string. It does not test `valType.bigint`; the supplied synthetic static type does not add that test. It does not recover a checker-narrowed wide carrier. Its non-native i64 route converts through f64. Consequently this call is not a universally equivalent substitute for upstream's handler.
4. Upstream `bigIntToStringIdx` requires i64 **and bigint:true**, native number-format mode and a registered exact formatter. `emitI64ToStringCall` first tries `emitNarrowedCarrierToString`: when the immediately preceding instruction is the known `__to_bigint` call and the carrier formatter can be supplied, it removes that unbox and formats the original carrier with radix10. Otherwise a registered exact formatter consumes the branded i64. Unbranded numeric i64 uses f64 conversion and `number_toString`, preserving the numeric distinction. If neither formatter is registered, it emits nothing and returns false; this existing upstream fallback is not a general guarantee of exact formatting for every route.
5. `emitStringBuiltinNumberResult` unwraps native formatter externrefs using `any.convert_extern; ref.cast $AnyString` only with valid native type indexes/native-format mode; otherwise reports externref. This preserves a real string result for equality/length consumers, not just console reformatting.
6. Import collector `declarations/import-collector.ts:736–747` records number formatter demand for non-string String arguments, and exact formatter demand for an oracle BigInt fact through `registerBigIntToStringDemand`. This supports the unchanged original statically-BigInt controls. It is not proof that every dynamic/stale fact registers the exact formatter; absent-demand behavior remains a stated limitation, not reason to insert a new late provider fallback here.

Deleting the duplicate early block restores upstream's String dispatch algorithm while keeping all other PR changes, including its shared coercion-engine behavior. Source reasoning supports preserving the PR's intended exact String(BigInt) observation through the upstream route; only measurement can establish that on this integrated tree. No universal i64/BigInt equivalence claim.

## Review and later validation obligations — NOT RUN

After semantic edit approval and a compiler grant:

- Canonical TS7 and scoped formatting, retain the existing first TS2367/format failures separately.
- Original `tests/issue-5399-javascript-runtime-safety.test.ts`, especially both O0/O2 exact stdout rows (`9007199254740995`, `-9007199254740993`, `0`). Do not replace these with synthetic equality-only controls.
- `tests/issue-6656-string-call-bigint.test.ts`: actual equality/length of small/signed64 BigInt String results and ordinary number control.
- Original PR6182 `tests/issue-5883-bigint-string.test.ts` and `tests/issue-5883-bigint-string-comma.test.ts`: wide positive/negative operands, signed/unsigned boundaries, raw result units, single evaluation, comma ordering and throws. Preserve zero-import assertions and separate raw/count observations.
- `tests/issue-6656-bigint-wide-carrier.test.ts` includes the narrowed `typeof n === "bigint"` String path. It covers more than this change; do not silently select only passing exports or discard existing failures.
- Need explicit native numeric-i64 control if the chosen original populations do not exercise unbranded i64. Plain JS number controls are not a substitute. No new fixture was authored under this proposal-only grant.
- The two original generator assembly rows failed fixture loading, not compilation. Provisioning is now complete; rerun only with a new slot grant, retaining first 123/125 report. This setup issue is independent of TS2367.

No broad suite or new denominator authorized by this document. Original effect-order/rest spread gap, known diagnostic-only generator behavior, and PR hold remain separate.

## Applied formatting only

Command (terminal455450, exit0): `node node_modules/prettier/bin/prettier.cjs --write src/codegen/bindings/initializer-carriers.ts src/codegen/expressions/extern.ts`.

Initializer helper signature joined to one line; declared rest ABI fallback object expanded to multiple lines. Read-back diff contains only those line wraps. Changes remain unstaged, separable from the original staged five-file resolution and original receipt.

- initializer-carriers.ts before `b1ca30b0b3b50cd25609bb4b7489890ef375e1c9f12dc3d4ec92940691feb662`; after `34f3194ad3fb9f03fc819d50a9d35617d930fab3ba72d3229f24c76c643b9a4c`.
- extern.ts before `8b2afcb08ee5fb68aff12cdc5436e1d1891319968d991fc222be413e23538da7`; after `0ba8936765955ff8aa00a47a1ae1048dbfe5d95dfda24ae3f54eae850eccf668`.
- call-identifier.ts unchanged `37d10b20763c948bdaeb3496a7f042cd5a3402404f1d31661ac1e133089705a5`.
- First receipt unchanged `b5870daceadfb9fa81d4f5122cbc2fdd12833ac1315bf40d34836f73042f7fe3`; first TS7 log unchanged `f1efcf8389d9d3692ce53d8e0338673a7af28c89a4aab664dd2f53958d76246c`; third batch JSON unchanged `0ce7664311786786e8b4e8f7007c8b85c3d88eb3a4786ea3797c5d74c0c86b31`.

Compiler slot remains returned. Await semantic edit review; no active process.
