# Native string/value consumer wiring — current census

Read-only census against scanner integration base bfe31c8 plus current
working changes; this is input to High's implementation specification.

The public compiler still calls generateModule/generateMultiModule in
src/compiler.ts:1079. src/compiler/output.ts also calls generateModule.
The internal runIrProgramDriver prepares, accepts and emits the whole
program, but the source search finds no production caller of that driver.
This directly contradicts any claim that public IR cutover is complete.

materializePhysicalProgram in src/ir/program-consumer.ts reserves vectors,
not the implemented native string, flatten, scanner or value producers.
Its resolver lacks resolveString/emitStringConst, and emitted-function
ownership accounts for program bodies, startup and vectors only.
PhysicalSetupPlan in src/ir/program-physical-plan.ts carries vectors but no
string/value resources; non-vector runtime callable/storage acceptance and
exact literal/helper/global ABI publication still need implementation.

The existing source-free join must receive the authenticated full program,
selected standalone/WasmGC projection, explicit representation/utf8Storage,
ordered literal demands and encoding evidence from allocation metadata.
Preserve real storage/materializer identities, oversized literal handling,
and the UTF16 empty literal required by flatten. Legacy prepareStringConst
in src/ir/integration.ts is reference behavior, not permission to call the
legacy compiler from the new physical consumer.

Use one transaction and the real chain strings -> flatten -> scanner ->
values, reserving before a single freeze and filling afterwards. Scanner
and values require the exact same issued plan object and string pack.
freezePreparedIrValue copies data and therefore cannot preserve an issued
plan's private authentication identity; keep issuance separate from copied
descriptive setup data.

Next scope for High: source-free demand planning, exact resource ownership,
prepared-consumer reservation/resolver/ABI wiring, and actual execution
through that consumer. Public-driver cutover, complete string operations,
other native families and strict direct retirement remain required later
steps, not excused by this census or the current resource tests.
