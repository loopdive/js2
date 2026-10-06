// #6749 part A — Web Crypto on the native regime in a JS environment.
// `__crypto_get_random_values` / `__crypto_random_uuid` are the `randomness`
// platform capability (like `Math.random`), not an unclassified builtin, so a
// native-first build links them; the UUID the host returns is marshalled to
// the native string carrier so the module sees a string.
import { describe, expect, it } from "vitest";
import { classifyHostImport } from "../src/host-import-policy.js";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const SRC = `
const rnds8 = new Uint8Array(16);
export function rng(): number { return crypto.getRandomValues(rnds8).length; }
export function v4(): string { return crypto.randomUUID(); }
export function v4type(): string { return typeof crypto.randomUUID(); }
`;

describe("#6749 Web Crypto under the native regime", () => {
  it("classifies the two crypto imports as the randomness platform capability", () => {
    for (const name of ["__crypto_get_random_values", "__crypto_random_uuid"]) {
      const policy = classifyHostImport({
        module: "env",
        name,
        kind: "func",
        intent: { type: "builtin", name },
      } as never);
      expect(policy.classification, name).toBe("platform-capability");
      expect(policy.family, name).toBe("randomness");
      expect(policy.nativeFallback, name).toBe(false);
    }
  });

  it("links and runs a uuid-shaped module under native-first", async () => {
    const result = await compile(SRC, { fileName: "issue-6749-crypto.ts", semanticProviders: "native-first" });
    expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
    const names = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => i.name);
    expect(names).toContain("__crypto_get_random_values");
    expect(names).toContain("__crypto_random_uuid");
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    const exports = wrapCompiledExports(result, instance) as Record<string, () => unknown>;
    expect(exports.rng()).toBe(16);
    expect(exports.v4type()).toBe("string");
    expect(exports.v4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
