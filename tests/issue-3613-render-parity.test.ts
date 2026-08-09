// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3613) LOCAL-vs-CI RENDER PARITY.
//
// The defect this pins
// --------------------
// `runTest262File` (tests/test262-runner.ts — the local in-process runner used
// by the baseline validator and ~40 issue tests) is NOT the CI path. CI runs
// `assembleOriginalHarness` → `CompilerPool(n, "unified")` →
// `scripts/test262-worker.mjs`. The two carried separate copies of the thrown-
// payload renderer, "kept in sync" by a comment — and they drifted: the local
// original-harness path (`originalHarnessThrownText`) never called
// `tryNativeExnRender`, so on the standalone lane EVERY `Test262Error`
// surfaced locally as
//
//     uncaught Wasm-GC exception (non-stringifiable payload)
//
// while CI reported the real assertion message.
//
// Why that is a harness defect and not cosmetics
//   • Triage done against the local runner sees one giant undifferentiated
//     bucket where CI sees distinct failures — message-derived cluster labels
//     become meaningless exactly where they are needed most.
//   • `originalNegativeMatches` decides a runtime-negative verdict by
//     searching the detail for `meta.negative.type`. The opaque label contains
//     no type name, so a standalone runtime-negative test that threw the RIGHT
//     error was scored `fail` locally and `pass` in CI — a VERDICT divergence,
//     not just a message one. That divergence is measured below.
//
// This is the same family as a vacuous pass: the machinery misreporting what
// actually happened. The structural remedy is one implementation
// (`scripts/lib/wasm-exn-render.mjs`) plus this test, rather than two
// implementations kept in sync by discipline.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { renderHarnessThrownText, tryNativeExnRender } from "../scripts/lib/wasm-exn-render.mjs";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { extractWasmExceptionMessage, runTest262File } from "./test262-runner.js";

const HARNESS_AVAILABLE = existsSync(join(__dirname, "..", "test262", "harness", "assert.js"));
if (!HARNESS_AVAILABLE && process.env.CI) {
  throw new Error("#3613: test262 harness inputs missing under CI — this file must not silently skip.");
}

// A standalone module whose `test()` throws a real in-module TypeError. The
// thrown value is a WasmGC struct with no host-reachable `.name`/`.message`,
// which is precisely the payload shape the two renderers disagreed on.
const THROWING_MODULE = `
export function test(): number {
  throw new TypeError("PARITY-MARKER-42");
}
`;

async function instantiateStandalone() {
  const r = await compile(THROWING_MODULE, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance;
}

describe("#3613 both lanes render the SAME thrown payload identically", () => {
  it("the standalone payload is host-opaque (the precondition that made the lanes diverge)", async () => {
    const instance = await instantiateStandalone();
    let caught: unknown;
    try {
      (instance.exports as { test: () => number }).test();
    } catch (e) {
      caught = e;
    }
    expect(caught, "the module must throw").toBeDefined();
    expect(caught).toBeInstanceOf(WebAssembly.Exception);

    const tag = (instance.exports as Record<string, unknown>).__exn_tag ?? (instance.exports as any).__tag;
    expect(tag, "standalone binaries export an exception tag").toBeTruthy();
    const payload = (caught as WebAssembly.Exception).getArg(tag as WebAssembly.Tag, 0) as any;
    // No host-readable `.name` — so the `${name}: ${message}` shortcut cannot
    // fire and the native render is the ONLY way to recover the real text.
    expect(typeof payload).toBe("object");
    expect(typeof payload?.name).not.toBe("string");
  });

  it("renderHarnessThrownText (local original-harness path) recovers the real message, not the opaque label", async () => {
    const instance = await instantiateStandalone();
    let caught: unknown;
    try {
      (instance.exports as { test: () => number }).test();
    } catch (e) {
      caught = e;
    }
    const rendered = renderHarnessThrownText(caught, instance);
    expect(rendered).toContain("PARITY-MARKER-42");
    // The error TYPE must survive too — `originalNegativeMatches` needs it.
    expect(rendered).toContain("TypeError");
    expect(rendered).not.toContain("non-stringifiable payload");
  });

  it("agrees with extractWasmExceptionMessage (the CI worker's renderer) on the same payload", async () => {
    const instance = await instantiateStandalone();
    let caught: unknown;
    try {
      (instance.exports as { test: () => number }).test();
    } catch (e) {
      caught = e;
    }
    const localPath = renderHarnessThrownText(caught, instance);
    const workerPath = extractWasmExceptionMessage(caught, instance);
    // Same thrown value ⇒ same reported message. This single assertion is what
    // would have caught the drift.
    expect(localPath).toBe(workerPath);
  });

  it("the native renderer is the mechanism (removing it reproduces the opaque label)", async () => {
    const instance = await instantiateStandalone();
    let caught: unknown;
    try {
      (instance.exports as { test: () => number }).test();
    } catch (e) {
      caught = e;
    }
    const tag = (instance.exports as any).__exn_tag ?? (instance.exports as any).__tag;
    const payload = (caught as WebAssembly.Exception).getArg(tag, 0);
    // POSITIVE CONTROL: the renderer produces non-empty output on this payload…
    expect(tryNativeExnRender(instance, payload)).toContain("PARITY-MARKER-42");
    // …and NEGATIVE CONTROL: with the exports hidden it returns null, which is
    // exactly the state the local lane was permanently in.
    expect(tryNativeExnRender({ exports: {} }, payload)).toBeNull();
  });

  it("host-lane behaviour is unchanged: a host Error still renders `Name: message`", () => {
    // The name prefix is load-bearing for runtime-negative matching. Pin it so
    // a future "simplification" cannot drop it.
    expect(renderHarnessThrownText(new TypeError("boom"))).toBe("TypeError: boom");
    expect(renderHarnessThrownText("plain string")).toBe("plain string");
  });
});

const runIf = HARNESS_AVAILABLE ? describe : describe.skip;

runIf("#3613 the divergence was a VERDICT divergence, not just a message one", () => {
  it("a standalone runtime-negative test whose expected error IS thrown scores pass", async () => {
    // Before the shared renderer, the detail read "uncaught Wasm-GC exception
    // (non-stringifiable payload)", which contains no "TypeError", so
    // `originalNegativeMatches` returned false and the local runner scored
    // `fail` where CI scored `pass`.
    const dir = mkdtempSync(join(tmpdir(), "render-parity-"));
    const file = join(dir, "runtime-negative.js");
    writeFileSync(
      file,
      `/*---\ndescription: "#3613 standalone runtime negative"\nnegative:\n  phase: runtime\n  type: TypeError\n---*/\nthrow new TypeError("expected");\n`,
    );
    try {
      const r = await runTest262File(file, "render-parity", 30_000, "standalone");
      expect(r.status, r.error).toBe("pass");
    } finally {
      restoreHostBuiltins();
    }
  }, 90_000);

  it("a standalone assertion failure reports its real message, not the opaque label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "render-parity-"));
    const file = join(dir, "assert-fail.js");
    writeFileSync(file, `/*---\ndescription: "#3613 standalone assertion failure"\n---*/\nassert.sameValue(1, 2);\n`);
    try {
      const r = await runTest262File(file, "render-parity", 30_000, "standalone");
      expect(r.status).toBe("fail");
      expect(r.error ?? "").toContain("SameValue");
      expect(r.error ?? "").not.toContain("non-stringifiable payload");
    } finally {
      restoreHostBuiltins();
    }
  }, 90_000);
});
