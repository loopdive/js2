// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5316 r4 — §10.5 DESCRIPTOR-MODEL post-trap invariants for the standalone
 * Proxy runtime (`src/codegen/object-runtime-proxy-invariants.ts`).
 *
 * Two kinds of assertion:
 *  1. the exact Test262 rows this slice flipped, pinned through the runner so a
 *     regression shows up as the row it actually is;
 *  2. a node-parity probe matrix — for each invariant, the SAME program shape
 *     with a compliant trap answer (must keep working) and a violating one
 *     (must throw a TypeError). The compliant half is the one that matters: a
 *     new throw in a program that worked before is the regression family every
 *     review of this lane has found.
 *
 * Every probe also asserts `result.imports` is `[]` — the invariants must not
 * pull a host import into a standalone module.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262_ROOT = join(REPO_ROOT, "test262");
const TIMEOUT_MS = 180_000;
const RUNNER_TIMEOUT_MS = 120_000;
const TEST262_AVAILABLE = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const test262It = TEST262_AVAILABLE ? it : it.skip;

/** Rows measured `fail` on `origin/main` and `pass` on this branch
 *  (`npx tsx scripts/run-test262-paths.mts --isolate … --standalone`,
 *  2026-09-04). */
const FLIPPED_ROWS = [
  "built-ins/Proxy/getOwnPropertyDescriptor/result-is-undefined-targetdesc-is-not-configurable.js",
  "built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-invalid-descriptor.js",
  "built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-not-configurable-not-writable-targetdesc-is-writable.js",
  "built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-not-configurable-targetdesc-is-undefined.js",
  "built-ins/Proxy/defineProperty/targetdesc-not-compatible-descriptor.js",
  "built-ins/Proxy/defineProperty/targetdesc-not-compatible-descriptor-not-configurable-target.js",
  "built-ins/Proxy/defineProperty/targetdesc-not-configurable-writable-desc-not-writable.js",
  "built-ins/Proxy/defineProperty/targetdesc-configurable-desc-not-configurable.js",
  "built-ins/Proxy/defineProperty/targetdesc-undefined-not-configurable-descriptor.js",
  "built-ins/Proxy/defineProperty/targetdesc-undefined-target-is-not-extensible.js",
  "built-ins/Proxy/deleteProperty/targetdesc-is-not-configurable.js",
  "built-ins/Proxy/deleteProperty/targetdesc-is-configurable-target-is-not-extensible.js",
  "built-ins/Proxy/has/return-false-target-not-extensible.js",
  "built-ins/Proxy/has/return-false-targetdesc-not-configurable.js",
  "built-ins/Proxy/get/accessor-get-is-undefined-throws.js",
  "built-ins/Proxy/get/not-same-value-configurable-false-writable-false-throws.js",
  "built-ins/Proxy/set/target-property-is-accessor-not-configurable-set-is-undefined.js",
  "built-ins/Proxy/set/target-property-is-not-configurable-not-writable-not-equal-to-v.js",
  "built-ins/Proxy/ownKeys/not-extensible-new-keys-throws.js",
  "built-ins/Proxy/ownKeys/not-extensible-missing-keys-throws.js",
  "built-ins/Proxy/ownKeys/return-all-non-configurable-keys.js",
] as const;

/** Rows that already passed on `origin/main` and must not be lost — the
 *  compliant side of the same traps. */
const CONTROL_ROWS = [
  "built-ins/Proxy/getOwnPropertyDescriptor/result-is-undefined-targetdesc-is-undefined.js",
  "built-ins/Proxy/defineProperty/return-is-abrupt.js",
  "built-ins/Proxy/deleteProperty/return-is-abrupt.js",
  "built-ins/Proxy/has/return-true-target-prop-exists.js",
  "built-ins/Proxy/ownKeys/return-is-abrupt.js",
  "built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-return-not-configurable.js",
] as const;

/**
 * One probe per invariant, in two halves. `compliant` must return 0 (the trap
 * answers something the spec permits, so the program keeps working);
 * `violating` must return 0 too — it catches its own TypeError and reports
 * a non-zero code if the throw did NOT happen or was the wrong type.
 */
