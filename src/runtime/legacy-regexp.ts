// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Extracted verbatim from src/runtime.ts (#3103) — Annex B legacy RegExp static
// state (RegExp.$1..$9 / $_ / $& etc.) plus the String.prototype symbol-method
// reroute for primitive search values (#3095). Pure move, host-side only;
// emits zero Wasm. No logic change.

function _escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * #3095 — The well-known Symbol each `String.prototype` symbol-dispatch method
 * looks up on its search value (per ECMA-262). `replaceAll` dispatches on
 * `@@replace` (there is no `@@replaceAll`).
 */
const _stringMethodDispatchSymbol: Record<string, symbol | undefined> = {
  match: Symbol.match,
  matchAll: Symbol.matchAll,
  search: Symbol.search,
  replace: Symbol.replace,
  replaceAll: Symbol.replace,
  split: Symbol.split,
};

/**
 * #3095 — For `String.prototype.{match,matchAll,search,replace,replaceAll,
 * split}` with a **primitive** (non-Object) search value, ECMA-262 does NOT
 * observably access the value's `Symbol.<method>` property; it goes straight to
 * the "regexp is not an Object" branch. The JS host (`recvStr[method](arg)`)
 * would instead run GetMethod on the primitive's wrapper prototype, triggering
 * any user-defined `Number.prototype[Symbol.match]` (etc.) accessor.
 *
 * To preserve host delegation while suppressing that observable access, we
 * pre-build the RegExp the spec's not-Object branch would create and hand
 * *that* to the host method — the host then dispatches on the built-in
 * `RegExp.prototype` symbol methods and never touches the primitive's
 * prototype. match/matchAll/search treat the primitive as a **pattern**
 * (RegExpCreate); replace/replaceAll/split treat it as a **literal string**
 * (so we escape it; `replaceAll` needs the global flag).
 *
 * Returns the replacement RegExp, or `undefined` to leave the arg unchanged.
 * Only engaged when the relevant Symbol property actually exists on the
 * primitive's prototype chain (checked with `in`/HasProperty, which does not
 * call getters) — so the common no-override case is byte-identical to before.
 */
export function _rerouteStringSymbolMethodPrimitive(method: string, first: unknown): RegExp | undefined {
  const t = typeof first;
  if (t !== "number" && t !== "string" && t !== "boolean" && t !== "bigint") return undefined;
  const sym = _stringMethodDispatchSymbol[method];
  if (sym === undefined) return undefined;
  // HasProperty (no getter side effect) against the prototype the primitive
  // would box to. (#3903) This used to read `sym in Object(first)`, which
  // allocated a fresh wrapper object on EVERY `split`/`replace` crossing —
  // ~10k of them per benchmark `run()`. Checking the prototype directly is
  // exactly equivalent for a Symbol key: a freshly boxed String wrapper's own
  // properties are only the integer indices and `length`, and Number/Boolean/
  // BigInt wrappers have no own properties at all, so no Symbol key can ever
  // be an own property of `Object(first)`.
  const proto =
    t === "string"
      ? String.prototype
      : t === "number"
        ? Number.prototype
        : t === "boolean"
          ? Boolean.prototype
          : BigInt.prototype;
  if (!(sym in proto)) return undefined;
  const str = String(first as number | string | boolean | bigint);
  switch (method) {
    case "match":
    case "search":
      return new RegExp(str);
    case "matchAll":
      return new RegExp(str, "g");
    case "replaceAll":
      return new RegExp(_escapeRegExpLiteral(str), "g");
    case "replace":
    case "split":
      return new RegExp(_escapeRegExpLiteral(str));
    default:
      return undefined;
  }
}

// (#1333) Annex B §B.2.2 — legacy RegExp static-property slots on %RegExp%.
// Updated after every successful RegExpBuiltinExec (intercepted in the
// `extern_class` method handler + `__extern_method_call` + `string_method`
// branches). Read via the getters installed by _installLegacyRegExpAccessors.
export type LegacyRegExpState = {
  input: string;
  lastMatch: string;
  lastParen: string;
  leftContext: string;
  rightContext: string;
  parens: string[];
};
const _legacyRegExpState: LegacyRegExpState = {
  input: "",
  lastMatch: "",
  lastParen: "",
  leftContext: "",
  rightContext: "",
  parens: ["", "", "", "", "", "", "", "", ""],
};
const _legacyRegExpInstalledOn: WeakSet<object> = new WeakSet();

