// #2550 — author-trust gate must allow the maintainer's fork.
//
// The #2549 author-trust gate in scripts/enqueue-green-prs.mjs only enqueued
// PRs whose authorAssociation was OWNER/MEMBER/COLLABORATOR. But GitHub
// classifies the maintainer `ttraenkler` (whose fork the whole team pushes to)
// as authorAssociation=CONTRIBUTOR on the base repo, so EVERY fork PR was
// skipped `untrusted-author:CONTRIBUTOR` and auto-enqueue was effectively
// disabled. #2550 layers a login/fork allowlist ALONGSIDE the association check.
//
// These tests pin the trust decision (`isTrustedAuthor`) directly — they make
// no `gh` calls (the live sweep is guarded behind an import.meta.url check).

import { describe, expect, it } from "vitest";
import { isTrustedAuthor } from "../scripts/enqueue-green-prs.mjs";

describe("#2550 author-trust gate fork allowlist", () => {
  // --- the bug being fixed: the maintainer's fork PRs (CONTRIBUTOR) must pass ---

  it("trusts ttraenkler even as CONTRIBUTOR (login allowlist)", () => {
    const r = isTrustedAuthor({ assoc: "CONTRIBUTOR", authorLogin: "ttraenkler", headRepoOwner: "ttraenkler" });
    expect(r.trusted).toBe(true);
    expect(r.reason).toContain("trusted-login:ttraenkler");
  });

  it("trusts a PR whose head repo is owned by the ttraenkler fork even if author login differs", () => {
    // e.g. an agent identity opening from a branch on ttraenkler/js2.
    const r = isTrustedAuthor({ assoc: "CONTRIBUTOR", authorLogin: "some-agent", headRepoOwner: "ttraenkler" });
    expect(r.trusted).toBe(true);
    expect(r.reason).toContain("trusted-fork:ttraenkler");
  });

  it("login allowlist is case-insensitive", () => {
    const r = isTrustedAuthor({ assoc: "NONE", authorLogin: "TTraenkler", headRepoOwner: "TTraenkler" });
    expect(r.trusted).toBe(true);
  });

  // --- the existing #2549 behaviour must still hold for org members ---

  it.each(["OWNER", "MEMBER", "COLLABORATOR"])("still trusts %s by association alone", (assoc) => {
    const r = isTrustedAuthor({ assoc, authorLogin: "anybody", headRepoOwner: "anybody" });
    expect(r.trusted).toBe(true);
    expect(r.reason).toBe(`association:${assoc}`);
  });

  // --- fail-closed: strangers stay untrusted no matter how green ---

  it.each(["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", "MANNEQUIN", "UNKNOWN"])(
    "rejects a stranger with association %s (no allowlist match)",
    (assoc) => {
      const r = isTrustedAuthor({ assoc, authorLogin: "drive-by", headRepoOwner: "drive-by" });
      expect(r.trusted).toBe(false);
      expect(r.reason).toBe(`untrusted-author:${assoc}`);
    },
  );

  it("rejects a missing/empty input (fails closed)", () => {
    expect(isTrustedAuthor({}).trusted).toBe(false);
    expect(isTrustedAuthor().trusted).toBe(false);
    // No login and no head-repo owner → only the association decides; UNKNOWN.
    expect(isTrustedAuthor({ assoc: "" }).reason).toBe("untrusted-author:UNKNOWN");
  });

  it("does NOT trust a stranger whose login merely contains 'ttraenkler' as a substring", () => {
    // Set membership is exact — guard against accidental substring trust.
    const r = isTrustedAuthor({ assoc: "NONE", authorLogin: "not-ttraenkler-evil", headRepoOwner: "evil-fork" });
    expect(r.trusted).toBe(false);
  });
});
