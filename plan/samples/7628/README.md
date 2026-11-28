# #7628 measurement inputs

Scratch for `plan/issues/7628-realm-write-scan-computed-key-writers.md`. Never to merge. Base: PR #7549's head
`b7cfc6257f`.

| file | what |
| --- | --- |
| `candidates.patch` | first round: the naive, use, receiver, const and key-value rules, switched by `RULE` (`naive`, `use`, `recv`, `const`, `num`, `combo`; `base` = no arm) |
| `v2.patch` | the revised rule (after PRV-7628), as planned: new `src/ir/key-values.ts`, the accessor caller, the binding record, `Reflect` spellings. No switch (`RULE=base` turns off only the computed-read check) |
| `rows2.mts` | the 46 fact rows (37 stop, 9 keep) of the plan's "Test changes" |
| `accessor-equiv.mts` | old `exactPreparedAccessorExpressionKey` vs `exactKey(keyValues(e))` on every expression of a directory |
| `scan-fixture.mts` | imports, class expressions and `arguments` in the byte-identity gate inputs |
| `probe-global.mts` | the out-of-scope `pristine` finding (global rebinding through `defineProperty` / `assign`) |
| `cmp.mjs` | census diff: pass counts, lost, gained, new crashes, changed rows |

## Trees

```bash
git worktree add --detach <dir>/base b7cfc6257f
cp -a <dir>/base <dir>/v2 && (cd <dir>/v2 && patch -p1 < <repo>/plan/samples/7628/v2.patch)
cp -a <dir>/base <dir>/cand && (cd <dir>/cand && patch -p1 < <repo>/plan/samples/7628/candidates.patch)
# each tree: ln -s <test262 checkout> test262; ln -s <node_modules> node_modules
```

## Census

`o411.txt` is `plan/samples/7354-o411.txt` without its `test/` prefix (`sed 's#^test/##'`).

```bash
cd <tree>
npx tsx scripts/ir-census/prepared-census.mts --files <repo>/plan/samples/7350-b3bc/carriers.txt \
  --out <out>/<tag>-carriers.jsonl --harness real --jobs 2
npx tsx scripts/ir-census/prepared-census.mts --files <out>/o411.txt \
  --out <out>/<tag>-o411.jsonl --harness real --jobs 2
node <repo>/plan/samples/7628/cmp.mjs <out>/base-carriers.jsonl <out>/<tag>-carriers.jsonl
```

For `candidates.patch`, prefix each census with `RULE=<rule>`. About 13 min (carriers) + 5 min (o411) on 4 cores.

## Rows, equivalence, fixture scan

```bash
mkdir -p <tree>/.tmp/7628 && cp rows2.mts probe-global.mts <tree>/.tmp/7628/ && (cd <tree> && npx tsx .tmp/7628/rows2.mts && npx tsx .tmp/7628/probe-global.mts)
# base: 37 of 46 rows differ (every stop row folds); v2: 0 of 46
# from <dir>, which holds base/ and v2/ (the script imports ./trees/base and ./trees/v2: adjust or symlink):
npx tsx accessor-equiv.mts <test262>/test      # {"files":53869,"exprs":4756986,"defined":1213753,"mismatches":0}
(cd <repo> && npx tsx plan/samples/7628/scan-fixture.mts)   # 824 texts, 5 imports, 0 class expressions, 1 arguments
```
