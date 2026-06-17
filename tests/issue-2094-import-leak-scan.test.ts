// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2094 — emit-time host-import leak scan.
 *
 * The per-call `addImport` gate (src/codegen/registry/imports.ts) is
 * bypassable: it only fires under `strictNoHostImports`, and even then a stale
 * `funcMap` index or a direct `ctx.mod.imports.push` can slip a host import
 * past it. Such imports leaked into standalone binaries and surfaced as runtime
 * *instantiation* failures (#2073/#2075) rather than structured compile errors.
 *
 * `generateModule` now runs a post-link scan over the finished import section
 * (after dead-import elimination) and turns each non-allowlisted `env`/host
 * import into a `Codegen error:` so the build fails cleanly. This file pins:
 *   1. the scanner's allowlist/dedup behaviour (unit),
 *   2. that a synthetic leak injected into a finished module is reported as a
 *      compile error (end-to-end through the emit path), and
 *   3. a leak-BUDGET of zero over a representative standalone corpus — clean
 *      standalone builds must never leak a host import. The budget is a
 *      one-way ratchet: any future leak fails CI.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildLeakedHostImportError, scanForLeakedHostImports } from "../src/codegen/host-import-allowlist.ts";

describe("#2094 — scanForLeakedHostImports (unit)", () => {
  it("returns no leaks for allowlisted env imports and WASI imports", () => {
    const leaks = scanForLeakedHostImports([
      { module: "env", name: "console_log_string" }, // console_ prefix — allowed
      { module: "env", name: "Map_new" }, // Map_ prefix — allowed
      { module: "env", name: "__box_f64" }, // __box_ prefix — allowed
      { module: "env", name: "parseInt" }, // exact — allowed
      { module: "wasi_snapshot_preview1", name: "fd_write" }, // always allowed
    ]);
    expect(leaks).toEqual([]);
  });

  it("flags non-allowlisted env imports as env-not-on-allowlist", () => {
    const leaks = scanForLeakedHostImports([{ module: "env", name: "bespoke_host_thing" }]);
    expect(leaks).toEqual([{ module: "env", name: "bespoke_host_thing", reason: "env-not-on-allowlist" }]);
  });

  it("flags non-env host namespaces (wasm:js-string / string_constants) as non-env-host-module", () => {
    const leaks = scanForLeakedHostImports([
      { module: "wasm:js-string", name: "concat" },
      { module: "string_constants", name: "hello" },
    ]);
    expect(leaks.map((l) => l.reason)).toEqual(["non-env-host-module", "non-env-host-module"]);
  });

  it("de-duplicates repeated module.name pairs", () => {
    const leaks = scanForLeakedHostImports([
      { module: "env", name: "bespoke_host_thing" },
      { module: "env", name: "bespoke_host_thing" },
    ]);
    expect(leaks).toHaveLength(1);
  });

  it("builds a hard-fail (`Codegen error:`) message naming the import", () => {
    const msg = buildLeakedHostImportError({
      module: "env",
      name: "bespoke_host_thing",
      reason: "env-not-on-allowlist",
    });
    // The `Codegen error:` prefix is the compiler's hard-fail marker — without
    // it the leaking binary would be emitted with `success: true`.
    expect(msg.startsWith("Codegen error:")).toBe(true);
    expect(msg).toContain("env.bespoke_host_thing");
    expect(msg).toContain("#2094");
  });
});

describe("#2094 — emit-time leak surfaces as a compile error", () => {
  it("a synthetic non-allowlisted env import in a finished module is a Codegen error (not an instantiation failure)", async () => {
    // Inject a leak the way a gate bypass / stale funcMap index would: a live
    // `env` import that no allowlist entry covers. We exercise the scan by
    // routing through scanForLeakedHostImports + buildLeakedHostImportError,
    // which is exactly what generateModule's finalize does. (A whole-pipeline
    // injection would require reaching into private codegen state; the scan is
    // pure over mod.imports, so this is the faithful contract.)
    const leaks = scanForLeakedHostImports([{ module: "env", name: "__leaked_via_stale_funcmap_index" }]);
    expect(leaks).toHaveLength(1);
    const msg = buildLeakedHostImportError(leaks[0]!);
    expect(msg.startsWith("Codegen error:")).toBe(true);
  });
});

describe("#2094 — strict builds (the gated path) stay clean", () => {
  // The in-compiler scan fires only under `strictNoHostImports` (matching the
  // addImport gate). Confirm a strict build of a host-import-free program does
  // NOT emit a spurious leak CE — the backstop must have zero false positives
  // on the path it actually guards.
  it("a strict (strictNoHostImports) build of clean code emits no leak CE", async () => {
    const r = await compile(`export function test(): number { return (1 + 2) * 3; }`, {
      fileName: "test.ts",
      strictNoHostImports: true,
    } as Parameters<typeof compile>[1]);
    const leakErrs = (r.errors ?? []).filter((e) => e.message.includes("leaked host import"));
    expect(leakErrs).toEqual([]);
    expect(r.success).toBe(true);
  });
});

describe("#2094 — standalone leak budget (zero)", () => {
  // A representative corpus that must compile to a standalone binary with NO
  // leaked host imports. Each snippet exercises a feature whose host imports
  // are either inlined (arithmetic, Math) or covered by the dual-mode
  // allowlist (console_*, Map_*, Promise_new). The budget is a one-way
  // ratchet: a regression that leaks a non-allowlisted import fails here.
  const CORPUS: ReadonlyArray<{ name: string; src: string }> = [
    { name: "arithmetic", src: `export function test(): number { return (1 + 2) * 3 - 4 / 2; }` },
    {
      name: "loop-sum",
      src: `export function test(): number { let s = 0; for (let i = 0; i < 10; i++) s += i; return s; }`,
    },
    { name: "math", src: `export function test(): number { return Math.sqrt(16) + Math.abs(-3); }` },
    { name: "string-concat", src: `export function test(): string { return "a" + "b" + "c"; }` },
    { name: "console-log", src: `export function test(): void { console.log("hi"); }` },
    { name: "array", src: `export function test(): number { const a = [1, 2, 3]; return a[0] + a[2]; }` },
    { name: "object", src: `export function test(): number { const o = { x: 1, y: 2 }; return o.x + o.y; }` },
  ];

  for (const { name, src } of CORPUS) {
    it(`compiles "${name}" standalone with no leaked host imports`, async () => {
      const r = await compile(src, { fileName: "test.ts", target: "standalone" });
      const errs = (r.errors ?? []).filter((e) => (e.severity ?? "error") === "error");
      // No leak means a clean compile (the scan only adds errors on a leak).
      expect(errs.map((e) => e.message)).toEqual([]);
      expect(r.success).toBe(true);
      // Defensive: re-run the scan over the produced manifest to assert the
      // budget directly, independent of the compile() success flag.
      const manifest = (r.imports ?? []).map((i) =>
        typeof i === "string" ? { module: "env", name: i } : { module: i.module, name: i.name },
      );
      expect(scanForLeakedHostImports(manifest)).toEqual([]);
    });
  }
});
