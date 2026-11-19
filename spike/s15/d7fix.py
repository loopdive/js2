import sys,re
pre, lib = sys.argv[1], sys.argv[2]
L = open(lib).read().split("\n")
i = next(k for k,l in enumerate(L) if l.startswith(" (global $global$12 (ref null $7) (struct.new $7"))
L.insert(i, ' (export "__undefined" (global $global$12))') if False else None
# exports must come after the global; append at end before closing paren
last = max(k for k,l in enumerate(L) if l == ')')
L.insert(last, ' (export "__undefined" (global $global$12))')
open(lib.replace(".wat",".u.wat"),"w").write("\n".join(L))
P = open(pre).read().split("\n")
s = next(k for k,l in enumerate(P) if l.startswith(" (global $global$2 (ref null $10) (struct.new $10"))
e = s+1
while not P[e].startswith(" ("): e += 1
del P[s:e]
imp = next(k for k,l in enumerate(P) if l.startswith(" (import"))
P.insert(imp, ' (import "legacy-lib" "__undefined" (global $global$2 (ref null $10)))')
open(pre.replace(".wat",".u.wat"),"w").write("\n".join(P))
