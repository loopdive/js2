# Landing blockers: source plans, not acceptance receipts

Preserved 2026-09-27 on the recovery branch after main merge 90255de510
(upstream main 5ad53338fe27735305bf656c931df7f46f785e1d).

These are source-reviewed implementation plans. They do not activate a repair,
establish equivalence, remove a PR hold, or authorize legacy compiler retirement.

- PR5753 guard v1 is blocked: physical constructor writes need not create a
  property bag. Treating a missing bag as missing property can hide a real write.
  The replacement plan requires one descriptor authority and closure of actual
  producers, readers, writers, deletion, redefinition and enumeration. Its core
  is approved for source-only implementation, not production activation.
- PR5748 array prototype behavior still needs authenticated supplying-instance
  provenance and real Get/Has/Set semantics. Raw storage presence is insufficient.
  All four original fixtures and positive controls remain required.
- PR5748's separate integration validation has cleared TS7 and scoped format
  after removing the duplicate early BigInt String branch. Original BigInt files
  report 76/77 passing; narrowedString returns 0 instead of 1. The unchanged
  main7443 control reproduces that failure (24/25 in the full wide-carrier file).
  All25 names, statuses and first error lines match; this is not a claim that
  raw stack traces or the complete compiler behavior are identical. The
  provisioned generator/default batch reports
  125/125 passing, with its original 123/125 missing-fixture report retained.

The linked plans retain their inspected source pins; this archive merge does not
repin their underlying experiments. Original176 PR5753 rows and all failures
remain the acceptance population. No source/test exclusions or expectation edits.
