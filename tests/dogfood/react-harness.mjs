import { pathToFileURL } from "node:url";

import { createPackageEntryHarness, runPackageEntryHarnessCli } from "./package-entry-harness.mjs";
import { setupReact } from "./setup-react.mjs";

export const runHarness = createPackageEntryHarness({
  name: "react",
  setup: setupReact,
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runPackageEntryHarnessCli(runHarness);
}
