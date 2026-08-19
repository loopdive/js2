// #4544 Part A — startup-isolation program.
//
// Does approximately nothing, so a wall-clock run of the compiled artifact is
// dominated by process exec + module instantiation rather than by any workload.
// `n` is threaded through and returned so the call cannot be folded away.
//
// This exists because the other corpus programs, even at their zero argument,
// still carry their own runtime scaffolds; this one isolates the floor that
// EVERY linear-backend module pays.
export function run(n: number): number {
  return n | 0;
}
