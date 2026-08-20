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

  it("keeps the ReactDOM Fizz DOM helper on its explicit host facade", () => {
    const root = mkdtempSync(join(tmpdir(), "js2-react-fizz-extract-"));
    const file = "fixture.js";
    try {
      writeFileSync(
        join(root, file),
        `import {getVisibleChildren, mergeOptions} from "../test-utils/FizzTestUtils";\n` +
          `describe("fixture", () => { it("uses Fizz helpers", () => {\n` +
          `  mergeOptions({}, {}); getVisibleChildren(document.body);\n` +
          `}); });\n`,
      );
      const result = extractReactUpstreamTests({
        root,
        testFiles: [file],
        admitAll: false,
        supportedInfrastructure: new Set(["needs-dom"]),
      });
      expect(result.rejected).toHaveLength(0);
      expect(result.tests).toHaveLength(1);
      expect(result.tests[0].prelude).toContain("__js2FizzTestUtils");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds create-react-class through the callable host facade", () => {
    const root = mkdtempSync(join(tmpdir(), "js2-react-class-extract-"));
    const file = "fixture.js";
    try {
      writeFileSync(
        join(root, file),
        `let createReactClass;\n` +
          `beforeEach(() => { createReactClass = require("create-react-class/factory")(React.Component, React.isValidElement, new React.Component().updater); });\n` +
          `describe("fixture", () => { it("uses factory", () => { createReactClass({render() { return null; }}); }); });\n`,
      );
      const result = extractReactUpstreamTests({ root, testFiles: [file], admitAll: false });
      expect(result.rejected).toHaveLength(0);
      expect(result.tests).toHaveLength(1);
      expect(result.tests[0].prelude).toContain("createReactClass = __js2CreateReactClass;");
      expect(result.tests[0].prelude).not.toContain("create-react-class/factory");
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
          `    expect("abc").toBeLessThan("def");\n` +
          `  });\n` +
          `});\n`,
      );
      const result = extractReactUpstreamTests({ root, testFiles: [file], admitAll: false });
      expect(result.tests.map((test: { name: string }) => test.name)).toEqual(["keeps ordinary string methods"]);
      expect(result.rejectionCounts["unsupported-matcher:toBeLessThan"]).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lifts concise and async test arrows without dropping their assertions", () => {
    const root = mkdtempSync(join(tmpdir(), "js2-react-concise-arrow-"));
    const file = "fixture.js";
    try {
      writeFileSync(
        join(root, file),
        `describe("fixture", () => {\n` +
          `  it("concise", () => expect("ok").toBe("ok"));\n` +
          `  it("async concise", async () => Promise.resolve(expect("ok").toBe("ok")));\n` +
          `});\n`,
      );
      const result = extractReactUpstreamTests({ root, testFiles: [file], admitAll: false });
      expect(result.rejected).toHaveLength(0);
      expect(result.tests).toHaveLength(2);
      expect(result.tests[0].body).toContain('expect("ok").toBe("ok")');
      expect(result.tests[0].body).toMatch(/^\(.*\);$/s);
      expect(result.tests[1].body).toMatch(/^await \(.*\);$/s);
      expect(result.tests[1].isAsync).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
