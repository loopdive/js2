# Pop proof repair, 2026-10-02

Original checkpoint c1a69649 retains the unchanged 33-case test. Its local first
run failed 14 cases and passed 19, matching CI. All 14 emitted storage-Pop
bodies were unreachable-only; the dispatcher used an inlined externref Pop.
The old proof incorrectly required a capacity marker inside the dead body.

The test-only repair follows the live direct or inlined route, isolates matching
carrier arms, proves the exact Get call precedes the matching receiver's length
write, and proves Get's bounds guard protects the matching backing-array read.
Four negative controls run inside the existing dense-O0 case. No test rows,
programs, expected values, compiler options or timeouts were removed or changed.

Measured pre-format source SHA-256:
540a85fdffa5c45ffaee58efcae0b9a97ec71992f69c1ee7e16206a8679ef668.
Standalone verification passed 33/33, then the complete nine-file changed-root
population passed 86/86, zero pending. Runner87631/PID61619 and all ten children
are terminal exit0. Parent compared all30 logged program/value receipts and
all22 emitted WAT files with the first failing run: unchanged, byte-for-byte WAT.

Repository Prettier then produced source SHA-256
20b7ce668160da90e128ba4e97c9b785ae7e87a7f798d24956eddbd269ea7ade.
Complete parsed TypeScript trees, excluding SourceFile raw text/trivia, matched
before/after at fac751b072230291dd05f8d8b0dc23a7477fdcf267e6357f7f52f32527e00629.
Independent Sol6.1 review found no actionable defect. The matcher is intentionally
format-specific and measured runtime coverage exercises the inlined route,
not the direct alternative. No global compiler/IR equivalence claim is made.

The archive preserves 24 exact JSON result/exit/inspection streams as base64
with original byte lengths and SHA-256, plus hashes/paths for22 retained raw
logs. Full raw logs and emitted WAT remain in the owned checkout, not duplicated
here. Original failures are not replaced by the repaired results.

These results precede merging upstream39cc565790, which includes new compiler
changes from PR6416. The combined version requires renewed validation. Hold,
required CI, protected queue and legacy-retirement constraints remain unchanged.
