// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5316 r6 — an accessor define on an EXISTING key of a NON-EXTENSIBLE carrier
 * must not throw.
 *
 * PR-1 of wave 5 (#5688, main `2269b94bec`) taught `__integrity_bag` the #4194
 * instance carrier, so `Object.preventExtensions(objectLiteral)` began actually
 * RECORDING `OBJ_FLAG_NONEXTENSIBLE` where it used to be a silent no-op. That
 * made `__defineProperty_accessor`'s §10.1.6.3 step 2 arm reachable for these
 * receivers — and that arm decides "new key" from `__obj_find` on the bag, which
 * cannot see an own DATA property that lives as a physical STRUCT FIELD of the
 * receiver. Two Test262 rows regressed on `main`
 * (`__defineGetter__`/`__defineSetter__` `define-non-extensible.js`): the test
 * defines a getter over an EXISTING key of a non-extensible object, which must
 * succeed, and only the NEW-key half may throw.
 *
 * The fix consults `__hasOwnProperty` — own-only, and complete for these
 * receivers (closed-struct field ladder + carrier bag) — on the RECEIVER before
 * refusing. `__desc_has_own` is deliberately not used: its §7.3.12 tail walks
 * the prototype chain, which would stop the throw for an INHERITED name
 * (`toString`), a case this file pins.
 *
 * Expectations are node-parity except where noted; every standalone probe also
 * asserts `result.imports` is `[]`.
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

/** The two rows this fix regains: `fail` on main `2269b94bec`, `pass` here. */
const REGAINED_ROWS = [
  "built-ins/Object/prototype/__defineGetter__/define-non-extensible.js",
  "built-ins/Object/prototype/__defineSetter__/define-non-extensible.js",
] as const;

/**
 * `pass` in the standalone baseline promoted 2026-09-06 20:25 UTC from main
 * `2269b94bec` — the siblings of the two regained rows, including
 * `define-non-configurable` (the throwing half of the same arm).
 */
const CONTROL_ROWS = [
  "built-ins/Object/prototype/__defineGetter__/define-existing.js",
  "built-ins/Object/prototype/__defineGetter__/define-new.js",
  "built-ins/Object/prototype/__defineGetter__/define-non-configurable.js",
  "built-ins/Object/prototype/__defineSetter__/define-existing.js",
  "built-ins/Object/prototype/__defineSetter__/define-new.js",
  "built-ins/Object/prototype/__defineSetter__/define-non-configurable.js",
] as const;

/**
 * Each probe returns a NUMBER; `1` is the intended answer everywhere except the
 * two sealed/frozen probes, which return `7` to say "it threw". The shapes are
 * the r6 diagnostic probes (`v*`/`w*`) verbatim.
 */
const PROBES: { name: string; source: string; expect: number }[] = [
  {
    name: "v1 __defineGetter__ over an existing key of a non-extensible literal",
    expect: 1,
    source: `
      const noop: any = function (): any { return 0; };
      const s: any = Object.preventExtensions({ existing: null });
      try { s.__defineGetter__("existing", noop); return 1; } catch (e) { return 7; }
    `,
  },
  {
    name: "v6 __defineSetter__ over the same existing key",
    expect: 1,
    source: `
      const noop: any = function (v: any): any { return 0; };
      const s: any = Object.preventExtensions({ existing: null });
      try { s.__defineSetter__("existing", noop); return 1; } catch (e) { return 7; }
    `,
  },
  {
    name: "v3 a genuinely NEW key on the same object still throws",
    expect: 1,
    source: `
      const noop: any = function (): any { return 0; };
      const s: any = Object.preventExtensions({ existing: null });
      try { s.__defineGetter__("brand new", noop); return 8; } catch (e) { return 1; }
    `,
  },
  {
    name: "w5 an INHERITED name is not an own key — still throws",
    expect: 1,
    source: `
      const noop: any = function (): any { return 0; };
      const s: any = Object.preventExtensions({ existing: null });
      try { s.__defineGetter__("toString", noop); return 8; } catch (e) { return 1; }
    `,
  },
  {
    name: "v4 Object.defineProperty accessor over the existing key",
    expect: 1,
    source: `
      const noop: any = function (): any { return 0; };
      const s: any = Object.preventExtensions({ existing: null });
      try { Object.defineProperty(s, "existing", { get: noop, configurable: true }); return 1; } catch (e) { return 7; }
    `,
  },
  {
    name: "w6 a set-only descriptor over the existing key",
    expect: 1,
    source: `
      const noop: any = function (v: any): any { return 0; };
      const s: any = Object.preventExtensions({ existing: null });
      try { Object.defineProperty(s, "existing", { set: noop, configurable: true }); return 1; } catch (e) { return 7; }
    `,
  },
  {
    name: "v8 a class instance whose field the constructor assigned",
    expect: 1,
    source: `
      const noop: any = function (): any { return 0; };
      class C { existing: any; constructor() { this.existing = null; } }
      const s: any = Object.preventExtensions(new C());
      try { s.__defineGetter__("existing", noop); return 1; } catch (e) { return 7; }
    `,
  },
  {
    name: "va preventExtensions as a separate statement",
    expect: 1,
    source: `
      const noop: any = function (): any { return 0; };
      const s: any = { existing: null };
      Object.preventExtensions(s);
      try { s.__defineGetter__("existing", noop); return 1; } catch (e) { return 7; }
    `,
  },
  {
    name: "ve the existing key was ADDED after creation",
    expect: 1,
    source: `
      const noop: any = function (): any { return 0; };
      const s: any = {};
      s.existing = null;
      Object.preventExtensions(s);
      try { s.__defineGetter__("existing", noop); return 1; } catch (e) { return 7; }
    `,
  },
  {
    name: "w9 a dynamic $Object receiver with a dynamically added key",
    expect: 1,
    source: `
      const noop: any = function (): any { return 0; };
      const s: any = {};
      s.dyn = 1;
      Object.preventExtensions(s);
      try { s.__defineGetter__("dyn", noop); return 1; } catch (e) { return 7; }
    `,
  },
  {
    name: "wa an empty $Object receiver still refuses a new key",
    expect: 1,
    source: `
      const noop: any = function (): any { return 0; };
      const s: any = {};
      Object.preventExtensions(s);
      try { s.__defineGetter__("nope", noop); return 8; } catch (e) { return 1; }
    `,
  },
  {
    name: "w1 a SEALED carrier makes the existing property non-configurable — throws",
    expect: 7,
    source: `
      const noop: any = function (): any { return 0; };
      const s: any = Object.seal({ existing: null });
      try { s.__defineGetter__("existing", noop); return 1; } catch (e) { return 7; }
    `,
  },
  {
    name: "w2 a FROZEN carrier likewise — throws",
    expect: 7,
    source: `
      const noop: any = function (): any { return 0; };
      const s: any = Object.freeze({ existing: null });
      try { s.__defineGetter__("existing", noop); return 1; } catch (e) { return 7; }
    `,
  },
  {
    name: "vb a DATA define over the existing key is untouched",
    expect: 1,
    source: `
      const s: any = Object.preventExtensions({ existing: null });
      try { Object.defineProperty(s, "existing", { value: 2 }); return s.existing === 2 ? 1 : 3; } catch (e) { return 7; }
    `,
  },
  {
    name: "w3 a DATA define over a FROZEN existing key still throws",
    expect: 7,
    source: `
      const s: any = Object.freeze({ existing: null });
      try { Object.defineProperty(s, "existing", { value: 2 }); return s.existing === 2 ? 1 : 3; } catch (e) { return 7; }
    `,
  },
  {
    name: "w4 a DATA define over a SEALED (still writable) existing key succeeds",
    expect: 1,
    source: `
      const s: any = Object.seal({ existing: 1 });
      try { Object.defineProperty(s, "existing", { value: 2 }); return s.existing === 2 ? 1 : 3; } catch (e) { return 7; }
    `,
  },
  {
    name: "vg the installed getter is the one that answers the later read",
    expect: 9,
    source: `
      var s = Object.preventExtensions({ existing: null });
      try {
        Object.defineProperty(s, "existing", { get: function () { return 9; }, configurable: true });
        return s.existing;
      } catch (e) { return 7; }
    `,
  },
];

/**
 * (RESIDUAL, not a target of this fix.) `Reflect.defineProperty` over the
 * existing key answered `null` before PR-1, TRAPPED on `main`, and answers
 * `null` again here — the trap is removed, the silent no-op is the pre-existing
 * #5316 gap. Node answers `5`. Pinned at the value MEASURED here so the residual
 * is visible rather than forgotten; raise it to node parity in a follow-up.
 */
const RESIDUAL_PROBES: { name: string; source: string; expect: number | null }[] = [
  {
    name: "vd Reflect.defineProperty accessor over the existing key (node: 5)",
    expect: null,
    source: `
      const s: any = Object.preventExtensions({ existing: null });
      const r: any = Reflect.defineProperty(s, "existing", { get: function (): any { return 5; } });
      return r ? s.existing : 7;
    `,
  },
];

async function runProbe(source: string, name: string): Promise<unknown> {
  const result = await compile(`export function test(): any {\n${source}\n}\n`, {
    allowJs: true,
    fileName: "issue-5316-r6-nonextensible-existing-key-accessor.ts",
    skipSemanticDiagnostics: true,
    target: "standalone" as const,
  });
  expect(
    result.success,
    `${name}: compile failed:\n${result.errors?.map((e) => `L${e.line}: ${e.message}`).join("\n") ?? ""}`,
  ).toBe(true);
  if (!result.success) return -1;
  expect(result.imports, `${name}: a standalone define probe must emit zero imports`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#5316 r6 accessor define on an existing key of a non-extensible carrier", () => {
  for (const probe of PROBES) {
    it(`standalone probe — ${probe.name}`, { timeout: TIMEOUT_MS }, async () => {
      expect(await runProbe(probe.source, probe.name)).toBe(probe.expect);
    });
  }

  for (const probe of RESIDUAL_PROBES) {
    it(`standalone residual — ${probe.name}`, { timeout: TIMEOUT_MS }, async () => {
      expect(await runProbe(probe.source, probe.name)).toBe(probe.expect);
    });
  }

  for (const relativePath of [...REGAINED_ROWS, ...CONTROL_ROWS]) {
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
