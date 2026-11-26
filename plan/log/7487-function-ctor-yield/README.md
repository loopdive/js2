# #7487 yield: literal `Function(...)` step-past

This is the measurement behind the Yield section of
`plan/issues/7487-prepared-literal-function-constructor.md`. It was run on main `c3b7be667a` on 2026-11-26, from a
worktree of that commit; `REPO` is a checkout holding the test262 submodule.

| file | what |
| --- | --- |
| `step-past.mjs` | the tool: `classify`, `build`, `stats` |
| `first-gap-function.tsv` | the 334 positive ES5 files whose first gap names `"Function"`, with their site class |
| `files.txt` / `files-meta.tsv` | the 197 rewritten files (literal-only, literal + value, `fnGlobalObject.js`) |
| `base-real.jsonl`, `step-standin.jsonl`, `step-real.jsonl` | the census rows, before and after the rewrite |

## Commands

```bash
REPO=/home/user/js2                                  # checkout with test262/ (the submodule)
WT=$PWD                                              # a worktree of the measured commit
OUT=$WT/plan/log/7487-function-ctor-yield

# 1. The stand-in census of every ES5 file (about 13 minutes on 4 cores), then the rows whose first gap is `Function`.
npx tsx scripts/ir-census/es5-files.mts --out .tmp/ir-census/es5-files.txt
npx tsx scripts/ir-census/prepared-census.mts --files .tmp/ir-census/es5-files.txt \
  --out .tmp/ir-census/prepared-standin.jsonl --harness stand-in --jobs 3
node $OUT/step-past.mjs classify .tmp/ir-census/prepared-standin.jsonl $REPO $OUT

# 2. A scratch tree: a worktree of the same commit whose test262/ the tool builds from REAL copies.
#    A fresh worktree's test262/ holds symlinks into the shared checkout; writing through them rewrites the shared
#    test262 (it happened once, 2026-11-26). Unlink them and remove the directory first: the tool refuses an existing one.
git -C $REPO worktree add --detach $REPO/.claude/worktrees/fnctor-tree <commit>
TREE=$REPO/.claude/worktrees/fnctor-tree
find $TREE/test262 -maxdepth 2 -type l -delete; rmdir $TREE/test262
ln -s $REPO/node_modules $TREE/node_modules
node $OUT/step-past.mjs build $OUT $REPO $TREE

# 3. The census on the rewritten files (both harnesses), the same files unrewritten (real harness), and the table.
(cd $TREE && npx tsx scripts/ir-census/prepared-census.mts --files $OUT/files.txt --out $OUT/step-standin.jsonl \
  --harness stand-in --jobs 4 --tree $TREE)
(cd $TREE && npx tsx scripts/ir-census/prepared-census.mts --files $OUT/files.txt --out $OUT/step-real.jsonl \
  --harness real --jobs 4 --tree $TREE)
npx tsx scripts/ir-census/prepared-census.mts --files $OUT/files.txt --out $OUT/base-real.jsonl --harness real --jobs 4
node $OUT/step-past.mjs stats $OUT
```

## Caveats

The rewrite is a bound, not the mechanism. It differs in four ways:

- one function object is shared across evaluations;
- the body is strict when the program is (`onlyStrict`);
- `toString`, `name` and `length` read the hoisted declaration;
- RV7432's B1/B2 checker and write-analysis effects are absent.

Rows that fail only because of strictness in `onlyStrict` programs are reported as unknown.

Re-run after the #7363 A1–A4 B1/B2 fixes land, and again after the #7487 arm.