const PROBES: { name: string; source: string }[] = [
  {
    name: "gopd: plain extensible target, compliant answer keeps working",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 1, configurable: true, writable: true });
      const p: any = new Proxy(target, {
        getOwnPropertyDescriptor(t: any, key: any): any { return Object.getOwnPropertyDescriptor(t, key); },
      });
      const d: any = Object.getOwnPropertyDescriptor(p, "k");
      if (d.value !== 1) return 1;
      if (d.configurable !== true) return 2;
      return 0;
    `,
  },
  {
    name: "gopd: hiding a non-configurable target property throws",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 1, configurable: false });
      const p: any = new Proxy(target, { getOwnPropertyDescriptor(): any { return undefined; } });
      try {
        Object.getOwnPropertyDescriptor(p, "k");
        return 1;
      } catch (e) {
        if (!(e instanceof TypeError)) return 2;
      }
      return 0;
    `,
  },
  {
    name: "gopd: preventExtensions target, absent key answered undefined keeps working",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 1, configurable: true });
      Object.preventExtensions(target);
      const p: any = new Proxy(target, {
        getOwnPropertyDescriptor(t: any, key: any): any { return Object.getOwnPropertyDescriptor(t, key); },
      });
      const d: any = Object.getOwnPropertyDescriptor(p, "missing");
      if (d !== undefined) return 1;
      return 0;
    `,
  },
  {
    name: "defineProperty: compatible redefinition of a configurable property keeps working",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 1, configurable: true, writable: true });
      let calls = 0;
      const p: any = new Proxy(target, {
        defineProperty(t: any, key: any, desc: any): boolean { calls++; Object.defineProperty(t, key, desc); return true; },
      });
      Object.defineProperty(p, "k", { value: 2 });
      if (calls !== 1) return 1;
      if (target.k !== 2) return 2;
      return 0;
    `,
  },
  {
    name: "defineProperty: reporting success over a non-configurable target property throws",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 1, configurable: false, writable: false });
      const p: any = new Proxy(target, { defineProperty(): boolean { return true; } });
      try {
        Object.defineProperty(p, "k", { value: 2 });
        return 1;
      } catch (e) {
        if (!(e instanceof TypeError)) return 2;
      }
      return 0;
    `,
  },
  {
    name: "defineProperty: a FALSY trap result is `false`, not a throw",
    source: `
      const p: any = new Proxy({}, { defineProperty(): boolean { return false; } });
      if (Reflect.defineProperty(p, "k", { value: 1 }) !== false) return 1;
      return 0;
    `,
  },
  {
    name: "has: answering false for a configurable key on an extensible target keeps working",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 1, configurable: true });
      const p: any = new Proxy(target, { has(): boolean { return false; } });
      if (("k" in p) !== false) return 1;
      return 0;
    `,
  },
  {
    name: "has: answering false for a non-configurable key throws",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 1, configurable: false });
      const p: any = new Proxy(target, { has(): boolean { return false; } });
      try {
        if ("k" in p) return 1;
        return 2;
      } catch (e) {
        if (!(e instanceof TypeError)) return 3;
      }
      return 0;
    `,
  },
  {
    name: "get: the pinned value of a frozen data property may be reported unchanged",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 7, configurable: false, writable: false });
      const p: any = new Proxy(target, { get(): number { return 7; } });
      if (p.k !== 7) return 1;
      return 0;
    `,
  },
  {
    name: "get: reporting a different value for a frozen data property throws",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 7, configurable: false, writable: false });
      const p: any = new Proxy(target, { get(): number { return 8; } });
      try {
        if (p.k === 8) return 1;
        return 2;
      } catch (e) {
        if (!(e instanceof TypeError)) return 3;
      }
      return 0;
    `,
  },
  {
    name: "set: accepting a write to a writable property keeps working",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 1, configurable: false, writable: true });
      const p: any = new Proxy(target, { set(t: any, key: any, v: any): boolean { t[key] = v; return true; } });
      p.k = 3;
      if (target.k !== 3) return 1;
      return 0;
    `,
  },
  {
    name: "set: reporting success on a frozen data property throws",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 1, configurable: false, writable: false });
      const p: any = new Proxy(target, { set(): boolean { return true; } });
      try {
        p.k = 2;
        return 1;
      } catch (e) {
        if (!(e instanceof TypeError)) return 2;
      }
      return 0;
    `,
  },
  {
    name: "deleteProperty: deleting a configurable key on an extensible target keeps working",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 1, configurable: true });
      const p: any = new Proxy(target, { deleteProperty(t: any, key: any): boolean { delete t[key]; return true; } });
      if (Reflect.deleteProperty(p, "k") !== true) return 1;
      return 0;
    `,
  },
  {
    name: "deleteProperty: reporting a delete of a non-configurable key throws",
    source: `
      const target: any = {};
      Object.defineProperty(target, "k", { value: 1, configurable: false });
      const p: any = new Proxy(target, { deleteProperty(): boolean { return true; } });
      try {
        Reflect.deleteProperty(p, "k");
        return 1;
      } catch (e) {
        if (!(e instanceof TypeError)) return 2;
      }
      return 0;
    `,
  },
  {
    name: "ownKeys: reporting the target's exact key set keeps working",
    source: `
      const target: any = {};
      Object.defineProperty(target, "a", { value: 1, configurable: false, enumerable: true });
      const p: any = new Proxy(target, { ownKeys(): string[] { return ["a"]; } });
      const keys: any = Object.getOwnPropertyNames(p);
      if (keys.length !== 1) return 1;
      if (keys[0] !== "a") return 2;
      return 0;
    `,
  },
  {
    name: "ownKeys: hiding a non-configurable key throws",
    source: `
      const target: any = {};
      Object.defineProperty(target, "a", { value: 1, configurable: false });
      const p: any = new Proxy(target, { ownKeys(): string[] { return []; } });
      try {
        Object.getOwnPropertyNames(p);
        return 1;
      } catch (e) {
        if (!(e instanceof TypeError)) return 2;
      }
      return 0;
    `,
  },
  {
    name: "proxy-of-proxy target: the inner proxy's own gopd dispatch answers the invariant",
    source: `
      const inner: any = {};
      Object.defineProperty(inner, "k", { value: 1, configurable: false });
      const mid: any = new Proxy(inner, {});
      const p: any = new Proxy(mid, { getOwnPropertyDescriptor(): any { return undefined; } });
      try {
        Object.getOwnPropertyDescriptor(p, "k");
        return 1;
      } catch (e) {
        if (!(e instanceof TypeError)) return 2;
      }
      return 0;
    `,
  },
  {
    name: "a trapless proxy over a frozen target keeps working (no invariant arm runs)",
    source: `
      const target: any = { a: 1 };
      Object.freeze(target);
      const p: any = new Proxy(target, {});
      if (p.a !== 1) return 1;
      if (("a" in p) !== true) return 2;
      return 0;
    `,
  },
];

