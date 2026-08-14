// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157, park 6) The standalone module a devirtualized method call emits must
 * VALIDATE under the tuned defaults.
 *
 * Regression guard for the merge-group failure that parked PR #4455: 36
 * standalone test262 regressions (33 `wasm_compile`), net −30 pass against a
 * −15 tolerance, every one of them wasm-hash-changed, and all in the
 * `cpn-class-decl-*` / `cpn-class-expr-*` computed-property-name family.
 *
 * The shape: a module-level class instance whose method call is devirtualized
 * to a 0-parameter direct call, so the receiver `global.get $__mod_c` — a
 * `(ref null $C)` GC struct in standalone, an `externref` under a JS host,
 * which is why this is standalone-only — sits several instructions away from
 * the consumer that actually needs it as an `externref`. Both late repairs
 * that supply the `extern.convert_any` mis-attributed the value once the
 * #4157 tuned set widened that window (`smi-box-fast-path.ts` inserts an
 * `if`, `ir-inline.ts` a `block`): the backward walk in
 * `fixCallArgTypesInBody` stops at control flow, and `fixLocalSetCoercion`
 * only ever looked at `body[i - 1]`.
 *
 * Both consumer shapes are pinned because the two failed differently:
 * `call[0] expected type externref, found global.get of type (ref null N)`
 * and its `local.set[0]` twin.
 *
 * These sources compile clean on the legacy `=0`-everything emission, so a
 * failure here is a tuned-set defect, never a missing feature.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Exactly the sharded standalone lane's single-file compile options. */
async function compileStandalone(source: string): Promise<Uint8Array> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "test.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors?.[0]?.message ?? "compile failed").toBe(true);
  return result.binary as Uint8Array;
}

/** V8's own message, so a failure names the offending operand slot. */
async function expectValidWasm(binary: Uint8Array): Promise<void> {
  if (WebAssembly.validate(binary)) return;
  await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
}

const CALL_OPERAND = `
function assert(mustBeTrue, message) {
  if (mustBeTrue === true) {
  }
}
class C {
  [1 + 1]() {
    return 2;
  }
  static [1 + 1]() {
    return 2;
  }
};

let c = new C();

assert.sameValue(
  c[1 + 1](),
  2
);
assert.sameValue(
  c[String(1 + 1)](),
  2
);
`;

const LOCAL_SET_OPERAND = `
function assert(mustBeTrue, message) {
  if (mustBeTrue === true) {
  }
}
class C {
  [1 + 1]() {
    return 2;
  }
  static [1 + 1]() {
  }
};

let c = new C();

assert.sameValue(
  c[String(1 + 1)](),
  2
);
`;

describe("#4157 park 6 — cross-hierarchy operand repair (standalone)", () => {
  it("validates when the receiver feeds a CALL operand slot", async () => {
    await expectValidWasm(await compileStandalone(CALL_OPERAND));
  });

  it("validates when the receiver feeds a local.set operand slot", async () => {
    await expectValidWasm(await compileStandalone(LOCAL_SET_OPERAND));
  });
});
