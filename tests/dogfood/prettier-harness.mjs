import { pathToFileURL } from "node:url";

import { createPackageEntryHarness, runPackageEntryHarnessCli } from "./package-entry-harness.mjs";
import { setupPrettier } from "./setup-prettier.mjs";

export const runHarness = createPackageEntryHarness({
  name: "prettier",
  setup: setupPrettier,
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runPackageEntryHarnessCli(runHarness);
}