async function runProbe(source: string, name: string): Promise<number> {
  const result = await compile(`export function test(): number {\n${source}\n}\n`, {
    allowJs: true,
    fileName: "issue-5316-r4-invariants.ts",
    skipSemanticDiagnostics: true,
    target: "standalone" as const,
  });
  expect(
    result.success,
    `${name}: compile failed:\n${result.errors?.map((e) => `L${e.line}: ${e.message}`).join("\n") ?? ""}`,
  ).toBe(true);
  if (!result.success) return -1;
  expect(result.imports, `${name}: a standalone proxy-invariant probe must emit zero imports`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#5316 r4 §10.5 descriptor-model Proxy invariants", () => {
  for (const probe of PROBES) {
    it(`standalone probe — ${probe.name}`, { timeout: TIMEOUT_MS }, async () => {
      expect(await runProbe(probe.source, probe.name)).toBe(0);
    });
  }

  for (const relativePath of [...FLIPPED_ROWS, ...CONTROL_ROWS]) {
    const filePath = join(TEST262_ROOT, "test", relativePath);
    test262It(`standalone Test262 row: ${relativePath}`, { timeout: TIMEOUT_MS }, async () => {
      try {
        const result = await runTest262File(filePath, "issue-5316-standalone", RUNNER_TIMEOUT_MS, "standalone");
        expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
      } finally {
        restoreHostBuiltins();
      }
    });
  }
});
