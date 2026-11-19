# #7354 function-value stand-in (research only, never merge)

Branch `claude/7354-fn-standin-research` = `claude/7354-integration` at `94abeb8347` plus the research stand-ins
used to measure the "function value with own properties" plan (see the plan section at the end of
`plan/issues/7354-prepared-path-harness-prelude-milestone.md` on `claude/7354-json`, `ce8710b801`).

- `src/` changes (= `standin-src-94abeb.diff`, applied): abort stand-ins for the assert.js formatting leaves
  (ToPrimitive of an unplain object, `dyn.json_stringify`, ToString of a function, `dyn.member_get`,
  `dyn.object_tag`), `__ir_dyn_method_call_N`, R5 and R7. Abort = `js.value.as_string` over undefined (an illegal
  cast). Behaviour on real programs is wrong by design; this branch only measures how far compilation gets.
- `fn-standin.mjs`: a SOURCE rewrite for lanes (a) and (b): a top-level function declaration read as a value becomes
  `F$fv` (one function-expression wrapper per declaration, created before the first statement); a static own property
  `F.p` becomes the script var `F$$p`. `FN_STANDIN_C1=1` also rewrites `Test262Error` (C1).

## The full-prelude program (compile time: 776 s per program on 94abeb8347)

Copy the census scripts (`git show origin/claude/es5-census-1119:scripts/ir-census/<f>`) into `scripts/ir-census/`,
put `fn-standin.mjs` and this `prepared-census.mts` (it applies the rewrite when `FN_STANDIN` is not `0`) there too,
symlink `test262` to a real checkout, then:

```bash
# one program: the original harness prefix (assert.js + sta.js + includes) + a test body, rewritten, compiled
npx tsx research/7354-fn-standin/t3.mts test262/harness/assert.js test262/harness/sta.js \
  test262/test/language/asi/S7.9_A6.1_T2.js
# census over the sample: step.sh <name> <CENSUS_STUBS> <FN_STANDIN> <FN_STANDIN_C1> [files]
```

`t3.mts` prints `success, compile ms, run result`. `run-sample.txt` lists 6 files of the 564 that get through
lowering; 5 of them passed when run. Compile time, not correctness, is what lane S6 measures here.
