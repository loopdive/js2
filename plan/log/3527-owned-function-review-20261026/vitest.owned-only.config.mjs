export default {
  test: { include: ["tests/issue-3527-owned-function-data.test.ts"], maxWorkers: 1, minWorkers: 1, pool: "forks" },
};
