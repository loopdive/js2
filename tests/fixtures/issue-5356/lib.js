// #5356 — a hoisted inner `function` that mutates an enclosing `let`/`const`.
// Untyped `.js` on purpose: the upstream npm suites feed package code in this
// shape, and a `: any` annotation routes the binding through a different arm.

// The issue's minimal reproduction: the only call sits in a branch that never
// runs, so the lazily minted cell stayed null and every later read was null.
export function deadBranch() {
  let output = "";
  output += "a";
  if (output === "zzz") {
    trim();
  }
  return "v=" + JSON.stringify(output);
  function trim() {
    output = "";
  }
}

export function neverCalled() {
  let output = "";
  output += "a";
  output += "a";
  return "v=" + JSON.stringify(output);
  function trim() {
    output = "";
  }
}

export function numberCounter() {
  let count = 0;
  count += 1;
  count += 1;
  if (count > 100) {
    reset();
  }
  return count;
  function reset() {
    count = 0;
  }
}

export function takenBranch() {
  let output = "";
  output += "a";
  if (output === "a") {
    trim();
  }
  output += "b";
  return "v=" + JSON.stringify(output);
  function trim() {
    output = "";
  }
}

export function counterInLoop() {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    if (i === 99) reset();
    n += i;
  }
  return n;
  function reset() {
    n = 0;
  }
}

export function twoSiblings() {
  let total = 0;
  function add(k) {
    total += k;
  }
  function reset() {
    total = 0;
  }
  if (total > 100) reset();
  add(3);
  add(4);
  return total;
}

export function asyncNested() {
  let count = 0;
  async function inc() {
    count += 1;
  }
  if (count > 100) inc();
  count += 5;
  return count;
}

// The race the bare #2692-skip removal introduced: a `let` declared directly
// in a `case` clause and mutated by a clause-level function. The case-scope
// logic decided "this clause's own binding" by comparing `localMap` with the
// raw pre-hoisted slot; once that slot's cell was live it hid the binding and
// gave the declaration a second slot, so `bump` incremented a stale 0 ("1").
export function switchClause(k) {
  let out = "";
  switch (k) {
    case 2:
      let count = 5;
      function bump() {
        count += 1;
      }
      bump();
      out = String(count);
      break;
    default:
      out = "d";
  }
  return out;
}

// Block-level function + block `let` inside a loop body (#2814 re-install path).
export function loopBlock() {
  let out = "";
  for (let i = 0; i < 3; i++) {
    let x = i * 10;
    function bump() {
      x += 1;
    }
    if (i === 1) bump();
    out += String(x) + ",";
  }
  return out;
}

// A block-scoped redeclaration shadows the captured outer name; a call inside
// the block must forward the OUTER binding's cell and must not hijack the
// inner binding's name (a dead call did on the parent: the inner read null).
export function shadowDead() {
  let output = "x";
  {
    let output = "inner";
    output += "!";
    if (output === "zzz") trim();
    output += "?";
    if (output !== "inner!?") return "BAD:" + String(output);
  }
  if (output === "zzz") trim();
  return output;
  function trim() {
    output = "";
  }
}

export function shadowTaken() {
  let output = "x";
  {
    let output = "inner";
    if (output === "inner") trim();
    output += "?";
    if (output !== "inner?") return "BAD:" + String(output);
  }
  return "outer=" + String(output);
  function trim() {
    output = "cleared";
  }
}

// Destructured `let` bindings captured by a mutator: the element stores must
// write through the cell (array lane trapped with `illegal cast`).
export function arrDstr(arr) {
  let [a, b] = arr;
  if (a > 100) bump();
  return a + b;
  function bump() {
    a = 0;
  }
}

export function objDstr(obj) {
  let { n } = obj;
  if (n > 100) bump();
  n += 1;
  return n;
  function bump() {
    n = 0;
  }
}

// prettier's `printDocToString` skeleton (the shape behind #5346): a command
// stack whose destructured `doc` shadows the parameter, `let output` mutated
// by a hoisted `trim` whose call sites all sit inside switch arms.
function getDocType(doc) {
  if (typeof doc === "string") return "string";
  if (Array.isArray(doc)) return "array";
  if (!doc) return undefined;
  return doc.type;
}

export function printDocToString(doc) {
  let position = 0;
  const commands = [{ indent: 0, mode: 1, doc }];
  let output = "";
  const settledOutput = [];
  let settledTextLength = 0;
  while (commands.length > 0) {
    const { indent, mode, doc } = commands.pop();
    switch (getDocType(doc)) {
      case "string": {
        const formatted = doc;
        if (formatted) {
          output += formatted;
          if (commands.length > 0) position += formatted.length;
        }
        break;
      }
      case "array":
        for (let index = doc.length - 1; index >= 0; index--) {
          const command = { indent, mode, doc: doc[index] };
          commands.push(command);
        }
        break;
      case "trim":
        trim();
        break;
      case "line":
        trim();
        output += "\n";
        position = 0;
        break;
      default:
        throw new Error("invalid doc " + String(doc));
    }
  }
  return settledOutput.join("") + output;

  function trim() {
    const trimmed = output.trimEnd();
    const count = output.length - trimmed.length;
    if (trimmed) {
      settledOutput.push(trimmed);
      settledTextLength += trimmed.length;
    }
    output = "";
    position -= count;
  }
}
