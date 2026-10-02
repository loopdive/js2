# Constructor runtime-cycle V2: preserved first result

This is diagnostic evidence, not runtime acceptance or production activation.
The separately reviewed observer ran once on pinned experiment
`fda4b498696f395889e199756c6b8c27a629387c` with the recorded source pins.

- Test result: 0/1 passed; process 83232 terminated with exit 1.
- Compilation succeeded, with no reported compile errors.
- First failure: `constructor allocation/publication/seed sequence not proved`.
- This failure occurred during the surviving-graph prerequisite, before native
  execution, original Wasm execution, derivative emission, or runtime observation.
- Runtime reentry and rollback remain UNOBSERVED. No rerun or relaxed assertion.
- The temporary test was removed after its exact archive was verified. All 17
  source/config pins and the experiment HEAD remain unchanged.

The observer hash is
`b67d6081bf47bdde9f855c82ba72d336c3fa61181a6cfd27915e60a6eaeb3b6b`.
The unchanged fixture hash is
`a122d333957f9aa8498bcbb86c889f372ef0dd0da281bb6f4fddbf61daa5ecb5`.
Full local output is retained in
`/private/tmp/js2-5883-main-6eac-20260927/.tmp/runtime-cycle-v2-nO4Rbp`.

The earlier V6 comparison remains 5/5 correspondence and 0/5 observer acceptance
and coverage. Neither result clears the held renderer or old-compiler retirement.
Investigate actual final-graph placements and capture assumptions before deciding
whether a diagnostic correction is justified; a matching failure is not a pass.
