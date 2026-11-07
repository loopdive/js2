import ts from "typescript";
import { arrayProtoMethodSpecLength } from "./array-object-proto.js";

// (#6979 S7-b) The host-only `[].includes`-as-a-value intercept
// (`tryCompileArrayMethodValue`, which borrowed the host `Array.prototype`
// method through the `__array_proto_method` import) is deleted with the rest
// of the env `__array_`/`__js_array_` builder emitters. Only the native
// spec-length table lookup below remains.

/**
 * (#4765) The spec `length` of an `Array.prototype` method VALUE whose static
 * type is its `lib.*.d.ts` signature — `[].slice.length`, `var s = [].push;
 * s.length` — or `undefined` for any other signature.
 *
 * The generic `Function.length` fold counts the declaration's leading required
 * parameters (§15.1.5), and the lib spells these methods with optional and rest
 * parameters the spec does not count that way: `slice(start?, end?)` answered
 * 0 for a spec 2, `push(...items)` 0 for a spec 1. The answer here comes from
 * the table the standalone `Array.prototype` glue already reports, so the
 * instance spelling and `Array.prototype.<m>.length` cannot disagree.
 */
export function arrayLibMethodSpecLength(sig: ts.Signature): number | undefined {
  const decl = sig.getDeclaration?.();
  if (decl === undefined || !decl.getSourceFile().isDeclarationFile) return undefined;
  const owner = decl.parent;
  if (!owner || !ts.isInterfaceDeclaration(owner)) return undefined;
  if (owner.name.text !== "Array" && owner.name.text !== "ReadonlyArray") return undefined;
  const name = decl.name;
  return name !== undefined && ts.isIdentifier(name) ? arrayProtoMethodSpecLength(name.text) : undefined;
}
