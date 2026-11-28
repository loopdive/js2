# #7628 measurement inputs

Scratch for `plan/issues/7628-realm-write-scan-computed-key-writers.md`. Never to merge. Base: PR #7549's head
`b7cfc6257f`.

| file | what |
| --- | --- |
| `candidates.patch` | first round: the naive, use, receiver, const and key-value rules, switched by `RULE` (`naive`, `use`, `recv`, `const`, `num`, `combo`; `base` = no arm) |
| `v2.patch` | the revised rule (after PRV-7628 round 1): new `src/ir/key-values.ts`, the accessor caller, the binding record, `Reflect` spellings. No switch (`RULE=base` turns off only the computed-read check). Misses N1 / N2 of round 2 |
| `v3.patch` | the rule after round 2, against the base like `v2.patch`: the binding record is `any` by default (`declaredBinding`, `BINDS_NO_VALUE`), loop-head variables are `any` (N1), the old sets and `freshNames` are gone, `nameKeyValues` is the dependency-indexed worklist. `key-values.ts`, `class-accessor-safety.ts` and the `memberWrites` arm are as in `v2.patch`. `RULE=base` as there |
| `rows3.mts` | the 56 fact rows (43 stop, 13 keep) of the plan's "Test changes"; a row may be a map of sources whose `./entry.*` key is the entry (`.ts` for TS declarations) |
| `mutate3.py` | applies each v3 mutation to a v3 tree, runs `rows3.mts`, restores, and prints the rows each fails |
| `accessor-equiv.mts` | old `exactPreparedAccessorExpressionKey` vs `exactKey(keyValues(e))` on every expression of a directory |
| `scan-fixture.mts` | imports, class expressions, `arguments`, TS value declarations (enum, namespace, `export =`) and loop-head initializers in the byte-identity gate inputs |
| `probe-global.mts` | the out-of-scope `pristine` finding (global rebinding through `defineProperty` / `assign`) |
| `cmp.mjs` | census diff: pass counts, lost, gained, new crashes, changed rows |

## Trees

```bash
git worktree add --detach <dir>/base b7cfc6257f
cp -a <dir>/base <dir>/v2 && (cd <dir>/v2 && patch -p1 < <repo>/plan/samples/7628/v2.patch)
cp -a <dir>/base <dir>/v3 && (cd <dir>/v3 && patch -p1 < <repo>/plan/samples/7628/v3.patch)
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
mkdir -p <tree>/.tmp/7628 && cp rows3.mts probe-global.mts <tree>/.tmp/7628/ && (cd <tree> && npx tsx .tmp/7628/rows3.mts && npx tsx .tmp/7628/probe-global.mts)
# base: 43 of 56 rows differ (every stop row folds); v2: 4 of 56 (N1 x2, N2 namespace, enum); v3: 0 of 56
python3 mutate3.py <dir>/v3      # needs .tmp/7628/rows3.mts in the v3 tree; one line per mutation
# from <dir>, which holds base/ and v2/ (the script imports ./trees/base and ./trees/v2: adjust or symlink):
npx tsx accessor-equiv.mts <test262>/test      # {"files":53869,"exprs":4756986,"defined":1213753,"mismatches":0}
(cd <repo> && npx tsx plan/samples/7628/scan-fixture.mts)   # 824 texts, 5 imports, 0 class expressions, 1 arguments,
                                                            # 1 TS value declaration (`export default u`), 0 loop-head initializers
```
