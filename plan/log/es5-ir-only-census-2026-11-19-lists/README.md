# Prepared-path census, 2026-11-19: files by first gap

Main `ee3fcdd610`, stand-in harness (`scripts/ir-census/stand-in-harness.mjs`),
all 9,174 ES5 files (8,717 positive). One `.tsv` per first-gap mechanism
(`scripts/ir-census/prepared-mechanisms.mjs`); compile crashes are split by
message family. Each row is `file<TAB>first gap detail` (cut at 120
characters). The Prepared path stops at its first gap, so a file is in
exactly one list.

| list | files |
| --- | ---: |
| `script-var-home-object-literal.tsv` | 1449 |
| `call-through-a-value.tsv` | 1225 |
| `new-on-a-plain-function-this-instanceof.tsv` | 924 |
| `built-in-global-as-a-value.tsv` | 860 |
| `built-in-call-or-method.tsv` | 763 |
| `built-in-constructor-new-x.tsv` | 448 |
| `function-expression-or-closure-as-a-value.tsv` | 381 |
| `crash-regexp-capability-deferred.tsv` | 259 |
| `script-var-home-array-literal.tsv` | 257 |
| `var-nested-in-top-level-code.tsv` | 245 |
| `function-declaration-read-as-a-value.tsv` | 226 |
| `array-literals.tsv` | 198 |
| `crash-eval-owning-predicate.tsv` | 196 |
| `other.tsv` | 167 |
| `script-var-home-primitive-literal.tsv` | 117 |
| `eval.tsv` | 96 |
| `script-var-home-new-expression.tsv` | 87 |
| `regexp-methods.tsv` | 83 |
| `native-intrinsic-provider-missing.tsv` | 75 |
| `function-declaration-in-a-block.tsv` | 69 |
| `script-var-home-regexp-literal.tsv` | 68 |
| `dynamic-operators-compare-update.tsv` | 53 |
| `assignment-to-an-undeclared-global.tsv` | 53 |
| `script-var-home-iife-result.tsv` | 39 |
| `delete.tsv` | 37 |
| `script-var-home-call-result.tsv` | 28 |
| `crash-object-static-not-admitted.tsv` | 26 |
| `script-var-home-no-initialiser.tsv` | 25 |
| `member-get-set-on-a-dynamic-value.tsv` | 22 |
| `async-test.tsv` | 22 |
| `crash-other.tsv` | 14 |
| `with.tsv` | 13 |
| `script-var-home-string.tsv` | 13 |
| `script-var-home-member-read.tsv` | 11 |
| `direct-call-into-a-refused-callee.tsv` | 10 |
| `script-var-home-function-expression.tsv` | 7 |
| `script-var-home-other.tsv` | 2 |
| `typeof.tsv` | 1 |

Regenerate (whole census, about 5 minutes on 4 cores, then the lists):

```bash
npx tsx scripts/ir-census/es5-files.mts                       # .tmp/ir-census/es5-files.txt
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/ir-census/es5-files.txt \
  --out .tmp/ir-census/prepared-standin.jsonl --harness stand-in
node scripts/ir-census/prepared-lists.mjs --rows .tmp/ir-census/prepared-standin.jsonl \
  --out plan/log/es5-ir-only-census-2026-11-19-lists
```

Re-measure one list after a slice:

```bash
cut -f1 plan/log/es5-ir-only-census-2026-11-19-lists/delete.tsv > .tmp/subset.txt
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/subset.txt \
  --out .tmp/subset.jsonl --harness stand-in
node scripts/ir-census/prepared-analyze.mjs --rows .tmp/subset.jsonl
```

`--harness real` compiles the real prelude (the program CI measures);
`--tree <dir>` measures another checkout (a `git archive` export with
`node_modules` and `test262` linked in).
