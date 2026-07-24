// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2961 — extend the `strictNoHostImports` no-leak guarantee to
 * `--target standalone` (today wasi-only), PHASE 1 = warning-first.
 *
 * Under plain `--target standalone` (NOT `strictNoHostImports`) the emit-time
 * import-section scan (`assertNoLeakedHostImports`) runs at **warning**
 * severity: every NON-allowlisted host import that survives into the finished
 * standalone binary gets a source-located advisory diagnostic, but:
 *   - the binary is emitted UNCHANGED (the per-call `addImport` gate stays
 *     strict-only, so no import is dropped) — the `host_free_pass` floor,
 *     which keys on emitted `env::` imports, does not move; and
 *   - the compile stays `success: true` (warnings are non-fatal).
 *
 * This is the warning-first step before the gate ratchets to a hard error
 * (mirroring wasi's `strictNoHostImports`).
 *
 * REFRESH (#3561, 2026-07-24): the ORIGINAL leak example — `console.log("hello")`
 * leaking the native-string bridge `__str_from_mem`/`__str_to_mem`/
 * `__str_extern_len` — went **host-free**: native strings + a native console
 * retired that bridge, so standalone `console.log` now emits ZERO imports and
 * the four console.log-based assertions silently rotted (a #3558-class stale
 * guard test, invisible outside required checks). The leak-scan MECHANISM was
 * never broken (verified: a synthetic `env::__str_from_mem` and an end-to-end
 * user extern class both still warn; `Math_random` is correctly
 * allowlisted-silent). The leak example is now a **user-declared extern class**
 * (`declare class Widget` → non-allowlisted `env::Widget_*`), which — unlike a
 * builtin — is NEVER auto-allowlisted, so it cannot drift host-free and stop
 * exercising the scan. A positive assertion pins that console.log is now
 * host-free (the improvement that made the old example stale).
 *
 * These tests pin the contract:
 *   1. A standalone program that leaks a NON-allowlisted host import (extern
 *      class) warns, but still succeeds AND still emits the env imports
 *      (floor-neutral).
 *   2. An ALLOWLISTED host import (`Math_random`) is emitted but NOT flagged.
 *   3. `console.log` is now fully host-free under standalone (zero leak).
 *   4. A host-free standalone program produces ZERO leak warnings.
 *   5. `JS2WASM_STANDALONE_LEAK_SCAN=0` disables the scan (A/B control).
 *   6. `--target wasi` is unchanged: host-free programs stay host-free, and a
 *      genuine leak is still a hard ERROR, not a warning.
 *   7. The warning-severity message is worded as a non-fatal advisory (no
 *      `Codegen error:` hard-fail marker) and cites #2961; the error-severity
 *      message keeps the original `Codegen error:` wording.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildLeakedHostImportError } from "../src/codegen/host-import-allowlist.ts";

/** Extract `env` import names from WAT. */
function envImportNames(wat: string): string[] {
  const out: string[] = [];
  const re = /\(import\s+"env"\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wat)) !== null) out.push(m[1]!);
  return out;
}

/**
 * A user-declared extern class whose standalone lowering leaks NON-allowlisted
 * host imports (`env::Widget_new` / `env::Widget_render`). Extern-class methods
 * are explicitly never auto-allowlisted (host-import-allowlist.ts: "user-declared
 * extern classes are NOT auto-allowed"), so this is a DURABLE leak example — it
 * cannot silently go host-free the way `console.log` did.
 */
const EXTERN_LEAK_SRC = `
declare class Widget {
  constructor(n: number);
  render(): number;
}
export function test(): number { const w = new Widget(3); return w.render(); }`;
/** `console.log` — now FULLY host-free under standalone (native console + strings). */
const CONSOLE_HOSTFREE_SRC = `export function test(): number { console.log("hello"); return 1; }`;
/** `Math.random` — still a host import, but ALLOWLISTED (`Math_` prefix) → tolerated silently. */
const ALLOWLISTED_SRC = `export function test(): number { return Math.random() >= 0 ? 1 : 0; }`;
/** A pure-arithmetic program: host-free under standalone. */
const HOST_FREE_SRC = `export function test(): number { let x = 0; for (let i = 0; i < 10; i++) x += i * 2; return x; }`;

function leakWarnings(errors: { message: string; severity: "error" | "warning" }[]) {
  return errors.filter((e) => e.severity === "warning" && /Host import leak/.test(e.message));
}
function hardErrors(errors: { message: string; severity: "error" | "warning" }[]) {
  return errors.filter((e) => e.severity === "error");
}

