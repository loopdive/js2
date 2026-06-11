// #2039 slice 2 — native-string helper double-shift between the two shift
// regimes (`__str_flatten` sub-bucket, ~165 standalone invalid-Wasm tests).
//
// The native-string helpers bake sibling-call funcIdx values at emission and
// record `nativeStrHelperImportBase`; `reconcileNativeStrFinalizeShift` later
// repairs them by `numImportFuncs - base` for imports added since. But the
// late-import flush (`shiftLateImportIndices`) ALSO repairs the helper map and
// bodies when an `ensureLateImport` batch lands — and did not advance `base`.
// The next reconcile then re-applied the same delta: `__str_flatten`'s internal
// `call __str_copy_tree` ended one slot high (calling itself), failing
// validation with `call[0] expected (ref null N), found i32.const`.
//
// Fix: every shift pass that repairs the helpers re-bases
// `nativeStrHelperImportBase` (shiftLateImportIndices and addStringImports'
// inline shift now match the re-base addUnionImports has done since
// #1677-fast-path), and ensureNativeStringHelpers settles any pending batch
// before baking (same #2039 guard as ensureObjectRuntime).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

async function compilesValidWasm(source: string, target?: "standalone" | "wasi"): Promise<true> {
  const result = await compile(source, { fileName: "test.ts", target, skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  // Throws if the module fails Wasm validation — this is the assertion.
  await WebAssembly.compile(result.binary);
  return true;
}

// Distilled from language/statements/class/elements/
// set-access-of-missing-private-setter.js: the private-accessor TypeError path
// requests late imports after the string helpers were emitted, and the
// assert.throws harness wrapper exercises the flush + reconcile interleaving.
const PRIVATE_SETTER_TYPEERROR = `
class C {
  get #f() { throw new Test262Error(); }
  setAccess() { this.#f = 'Test262'; }
}
let c = new C();
assert.throws(TypeError, function() { c.setAccess(); }, 'msg');
`;

describe("#2039 slice 2: native-string helper shift-regime double-shift", () => {
  it("standalone: late-import flush + finalize reconcile do not double-shift __str_flatten", async () => {
    const meta = parseMeta(PRIVATE_SETTER_TYPEERROR);
    const { source: wrapped } = wrapTest(PRIVATE_SETTER_TYPEERROR, meta);
    expect(await compilesValidWasm(wrapped, "standalone")).toBe(true);
  });

  it("wasi: same wrapped source stays valid (shared native-strings path)", async () => {
    const meta = parseMeta(PRIVATE_SETTER_TYPEERROR);
    const { source: wrapped } = wrapTest(PRIVATE_SETTER_TYPEERROR, meta);
    expect(await compilesValidWasm(wrapped, "wasi")).toBe(true);
  });

  it("host-mode guard: the same wrapped source stays valid on the default path", async () => {
    // base stays -1 on the default GC path, so the re-base is a hard no-op
    // there (#618 hazard); this pins that.
    const meta = parseMeta(PRIVATE_SETTER_TYPEERROR);
    const { source: wrapped } = wrapTest(PRIVATE_SETTER_TYPEERROR, meta);
    expect(await compilesValidWasm(wrapped)).toBe(true);
  });
});
