export default {
  test: {
    include: [
      "tests/issue-3518-native-string-output-resources.test.ts",
      "tests/issue-3518-native-bigint-number-owner.test.ts",
      "tests/issue-3518-native-number-primitive-classifier.test.ts",
      "tests/issue-3518-native-boolean-boxes.test.ts",
      "tests/issue-3518-native-boolean-resources.test.ts",
      "tests/issue-3518-native-boolean-bodies.test.ts",
      "tests/issue-3518-native-boolean-boundary-contracts.test.ts",
      "tests/issue-3527-owned-function-data.test.ts",
      "tests/issue-3518-module-reservations.test.ts",
      "tests/issue-3518-physical-snapshot-comparison.test.ts",
    ],
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
  },
};
