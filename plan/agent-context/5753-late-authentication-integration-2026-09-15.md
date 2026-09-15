# PR5753 late-authentication integration

Checkpoint3870662235 passed the final33-file preserved regression/runtime group:
413/413. Its push was stopped by the ancestry check because main advanced via
PR5938 to095e87d47f6900e038a90bec7419aaea6dd24965. That main merges cleanly,
preserving both inventories. CLI cache, optimizer path probing and multi-file
prepass changes require fresh composed validation; do not transfer the413 result
to the refreshed tree without rerunning it. No force push or stale-base push.

Parent integration follows committed C1 checkpoint2a528c8743. D1 commits
0b99423312, f5857656c3 and c1fb88f8a9 are composed with U1 commits7fef9b7e1b
and9e5a292f26. Original published PR head51590be and main8c9b65b389 remain
ancestors; no force push or gate baseline change is intended.

D1 authenticates both original receipt identities and the complete current peer
population through the current lookup at late closure boundaries. It preserves
sequential preparations while rejecting invalidated originals hidden by renewal,
partial peers and cached/nested payload reuse without proof. U1 retains the
canonical provider/import/resource descriptors for already-complete and mixed
consumers through deferred sealing and commit; first-component publication
survives a second-component refusal. The exact old C1 relocation receipt remains,
with only the two approved U1 spans inverted and mutation controls retained.

Independent High review accepted exact c1fb88f8 and9e5a292f:52/52 D1 controls,
84/84 U1/C1 controls, and the reviewer's original reproductions. These counts
overlap parent tests and are not additive coverage. Parent composed four-suite
run65288 passes138/138 under the documented2GB single-fork setting. Prior run
8513 exhausted its default512MB heap and is not a pass. TypeScript7 and unchanged
layering gate pass85 import lines against baseline90. Final broad preservation
rerun and normal publication checks remain required.

Before these final follow-ups, the original23-file regression group passed
322/322. The seven timer assertions also fail on pinned main: fresh22-test
main/pre-D1 runs both15 passed/7 failed, identical ordered statuses and normalized
failure messages/stacks. Rendered WAT indices differ, so that evidence is not
whole-artifact equality. Preserve the failures and all fixtures; do not refresh
their expectations. Exact reports are retained in
`/private/tmp/js2-5753-timer-attribution-logs.C6qeMY`.

Remaining evidence limit: no verified admitted live compile exercises final
binding with an open dynamic overlay. Real staged-overlay and live late-refusal
controls are present, but do not claim that additional execution coverage.
Inventory validity is not architectural completion or IR-only retirement.
Parent remains the sole integration/publication owner; #5748's runtime repairs
and #5939's independent native-inventory CI repair are separate worktrees.
