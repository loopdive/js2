# S15 spike scratch (not for merge)

Write-up: `plan/log/prepared-runtime-library-spike-2026-11-19.md`.
Run from this directory after `pnpm install`: `npx tsx p1.mts` (boundary probes; `--share-tag` for the shared
exception tag), `FINAL_STRINGS=1 npx tsx b8.mts` (long strings, with/without), `npx tsx measure.mts` (size/time).
d7 shared-undefined fix: `python3 d7fix.py d7.bridged.wat d7.lib.wat` after p1 has produced them, then `d7run.mts`.
`prelude.js` = scripts/test262-fyi-runtime.js + test262 harness/assert.js + harness/sta.js + `assert.sameValue(1, 1);`.
