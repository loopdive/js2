// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4536 — forwarding a rest vector through a dynamically stored callable must
 * preserve its individual arguments at the JS-host boundary.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";

const PROVIDER_MJS = `
export default function ruleMessages(ruleName, messages) {
  const newMessages = {};
  for (const [messageId, messageText] of Object.entries(messages)) {
    newMessages[messageId] = (...args) => \`${"\${messageText(...args)}"} (\${ruleName})\`;
  }
  return newMessages;
}
`;

const ENTRY_TS = `
import ruleMessages from "./ruleMessages.mjs";

const original = {
  bad: (x: string, y: number, z: string) => \`GOOD \${x} [\${y} and \${z}]\`,
};
const messages = ruleMessages("bar", original);
export function run(): string { return messages.bad("baz", 2, "hoohah"); }
`;

async function compileFixture() {
  const root = mkdtempSync(join(tmpdir(), "issue-4536-callable-spread-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "ruleMessages.mjs"), PROVIDER_MJS);
  const entry = join(root, "entry.ts");
  writeFileSync(entry, ENTRY_TS);

  const result = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "web",
    experimentalIR: true,
    emitWat: false,
    deferTopLevelInit: true,
  });
  expect(result.success).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const imports = buildCompiledImports(result as never, {}) as Record<string, unknown> & {
    setInstance?: (instance: WebAssembly.Instance) => void;
    __setInstance?: (instance: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary!, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, () => string>;
}

describe("#4536 callable spread ABI", () => {
  it("expands a rest vector before invoking a stored callable", async () => {
    const exports = await compileFixture();
    expect(exports.run()).toBe("GOOD baz [2 and hoohah] (bar)");
  });
});
