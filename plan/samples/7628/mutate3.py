# #7628 v3 mutations. usage: python3 mutate3.py <v3 tree> (with .tmp/7628/rows3.mts in it); applies each mutation,
# runs rows3, restores the file, prints the rows it fails.
import subprocess, sys, pathlib
T = pathlib.Path(sys.argv[1])
B, R, K = "src/ir/builtin-global-binding.ts", "src/ir/realm-member-writes.ts", "src/ir/key-values.ts"
LOOKUP = "env.has(id.text) ? env.get(id.text) : undefined"
M = {
  "N1 loop-head variable stores its initializer": [(B, "return (ts.isForInStatement(list.parent) || ts.isForOfStatement(list.parent)) && list.parent.initializer === list;", "return false;")],
  "N2 enum binds no value": [(B, "  ts.SyntaxKind.ImportAttribute,\n", "  ts.SyntaxKind.ImportAttribute,\n  ts.SyntaxKind.EnumDeclaration,\n")],
  "N2 namespace binds no value": [(B, "  ts.SyntaxKind.ImportAttribute,\n", "  ts.SyntaxKind.ImportAttribute,\n  ts.SyntaxKind.ModuleDeclaration,\n")],
  "N2 import = binds no value": [(B, "  ts.SyntaxKind.ImportAttribute,\n", "  ts.SyntaxKind.ImportAttribute,\n  ts.SyntaxKind.ImportEqualsDeclaration,\n")],
  "no record and no import binding": [(B, "  ts.SyntaxKind.ImportAttribute,\n", "  ts.SyntaxKind.ImportAttribute,\n  ts.SyntaxKind.ImportEqualsDeclaration,\n  ts.SyntaxKind.ImportSpecifier,\n  ts.SyntaxKind.ImportClause,\n  ts.SyntaxKind.NamespaceImport,\n"), (R, LOOKUP, "env.has(id.text) ? env.get(id.text) : bindings.has(id.text) ? undefined : new Set<KeyValue>()")],
  "N2 every import binds no value": [(B, "  ts.SyntaxKind.ImportAttribute,\n", "  ts.SyntaxKind.ImportAttribute,\n  ts.SyntaxKind.ImportEqualsDeclaration,\n  ts.SyntaxKind.ImportSpecifier,\n  ts.SyntaxKind.ImportClause,\n  ts.SyntaxKind.NamespaceImport,\n")],
  "CTL types record any": [(B, "  ts.SyntaxKind.InterfaceDeclaration,\n  ts.SyntaxKind.TypeAliasDeclaration,\n", "")],
  "no implicit arguments": [(B, '      bind("arguments", ANY);', "      ;")],
  "worklist: no re-queue of readers": [(R, "    readers.get(name)?.forEach((reader) => queue.add(reader));", "")],
  "a name with no record holds no value": [(R, LOOKUP, "env.has(id.text) ? env.get(id.text) : bindings.has(id.text) ? undefined : new Set<KeyValue>()")],
  "drop the rebound names": [(R, "    if (rebound.has(name)) continue;\n", "")],
  "postfix ++ is no number": [(K, "  if (ts.isPostfixUnaryExpression(node)) return ONE_SOME_NUMBER;", "  if (ts.isPostfixUnaryExpression(node)) return undefined;")],
}
for name, edits in M.items():
    saved = {}
    for f, old, new in edits:
        p = T / f
        saved.setdefault(f, p.read_text())
        s = (T / f).read_text()
        n = s.count(old)
        assert n >= 1, (name, old)
        p.write_text(s.replace(old, new))
    out = subprocess.run(["npx", "tsx", ".tmp/7628/rows3.mts"], cwd=T, capture_output=True, text=True).stdout
    for f, s in saved.items(): (T / f).write_text(s)
    diffs = [l[5:35].strip() for l in out.splitlines() if l.startswith("DIFF")]
    print(f"{name}: {len(diffs)} fail: {', '.join(diffs)}")
