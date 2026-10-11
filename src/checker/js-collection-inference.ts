// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 slice V12 — keyed-collection type parameters are never inferred from
 * constructor arguments in JavaScript source.
 *
 * A `.js` program carries no static types. When TypeScript checks it, the
 * stock `MapConstructor` overloads infer `K`/`V` from the initial entries:
 * `new Map([[4, 4], ["foo3", 3]])` becomes `Map<string | number, number>`.
 * JavaScript does not honour that inference — `map.set(1, "valid")` is a
 * perfectly ordinary write — but every consumer that trusts the inferred value
 * type (a `var` slot, a call argument, a `forEach` callback parameter) lowers
 * the read as `f64` and turns the stored string into `NaN` (test262
 * `built-ins/Map/prototype/set/append-new-values`).
 *
 * The fix is at the type source, not at each consumer: for a `.js` entry the
 * checker sees an extra ambient root that prepends no-inference overloads to
 * the keyed-collection constructors. Interface merging orders a later
 * declaration's overloads first, so these win overload resolution:
 *
 * - type parameters default to the dynamic type (`any`; `WeakKey` for weak
 *   keys, matching the stock zero-argument overload), and
 * - `NoInfer` blocks inference from the arguments, while an explicit type
 *   argument or a contextual JSDoc `@type` still binds them.
 *
 * TypeScript sources never receive this root, so annotated or inferred TS
 * collections keep their typed fast paths unchanged.
 */
import { ts } from "../ts-api.js";

/** Synthetic root name; deliberately not `lib.*` so the extern-declaration lib walk skips it. */
export const JS_COLLECTION_INFERENCE_DTS_NAME = "__js2wasm_js_collections.d.ts";

const JS_COLLECTION_INFERENCE_DTS = `interface MapConstructor {
  new <K = any, V = any>(entries?: readonly (readonly [NoInfer<K>, NoInfer<V>])[] | null): Map<K, V>;
  new <K = any, V = any>(iterable?: Iterable<readonly [NoInfer<K>, NoInfer<V>]> | null): Map<K, V>;
}
interface SetConstructor {
  new <T = any>(values?: readonly NoInfer<T>[] | null): Set<T>;
  new <T = any>(iterable?: Iterable<NoInfer<T>> | null): Set<T>;
}
interface WeakMapConstructor {
  new <K extends WeakKey = WeakKey, V = any>(entries?: readonly (readonly [NoInfer<K>, NoInfer<V>])[] | null): WeakMap<K, V>;
  new <K extends WeakKey = WeakKey, V = any>(iterable?: Iterable<readonly [NoInfer<K>, NoInfer<V>]> | null): WeakMap<K, V>;
}
`;

const sourceFiles = new Map<string, ts.SourceFile>();

/** The synthetic ambient root, parsed once per language version. */
export function jsCollectionInferenceSourceFile(
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.SourceFile {
  const key = JSON.stringify(languageVersion);
  let sf = sourceFiles.get(key);
  if (!sf) {
    sf = ts.createSourceFile(JS_COLLECTION_INFERENCE_DTS_NAME, JS_COLLECTION_INFERENCE_DTS, languageVersion, true);
    sourceFiles.set(key, sf);
  }
  return sf;
}
