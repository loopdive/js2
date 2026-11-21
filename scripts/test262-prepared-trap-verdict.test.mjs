// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #7354 U0: on the Prepared lane a Wasm trap is never the expected throw of a
// runtime-negative row, and a trap out of the async drain after the completion
// marker fails the row. Other lanes keep their published verdicts (#7447).
import assert from "node:assert/strict";
import test from "node:test";
import { asyncRowVerdict, renderHostError, runtimeNegativeThrowAccepted } from "./test262-runtime-verdict.mjs";

// Hand-encoded (this CI step installs no packages) so the trap carries real frame names:
//   (module
//     (tag $t (export "__exn_tag") (param externref))
//     (func $Test262Error (export "trapInTest262Error") unreachable)
//     (func $assertThrows (export "trapUnderAssert") call $Test262Error)
//     (func (export "throwPayload") (param externref) local.get 0 throw $t))
const sized = (bytes) => (assert.ok(bytes.length < 128), [bytes.length, ...bytes]);
const name = (text) => sized([...Buffer.from(text)]);
const vec = (items) => [items.length, ...items.flat()];
const section = (id, bytes) => [id, ...sized(bytes)];
const bytes = new Uint8Array([
  ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
  ...section(
    1,
    vec([
      [0x60, 1, 0x6f, 0],
      [0x60, 0, 0],
    ]),
  ),
  ...section(3, vec([[1], [1], [0]])),
  ...section(13, vec([[0, 0]])),
  ...section(
    7,
    vec([
      [...name("__exn_tag"), 4, 0],
      [...name("trapInTest262Error"), 0, 0],
      [...name("trapUnderAssert"), 0, 1],
      [...name("throwPayload"), 0, 2],
    ]),
  ),
  ...section(10, vec([sized([0, 0x00, 0x0b]), sized([0, 0x10, 0, 0x0b]), sized([0, 0x20, 0, 0x08, 0, 0x0b])])),
  ...section(0, [
    ...name("name"),
    1,
    ...sized(
      vec([
        [0, ...name("Test262Error")],
        [1, ...name("assertThrows")],
      ]),
    ),
  ]),
]);
const { instance } = await WebAssembly.instantiate(bytes);

function caught(run) {
  try {
    run();
  } catch (err) {
    return err;
  }
  assert.fail("expected a throw");
}

// The worker renders a host error through the same `renderHostError`.
const render = (err) => (err instanceof Error ? renderHostError(err) : String(err));
const accepted = (err, inst, expectedErrorType, prepared) =>
  runtimeNegativeThrowAccepted(err, inst, { expectedErrorType, originalHarness: true, prepared, render });

const trapInTest262Error = caught(() => instance.exports.trapInTest262Error());
const trapUnderAssert = caught(() => instance.exports.trapUnderAssert());
const expectedThrow = caught(() => instance.exports.throwPayload({ name: "Test262Error" }));
const otherThrow = caught(() => instance.exports.throwPayload({ name: "TypeError" }));

test("the trap renders its frames, so a name match sees the expected type", () => {
  assert.ok(trapInTest262Error instanceof WebAssembly.RuntimeError);
  assert.equal(render(trapUnderAssert), "unreachable [in Test262Error() ← assertThrows]");
});

for (const [lane, prepared] of [
  ["Prepared", true],
  ["non-Prepared", false],
]) {
  test(`${lane}: a trap in a function named Test262Error`, () => {
    for (const inst of [null, instance]) {
      assert.equal(accepted(trapInTest262Error, inst, "Test262Error", prepared), !prepared);
      assert.equal(accepted(trapUnderAssert, inst, "Test262Error", prepared), !prepared);
    }
  });

  test(`${lane}: a trap with no expected type`, () => {
    assert.equal(accepted(trapInTest262Error, instance, undefined, prepared), !prepared);
    assert.equal(
      runtimeNegativeThrowAccepted(trapInTest262Error, instance, { originalHarness: false, prepared, render }),
      !prepared,
    );
  });

  test(`${lane}: a real throw of the expected type passes`, () => {
    assert.ok(expectedThrow instanceof WebAssembly.Exception);
    assert.equal(accepted(expectedThrow, instance, "Test262Error", prepared), true);
    class Test262Error extends Error {}
    assert.equal(accepted(new Test262Error("x"), null, "Test262Error", prepared), true);
  });

  test(`${lane}: a real throw of another type fails`, () => {
    assert.equal(accepted(otherThrow, instance, "Test262Error", prepared), false);
    assert.equal(accepted(new TypeError("x"), null, "Test262Error", prepared), false);
  });

  test(`${lane}: an async drain that traps after the completion marker`, () => {
    const verdict = asyncRowVerdict({ completed: true, drainError: trapInTest262Error, prepared });
    assert.equal(verdict, prepared ? "threw-after-completion" : "pass");
    assert.equal(
      asyncRowVerdict({ completed: true, drainError: expectedThrow, prepared }),
      prepared ? "threw-after-completion" : "pass",
    );
  });

  test(`${lane}: the other async outcomes`, () => {
    assert.equal(asyncRowVerdict({ completed: true, drainError: null, prepared }), "pass");
    assert.equal(asyncRowVerdict({ completed: false, drainError: trapInTest262Error, prepared }), "no-completion");
    assert.equal(
      asyncRowVerdict({ failureMarker: "Test262:AsyncTestFailure:x", completed: true, drainError: null, prepared }),
      "failure-marker",
    );
  });
}