export function _makeLegacyRegExpState(): LegacyRegExpState {
  return { input: "", lastMatch: "", lastParen: "", leftContext: "", rightContext: "", parens: new Array(9).fill("") };
}

// #1933 — update the legacy RegExp static state. `state` is the per-instance
// slot (threaded from `instanceState.legacyRegExpState`); falls back to the
// shared module-level slot for legacy callers without an instanceState.
export function _updateLegacyRegExpState(
  input: string,
  m: RegExpExecArray | RegExpMatchArray | null,
  state: LegacyRegExpState = _legacyRegExpState,
): void {
  if (m == null) return;
  const idx = m.index ?? 0;
  const matchStr = m[0] ?? "";
  state.input = input;
  state.lastMatch = matchStr;
  state.leftContext = input.substring(0, idx);
  state.rightContext = input.substring(idx + matchStr.length);
  let lastNonEmptyParen = "";
  for (let i = 0; i < 9; i++) {
    const cap = m[i + 1];
    const v = cap == null ? "" : String(cap);
    state.parens[i] = v;
    if (cap != null) lastNonEmptyParen = v;
  }
  state.lastParen = lastNonEmptyParen;
}

export function _installLegacyRegExpAccessors(C: unknown, state: LegacyRegExpState = _legacyRegExpState): void {
  if (C == null || (typeof C !== "function" && typeof C !== "object")) return;
  if (_legacyRegExpInstalledOn.has(C as object)) return;
  _legacyRegExpInstalledOn.add(C as object);
  // #1933 — the accessors read/write the per-instance `state` (threaded from
  // instanceState), so `RegExp.$1`/`$_` etc. don't cross instances.
  type Slot = readonly [string, readonly string[], () => string, ((v: unknown) => void)?];
  const slots: Slot[] = [
    [
      "input",
      ["$_"],
      () => state.input,
      (v) => {
        state.input = String(v);
      },
    ],
    ["lastMatch", ["$&"], () => state.lastMatch],
    ["lastParen", ["$+"], () => state.lastParen],
    ["leftContext", ["$`"], () => state.leftContext],
    ["rightContext", ["$'"], () => state.rightContext],
  ];
  for (const [name, aliases, getter, setter] of slots) {
    // (#1333) Note: `set` must be explicitly `undefined` for read-only slots.
    // Per ES §10.1.6.3 OrdinaryDefineOwnProperty, an absent field in the
    // descriptor preserves the current value, so V8's pre-existing native
    // setter would leak through. Spec mandates `set: undefined` for the
    // read-only legacy accessors (lastMatch/lastParen/leftContext/rightContext
    // and $1-$9) — see annexB/legacy-accessors/*/prop-desc.js.
    const desc: PropertyDescriptor = setter
      ? {
          get(this: unknown) {
            if (this !== C) throw new TypeError(`RegExp.${name} getter requires the RegExp constructor as this`);
            return getter();
          },
          set(this: unknown, v: unknown) {
            if (this !== C) throw new TypeError(`RegExp.${name} setter requires the RegExp constructor as this`);
            setter(v);
          },
          enumerable: false,
          configurable: true,
        }
      : {
          get(this: unknown) {
            if (this !== C) throw new TypeError(`RegExp.${name} getter requires the RegExp constructor as this`);
            return getter();
          },
          set: undefined,
          enumerable: false,
          configurable: true,
        };
    try {
      Object.defineProperty(C, name, desc);
      for (const alias of aliases) Object.defineProperty(C, alias, desc);
    } catch {
      // Slot non-configurable on this host — leave native annexB in place.
    }
  }
  for (let i = 1; i <= 9; i++) {
    const idx = i - 1;
    try {
      Object.defineProperty(C, `$${i}`, {
        get(this: unknown) {
          if (this !== C) throw new TypeError(`RegExp.$${i} getter requires the RegExp constructor as this`);
          return state.parens[idx];
        },
        set: undefined,
        enumerable: false,
        configurable: true,
      });
    } catch {
      // ignore
    }
  }
}
