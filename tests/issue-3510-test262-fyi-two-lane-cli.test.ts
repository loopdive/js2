import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeTestFile,
  parseArgs,
  parseTest262Flags,
  parseTest262Negative,
  processOutcome,
  testPathForInput,
} from "../scripts/test262-fyi-cli.mjs";

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function externalTest262Root(engineSuffix: string): { root: string; inputPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "js2-test262-fyi-cli-"));
  scratchRoots.push(root);
  const directory = path.join(root, "test", "language", "module-code");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "value_FIXTURE.js"), "export const value = 42;\n");
  const inputPath = path.join(directory, `entry.js.${engineSuffix}`);
  fs.writeFileSync(
    inputPath,
    `/*---\nflags: [module]\n---*/\nimport { value } from "./value_FIXTURE.js";\nif (value !== 42) throw new Error("fixture graph was not evaluated");\n`,
  );
  return { root, inputPath };
}

describe("#3510 test262.fyi one-shot engine CLI", () => {
  it.each([
    ["gc", "js2_host"],
    ["standalone", "js2_standalone"],
  ] as const)("executes one isolated %s source using FYI's external fixture tree", async (target, engineSuffix) => {
    const { root, inputPath } = externalTest262Root(engineSuffix);
    await expect(
      executeTestFile({ target, test262Root: root, inputPath, engineSuffix, module: true }),
    ).resolves.toMatchObject({ pass: true, phase: "runtime", reachedTest: true });
  });

  it("accepts test262.fyi's inline and block flag spellings", () => {
    expect([...parseTest262Flags("flags: [module, async]\n")]).toEqual(["module", "async"]);
    expect([...parseTest262Flags("flags:\n  - noStrict\n  - async # completion\n")]).toEqual(["noStrict", "async"]);
    expect(parseTest262Negative("negative:\n  phase: runtime\n  type: TypeError\n")).toEqual({
      phase: "runtime",
      type: "TypeError",
    });
  });

  it("maps the temporary engine filename back to the original Test262 path", () => {
    const { root, inputPath } = externalTest262Root("js2_host");
    expect(testPathForInput(inputPath, root, "js2_host")).toBe("language/module-code/entry.js");
  });

  it("uses ordinary process output instead of a direct-verdict runner hook", () => {
    expect(processOutcome({ pass: true, asyncTest: true })).toEqual({
      exitCode: 0,
      stdout: "Test262:AsyncTestComplete\n",
      stderr: "",
    });
    expect(processOutcome({ pass: false, detail: "TypeError: expected", asyncTest: false })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "TypeError: expected\n",
    });
  });

  it("leaves an expected negative visible to the external verdict classifier", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "js2-test262-fyi-cli-negative-"));
    scratchRoots.push(root);
    const directory = path.join(root, "test", "language", "statements", "function");
    fs.mkdirSync(directory, { recursive: true });
    const inputPath = path.join(directory, "negative.js.js2_host");
    fs.writeFileSync(
      inputPath,
      `/*---\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nfunction invalid(,) {}\n`,
    );

    const result = await executeTestFile({
      target: "gc",
      test262Root: root,
      inputPath,
      engineSuffix: "js2_host",
    });
    expect(result).toMatchObject({
      pass: true,
      phase: "compile",
      negative: { phase: "parse", type: "SyntaxError" },
    });
    expect(processOutcome(result)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "SyntaxError: expected parse negative observed\n",
    });
  });

  it("encodes a wrong-phase negative as a clean child result so FYI records a failure", () => {
    expect(
      processOutcome({
        pass: false,
        detail: "expected TypeError but compiler rejected for an unrelated reason",
        asyncTest: false,
        negative: { phase: "runtime", type: "TypeError" },
      }),
    ).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("rejects ambiguous targets instead of silently publishing a third mode", () => {
    expect(() => parseArgs(["--target", "wasi", "--test262-root", "/tmp/test262", "/tmp/test262/test/a.js"])).toThrow(
      "--target must be gc or standalone",
    );
  });
});
