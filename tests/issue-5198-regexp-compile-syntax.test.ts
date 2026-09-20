// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5198 — Annex B RegExp.prototype.compile syntax classification.
 *
 * The direct, statically primitive path may reject an invalid pattern before
 * it mutates its receiver. Genuinely runtime-built patterns keep #4439's
 * poisoned-carrier contract: a host-valid pattern outside the runtime grammar
 * constructs, exposes its metadata, and only refuses on first use.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5198-regexp-compile-syntax.js",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), `${lane} module failed validation`).toBe(true);

  const module = await WebAssembly.compile(result.binary);
  if (lane === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);

  const importObject = result.importObject ?? {};
  const instance = await WebAssembly.instantiate(module, importObject);
  (importObject as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

const INVALID_LITERAL_SOURCE = `
  export function test() {
    var subject = /test262/ig;
    var firstThrown = 0;
    var firstState = 0;
    var firstMatcher = 0;
    subject.lastIndex = 2;
    try { subject.compile("?"); } catch (error) { firstThrown = error instanceof SyntaxError ? 1 : 0; }
    firstState = subject.source === "test262" && subject.flags === "gi" && subject.lastIndex === 2 ? 1 : 0;
    subject.lastIndex = 0;
    firstMatcher = subject.test("TEsT262") ? 1 : 0;

    var secondThrown = 0;
    var secondState = 0;
    var secondMatcher = 0;
    subject.lastIndex = 3;
    try { subject.compile(".{2,1}"); } catch (error) { secondThrown = error instanceof SyntaxError ? 1 : 0; }
    secondState = subject.source === "test262" && subject.flags === "gi" && subject.lastIndex === 3 ? 1 : 0;
    subject.lastIndex = 0;
    secondMatcher = subject.test("TEsT262") ? 1 : 0;

    var templateThrown = 0;
    var templateState = 0;
    subject.lastIndex = 4;
    try { subject.compile(\`?\`, void 0); } catch (error) { templateThrown = error instanceof SyntaxError ? 1 : 0; }
    templateState = subject.source === "test262" && subject.flags === "gi" && subject.lastIndex === 4 ? 1 : 0;

    return firstThrown && firstState && firstMatcher &&
      secondThrown && secondState && secondMatcher &&
      templateThrown && templateState ? 1 : 0;
  }
`;

const DYNAMIC_VALID_UNSUPPORTED_SOURCE = `
  function runtimePattern() { return "[z-z]"; }
  export function test() {
    var subject = /old/g;
    var returned = subject.compile(runtimePattern());
    if (returned !== subject || subject.source !== "[z-z]" || subject.flags !== "" || subject.lastIndex !== 0) return 0;
    try { return subject.test("z") ? 3 : 0; }
    catch (error) { return error instanceof TypeError ? 2 : 0; }
  }
`;

const LITERAL_VALID_UNSUPPORTED_SOURCE = `
  export function test() {
    var subject = /old/g;
    var returned = subject.compile("[z-z]");
    if (returned !== subject || subject.source !== "[z-z]" || subject.flags !== "" || subject.lastIndex !== 0) return 0;
    try { return subject.test("z") ? 3 : 0; }
    catch (error) { return error instanceof TypeError ? 2 : 0; }
  }
`;

const SHADOWED_UNDEFINED_SOURCE = `
  function compileWithShadowedUndefined(undefined) {
    var subject = /old/;
    var returned = subject.compile("a", undefined);
    return returned === subject && subject.source === "a" && subject.flags === "i" && subject.test("A") ? 1 : 0;
  }
  export function test() { return compileWithShadowedUndefined("i"); }
`;

const RECEIVER_EVALUATION_SOURCE = `
  export function test() {
    var subject = /test262/ig;
    var receiverEffects = 0;
    function receiver() { receiverEffects += 1; return subject; }
    subject.lastIndex = 2;
    try { receiver().compile("?"); }
    catch (error) {
      if (!(error instanceof SyntaxError && receiverEffects === 1 &&
        subject.source === "test262" && subject.flags === "gi" && subject.lastIndex === 2)) return 0;
      subject.lastIndex = 0;
      return subject.test("TEsT262") ? 1 : 0;
    }
    return 0;
  }
`;

const RECEIVER_ABRUPT_SOURCE = `
  export function test() {
    var receiverEffects = 0;
    function receiver() { receiverEffects += 1; throw "receiver-abrupt"; }
    try { receiver().compile("?"); }
    catch (error) { return error === "receiver-abrupt" && receiverEffects === 1 ? 1 : 0; }
    return 0;
  }
`;

describe("#5198 — RegExp.prototype.compile syntax", () => {
  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: rejects invalid primitive syntax before every receiver mutation`, async () => {
      await expect(run(INVALID_LITERAL_SOURCE, lane)).resolves.toBe(1);
    });

    it(`${lane}: declines a shadowed undefined binding`, async () => {
      await expect(run(SHADOWED_UNDEFINED_SOURCE, lane)).resolves.toBe(1);
    });

    it(`${lane}: evaluates the receiver before an invalid primitive throw`, async () => {
      await expect(run(RECEIVER_EVALUATION_SOURCE, lane)).resolves.toBe(1);
    });

    it(`${lane}: preserves an abrupt receiver before an invalid primitive throw`, async () => {
      await expect(run(RECEIVER_ABRUPT_SOURCE, lane)).resolves.toBe(1);
    });
  }

  it("standalone: preserves the valid-but-unsupported dynamic poison contract", async () => {
    await expect(run(DYNAMIC_VALID_UNSUPPORTED_SOURCE, "standalone")).resolves.toBe(2);
  });

  it("host: executes the valid dynamic pattern", async () => {
    await expect(run(DYNAMIC_VALID_UNSUPPORTED_SOURCE, "host")).resolves.toBe(3);
  });

  it("standalone: does not turn a valid unsupported literal into SyntaxError", async () => {
    await expect(run(LITERAL_VALID_UNSUPPORTED_SOURCE, "standalone")).resolves.toBe(2);
  });

  it("host: executes the valid unsupported literal", async () => {
    await expect(run(LITERAL_VALID_UNSUPPORTED_SOURCE, "host")).resolves.toBe(3);
  });
});
