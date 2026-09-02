function makeCounter(start: number): () => number {
  let c = start;
  return () => {
    c += 1;
    return c;
  };
}
export function entry(start: number): number {
  const next = makeCounter(start);
  next();
  next();
  return next();
}
