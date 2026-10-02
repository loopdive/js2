# Validation after compiler-main merge

Measured composition: bbd4abc201fcd8dd0a3903910258f09d7bbd419c, including
upstream39cc565790 and the reviewed Pop proof repair. Canonical TS7 exits0;
the complete nine changed-test files pass86/86 and incoming builtins pass23/23.
All7517 input pins remain unchanged. Runner50115/PID67591 and all12 original
children are terminal. An orchestration exit0 is not all-test success: the
original host-gate child exited1, passing5/22 because tsx IPC was sandbox-denied.

The unchanged host-gate suite with IPC permission then passed9/22 and failed13:
the owned worktree had an empty Test262 directory. The gate correctly refused
to classify without its corpus. Parent provisioned content symlinks to the
canonical checkout at exact gitlink b363f29d3c43c626dc852744ad64a0b48a003693,
with tracked test contents clean, and left shared data/configuration untouched.
The subsequent unchanged22-case run passed22/22, zero pending, session84852,
child79308, exit0. Both earlier failures remain separate historical records.

The archive embeds29 exact JSON invocation/result/exit streams as base64,
including all three host-gate reports, with original bytes and SHA-256. Raw
logs and the7517-input pin file remain at their recorded owned-checkout paths;
their hashes are included without duplicating the large inputs manifest.

These are bounded checkpoint and gate-setup results, not full IR equivalence.
PR5883 remains held until publication, required CI and protected-queue acceptance.
Its preservation scope does not close issue5197's live-vector feature acceptance
or permit legacy retirement. Further main883ec89 contains docs/CI/release changes
only; its added checks require separate validation before publication.
