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

import { readFileSync } from "node:fs";

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

describe("the promotion bot is allowlisted in BOTH login spellings", () => {
  // `gh pr list --json author` resolves through GraphQL, where a GitHub App's
  // `Bot.login` is the BARE slug; REST reports the same account as
  // `<slug>[bot]`. auto-enqueue.yml wrote the allowlist in the REST form only,
  // so the comparison against the GraphQL form never matched: PR #4817 sat
  // CLEAN and unenqueued for three hours on 2026-08-24 with
  // `untrusted-author:CONTRIBUTOR` in the log, while the npm-compat dashboard
  // stayed frozen. The workflow now names both forms.
  const workflow = readFileSync(new URL("../.github/workflows/auto-enqueue.yml", import.meta.url), "utf8");

  it("passes the app slug to the allowlist with and without the [bot] suffix", () => {
    const line = workflow.split("\n").find((l) => l.includes("TRUSTED_AUTHOR_LOGINS:"));
    expect(line).toBeDefined();
    expect(line).toContain("${{ steps.app-token.outputs.app-slug }},");
    expect(line).toContain("${{ steps.app-token.outputs.app-slug }}[bot]");
  });

  it("trusts an allowlisted login regardless of which spelling the API returned", () => {
    // The decision function itself is spelling-agnostic: it just matches the
    // configured set. Both entries are what makes either API form work.
    for (const login of ["promo-bot", "promo-bot[bot]"]) {
      const r = isTrustedAuthor({
        assoc: "CONTRIBUTOR",
        authorLogin: login,
        headRepoOwner: "loopdive",
      });
      // With the default allowlist neither is trusted; this pins that the
      // gate still FAILS CLOSED for a login nobody configured.
      expect(r.trusted).toBe(false);
      expect(r.reason).toBe("untrusted-author:CONTRIBUTOR");
    }
  });

  // --- the login has to come from a source that names an App author ---
  //
  // Allowlisting both spellings (above) was necessary but not sufficient: the
  // sweep matched against the login from `gh pr list --json author`, which for
  // a GitHub App author does not yield the app slug, so the promotion PR kept
  // being skipped `untrusted-author:CONTRIBUTOR` with a correct allowlist in
  // place. The login is now read from the same GraphQL page that already
  // returns authorAssociation, where a Bot actor's login resolves.

  it("selects the author login in the association GraphQL query", () => {
    const script = readFileSync(new URL("../scripts/enqueue-green-prs.mjs", import.meta.url), "utf8");
    const query = script.slice(script.indexOf("function authorAssociations()"));
    expect(query).toContain("number authorAssociation author { login }");
  });

  it("carries both association and login per PR, and logs the login it saw on a skip", () => {
    const script = readFileSync(new URL("../scripts/enqueue-green-prs.mjs", import.meta.url), "utf8");
    // The map value is a record, not a bare association string — a caller that
    // reads it as a string would silently compare "[object Object]".
    expect(script).toContain(
      'byNumber.set(n.number, { assoc: n.authorAssociation || "NONE", login: n.author?.login || "" })',
    );
    // A skip must name the login, otherwise a spelling mismatch is
    // indistinguishable in the log from a genuinely untrusted stranger.
    expect(script).toContain('`${trust.reason} (login=${authorLogin || "(none)"})`');
  });
});
