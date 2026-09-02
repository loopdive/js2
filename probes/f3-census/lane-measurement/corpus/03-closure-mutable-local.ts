export function entry(n: number): number {
  let total = 0;
  const bump = (k: number): void => {
    total += k;
  };
  for (let i = 0; i < n; i++) bump(i);
  return total;
}
