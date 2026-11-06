import { readFileSync } from "node:fs";
import { resolve } from "node:path";
export default {
  plugins: [
    {
      name: "byte-copy-preimage",
      enforce: "pre",
      transform(code, id) {
        return id === resolve("src/wasm/physical/owned-function-data.ts")
          ? {
              code: readFileSync(
                "../codex-3527-promise-contract-integration-20261025/.tmp/owned-function-data.ts.before-byte-fix",
                "utf8",
              ),
              map: null,
            }
          : undefined;
      },
    },
  ],
  test: { include: ["tests/issue-3527-owned-function-data.test.ts"], maxWorkers: 1, minWorkers: 1, pool: "forks" },
};
