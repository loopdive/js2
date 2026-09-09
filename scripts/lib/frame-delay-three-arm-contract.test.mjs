import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSuite, validatePopulation, sha, SPEC } from "./frame-delay-three-arm-contract.mjs";

// Synthetic instrument controls only. No compiler, Wasm or historical arm runs.
function population(suite) {
  const fixtures = SPEC[suite].ids.map((id) => ({ id, source: "synthetic", sourceSha256: sha("synthetic") }));
  const actions = [
    "pending-70",
    "non-i31",
    "sequential",
    "parallel-reverse",
    "empty",
    "sequential-reject",
    "parallel-reject",
    "undefined",
  ];
  const binary = Buffer.from("synthetic-not-a-wasm-module").toString("base64");
  return {
    schema: SPEC[suite].schema,
    fixtures,
    rows: fixtures.map((fixture) => ({
      id: fixture.id,
      fixture,
      kind: "executed",
      binary,
      wat: "synthetic",
      result: { resources: [1, 2], extra: "retained" },
      values: (fixture.id === "family"
        ? actions
        : fixture.id === "delay"
          ? ["concurrent-delay", "registration-rejection"]
          : ["single"]
      ).map((action) => ({ action, actual: 1, instantiatedBinary: binary })),
    })),
    closureCertified: false,
    physicalAcceptanceCertified: false,
    retirementCertified: false,
  };
}
for (const suite of ["frame", "delay"]) {
  test(suite + " full synthetic denominator validates (not runtime evidence)", () =>
    validatePopulation(population(suite), suite),
  );
  for (const [name, mutate] of [
    ["missing row", (r) => r.rows.pop()],
    [
      "duplicate row",
      (r) => {
        r.rows[1] = r.rows[0];
      },
    ],
    ["missing execution", (r) => r.rows[0].values.pop()],
    ["reordered scenarios", (r) => r.rows[0].values.reverse()],
    [
      "nonexecuted",
      (r) => {
        r.rows[0].kind = "compile-error";
      },
    ],
    [
      "wrong instantiated binary",
      (r) => {
        r.rows[0].values[0].instantiatedBinary = "wrong";
      },
    ],
    [
      "fixture mutation",
      (r) => {
        r.fixtures[0].source = "changed";
      },
    ],
    [
      "false certification",
      (r) => {
        r.retirementCertified = true;
      },
    ],
  ])
    test(suite + " rejects " + name, () => {
      const r = population(suite);
      mutate(r);
      assert.throws(() => validatePopulation(r, suite));
    });
  test(suite + " preserves original mismatch separately from repaired equality", () => {
    const old = population(suite),
      repaired = structuredClone(old),
      candidate = structuredClone(old);
    old.rows[0].binary = "historically-different";
    const verdict = compareSuite(old, repaired, candidate);
    assert.equal(verdict.originalCandidateExact, false);
    assert.equal(verdict.repairedCandidateExact, true);
    assert.equal(verdict.pass, true);
  });
  for (const [name, mutate] of [
    [
      "bytes",
      (r) => {
        r.rows[0].binary += "x";
      },
    ],
    [
      "WAT",
      (r) => {
        r.rows[0].wat += "x";
      },
    ],
    ["resource ordering", (r) => r.rows[0].result.resources.reverse()],
    [
      "unknown result field loss",
      (r) => {
        delete r.rows[0].result.extra;
      },
    ],
    [
      "value",
      (r) => {
        r.rows[0].values[0].actual = 2;
      },
    ],
    [
      "fixture metadata",
      (r) => {
        r.fixtures[0].metadata = "added";
      },
    ],
  ])
    test(suite + " exact comparison catches " + name, () => {
      const original = population(suite),
        repaired = structuredClone(original),
        candidate = structuredClone(original);
      mutate(candidate);
      assert.equal(compareSuite(original, repaired, candidate).pass, false);
    });
}
test("late-import must remain equal even when repaired/candidate match", () => {
  const original = population("frame"),
    repaired = structuredClone(original),
    candidate = structuredClone(original);
  original.rows.at(-1).wat += "original-only";
  assert.equal(compareSuite(original, repaired, candidate).pass, false);
});
