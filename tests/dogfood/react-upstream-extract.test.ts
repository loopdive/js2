import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood helper has no declaration file
import { extractReactUpstreamTests } from "./react-upstream-extract.mjs";

describe("react upstream extractor", () => {
  it("drops ESM helper imports and records their bindings as unavailable scaffolding", () => {
    const root = mkdtempSync(join(tmpdir(), "js2-react-extract-"));
    const file = "fixture.js";
    try {
      mkdirSync(join(root, "suite"));
      writeFileSync(
        join(root, file),
        `import {helper as importedHelper} from "external-helper";\n` +
          `describe("fixture", () => { it("uses helper", () => { importedHelper(); }); });\n`,
      );
      const result = extractReactUpstreamTests({ root, testFiles: [file], admitAll: false });
      expect(result.tests).toHaveLength(0);
      expect(result.rejectionCounts["needs-dropped-scaffolding"]).toBe(1);
      expect(result.rejected[0].fullName).toBe("fixture › uses helper");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only treats calls rooted at expect as matchers", () => {
    const root = mkdtempSync(join(tmpdir(), "js2-react-matcher-"));
    const file = "fixture.js";
    try {
      writeFileSync(
        join(root, file),
        `describe("fixture", () => {\n` +
          `  it("keeps ordinary string methods", () => {\n` +
          `    const value = "abc";\n` +
          `    expect(value.toString()).toMatch("abc");\n` +
          `    expect(value.toLowerCase()).toBe("abc");\n` +
          `  });\n` +
          `  it("rejects an unsupported Jest matcher", () => {\n` +
          `    expect("abc").toBeGreaterThan("def");\n` +
          `  });\n` +
          `});\n`,
      );
      const result = extractReactUpstreamTests({ root, testFiles: [file], admitAll: false });
      expect(result.tests.map((test: { name: string }) => test.name)).toEqual(["keeps ordinary string methods"]);
      expect(result.rejectionCounts["unsupported-matcher:toBeGreaterThan"]).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
