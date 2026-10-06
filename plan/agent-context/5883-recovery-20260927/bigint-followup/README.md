# BigInt follow-up — held implementation evidence

Documentation/data only; no runtime activation or acceptance. Apply provider
and dynamic-admission patches only after original integration.patch plus the
Symbol two-hunk patch from followup/. Test text files preserve exact source.
The String patch is explicitly an unsuccessful candidate, not a verified fix.
Old compiler, all fixtures/expectations and the PR hold remain required.

- Provider typecheck43085 exit0; candidate83829 exit1:48/63. Original ToObject
  improves14/20 to17/20, diagnostics12/12, additive BigInt19/31.
- Exact baseline608 additive31 run25925 exit1:1/31 versus19/31,18gains and zero
  passing losses. All31 source/hash pairs retained; native63/63 on candidate.
- String candidate41933 exit1:27/44, including unchanged BigInt19/31 and
  String8/13. Exact baseline89673 also8/13, same per-row results. No gain.
- Width discriminator38522 exit1:5/6. The narrow negative control fails, so
  these five passing cases are NOT evidence of full-width preservation.
- Generator sixth candidate is separate, not integrated:1203 exit1,14/22
  versus10/22. Original12/12, additive2/6, receiver0/4; no lost passing rows.
  The .then failure now traps; eight failures remain. Initial typecheck42666
  failed an AST annotation. The annotation-only repair rechecked87889 exit0.

Raw parent logs remain in owned worktrees under .tmp; JSON preserves available
source/native/compile/actual rows, but a thrown execution can lack an actual
or import row. Do not turn missing measurements into successful outcomes.
Wide formatting, constructor narrowing, overrides/shadowing, String/array
iterator cases, exact activation and prototype authority remain unfinished.

The full one-context activation plan is preserved for implementation. Russell
owns an unintegrated metadata-only occurrence-ownership foundation; Huygens
audits staged-instruction consumers. Neither is completed runtime activation.
Mendel investigates .then after false Promise wrapping was removed. Curie
investigates the unsuccessful String path. Singer is validating the latest
class accessor routing, with the sole compiler slot at this snapshot.
