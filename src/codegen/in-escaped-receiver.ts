import ts from "typescript";

/**
 * (#4765) Has `name` been handed to a call as an argument or as a `this`
 * value anywhere in `file`?
 *
 * The `in` fold answers §7.3.12 from the receiver's COMPILE-TIME struct shape.
 * That is sound only while the compiler owns the object's shape — and it stops
 * owning it the moment the object is passed to a callee it cannot see through.
 * The callee may delete a property, and the struct's field list does not shrink
 * on delete, so the fold keeps reporting the key as present:
 *
 *   var a = { "9007199254740990": "y", length: 2 ** 53 - 1 };
 *   Array.prototype.pop.call(a);          // host pop deletes the last index
 *   "9007199254740990" in a               // folded true; spec says false
 *
 * `hasOwnProperty` was already correct here — it consults the delete tombstone
 * (`_wasmStructDeletedKeys`). So does `__extern_has`. Only the fold disagreed,
 * which is what the test262 "…is removed" family asserts across
 * `Array.prototype.{pop,splice,unshift}`.
 *
 * Note the deletion comes from HOST code, not from a `delete` statement, so no
 * "this module uses delete" signal can catch it — the receiver escaping is the
 * only observable. Standalone already has an equivalent guard for its own
 * growable-`$Object` receivers (`growableObjectLiteralVars`), but that set is
 * populated by a shape-widening pass that does not run in the host lane, so the
 * host lane needs this separate, value-independent question.
 *
 * Deliberately conservative and cheap, mirroring `identifierIsWrittenTo`
 * (the #4484 D / #4515 guard in the same function, which scans the file for
 * writes to the receiver binding for exactly the same "the static type is not a
 * fact about this site" reason). Being wrong in the permissive direction only
 * costs one `__extern_has` call on an `in` — never a wrong answer — whereas
 * being wrong in the restrictive direction is the folded-`true` bug above.
 */
export function identifierEscapesToCall(file: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const arg of node.arguments ?? []) {
        if (ts.isIdentifier(arg) && arg.text === name) {
          found = true;
          return;
        }
        // `f.call(a, …)` / `f.apply(a, …)` pass `a` as the `this` value — the
        // shape of the call that actually reaches these test262 rows.
        if (ts.isSpreadElement(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === name) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
