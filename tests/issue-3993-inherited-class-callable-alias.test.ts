import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#3993 inherited class callable aliases", () => {
  it("keeps a base method owned by module init callable from a nested child class", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-inherited-alias-"));
    try {
      writeFileSync(
        join(dir, "base.js"),
        `var Base = class {
  add(value) { return value + 1; }
};
export { Base };
`,
      );
      writeFileSync(
        join(dir, "entry.js"),
        `import { Base } from "./base.js";

export function run() {
  const Child = class extends Base {
    own() { return 0; }
  };
  return new Child().add(41);
}
`,
      );

      const result = await compileProject(join(dir, "entry.js"), {
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "gc",
        platform: "node",
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const imports = result.importObject ?? buildImports(result.imports, undefined, result.stringPool);
      const instance = await WebAssembly.instantiate(result.binary, imports);
      imports.__setInstance?.(instance.instance);
      expect((instance.instance.exports.run as () => number)()).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
