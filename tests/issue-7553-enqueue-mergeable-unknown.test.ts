// #7553 — a green PR whose `mergeable` the list query reports as UNKNOWN is
// asked again instead of being skipped until some later sweep gets lucky.

import { describe, expect, it } from "vitest";
import { enqueueEligibility, settledMergeable } from "../scripts/enqueue-green-prs.mjs";

function rereads(answers: string[]) {
  const calls = { reread: 0, pause: 0 };
  const settled = settledMergeable(
    "UNKNOWN",
    () => answers[calls.reread++],
    () => void calls.pause++,
  );
  return { settled, calls };
}

describe("#7553 mergeable UNKNOWN is re-read", () => {
  it("takes the computed answer of the first re-read", () => {
    expect(rereads(["MERGEABLE"])).toEqual({ settled: "MERGEABLE", calls: { reread: 1, pause: 1 } });
  });

  it("keeps asking while the answer is still UNKNOWN", () => {
    expect(rereads(["UNKNOWN", "CONFLICTING"])).toEqual({ settled: "CONFLICTING", calls: { reread: 2, pause: 2 } });
  });

  it("gives up after its attempts, and the gate then refuses the PR", () => {
    const { settled, calls } = rereads(["UNKNOWN", "UNKNOWN", "MERGEABLE"]);
    expect(calls.reread).toBe(2);
    expect(enqueueEligibility({ checks: null, requiredNames: [], mergeable: settled })).toMatchObject({
      eligible: false,
      reason: "mergeable:UNKNOWN",
    });
  });

  it("does not ask again when the list already had an answer", () => {
    for (const known of ["MERGEABLE", "CONFLICTING"]) {
      const asked = { n: 0 };
      expect(
        settledMergeable(
          known,
          () => void asked.n++,
          () => void asked.n++,
        ),
      ).toBe(known);
      expect(asked.n).toBe(0);
    }
  });
});
