// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3488, slice a) `%TypedArray%.prototype` accessor getters extracted
// reflectively via `Object.getOwnPropertyDescriptor(proto, name).get` and
// invoked as a BARE function (`getter()`, i.e. an undefined `this`) must throw a
// CATCHABLE TypeError — not die on an uncatchable Wasm `null_deref` trap.
//
// Root cause (verify-first): the getter body itself is correct (it throws a
// catchable TypeError for a non-view `this`). The trap was in the CALL PATH: a
// non-null HOST-function-valued callee (the reflective `.get`, a host callable,
// NOT a wasm closure struct) fell through the closure-struct dispatch, which
// `struct.get`-trapped on the nulled cast. `calleeMayBeHostCallable`
// (src/codegen/expressions/calls.ts) now recognises the `gOPD(o, k).get`/`.set`
// reflective-accessor extraction, so the `__call_function` host-callable arm is
// emitted and the call routes through the host (throwing the catchable
// TypeError). #3441 unmasked this by letting the TypedArray harness run past
// __module_init.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

// The reflective-getter `*/invoked-as-func.js` family that previously trapped
// (null_deref) and now passes (throws a catchable TypeError the harness asserts).
const INVOKED_AS_FUNC_GETTERS = [
  "built-ins/TypedArray/prototype/buffer/invoked-as-func.js",
  "built-ins/TypedArray/prototype/byteLength/invoked-as-func.js",
  "built-ins/TypedArray/prototype/byteOffset/invoked-as-func.js",
  "built-ins/TypedArray/prototype/length/invoked-as-func.js",
  "built-ins/TypedArray/prototype/Symbol.toStringTag/invoked-as-func.js",
  "built-ins/TypedArray/prototype/Symbol.toStringTag/BigInt/invoked-as-func.js",
] as const;

const TRAP_SIGNATURE = /dereferencing a null pointer|out of bounds|illegal cast|unreachable/;

describe("#3488 reflective accessor getter invoked-as-func — catchable TypeError, not a trap", () => {
  it("TypedArray proto getters extracted via gOPD().get and called bare no longer trap (pass)", async () => {
    for (const rel of INVOKED_AS_FUNC_GETTERS) {
      const result = await runTest262File(resolve("test262/test", rel), rel.split("/")[0]!, 15000);
      restoreHostBuiltins();
      const err = String((result as { error?: unknown }).error ?? "");
      expect(err, `${rel} must not hit an uncatchable Wasm trap`).not.toMatch(TRAP_SIGNATURE);
      expect(result.status, `${rel} should pass (getter() throws a catchable TypeError)`).toBe("pass");
    }
  }, 180_000);

  it("a real view receiver still reads the accessor correctly (no dispatch regression)", async () => {
    // invoked-as-accessor.js: reading `.length` off the PROTOTYPE (a non-view,
    // non-null `this`) must still throw a catchable TypeError — the fix must not
    // perturb the valid-receiver / prototype-receiver paths.
    const rel = "built-ins/TypedArray/prototype/length/invoked-as-accessor.js";
    const result = await runTest262File(resolve("test262/test", rel), "built-ins", 15000);
    restoreHostBuiltins();
    expect(result.status).toBe("pass");
  }, 60_000);
});
