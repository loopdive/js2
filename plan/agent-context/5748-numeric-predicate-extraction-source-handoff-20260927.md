# Numeric-predicate extraction: source-only, awaiting slot

Parent approved a meaningful bounded extraction after commit session 31111 failed
the normal function budget: compileBoundIdentifierCall 3755 > 3753. Existing issue
allowances name its wrapper, not this function. No allowance/baseline edits or
cosmetic compression. No commit occurred. Parent now owns the validation slot.

## Separate unstaged delta

- `src/codegen/expressions/call-identifier.ts`: private
  `emitGlobalNumericPredicate(ctx, fctx, operand, predicate): ValType` extracts the
  global isNaN/isFinite emission. Both original dispatch/arity guards remain at
  their original checkpoint. The helper performs the same Symbol coercion guard,
  compiles the numeric operand once, allocates the same f64 local with the same
  name/ordinal at the same time, and pushes the same instruction sequence.
  Throw and normal paths preserve `{ kind: "i32", boolean: true }`.
- `tests/issue-5748-global-numeric-predicate-extraction.test.ts`: new source-only
  controls, statically 20 cases: two pipelines × two predicates × (one exact IR
  suffix/local check plus numeric/Symbol operand-once checks in host/standalone).
  Numeric controls observe boolean branding and a count of exactly one. Symbol
  controls require TypeError and exactly one operand call. Full selected-function
  IR and per-fixture source/binary SHA256 are printed for the paired comparison.
- This handoff. No existing fixtures or staged checkpoint files edited. Index
  still contains the parent's five reviewed dead-export-fix/handoff files.

The giant function loses 28 physical source lines before formatting, rather than
receiving a renamed budget exemption. No function-budget pass is claimed until
the actual gate runs. New helper is private and called by production dispatch;
no new exported API, runtime helper registration or dependency cycle.

## Frozen before-source and hashes

Before-source is retained in owned `.tmp/5748-call-identifier-pre-predicate-extraction.ts`.
It was reconstructed via apply_patch from bounded full-file reads, then SHA256
verified byte-identical to the original before editing:

- Before source/archive: `8341e693cb4d3e96c4dd553486eb718cd91a0682e2341e7ded5a41b1a07ee087`.
- After source: `b958a4d7f9c74ba8a627e2a6a93c52136a2c933557fdb28252cbab2f6669d6cd`.
- New test: `9d8f8e1446f1f17d4185e26565ce17104d0f3c736a10907957a2d6dfda2ff6a9`.

One initial patch attempt rejected out-of-order hunks without applying changes;
the corrected ordered patch succeeded. No compiler/test/formatter/gate ran.

## Validation plan, only after explicit slot grant

Preserve and run the complete original files, not selected passing cases:

1. `tests/issue-5395-additional-boolean-brands.test.ts` (boolean rendering matrix).
2. `tests/issue-5399-javascript-runtime-safety.test.ts` (original refusal and
   neighboring controls, BigInt evidence).
3. `tests/issue-1436.test.ts` (coercion and abrupt completion, neighboring globals).
4. `tests/issue-2881.test.ts` (distinct non-coercing Number.is* behavior).
5. New `tests/issue-5748-global-numeric-predicate-extraction.test.ts` in full.

Before/after pairing must not overwrite the parent's active integration source
or index. Prepare a separate owned diagnostic overlay at the same pinned HEAD,
with the same approved checkpoint deltas and dependencies, only replacing
call-identifier with the archived before bytes. Apply identical new-test bytes
to both. Verify the complete source difference is only this extraction, then
run sequentially with the same options/environment and save first logs/JSON.
Compare exact selected-function IR records (including locals and instruction
order) and binary hashes by complete fixture key, plus all test outcomes.
No missing record counts as equality; retain source hashes and full case names.
The printed fixture keys require four IR records and sixteen binary records per
complete successful new-test run. If an earlier assertion prevents a record,
the pair is incomplete, not equivalent. These are bounded exact witnesses, not
whole-compiler equivalence or retirement proof. Diagnose any pre-existing probe
or pipeline mismatch rather than weakening expected output or hiding failures.

Then canonical source TS7, supplemental test TS7, focused formatting, function
budget and normal relevant gates as granted. Count actual terminal cases; never
reinterpret source enumeration as execution. Preserve all first failures. Keep
original historical BigInt receipts and HOLD limitations unchanged. No commit or
push by this agent before parent review.
