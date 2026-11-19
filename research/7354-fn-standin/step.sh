#!/bin/bash
# usage: step.sh <name> <CENSUS_STUBS> <FN_STANDIN 0|1> <FN_STANDIN_C1 0|1> [files]
cd /home/user/js2/.claude/worktrees/census-fn
files=${5:-.tmp/ir-census/sample.txt}
CENSUS_STUBS="$2" FN_STANDIN="$3" FN_STANDIN_C1="$4" timeout 36000 npx tsx scripts/ir-census/prepared-census.mts --files "$files" --out .tmp/ir-census/$1.jsonl --harness real --jobs 3 > .tmp/ir-census/$1.log 2>&1
echo "exit $?"
node .tmp/ir-census/walls.mjs .tmp/ir-census/$1.jsonl | cut -c1-230
