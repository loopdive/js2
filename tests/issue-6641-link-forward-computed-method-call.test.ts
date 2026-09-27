// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6641 (#5383 S58) — a COMPUTED-KEY method call on a linked-provider-owned
// externref receiver answered `null` under `--target standalone`:
// `api[k](3, 4)` → `null` while the literal twin `api.add(3, 4)` → `7`.
//
// ROOT CAUSE (S57 reduced the repro; S58 found the mechanism). The literal
// call reaches `__extern_method_call` generically for an `any`/externref
// receiver via the `(#799 WI3)` arm in `call-receiver-method.ts`. The
// computed-key call site (`call-tail-dispatch.ts`) has arms for a user-class
// receiver, a TS-KNOWN plain-object-literal receiver, and (JS-host only)
// `tryEmitDynamicElementHostMethodCall` — but nothing covers the
// `any`/externref case under `--target standalone`/`wasi`
// (`tryEmitDynamicElementHostMethodCall` bails via `noJsHost`). A
// linked-provider receiver's static type is always `any` (it crossed a
// `field(): any` getter stub), so it fell through every arm to the silent
// "drop everything, return null" fallback — never reaching
// `__extern_method_call` at all. Confirmed by instrumentation: the provider's
// `__js2wasm_link_method_call` wrapper's call counter never incremented for a
// computed call, while it incremented once per literal call.
//
// THE FIX: `tryEmitGenericComputedMethodCall`
// (`dynamic-element-generic-call.ts`) — the standalone/wasi twin of the WI3
// arm, computing the method name at RUNTIME (the same key marshaling the
// working element-access READ path already uses) instead of a string
// constant.
//
// Host-free: `hostBridge: "off"` and an EMPTY import object, matching #6605's
// convention — every value crosses purely in Wasm, no host decode step to
// mask a boundary bug.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/** The provider half: an object-literal method bag AND a class instance. */
const PROVIDER = `
  export const api = {
    add(a, b) { return a + b; },
    countArgs() { return arguments.length; },
    self() { return this; },
    chain() { return api; },
    notAFunction: 42,
  };
  export class Box {
    value = 9;
    get(a) { return this.value + a; }
  }
  export const box = new Box();
`;

async function linkedPair(provider: string, consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6641-"));
  const packageRoot = join(root, "node_modules", "pkg6641");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "pkg6641", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(
    entry,
    `import { api, box } from "pkg6641";\nexport function __probeA() { return typeof api; }\nexport function __probeB() { return typeof box; }\n`,
  );
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "pkg6641")!;
  const apiField = artifact.exportBoundaries!.api!.field;
  const boxField = artifact.exportBoundaries!.box!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${apiField}(): any;\nexport declare function ${boxField}(): any;\n`,
      [consumerEntry]:
        `import { ${apiField}, ${boxField} } from "/__ns_stub";\n` +
        `const api = ${apiField}();\nconst box = ${boxField}();\n${consumer}`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([
        [apiField, { module: artifact.namespace, field: apiField }],
        [boxField, { module: artifact.namespace, field: boxField }],
      ]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

const CONSUMER = `
  // TEETH — all four answered null / threw wrong on the base tree.
  export function computedTwoArgs() { const k = "add"; return api[k](3, 4); }
  export function computedZeroArgs() { const k = "countArgs"; return api[k](); }
  export function computedThreeArgs() { const k = "countArgs"; return api[k](1, 2, 3); }
  export function computedClassMethod() { const k = "get"; return box[k](1); }
  export function computedChained() { const k = "chain"; const k2 = "add"; return api[k]()[k2](5, 6); }
  export function computedNonFunctionThrows() {
    const k = "notAFunction";
    try { api[k](); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
  }
  // CONTROLS — must not move.
  export function literalTwoArgs() { return api.add(3, 4); }
  export function inModuleComputed() {
    const inner = { m(a) { return a * 2; } };
    const k = "m";
    return inner[k](21);
  }
`;

describe("#6641 a computed-key method call on a linked-provider-owned externref receiver", () => {
  it(
    "dispatches through the generic __extern_method_call arm, matching the literal-key twin",
    { timeout: 600_000 },
    async () => {
      const ex = await linkedPair(PROVIDER, CONSUMER);
      // TEETH
      expect(ex.computedTwoArgs()).toBe(7);
      expect(ex.computedZeroArgs()).toBe(0);
      expect(ex.computedThreeArgs()).toBe(3);
      expect(ex.computedClassMethod()).toBe(10);
      expect(ex.computedChained()).toBe(11);
      expect(ex.computedNonFunctionThrows()).toBe(1);
      // CONTROLS
      expect(ex.literalTwoArgs()).toBe(7);
      expect(ex.inModuleComputed()).toBe(42);
    },
  );
});
