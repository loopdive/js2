export function entry(n: number): number {
  const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1));
  return fact(n);
}
