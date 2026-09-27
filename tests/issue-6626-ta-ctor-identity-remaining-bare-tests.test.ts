// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6626 (#5383 S39) — the LAST batch of bare `ref.test $__ta_ctor` /
// `taCtorTypeIdx` receiver tests, unaudited by #6620/#6622: `dataview-native.ts`
// (5 sites), `property-access-dispatch.ts` (1 site), `ta-ctor-meta.ts` (2 call
// sites, one of them the shared `isTaCtor()` helper reused at 5 splice points
// across `__builtinfn_get_meta`/`__builtinfn_gopd`/`__builtinfn_delete`).
//
// SAME ROOT CAUSE AS #6620/#6622/#6601: `$__ta_ctor` is `{kind: i32, brand:
// i32}` (`registry/types.ts`) — exactly the WasmGC shape of a field-less
// class's compiled root (`{__tag: i32, __shape_brand: i32}`, `class-bodies.ts`
// #2158/#2009), for BOTH an instance and — per #3976 — a class-object VALUE.
// A bare `ref.test` cannot tell the two apart; every site here now routes
// through `taCtorIdentityTestInstrs` (#5194 r3 F1 / #5383 S2f R11), which adds
// the `brand` FIELD-VALUE check and can only ever REMOVE a false positive.
//
// MEASURED fix-witnesses below (file-copy revert of the ONE file named,
// 2026-09-17, single-module standalone compile, no linking needed — unlike
// #6620/#6622 this collision reproduces with a purely LOCAL field-less class
// whose compiler-assigned `__tag` happens to land inside `TA_CTOR_KINDS`'
// 0..10 range):
//   dataview-native.ts revert:  `(x:any).BYTES_PER_ELEMENT` on a tag-3
//     instance answers `2` (Int16Array's byte width) instead of `0`.
//   ta-ctor-meta.ts revert:     `typeof (x:any).prototype` answers `"object"`
//     instead of `"undefined"`; `Object.getOwnPropertyDescriptor(x,
//     "BYTES_PER_ELEMENT")` answers a real descriptor instead of `null`;
//     `Object.prototype.hasOwnProperty.call(x, "prototype")` answers `true`
//     instead of `false`.
//
// NOT INDEPENDENTLY WITNESSED (audited + fixed defensively, same
// answer-preserving pattern, but no reachable wrong-answer found within this
// slice's budget — see plan/issues/6626-*.md "S39 findings" for the
// bisection attempted):
//   - dataview-native.ts's three dynamic-`new ctor(...)` construct sites
//     (`emitDynamicTaViewConstruct`, `emitTaDynCtorConstructFromLocals` ×2
//     call sites). `emitDynamicNewFallback` (`new-super.ts`) intercepts a
//     LOCAL field-less class first (it is a real candidate there), and a
//     LINKED provider class passed the same way through `new k(buf)` did not
//     reproduce the collision either — some other correct-answer path wins
//     before the vulnerable arm in both cases tried.
//   - property-access-dispatch.ts's `$262.createRealm().global` receiver arm
//     — reproducing needs the actual test262 `$262` harness object, out of
//     reach of a synthetic vitest probe in this slice.
//
// Every fix-witness `it` below is measured FAILING on the named file's
// file-copy-reverted base and PASSING on branch; every control passes on
// both trees unchanged (TypedArray/DataView controls are LABELLED, not
// counted as fix-witnesses).
import { describe, expect, it } from "vitest";
import { compileMulti, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/** Compile a single standalone module and read the string `prepare()`/`at()` returned, host-free. */
async function runOne(src: string): Promise<string> {
  const entry = "/__m.ts";
  const result = await compileMulti({ [entry]: src }, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    canonicalRuntimeTypes: true,
    ...STANDALONE,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  const exports = instance.exports as unknown as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(exports.at(i));
  return out;
}

/**
 * A field-less class `PD` at `__tag` 3 (three filler classes ahead of it) —
 * inside `TA_CTOR_KINDS`' 0..10 range at index 3 (`Int16Array`, byte width 2),
 * so a structural collision manifests as a visibly wrong nonzero/non-null
 * answer rather than silently declining. `mkTA` is required so a `$__ta_ctor`
 * type is actually REGISTERED in the module (`ctx.taCtorTypeIdx >= 0`) —
 * without any TA-constructor-as-value usage anywhere, none of the audited
 * arms even run.
 */
function src(expr: string): string {
  return (
    `class C0 {} class C1 {} class C2 {}\n` +
    `class PD { ident() { return "pd"; } }\n` +
    `function mkTA(k) { return new k(4); }\n` +
    `var __internalTA = mkTA(Uint8Array);\n` +
    `var x: any = new PD();\n` +
    `let __s = "";\n` +
    `export function prepare() { try { __s = "" + (${expr})} catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n` +
    `export function at(i) { return __s.charCodeAt(i); }\n`
  );
}

describe("#6626 — remaining bare `ref.test $__ta_ctor` sites", () => {
  describe("dataview-native.ts — emitTaCtorBytesPerElement", () => {
    it(
      "a dynamic `.BYTES_PER_ELEMENT` read on a tag-3 collision instance declines to `0` " +
        "(base tree, `dataview-native.ts` reverted: answers `2`, Int16Array's byte width)",
      async () => {
        const out = await runOne(
          src(`(function() { function bpe(v: any) { return v.BYTES_PER_ELEMENT; } return bpe(x); })()`),
        );
        expect(out).toBe("0");
      },
    );

    it("a GENUINE TypedArray constructor's `.BYTES_PER_ELEMENT` still answers correctly (control)", async () => {
      const out = await runOne(
        src(
          `(function() { function bpe(v: any) { return v.BYTES_PER_ELEMENT; } var ctors: any[] = [Uint8Array, Int16Array]; return bpe(ctors[1]); })()`,
        ),
      );
      expect(out).toBe("2");
    });
  });

  describe("ta-ctor-meta.ts — isTaCtor() receiver guard (5 splice sites)", () => {
    it(
      "a dynamic `.prototype` read on a tag-3 collision instance answers `undefined` " +
        "(base tree, `ta-ctor-meta.ts` reverted: answers `object`)",
      async () => {
        const out = await runOne(src(`typeof x.prototype`));
        expect(out).toBe("undefined");
      },
    );

    it(
      '`Object.getOwnPropertyDescriptor(x, "BYTES_PER_ELEMENT")` on a tag-3 collision instance answers `null` ' +
        "(base tree: a real-looking descriptor `{value:2,...}`)",
      async () => {
        const out = await runOne(src(`JSON.stringify(Object.getOwnPropertyDescriptor(x, "BYTES_PER_ELEMENT"))`));
        expect(out).toBe("null");
      },
    );

    it(
      '`hasOwnProperty(x, "prototype")` on a tag-3 collision instance answers `false` ' + "(base tree: answers `true`)",
      async () => {
        const out = await runOne(src(`Object.prototype.hasOwnProperty.call(x, "prototype")`));
        expect(out).toBe("false");
      },
    );

    it("a GENUINE TypedArray constructor's `.prototype`/gopd still answer correctly (control)", async () => {
      const out = await runOne(
        src(
          `(function() { var ctors: any[] = [Uint8Array, Int16Array]; ` +
            `return typeof ctors[1].prototype + ":" + JSON.stringify(Object.getOwnPropertyDescriptor(ctors[0], "BYTES_PER_ELEMENT")); })()`,
        ),
      );
      expect(out).toBe('object:{"value":1,"writable":false,"enumerable":false,"configurable":false}');
    });
  });

  describe("dataview-native.ts — dynamic `new ctor(...)` construct sites (defensive fix, no reachable wrong answer found)", () => {
    it("`new k(arrayBufferTyped)` with k=a local tag-3 collision class still constructs the real class (control)", async () => {
      const out = await runOne(
        src(
          `(function() { function dynNew(k: any) { var buf = new ArrayBuffer(8); var r = new k(buf); ` +
            `return typeof r + ':' + (r && r.ident ? r.ident() : 'no-ident'); } return dynNew(PD); })()`,
        ),
      );
      expect(out).toBe("object:pd");
    });

    it("`new k()` no-arg dynamic construct with the same collision class still constructs the real class (control)", async () => {
      const out = await runOne(
        src(
          `(function() { function dynNew(k: any) { var r = new k(); ` +
            `return typeof r + ':' + (r && r.ident ? r.ident() : 'no-ident'); } return dynNew(PD); })()`,
        ),
      );
      expect(out).toBe("object:pd");
    });

    it("a GENUINE dynamic TypedArray construct from a buffer still answers correctly (control)", async () => {
      const out = await runOne(
        src(
          `(function() { function dynNew(k: any) { var buf = new ArrayBuffer(8); var r: any = new k(buf); return r.length + ':' + r.BYTES_PER_ELEMENT; } return dynNew(Int16Array); })()`,
        ),
      );
      expect(out).toBe("4:2");
    });
  });
});
