// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7478 — a standalone consumer that LINKS a provider and mentions `eval`
// skipped calls to its own top-level functions.
//
// THE MECHANISM. With an `eval` mention every top-level function declaration is
// a live binding, so `g(false)` reads `g` as a runtime-eval carrier and calls
// it through `__runtime_eval_call_aot` → `__apply_closure(g)`. There the #6420
// peer arm asks the PROVIDER's `callableKind`, whose bit 0 was plain
// `__is_callable` — structural, 1 for any closure-root struct — and ships `g`
// to the provider's `__apply_closure`. `g(false)` specialises `g` to
// `(self, i32)`, a signature only the consumer minted, so the provider's ladder
// had no arm for it and answered the undefined sentinel: `g` never ran, its
// `throw` was lost, and test262's `assert(false, msg)` passed vacuously in
// every such unit. The fix: the provider's bit 0 excludes a closure it cannot
// dispatch, so the consumer keeps it on its own ladder.
//
// Host-free: `hostBridge: "off"`. The `js2wasm:runtime-eval` namespace gets
// throwing stubs — no probe below evaluates code, the mention alone matters.
// Every probe answers a NUMBER (a standalone string cannot cross to the host).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

const PROVIDER = `export const NS = Object.freeze({ __proto__: null, id(x) { return x; } });`;

async function linkedConsumer(consumer: string): Promise<Record<string, () => number>> {
  const root = mkdtempSync(join(tmpdir(), "issue-7478-"));
  const packageRoot = join(root, "node_modules", "ns7478");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns7478", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), PROVIDER);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns7478";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns7478")!;
  const field = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]: `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n${consumer}`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      sharedExceptionTag: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const evalStubs: Record<string, () => never> = {};
  for (const item of WebAssembly.Module.imports(new WebAssembly.Module(result.binary as Uint8Array))) {
    if (item.module !== "js2wasm:runtime-eval") continue;
    evalStubs[item.name] = () => {
      throw new Error(`unexpected runtime-eval call ${item.name}`);
    };
  }
  const { instance } = await instantiateLinkedProject(result, { "js2wasm:runtime-eval": evalStubs } as never);
  return instance.exports as unknown as Record<string, () => number>;
}

// 1 = threw "in" (correct). 0 = the call returned normally (the defect).
const THROWS = (call: string): string =>
  `export function probe() { try { ${call}; return 0; } catch (e) { return e === "in" ? 1 : 2; } }`;

describe("#7478 linked standalone consumer that mentions eval", () => {
  it("runs a boolean-specialised top-level function (its throw is not lost)", async () => {
    // Base tree: 0 — `g` never ran.
    const ns = await linkedConsumer(`globalThis.eval;\nfunction g(m) { throw "in"; }\n${THROWS("g(false)")}`);
    expect(ns.probe()).toBe(1);
  });

  it("returns the value of a function whose result type only this module minted", async () => {
    // Base tree: 0 — the undefined sentinel, not 7.
    const ns = await linkedConsumer(
      `globalThis.eval;\nfunction g(m) { return 7; }\nexport function probe() { return g("x"); }`,
    );
    expect(ns.probe()).toBe(7);
  });

  it("runs a function whose signature this provider lacks, externref formal and all", async () => {
    // Base tree: 0. The real Temporal provider happens to have this signature,
    // which is why `g("x")` already threw there.
    const ns = await linkedConsumer(`globalThis.eval;\nfunction g(m) { throw "in"; }\n${THROWS('g("x")')}`);
    expect(ns.probe()).toBe(1);
  });

  it("control: without an eval mention the call is direct", async () => {
    const ns = await linkedConsumer(`function g(m) { throw "in"; }\n${THROWS("g(false)")}`);
    expect(ns.probe()).toBe(1);
  });

  it("control: a provider-owned function value still reaches the provider", async () => {
    const ns = await linkedConsumer(`globalThis.eval;\nexport function probe() { var f = NS.id; return f(5); }`);
    expect(ns.probe()).toBe(5);
  });
});
