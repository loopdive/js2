export default {
  test: {
    include: [
      "tests/issue-3518-module-reservations.test.ts",
      "tests/issue-3518-physical-snapshot-comparison.test.ts",
      "tests/issue-3527-descriptor-snapshots.test.ts",
      "tests/issue-3527-publication-snapshot-comparison.test.ts",
      "tests/issue-3518-final-parent-reservations.test.ts",
      "tests/issue-3518-reservation-completion-assertion.test.ts",
      "tests/issue-3518-type-reservation-auth.test.ts",
      "tests/issue-3527-snapshot-intrinsic-observations.test.ts",
    ],
    maxWorkers: 1,
    minWorkers: 1,
  },
};
