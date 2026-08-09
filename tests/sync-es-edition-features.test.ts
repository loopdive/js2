import { describe, expect, it } from "vitest";
import { parseFinishedProposals } from "../scripts/sync-es-edition-features.ts";

const FIXTURE = `# Finished Proposals

| Proposal | Author | Champion(s) | Meeting Notes | Expected Publication Year |
| --- | --- | --- | --- | --- |
| [Explicit Resource Management][resource-management] | Ron | Ron | notes | 2027 |
| [\`Promise.withResolvers\`][promise-defer] | Peter | Peter | notes | 2024 |
| [Array.fromAsync][from-async] | J.S.
Choi | J.S. Choi | notes | 2026 |

[resource-management]: https://github.com/tc39/proposal-explicit-resource-management
[promise-defer]: https://github.com/tc39/proposal-promise-with-resolvers
[from-async]: https://github.com/tc39/proposal-array-from-async
`;

describe("parseFinishedProposals", () => {
  it("extracts edition features and their canonical proposal links", () => {
    expect(parseFinishedProposals(FIXTURE)).toEqual([
      {
        name: "Explicit Resource Management",
        edition: 2027,
        proposalUrl: "https://github.com/tc39/proposal-explicit-resource-management",
      },
      {
        name: "Promise.withResolvers",
        edition: 2024,
        proposalUrl: "https://github.com/tc39/proposal-promise-with-resolvers",
      },
      {
        name: "Array.fromAsync",
        edition: 2026,
        proposalUrl: "https://github.com/tc39/proposal-array-from-async",
      },
    ]);
  });

  it("ignores table rows without a valid publication year and deduplicates features", () => {
    const markdown = FIXTURE.replace(
      "\n\n[resource-management]",
      "\n| [Explicit Resource Management][resource-management] | Ron | Ron | notes | 2027 |\n| Draft only | A | B | notes | TBD |\n\n[resource-management]",
    );
    expect(parseFinishedProposals(markdown).map(({ name, edition }) => ({ name, edition }))).toEqual([
      { name: "Explicit Resource Management", edition: 2027 },
      { name: "Promise.withResolvers", edition: 2024 },
      { name: "Array.fromAsync", edition: 2026 },
    ]);
  });
});
