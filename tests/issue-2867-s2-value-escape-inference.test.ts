// (#2867 S2 / S2b) Two independent defects that both surfaced as the SAME
// symptom — `illegal cast [__then_fulfill_N <- __drain_microtasks]`, the largest
// `built-ins/Promise` standalone failure bucket (114 of 729 files; 13 after
// these fixes, and the corpus went 206 -> 252 pass with 0 regressions).
//
// S2 — value-escape parameter inference.
//   `inferParamTypeFromCallSites` narrows an untyped JS parameter when every
//   call site IT CAN SEE agrees, and it models exactly one caller shape:
//   `h(...)` / `new h(...)`. A function that also escapes as a VALUE
//   (`p.then(h, h)`, `arr.map(h)`) acquires callers that scan never sees, so the
//   agreement is not evidence. test262's async harness is exactly this: `$DONE`
//   is called directly with message STRINGS *and* installed as a reaction via
//   `.then($DONE, $DONE)`. The scan agreed on "string", the parameter lowered to
//   a non-nullable native-string `ref`, and the native then-wrapper's
//   `any.convert_extern` + `ref.cast` trapped as soon as the drive delivered
//   `undefined` or an Error. The guard withdraws GC-`ref` narrowings (only those
//   trap; f64/i32 coerce) when the name escapes as a value.
//
// S2b — zero-argument `.then()`.
//   `call-receiver-method.ts` gated the whole Promise instance-method block on
//   `arguments.length >= 1`, so `.then()` fell through to the GENERIC member-call
//   path and emitted a reflective `__call_m_then_0` trampoline over a native
//   `$Promise` (the failing module carried exactly that one extra function versus
//   the `.then(undefined, undefined)` spelling, which already worked). It now
//   takes the native absent-handler identity chain, admitted the same way the
//   zero-arg `.finally()` admission (#2903) already is.
//
// Both are pinned on BOTH carrier lanes (`--target standalone` and
// `--target wasi`), because the carrier gates cover both since the #2980 flip,
// plus a gc/host control so the default lane is exercised too. Sources are `.js`
// on purpose: the S2 defect requires an *unannotated* parameter, and an
// explicit `any` annotation short-circuits the inference before it can fire.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

type CarrierTarget = "standalone" | "wasi";
const CARRIER_TARGETS: readonly CarrierTarget[] = ["standalone", "wasi"];

/** A function used BOTH as a `.then` reaction and called directly with a string. */
const ESCAPED_HANDLER_SRC = `
var out = 0;
function h(error) { out = error ? 1 : 2; }
export function run() {
  Promise.resolve(1)
    .then(function () { h('a string argument at a direct call site'); }, function (e) { })
    .then(h, h);
  __drain_microtasks();
  __drain_microtasks();
  __drain_microtasks();
  return out;
}
`;

/** Zero-argument `.then()` must pass the fulfilment value through unchanged. */
const ZERO_ARG_THEN_SRC = `
var obj = {};
var seen = 0;
export function run() {
  Promise.resolve(obj).then().then(function (arg) { seen = (arg === obj) ? 1 : 2; });
  __drain_microtasks();
  __drain_microtasks();
  __drain_microtasks();
  return seen;
}
`;

async function buildAndRun(src: string, target: CarrierTarget): Promise<number> {
  const r = await compile(src, { fileName: "t.js", target });
  expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  // Host-free: the carrier lanes must not have fallen back to `Promise_*` /
  // `__make_callback` host imports to get this right.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { run(): number }).run();
}

describe("#2867 S2 — value-escape param inference + zero-arg .then()", () => {
  describe.each(CARRIER_TARGETS)("--target %s", (target) => {
    it("a handler called with a string elsewhere still receives the drive's value (no illegal cast)", async () => {
      // Before the guard this trapped in `__then_fulfill_N` under
      // `__drain_microtasks`, because `h`'s parameter had been narrowed to a
      // non-nullable native-string ref from the `h('…')` call site alone.
      // The first reaction calls `h('…')` (truthy -> 1); the chained reaction
      // then delivers `undefined` (falsy -> 2), which is the value the old
      // `ref.cast` could not represent.
      await expect(buildAndRun(ESCAPED_HANDLER_SRC, target)).resolves.toBe(2);
    });

    it("zero-argument .then() passes the fulfilment value through by identity", async () => {
      // Before the admission this took the reflective `__call_m_then_0`
      // trampoline and trapped; `.then(undefined, undefined)` already worked,
      // which is what isolated the gate as the cause.
      await expect(buildAndRun(ZERO_ARG_THEN_SRC, target)).resolves.toBe(1);
    });
  });

  // gc/host control. `param-return-inference.ts` is NOT carrier-gated — it
  // changes parameter ABIs corpus-wide — so the default lane must be exercised,
  // not assumed inert. Promises are host-backed here (`__drain_microtasks` is a
  // void no-op and the reactions run on the host job queue), so this asserts the
  // compile/validate contract rather than a drained value.
  describe("gc/host lane control", () => {
    it.each([
      ["escaped handler", ESCAPED_HANDLER_SRC],
      ["zero-argument .then()", ZERO_ARG_THEN_SRC],
    ])("%s still compiles to valid wasm on the default lane", async (_label, src) => {
      const r = await compile(src, { fileName: "t.js" });
      expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
      expect(WebAssembly.validate(r.binary)).toBe(true);
    });
  });
});
