# Prepared-path census, 2026-11-19: per-label file lists

Main `ee3fcdd610`, stand-in harness, all 9,174 ES5 files (8,717 positive).
Each `.tsv` row is `file<TAB>first gap detail` (detail cut at 300 characters).

| list | files | what |
| --- | ---: | --- |
| `crash-regexp-capability-deferred.tsv` | 259 | compile throws: extern method call `.exec` / `.test` / property read `.source` is capability-deferred |
| `crash-eval-owning-predicate.tsv` | 196 | compile throws: certified global eval lost an owning predicate |
| `crash-object-static-not-admitted.tsv` | 26 | compile throws: `Object.defineProperty` is not an admitted Object static |
| `crash-other.tsv` | 14 | every other compile throw, full message |
| `nested-top-level-var.tsv` | 245 | first gap: module-init unit contains a nested var declaration |
| `function-declaration-in-block.tsv` | 69 | first gap: unsupported body statement FunctionDeclaration |
| `undeclared-global-write.tsv` | 53 | first gap: assignment / compound assign / update of an undeclared identifier |
| `delete.tsv` | 37 | first gap: delete has no IR lowering |

Re-run on a subset (one file path per line, relative to `test262/test/`):

```bash
cut -f1 plan/log/es5-ir-only-census-2026-11-19-lists/delete.tsv > .tmp/subset.txt
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/subset.txt \
  --out .tmp/subset.jsonl --harness stand-in --jobs 4
node scripts/ir-census/prepared-analyze.mjs --rows .tmp/subset.jsonl
```

`--harness real` measures the real prelude instead; `--tree <dir>` measures
another checkout. The stand-in is `scripts/ir-census/stand-in-harness.mjs`.
