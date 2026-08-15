// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4468) Fix-forward regression pins for the three families PR #4507 broke on
// `main` (merge commit 6756ed8c; parent c3ff8a1f). Each case here FAILS on
// 6756ed8c and PASSES on c3ff8a1f, so the pin is on #4507's defect, not on a
// pre-existing gap:
//
//   1. object-shape trampoline receiver — `this.#m.call(o)` with a receiver
//      that is not the method's struct trapped `null_deref` (uncatchable)
//      because the trampoline asserted its deliberately-nullable receiver slot
//      non-null. (test262 `class/elements/super-access-inside-a-private-method`)
//   2. closed-method dispatch under-application — an object-literal method with
//      a destructured-with-default parameter, called with no argument, received
//      JS `null` instead of `undefined`, so its default never fired and the
//      destructuring threw. (test262 `object/dstr/meth-dflt-obj-ptrn-empty`
//      and its `gen-`/`async-gen-` siblings)
//   3. object-spread source materialization — a closed struct spread on the
//      JS-host lane was snapshotted from its STATIC fields, so a preceding
//      spread's getter mutating that source was unobservable.
//      (test262 `{array,new,super/call-}spread-obj-manipulate-outter-obj-in-getter`)
//
// The lane mirrors the test262 original-harness runner (`allowJs`,
// `skipSemanticDiagnostics`, `deferTopLevelInit`, `hostBridge: "always"`) —
// these shapes depend on JS expando/`delete` inference, which the default
// strict-TS lane does not reproduce.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runJsLane(source: string): Promise<unknown> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4468.js",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    hostBridge: "always",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool) as WebAssembly.Imports & {
    setInstance?: (instance: WebAssembly.Instance) => void;
    setExports?: (exports: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  imports.setExports?.(instance.exports);
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return exports.test?.();
}

describe("#4468 — PR #4507 object-shape regressions", () => {
  it("family 1: a private method reached through a foreign receiver runs instead of trapping", async () => {
    // `this.#m.call(o)` routes through `__obj_meth_tramp_C___priv_m_cached`.
    // `o` is not a `C`, so the trampoline takes its #2025 "present but
    // structurally different receiver" arm and passes `ref.null`. #4507 appended
    // `ref.as_non_null` there, turning that legal path into a `null_deref` trap.
    expect(
      await runJsLane(`
        class A {
          method() { return "Test262"; }
        }
        class C extends A {
          #m() { return super.method(); }
          access(o) { return this.#m.call(o); }
        }
        var c = new C();
        var own = c.access(c);
        var foreign = c.access({});
        export function test() { return own + "/" + foreign; }
      `),
    ).toBe("Test262/Test262");
  });

  it("family 2: an object-literal method's destructured default fires when called with no argument", async () => {
    // The closed-method dispatcher may under-apply `method({} = obj)` only if it
    // can encode "argument not provided". On the JS-host lane that is `undefined`;
    // `ref.null.extern` is a REAL argument (JS `null`), so the default is skipped
    // and `{}` destructures null → "Cannot destructure 'null' or 'undefined'".
    expect(
      await runJsLane(`
        var accessCount = 0;
        var obj = Object.defineProperty({}, "attr", { get: function () { accessCount += 1; } });
        var callCount = 0;
        var obj = {
          method({} = obj) { callCount = callCount + 1; }
        };
        obj.method();
        export function test() { return "calls=" + callCount + ",access=" + accessCount; }
      `),
    ).toBe("calls=1,access=0");
  });

  it("family 3: a spread source mutated by an earlier spread's getter is copied post-mutation", async () => {
    // CopyDataProperties reads `o` AFTER `cthulhu`'s getter deletes `a`, sets
    // `b` and adds the expando `c`. Materializing the closed struct's STATIC
    // fields instead of reflecting the live object reports the pre-mutation
    // key set (`a` still present, `c` missing).
    expect(
      await runJsLane(`
        var o = { a: 0, b: 1 };
        var cthulhu = { get x() { delete o.a; o.b = 42; o.c = "ni"; } };
        var out = "";
        (function (obj) {
          out =
            "hasA=" + obj.hasOwnProperty("a") +
            ",b=" + obj.b +
            ",c=" + obj.c +
            ",hasX=" + obj.hasOwnProperty("x") +
            ",keys=" + Object.keys(obj).length;
        }.apply(null, [{ ...cthulhu, ...o }]));
        export function test() { return out; }
      `),
    ).toBe("hasA=false,b=42,c=ni,hasX=true,keys=3");
  });
});
