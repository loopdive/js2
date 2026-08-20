import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

describe("dogfood launchers", () => {
  it("run tsx through Node's loader instead of the IPC-based npx shim", () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      scripts: Record<string, string>;
    };

    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (!name.startsWith("dogfood:") || !command.includes("tests/dogfood/") || !command.includes("tsx")) {
        continue;
      }
      expect(command, name).not.toContain("npx tsx");
      expect(command, name).toContain("--import tsx");
    }
  });
});
