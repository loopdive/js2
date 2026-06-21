// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2564 (regression) — the virtual-method-dispatch tag cascade must give each
 * nested `if` its OWN `blockType` object, so dead-import elimination cannot
 * double-remap a shared block-type.
 *
 * Root cause: `emitVirtualMethodDispatchByTag` (src/codegen/expressions/calls.ts)
 * lowers a method call on a class-with-subclasses to a tag cascade —
 * `struct.get __tag` == classTag → call <Class>_<method>, one nested `if` per
 * candidate. The cascade originally shared a SINGLE `blockType` object across all
 * the nested `if`s. `eliminateDeadImports`'s `remapTypeIdxInBody` then remaps the
 * survivor-compacted type table AND every instruction's block-type; its
 * double-remap guard (#1302 `seen` WeakSet) keys on the *instruction* object, not
 * on the shared `blockType.type` sub-object — so each aliasing `if` chain-remapped
 * the shared block-type a second time (20→16 on the first `if`, then 16→13 on the
 * second, because the compaction map shifts each survivor down). The callee func's
 * result type, remapped exactly once in the type table, landed on 16, so the `if`
 * fall-through expected 13 (`$__fn_wrap_0`) but got 16 (the real return struct) →
 * `type error in fallthru[0] (expected (ref null 13), got (ref null 16))`.
 *
 * The source below is the EXACT output of the test262 runner's `wrapTest` for
 * `language/statements/class/elements/privatefieldset-typeerror-3.js` (the helper
 * preamble + the function-local class whose method returns `class extends Outer`).
 * The preamble's `Test262Error` class + `isSameValue`/`assert_*` helpers are
 * load-bearing: they populate the type table so the survivor-compaction remap
 * produces the specific chain (20→16→13) that lands the double-remapped block-type
 * on a real-but-wrong type. A minimal hand-written class does not reproduce — the
 * renumbering chain is shorter — so the fixture is reproduced verbatim. The
 * assertion is module VALIDITY; only V8's index-resolved function-body validation
 * rejects the double-remapped block-type.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// Verbatim `wrapTest(privatefieldset-typeerror-3.js)` output (2026-06-21).
const WRAPPED_PRIVATEFIELDSET_TYPEERROR_3 = `
let __fail: number = 0;
let __assert_count: number = 1;

class Test262Error {
  message: string;
  constructor(msg: string) {
    this.message = msg;
  }
}

function isSameValue(a: number, b: number): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}

function assert_sameValue(actual: number, expected: number): void {
  __assert_count = __assert_count + 1;
  if (!isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}

function assert_notSameValue(actual: number, expected: number): void {
  __assert_count = __assert_count + 1;
  if (isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}

function assert_true(value: number): void {
  __assert_count = __assert_count + 1;
  if (!value) {
    if (!__fail) __fail = __assert_count;
  }
}

export function test(): number {

  try {
class Outer {
  #x = 42;

  innerclass() {
    return class extends Outer {
      f() {
        this.#x = 1;
      }
    }
  }

  value() {
    return this.#x;
  }
}

var outer = new Outer();
var Inner = outer.innerclass();
var i = new Inner();

assert_sameValue(outer.value(), 42);
assert_sameValue(i.value(), 42);

i.f();

assert_sameValue(outer.value(), 42);
assert_sameValue(i.value(), 1);
  } catch (e) {
    if (!__fail) __fail = -1;
    throw e;
  }
  if (__fail) { return __fail; }
  return 1;
}
`;

describe("#2564 virtual-dispatch block-type DCE double-remap", () => {
  it("method returning a subclass expression under the test262 wrap produces valid wasm", async () => {
    const r = await compile(WRAPPED_PRIVATEFIELDSET_TYPEERROR_3, { skipSemanticDiagnostics: true });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // `WebAssembly.validate` runs full function-body validation — it is what
    // caught the double-remapped `if` block-type (`expected (ref null 13), got
    // (ref null 16)`). A symbolic disassembly looks fine; only V8's
    // index-resolved validation rejects the binary. Before the fix this was
    // `false`; the runner reported the file as malformed_wasm / compile_error.
    expect(WebAssembly.validate(r.binary), "compiled module must validate").toBe(true);
  });
});
