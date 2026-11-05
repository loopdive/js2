import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const paths = [
  "src/wasm/physical/module-reservations.ts",
  "src/backend/wasmgc/resources/native-string-output.ts",
  "src/backend/wasmgc/resources/native-bigint-number.ts",
  "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
  "src/backend/wasmgc/resources/native-booleans.ts",
];
export default {
  plugins: [
    {
      name: "exact-main-baseline",
      enforce: "pre",
      transform(code, id) {
        const p = paths.find((p) => id === resolve(p));
        return p ? { code: readFileSync(resolve(".tmp/base-inputs", p), "utf8"), map: null } : undefined;
      },
    },
  ],
  test: {
    include: ["tests/issue-3518-module-reservations.test.ts", ".tmp/legacy-identity.test.ts"],
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
  },
};
