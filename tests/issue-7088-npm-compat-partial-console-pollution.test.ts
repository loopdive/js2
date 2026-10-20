import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const generator = readFileSync(new URL("../scripts/generate-npm-compat-report.mjs", import.meta.url), "utf8");

describe("#7088 npm-compat focused workers survive package console pollution", () => {
  it("does not use the mutable console after writing a partial report", () => {
    const partialWriterStart = generator.indexOf("if (partialOutputPath) {");
    const partialWriterEnd = generator.indexOf(
      "\n}\n\nfunction assertMeasuredOptimizationReceipts",
      partialWriterStart,
    );
    const completionStart = generator.indexOf("} else if (partialOutputPath) {", partialWriterEnd);
    const completionEnd = generator.indexOf("} else {", completionStart);

    expect(partialWriterStart).toBeGreaterThan(-1);
    expect(partialWriterEnd).toBeGreaterThan(partialWriterStart);
    expect(completionStart).toBeGreaterThan(partialWriterEnd);
    expect(completionEnd).toBeGreaterThan(completionStart);

    const partialWriter = generator.slice(partialWriterStart, partialWriterEnd);
    const partialCompletion = generator.slice(completionStart, completionEnd);
    for (const source of [partialWriter, partialCompletion]) {
      expect(source).toContain("process.stdout.write");
      expect(source).not.toMatch(/\bconsole\.(?:log|warn|error)\s*\(/);
    }
  });
});
