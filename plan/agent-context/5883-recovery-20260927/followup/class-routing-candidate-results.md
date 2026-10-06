# Frozen routing candidate validation

Candidate patch SHA-256: 5c31ad8f7784bc01e04a8244c0f16092f1ab54e71fc0d4e21210f12440db6b63
Initial patch SHA-256: 67df774c6a6cd08334dcffa0c4acd90a82b10f9fffcfcecd92c9d429c05e0c81
Base: 5668c8014b8365358ed655bf6f14b11c85a04065

Preserved patch hash and reverse-apply dry check passed before execution.
Production code and tests were not edited during validation.

Sequential execution:

- Handle 67935: `node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`, exit 0. Log: typecheck-routing-candidate.log.
- Handle 16752: `VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 node node_modules/vitest/dist/cli.js run tests/issue-5753-class-property-runtime.test.ts tests/issue-5753-class-field-provenance.test.ts --reporter=verbose`, exit 1, 43.05 seconds. Log: focused-routing-candidate.log.

47 tests: 38 pass / 9 fail (initial 36 pass / 11 fail).
Provenance: 23/23 pass. Runtime: 15/24 pass (initial 13/24).
All 24 runtime receipts match the initial source text AND source SHA-256 by
case name and optimization level. All native results remain 1. Zero imports
in 22/24; getter-query controls still import env.__js_array_new/__js_array_push.
Full source/binary hashes, imports, outcomes and errors remain in both logs.

Gains: static enumeration at O0 and O2 only; source SHA-256
20e898a0c92a43b6f24defefaadbbd02524342fc7fa6843487913af76f90da1c.
No pass-to-fail regressions among these focused controls.

Remaining failures at both O0/O2:

- inherited static setter: wasm -2;
- constructor/prototype/public-dollar role: WebAssembly.Exception;
- live static override/delete/re-add: wasm -3;
- getter-query: two forbidden array imports (execution not reached).

Remaining O2-only failure: abrupt initialization, RuntimeError unreachable.
The override binary changed but its assertion still fails. Getter-query binary
is unchanged, so the edited argument-builder site did not resolve its import
path. Setter, role and abrupt failure binaries also remain unchanged.

Both handles terminal; no kills or restarts. Compiler slot explicitly released
for the parent's Symbol candidate. No124/176 run, no original fixture rerun;
their preserved earlier outcomes remain 3/3 and four native/Wasm variants.
No baseline equivalence or integration readiness claim.

