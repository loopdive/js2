// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1918 — Stack-balance strict mode + fixup telemetry.
 *
 * The stack-balance pass repairs the emitter's own output; every repair is a
 * masked codegen bug, and some are lossy (a missing branch value patched with
 * a const default ships a silently-wrong runtime value). Historically the
 * fixup count was computed and discarded. This change:
 *
 *   - threads each fixup out as a located `FixupEvent` (`getFixupEvents`),
 *   - aggregates them by kind (`summarizeFixups`),
 *   - exposes a strict mode (`JS2WASM_STRICT_BALANCE`) that promotes each
 *     fixup to a compiler warning (=1) or a hard error (=error).
 *
 * The corpus ratchet (`scripts/check-stack-balance.ts` + baseline JSON, wired
 * into ci.yml's quality job) is exercised separately by CI; here we test the
 * instrumentation and strict-mode plumbing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { getFixupEvents, stackBalance, summarizeFixups } from "../src/codegen/stack-balance.js";
import type { WasmModule } from "../src/ir/types.js";

function emptyModule(): WasmModule {
  return {
    types: [],
    imports: [],
    functions: [],
    globals: [],
    exports: [],
    memories: [],
    tables: [],
    elements: [],
    dataSegments: [],
    tags: [],
  } as unknown as WasmModule;
}

/** A module whose only function has an i32-typed block with an empty body —
 *  the LOSSY arm: stack-balance fills the missing value with `i32.const 0`. */
function moduleWithLossyDefault(): WasmModule {
  const mod = emptyModule();
  mod.types.push({ kind: "func", name: "$f", params: [], results: [{ kind: "i32" }] });
  mod.functions.push({
    name: "victim",
    typeIdx: 0,
    locals: [],
    body: [{ op: "block", blockType: { kind: "val", type: { kind: "i32" } }, body: [] }],
    exported: false,
  } as never);
  return mod;
}

describe("#1918 stack-balance fixup telemetry", () => {
  afterEach(() => {
    // Reflect.deleteProperty (not `delete`) avoids biome's noDelete rule, and
    // (not `= undefined`) genuinely unsets rather than stringifying to the
    // truthy "undefined". See tests/issue-1231.test.ts.
    Reflect.deleteProperty(process.env, "JS2WASM_STRICT_BALANCE");
    Reflect.deleteProperty(process.env, "JS2WASM_LOG_STACK_BALANCE");
  });

  it("records a located FixupEvent for a lossy const-default repair", () => {
    const mod = moduleWithLossyDefault();
    stackBalance(mod);
    const events = getFixupEvents();
    const lossy = events.find((e) => e.kind === "default-value-lossy");
    expect(lossy, `expected a default-value-lossy event, got: ${JSON.stringify(events)}`).toBeTruthy();
    expect(lossy!.lossy).toBe(true);
    expect(lossy!.func).toBe("victim");
    expect(lossy!.detail).toMatch(/i32\.const 0/);
  });

  it("getFixupEvents resets per stackBalance run", () => {
    stackBalance(moduleWithLossyDefault());
    expect(getFixupEvents().length).toBeGreaterThan(0);
    // A clean module produces no fixups; the collector must be reset.
    stackBalance(emptyModule());
    expect(getFixupEvents()).toEqual([]);
  });

  it("summarizeFixups always reports every kind, zero-filled", () => {
    const summary = summarizeFixups([]);
    expect(Object.keys(summary).sort()).toEqual(
      [
        "branch-type-cast",
        "branch-type-coerce",
        "call-arg-coerce",
        "default-value-lossy",
        "drop-excess",
        "local-set-coerce",
        "struct-field-coerce",
      ].sort(),
    );
    for (const v of Object.values(summary)) expect(v).toBe(0);
  });

  it("summarizeFixups counts events by kind", () => {
    stackBalance(moduleWithLossyDefault());
    const summary = summarizeFixups(getFixupEvents());
    expect(summary["default-value-lossy"]).toBeGreaterThan(0);
  });

  // ── End-to-end strict-mode behaviour through the public compile API ──

  // A small program with branchy control flow that lowers to runtime helpers
  // which currently rely on stack-balance fixups (e.g. __vec_len). This is a
  // deliberately conservative check: we only assert relative behaviour across
  // the three modes, not an absolute fixup count.
  const SOURCE = `
    export function classify(x: number): number {
      let r: number;
      if (x > 0) { r = 1; } else if (x < 0) { r = -1; } else { r = 0; }
      return r;
    }
  `;

  it("default mode is silent — no warnings/errors from stack-balance", async () => {
    const r = await compile(SOURCE, { fileName: "issue-1918.ts" });
    expect(r.success).toBe(true);
    expect(r.errors.filter((e) => /Stack-balance fixup/.test(e.message))).toEqual([]);
  });

  it("JS2WASM_STRICT_BALANCE=1 surfaces fixups as warnings without failing the compile", async () => {
    process.env.JS2WASM_STRICT_BALANCE = "1";
    const r = await compile(SOURCE, { fileName: "issue-1918.ts" });
    const warnings = r.errors.filter((e) => /Stack-balance fixup/.test(e.message));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((e) => e.severity === "warning")).toBe(true);
    // Warnings must not fail the compile.
    expect(r.success).toBe(true);
  });

  it("JS2WASM_STRICT_BALANCE=error fails the compile with error-severity diagnostics", async () => {
    process.env.JS2WASM_STRICT_BALANCE = "error";
    const r = await compile(SOURCE, { fileName: "issue-1918.ts" });
    const errs = r.errors.filter((e) => /Stack-balance fixup/.test(e.message));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((e) => e.severity === "error")).toBe(true);
    // Error-severity stack-balance diagnostics carry the "Codegen error:" prefix
    // so the compiler's success gate fails the compile.
    expect(errs.every((e) => e.message.startsWith("Codegen error:"))).toBe(true);
    expect(r.success).toBe(false);
  });
});
