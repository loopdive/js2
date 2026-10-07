# Cast-free C ABI test repair: frozen paired qualification

This extends, not replaces, the historical evidence in the parent directory and
the preceding `main-e1e/` epoch. Original test bytes remain in
`original-v3-test.ts.gz`; original strict errors remain in `main-e1e/`.

Production baseline: canonical main e1e07bd4683faafcd69846bc757cce36ebb9fb61.
Test-only baseline execution HEAD:2a866ff9d31dc0a7c0d18cc7489c6bee79c0705a.
Candidate execution HEAD:44dd2415dc8422939c313c72b3034943eadcf997.
Candidate's sole production delta is the existing ten-line C ABI resolver fix.
Shared A source is unchanged. Sol repair source commit:cf07ca68c160c46155e0b4d4819a649224fc9d07,
integrated unchanged asb0233789838188a726b4200d1e0634a92b61cbda.
Repaired test SHA256:d3dec54184b30de6aea6c25c9b6e6adb99eca98f2f603bd1b05d958ca764585a.

Both strict runs use their OWN identical `.tmp/6893-main-e1e/tsconfig.test-inclusive.json`:

```sh
node node_modules/typescript7/lib/tsc.js --noEmit -p .tmp/6893-main-e1e/tsconfig.test-inclusive.json
```

Both exit0, zero diagnostics. The unchanged configuration is preserved in
`../main-e1e/strict-config.json.gz`; it includes all source and the owned test.

Paired final runtime command (external300-second deadline; output paths differ
only by arm; no forced suite-wide IR setting):

```sh
pnpm exec vitest run tests/issue-6893-linear-cabi-array-forwarding.test.ts tests/c-abi.test.ts tests/issue-1835.test.ts tests/issue-1938-number-array-f64.test.ts tests/issue-1977.test.ts tests/issue-4539-c-link.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=default --reporter=json --outputFile.json=/absolute/arm-results.json
```

JSON reporting was added identically to both arms solely to retain all98 named
case statuses. The preliminary repaired baseline with the original default
reporter is separately preserved as `baseline98.log.gz`; it also measures89/9.
Final baseline:89 pass/9 fail, exit1; candidate:98 pass/0 fail, exit0. Zero skips,
six files, all80 original controls passing. Case-result comparison retains every
case identity and full baseline failureMessages, not just suite totals.

All32 semantic records per arm are EXACTLY equal to that arm's pre-repair epoch;
only provenance revision/testSha256 differs. All33 paired records have identical
kind populations and pass the earlier explicit boundary-delta/custody comparison.
Thirty baseline failure identity/message lines match exactly before/after repair;
raw full stacks and source frames remain available, including shifted line numbers.

Reproduce the three committed comparison scripts using the compressed artifacts:

```sh
node ../compare-instrument-repair.mjs ../main-e1e/baseline98.log.gz baseline98-final.log.gz ../main-e1e/candidate98.log.gz candidate98-final.log.gz
node ../compare-main-composition.mjs baseline98-final.log.gz candidate98-final.log.gz d3dec54184b30de6aea6c25c9b6e6adb99eca98f2f603bd1b05d958ca764585a
node ../compare-case-results.mjs baseline98-results.json.gz candidate98-results.json.gz
```

The3.75/69/40 scalar corrections belong to A's landed read repair. The source
array-return fixtures still use fallback: no new IR admission, performance
equality or legacy-retirement credit. Session A owns final queue integration.
PR6587 remains non-draft HOLD until remaining gates and coordinated acceptance.
