export function calculate(x: number): number {
  return new Function("x", "return x + 9")(x);
}
