# Contributing to js2wasm

`js2wasm` is an open-source project stewarded by **Loopdive GmbH** — a technical foundation for the next generation of the internet, developed fully in the open. This guide covers the technical workflow and the contributor licensing terms required for accepted contributions.

## Development Setup

```bash
git clone https://github.com/loopdive/js2wasm.git
cd js2
pnpm install
```

## Minimum Local Checks

Run these before opening a pull request:

```bash
pnpm typecheck
pnpm lint
npm test
```

For playground work:

```bash
pnpm dev
```

## Test262

Test262 is used as the primary public conformance tracking loop. In this repository it is a measurement and regression tool, not a simple pass/fail gate.

Preferred local command:

```bash
pnpm run test:262
```

PRs may also be validated through CI workflows that compare the branch against the current `main` baseline.

## Contribution Expectations

- Keep changes focused.
- Add regression tests for bug fixes where practical.
- Do not mix unrelated cleanup into a compiler change.
- Preserve the current compiler architecture and repo conventions unless the change explicitly aims to refactor them.

## Agent-Assisted Contributions

This project develops in the open with an agentic workflow. You can use it too.

If you have [Claude Code](https://docs.claude.com/claude-code), you can contribute at agent speed:

1. Browse `plan/issues/` — issue files are flat (`plan/issues/<id>-<slug>.md`); each is a real implementation spec with root-cause analysis, spec citations, and target files already identified. The `status:` frontmatter field tracks state (`ready`, `in-progress`, `blocked`, `done`).
2. Claim one in your fork (update the `status` frontmatter or just start working).
3. Spawn a developer agent pointed at the issue. It will read `.claude/agents/developer.md` for role, apply `.claude/hooks/pre-git-commit.sh` safety checks (a `✓` checkmark required in commit messages), push a branch, and open a PR against this repo.
4. Human review + merge as usual.

You do **not** need agents to contribute. Regular PRs from any contributor are welcome via the standard flow below. The agent path is a force multiplier, not a requirement.

**Where to find issues:**

- `plan/issues/*.md` — issues are flat; filter by frontmatter `status: ready` to find unblocked items. (`plan/issues/sprints/<N>.md` are the frozen per-sprint retrospective docs, not issue files.)
- `plan/issues/backlog/` — longer-term items that need more investigation first.
- `plan/issues/wont-fix/` — decided against implementing (for context only).
- `plan/log/dependency-graph.md` — current priorities and what's blocked on what.
- [The dashboard](https://js2wasm.loopdive.com/dashboard/) provides a filtered UI view of ready-to-pick issues.

**Protected paths** (changes to these go through CODEOWNERS review):

- `plan/` — the roadmap and implementation specs
- `.claude/` — agent coordination, hooks, memory

Changes under those paths are welcome but need maintainer approval to keep direction coherent.

## Contributor License Agreement (CLA)

Contributions to this repository require agreement to the Loopdive contributor terms.

By contributing code, documentation, tests, or other material to this repository, you agree that:

- you have the right to submit the contribution
- you grant **Loopdive GmbH** an irrevocable, worldwide, perpetual, sublicensable license to use, reproduce, modify, distribute, relicense, and otherwise exploit your contribution under any license terms
- you agree that Loopdive GmbH may use your contribution in both open-source and commercial licensing contexts

If you do not agree to these terms, do not submit a contribution.

This CLA exists so Loopdive GmbH can sustainably steward the project over the long term — keeping it maintained, funded, and relicensable should open-source license standards evolve — while the source is distributed under the Apache 2.0 with LLVM Exceptions license.

### How acceptance is recorded (the `cla-check` gate)

Acceptance is recorded affirmatively and audibly — there is no third-party
service. The `cla-check` GitHub Action (`.github/workflows/cla-check.yml`)
gates every pull request:

1. When you open a PR, the gate checks whether your GitHub account has a
   recorded acceptance in `.github/cla/signatures.json` at the **current CLA
   version**.
2. If not, the gate fails and a bot posts a one-time comment asking you to
   accept. **Comment this exact phrase on your PR:**

   > I have read and agree to the CLA

3. The Action then appends a signature record
   (`{login, name, pr, commit_sha, cla_version, signed_at}`) to
   `.github/cla/signatures.json`, commits it as `github-actions[bot]`, and the
   `cla-check` turns green. Your acceptance is now part of the repo's history.

**Exempt contributors** — members of the `loopdive` organization, the
maintainer, and automation bots (`github-actions[bot]`, `dependabot[bot]`, any
`*[bot]`) are exempt and pass the gate automatically with no signature. Only
external (non-member) human contributors need to comment the phrase. The
exemption is resolved live via the GitHub org-membership API, with an explicit
fallback allowlist at `.github/cla/allowlist.json`.

**CLA version / re-acceptance** — the CLA version is derived from the content
hash of [`CLA.md`](./CLA.md) (`CLA_VERSION` in `.github/cla/cla-gate.mjs`). A
signature is only valid for the version it was recorded against, so if the CLA
terms ever change, the version bumps and contributors are asked to re-accept
the updated terms. Past acceptances of the old terms remain in the audit trail.

## Pull Requests

When opening a PR:

- explain the problem being solved
- describe any conformance or behavior impact
- include the relevant tests or rationale if tests are not added

PRs are gated by the `cla-check` workflow described above. For external
contributors this means: open the PR, then comment the agreement phrase so the
gate can record your acceptance.

## License

The repository source is licensed under **Apache-2.0 WITH LLVM-exception**. See [LICENSE](./LICENSE).

Contributions are accepted only under the CLA terms above.
