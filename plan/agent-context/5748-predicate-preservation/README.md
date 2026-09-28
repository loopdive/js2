# Numeric predicate extraction: exact bounded preservation

This checkpoint clears the function-size blocker encountered while publishing
the dead-export repair. It extracts global isNaN/isFinite emission into a private
helper without changing dispatch guards, Symbol coercion, one-time operand
evaluation, local names or emitted instructions. No budget exemption was added.

The before overlay is pinned at d6f4da7029f06ea81ac20f6271a285fa6179d9a9 with the
same reviewed dead-export repair and diagnostic bytes as the candidate. A full
source/test comparison found only call-identifier.ts differed. Its archived
before SHA256 is 8341e693cb4d3e96c4dd553486eb718cd91a0682e2341e7ded5a41b1a07ee087.

## Complete diagnostic retained, not a green correctness claim

The sibling 5748-frozen-predicate-pair-9d8f.test.ts.txt contains all 20 cases,
unchanged expectations and sources; SHA256
9d8f8e1446f1f17d4185e26565ce17104d0f3c736a10907957a2d6dfda2ff6a9.
It is a manual diagnostic archive, not an automatically discovered passing test.
To reproduce, stage its exact bytes temporarily as
tests/issue-5748-global-numeric-predicate-extraction.test.ts and run that file
with one worker. Preserve the result before removing only that temporary copy.

Before, first candidate and post-format candidate each report 16 passes and four
failures. All four failures are numeric operand-once controls in standalone mode,
covering both predicates and both IR settings: actual zero versus expected one.
No expectation was changed, test skipped, or failing fixture removed from the
archive. Their causal interpretation remains unproven. Exact preservation is
not evidence that those underlying behaviors are correct.

All three raw logs are committed alongside this record. The parent independently
parsed the raw logs and JSON reports and asserted exact equality of:

- 4/4 selected-function IR records, including locals and instruction order;
- 16/16 source and emitted-binary hash records, keyed by all fixture dimensions;
- 20/20 ordered names, statuses and full failure-message arrays, replacing only
  the two absolute checkout roots with the same placeholder.

No missing record was treated as equal. The post-format run used unchanged
diagnostic bytes: session97017, terminal4fea89, exit1 as recorded, not a success
exit. Its separate exact comparison exited0. The temporary automatic-discovery
copy was removed after terminal completion; the frozen diagnostic remains.

## Other validation

- Original four regression files: 79/79, session53766, terminal596dac, exit0.
- Source TS7: session71289, terminal0a1a46, exit0.
- Supplemental source plus diagnostic TS7: session44754, terminal90a7c0, exit0.
- Function-size gate: session74041, terminal66a96f, exit0 with unchanged limits.
- Initial formatting check failed on source and diagnostic; source was formatted
  before the final exact pair above. The historical diagnostic remains frozen.
- The separate ownership-test repair retains its 26/26 evidence and first typing
  failures in the sibling dead-export receipts.

The PR remains HOLD for the existing behavioral blockers. Neither preservation
of these failures nor the configured preservation gate certifies full compiler
equivalence, strict graph closure or retirement of the legacy compiler.
