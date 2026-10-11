// #6868 — template-literal (and string-mapping) types are strings. `.length`
// on a `` `${string}-${string}` ``-typed value read NaN on standalone and on
// the native regime because the oracle/type-mapper only recognised
// `String | StringLiteral`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const SRC = `
function f(): \`\${string}-\${string}\` { return "ab-cd" as any; }
function g(): Uppercase<string> { return "ABC" as any; }
export function lenTL(): number { return f().length; }
export function lenMapped(): number { return g().length; }
export function concatTL(): string { return f() + "!"; }
`;

async function run(options: { target?: "standalone"; semanticProviders?: "native-first" }) {
  const result = await compile(SRC, { fileName: "issue-6868.ts", ...options });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  if (options.target === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    return instance.exports as Record<string, () => unknown>;
  }
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return wrapCompiledExports(result, instance) as Record<string, () => unknown>;
}

describe("#6868 template-literal string types", () => {
  for (const [label, options] of [
    ["standalone", { target: "standalone" }],
    ["native regime in a JS environment", { semanticProviders: "native-first" }],
    ["default gc", {}],
  ] as const) {
    it(`reads .length and concatenates on ${label}`, async () => {
      const exports = await run(options);
      expect(exports.lenTL()).toBe(5);
      expect(exports.lenMapped()).toBe(3);
      // A raw standalone export hands JS the native string struct; the JS
      // lanes marshal it, so only they can compare the concatenated value.
      if (options.target !== "standalone") expect(exports.concatTL()).toBe("ab-cd!");
    });
  }
});