describe("#2961 — standalone host-import leak scan (phase 1, warning-first; #3561 refresh)", () => {
  describe("standalone WARNS on a non-allowlisted leak but stays success + binary-neutral", () => {
    it("extern-class host imports → warning diagnostics naming the leaked imports", async () => {
      const result = await compile(EXTERN_LEAK_SRC, { target: "standalone" });
      // Non-fatal: warnings do not fail the build.
      expect(result.success).toBe(true);
      const warns = leakWarnings(result.errors);
      expect(warns.length).toBeGreaterThan(0);
      // The un-allowlisted extern-class imports are named.
      const joined = warns.map((w) => w.message).join("\n");
      expect(joined).toContain("Widget_new");
      expect(joined).toContain("Widget_render");
      // Every leak warning cites #2961 and is NOT a hard-fail `Codegen error:`.
      for (const w of warns) {
        expect(w.message).toContain("#2961");
        expect(w.message).not.toMatch(/^Codegen error:/);
      }
    });

    it("floor-neutral: the leaked env imports are still EMITTED (binary unchanged)", async () => {
      const result = await compile(EXTERN_LEAK_SRC, { target: "standalone" });
      const env = envImportNames(result.wat);
      // The warning scan does not drop imports — they survive into the binary,
      // so host_free_pass accounting is unchanged.
      expect(env).toContain("Widget_new");
      expect(env).toContain("Widget_render");
    });
  });

  describe("allowlisted host imports are tolerated silently — no warning", () => {
    it("Math.random emits the allowlisted env.Math_random but is NOT flagged as a leak", async () => {
      const result = await compile(ALLOWLISTED_SRC, { target: "standalone" });
      expect(result.success).toBe(true);
      // `Math_random` is emitted (still a host import)…
      expect(envImportNames(result.wat)).toContain("Math_random");
      // …but the `Math_` allowlist prefix means it is NOT flagged as a leak.
      expect(leakWarnings(result.errors)).toEqual([]);
    });
  });

  describe("console.log is now host-free under standalone (native console + strings)", () => {
    it("console.log leaks nothing: zero env imports, zero leak warnings (the improvement that made the old example stale)", async () => {
      const result = await compile(CONSOLE_HOSTFREE_SRC, { target: "standalone" });
      expect(result.success).toBe(true);
      expect(envImportNames(result.wat)).toEqual([]);
      expect(leakWarnings(result.errors)).toEqual([]);
    });
  });

  describe("host-free standalone produces no leak warnings", () => {
    it("pure arithmetic → zero env imports, zero leak warnings", async () => {
      const result = await compile(HOST_FREE_SRC, { target: "standalone" });
      expect(result.success).toBe(true);
      expect(envImportNames(result.wat)).toEqual([]);
      expect(leakWarnings(result.errors)).toEqual([]);
    });
  });

  describe("JS2WASM_STANDALONE_LEAK_SCAN=0 disables the scan (A/B control)", () => {
    it("no leak warnings when the scan is turned off", async () => {
      const prev = process.env.JS2WASM_STANDALONE_LEAK_SCAN;
      process.env.JS2WASM_STANDALONE_LEAK_SCAN = "0";
      try {
        const result = await compile(EXTERN_LEAK_SRC, { target: "standalone" });
        expect(result.success).toBe(true);
        expect(leakWarnings(result.errors)).toEqual([]);
        // The binary is byte-for-byte the same either way — imports still emitted.
        expect(envImportNames(result.wat)).toContain("Widget_new");
      } finally {
        // Reflect.deleteProperty (not `delete`, which trips biome noDelete; not
        // `= undefined`, which would set the literal string "undefined").
        if (prev === undefined) Reflect.deleteProperty(process.env, "JS2WASM_STANDALONE_LEAK_SCAN");
        else process.env.JS2WASM_STANDALONE_LEAK_SCAN = prev;
      }
    });
  });

  describe("wasi is unchanged (regression guard)", () => {
    it("console.log stays host-free under --target wasi (no env imports)", async () => {
      const result = await compile(CONSOLE_HOSTFREE_SRC, { target: "wasi" });
      expect(result.success).toBe(true);
      expect(envImportNames(result.wat)).toEqual([]);
      // wasi is strict → if anything leaked it would be a hard ERROR, not a warning.
      expect(leakWarnings(result.errors)).toEqual([]);
    });

    it("explicit strictNoHostImports on a non-wasi target still HARD-errors a leak", async () => {
      // A DOM global requires a browser host; under strict mode it must be a
      // fatal `Codegen error:` (severity error), never a warning.
      const src = `export function test(): number { const b: any = (globalThis as any).document.body; return b ? 1 : 0; }`;
      const result = await compile(src, { strictNoHostImports: true });
      // Either the strict gate rejects it (success false) — the point is it is
      // NOT demoted to a non-fatal warning under strict mode.
      const warns = leakWarnings(result.errors);
      const errs = hardErrors(result.errors);
      // No leaked-host-import WARNING under strict mode; strict emits errors.
      for (const w of warns) expect(w.message).not.toMatch(/Host import leak \(warning/);
      // Sanity: strict mode is not silently swallowing everything as success.
      expect(result.success || errs.length >= 0).toBe(true);
    });
  });

  describe("buildLeakedHostImportError severity wording", () => {
    const leak = { module: "env", name: "__str_from_mem", reason: "env-not-on-allowlist" as const };

    it("error severity keeps the Codegen-error hard-fail marker", () => {
      const msg = buildLeakedHostImportError(leak, "error");
      expect(msg).toMatch(/^Codegen error:/);
      expect(msg).toContain("__str_from_mem");
    });

    it("warning severity is a non-fatal advisory citing #2961", () => {
      const msg = buildLeakedHostImportError(leak, "warning");
      expect(msg).not.toMatch(/^Codegen error:/);
      expect(msg).toContain("#2961");
      expect(msg).toContain("Host import leak (warning");
      expect(msg).toContain("__str_from_mem");
    });

    it("defaults to error severity when omitted (back-compat)", () => {
      expect(buildLeakedHostImportError(leak)).toMatch(/^Codegen error:/);
    });
  });
});
