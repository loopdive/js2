// Every expression of every test262 test file: base exactPreparedAccessorExpressionKey vs v2 exactKey(keyValues(e)).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ts } from "./trees/v2/src/ts-api.js";
import { exactPreparedAccessorExpressionKey as old } from "./trees/base/src/ir/class-accessor-safety.js";
import { exactKey, keyValues } from "./trees/v2/src/ir/key-values.js";
const root = process.argv[2];
let files = 0, exprs = 0, defined = 0, mismatches = 0;
const walk = (dir: string): void => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) check(p);
  }
};
const check = (p: string) => {
  files++;
  const sf = ts.createSourceFile(p, readFileSync(p, "utf8"), ts.ScriptTarget.Latest, true);
  const v = (n: ts.Node): void => {
    if (ts.isExpression(n)) {
      exprs++;
      const a = old(n), b = exactKey(keyValues(n));
      if (a !== undefined) defined++;
      if (a !== b && !(Number.isNaN(Number(a)) && a === b)) {
        mismatches++;
        if (mismatches <= 20) console.log("MISMATCH", p, JSON.stringify(n.getText().slice(0, 80)), a, b);
      }
    }
    ts.forEachChild(n, v);
  };
  v(sf);
};
walk(root);
console.log(JSON.stringify({ files, exprs, defined, mismatches }));
