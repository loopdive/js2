// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6430(b) — reading an ABSENT field off a FIELD-LESS struct answered `0`
// instead of `undefined`.
//
// `function f(opt = {}) { return typeof opt.maxAge }` lowers `{}` to a
// field-less struct `(struct)`. `emitStructFieldNamesExport` emitted an arm
// only for shapes with at least one field, so `__struct_field_names` answered
// `ref.null` for that receiver — which the host runtime reads as "unknown
// legacy shape, keep probing", NOT as "known shape with no fields". The probe
// it then keeps is `__sget_maxAge`, a getter shared by every structurally
// compatible shape in the module (one is registered as soon as ANY caller
// passes `{ maxAge: … }`), whose f64-mode miss default is `f64.const 0`. So an
// absent field read back a real `0`:
//
//   parent: typeof f({})       → "number"   (want "undefined")
//           f({}).maxAge === undefined → false
//
// Production witness: hono's `_serialize(name, value, opt: CookieOptions = {})`
// tests `typeof opt.maxAge === 'number' && opt.maxAge >= 0`, so an absent
// `maxAge` appended a spurious `Max-Age=0` to every serialized cookie.
//
// The fix gives every non-synthetic shape an arm — field-less ones answer the
// EMPTY CSV — and teaches `_structFieldNamesRaw` that `""` is a positive
// answer (`[]`, known shape, no fields) rather than `null`. `readField` then
// yields NO_GENERATED_FIELD and the read resolves to `undefined`.
//
// ANTI-VACUITY: `control`/`controlValue` read a field that IS present on the
// receiver and must keep answering the real value — a fix that made every
// struct read answer `undefined` fails here. The `{ maxAge: 3 }` caller is also
// what registers the `__sget_maxAge` getter in the first place, so without it
// the bug does not exist and the test would be vacuous.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const DEP = `
export function typeOfMaxAge(opt = {}) { return typeof opt.maxAge; }
export function isUndef(opt = {}) { return opt.maxAge === undefined; }
export function readMaxAge(opt = {}) { return opt.maxAge; }
export function hasOwnMaxAge(opt = {}) { return Object.prototype.hasOwnProperty.call(opt, 'maxAge'); }
export function jsonOf(opt = {}) { return JSON.stringify(opt); }
// A FIELD-LESS base class whose subclass adds fields: a ref.test of Base
// matches a Derived instance too, so an empty-CSV arm for Base must NOT be
// emitted -- one ahead of Derived's in the ladder strips Derived's fields.
export class Base {}
export class Derived extends Base {
  constructor(x) { super(); this.x = x; this.y = 2; }
}
export function keysOf(o) { return Object.keys(o).join('|'); }
`;

const ENTRY = `
import { typeOfMaxAge, isUndef, readMaxAge, hasOwnMaxAge, jsonOf, Base, Derived, keysOf } from './dep.js';
export function noArg() { return typeOfMaxAge(); }
export function emptyObj() { return typeOfMaxAge({}); }
export function explicitUndef() { return typeOfMaxAge(undefined); }
export function undefEmpty() { return isUndef({}); }
export function emptyHasOwn() { return hasOwnMaxAge({}); }
export function emptyJson() { return jsonOf({}); }
// Anti-vacuity controls: the field IS present on this receiver.
export function control() { return typeOfMaxAge({ maxAge: 3 }); }
export function controlValue() { return readMaxAge({ maxAge: 3 }); }
export function controlUndef() { return isUndef({ maxAge: 3 }); }
export function controlHasOwn() { return hasOwnMaxAge({ maxAge: 3 }); }
export function controlJson() { return jsonOf({ maxAge: 3 }); }
export function derivedKeys() { return keysOf(new Derived(1)); }
export function derivedJson() { return JSON.stringify(new Derived(1)); }
export function baseKeys() { return keysOf(new Base()); }
export function baseMissing() { return typeof (new Base()).x; }
`;

async function compileFixture(): Promise<CompileResult> {
  const root = mkdtempSync(join(tmpdir(), "js2-6430b-"));
  roots.push(root);
  for (const [name, source] of Object.entries({ "dep.js": DEP, "main.js": ENTRY })) {
    const file = join(root, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, source);
  }
  return compileProject(join(root, "main.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "web",
  });
}

describe("#6430(b) absent field on a field-less struct", () => {
  it("answers undefined, not the shared getter's f64 miss-default 0", async () => {
    const result = await compileFixture();
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
    (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
    (instance.exports.__module_init as (() => void) | undefined)?.();
    const exports = instance.exports as unknown as Record<string, () => unknown>;

    // All three answered "number" on the parent.
    expect(exports.noArg!()).toBe("undefined");
    expect(exports.emptyObj!()).toBe("undefined");
    expect(exports.explicitUndef!()).toBe("undefined");
    // Parent answered 0 (false).
    expect(exports.undefEmpty!()).toBe(1);
    // Same root cause, same fix: `hasOwnProperty` on a field-less receiver
    // answered TRUE on the parent, because the unknown-shape verdict let the
    // shared getter stand in for a real field.
    expect(exports.emptyHasOwn!()).toBe(0);
    expect(exports.emptyJson!()).toBe("{}");

    // Anti-vacuity: a PRESENT field is untouched.
    expect(exports.control!()).toBe("number");
    expect(exports.controlValue!()).toBe(3);
    expect(exports.controlUndef!()).toBe(0);
    expect(exports.controlHasOwn!()).toBe(1);
    expect(exports.controlJson!()).toBe('{"maxAge":3}');

    // The supertype guard. A field-less arm for `Base` would match a `Derived`
    // instance too (`ref.test` is subtyping, and `extends` sets `superTypeIdx`),
    // and an empty CSV ahead of Derived's arm strips Derived's own fields:
    // measured WITHOUT the guard, `derivedKeys` answered "" and `derivedJson`
    // answered "{}". A field-less shape that nothing extends still gets its arm.
    expect(exports.derivedKeys!()).toBe("x|y");
    expect(exports.derivedJson!()).toBe('{"x":1,"y":2}');
    expect(exports.baseKeys!()).toBe("");
    expect(exports.baseMissing!()).toBe("undefined");
  }, 120_000);
});
