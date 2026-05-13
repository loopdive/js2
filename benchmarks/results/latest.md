# js2wasm Benchmark Results

Date: 2026-05-08
Node: v25.2.1
Platform: darwin arm64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.090ms | 0.103ms | 0.089ms | — | gc-native |
| string/concat-long | 0.012ms | 0.009ms | 0.015ms | — | host-call |
| string/indexOf | 0.014ms | 0.286ms | 0.038ms | — | js |
| string/includes | 0.015ms | 0.282ms | 0.044ms | — | js |
| string/split | 0.262ms | 9.14ms | 1.19ms | — | js |
| string/replace | 0.030ms | 0.291ms | 0.091ms | — | js |
| string/case-convert | <0.001ms | 0.681ms | 0.068ms | — | js |
| string/substring | 0.003ms | 3.04ms | 0.036ms | — | js |
| string/trim | 0.117ms | 2.49ms | 0.169ms | — | js |
| string/startsWith-endsWith | 0.325ms | 5.52ms | 0.287ms | — | gc-native |
| array/push-pop | 0.664ms | 0.738ms | 0.582ms | — | gc-native |
| array/sort-i32 | 0.526ms | 0.152ms | 0.122ms | — | gc-native |
| array/map-filter | 0.116ms | 0.250ms | — | — | js |
| array/reduce | 1.44ms | 0.845ms | — | — | host-call |
| array/indexOf | 1.08ms | 2.69ms | 2.70ms | — | js |
| array/slice | 0.014ms | 0.028ms | 0.025ms | — | js |
| array/reverse | 6.59ms | 3.95ms | 3.99ms | — | host-call |
| array/forEach | 0.049ms | 0.067ms | — | 0.012ms | linear-memory |
| array/find | 0.329ms | 0.694ms | — | — | js |
| dom/create-elements | 0.027ms | 0.012ms | — | — | host-call |
| dom/set-attributes | 0.092ms | 0.013ms | — | — | host-call |
| dom/read-attributes | 0.253ms | — | — | — | js |
| dom/modify-text | 0.338ms | 0.041ms | — | — | host-call |
| mixed/csv-parse | 0.302ms | 13.90ms | 0.846ms | — | js |
| mixed/text-search | 0.182ms | 12.22ms | 1.01ms | — | js |
| mixed/fibonacci | 0.111ms | 0.115ms | 0.091ms | 0.205ms | gc-native |
| mixed/matrix-multiply | 0.174ms | 0.315ms | 0.139ms | — | gc-native |
| mixed/sieve | 1.07ms | 0.975ms | 0.810ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.14x slower | 1.01x faster | — |
| string/concat-long | 1.35x faster | 1.24x slower | — |
| string/indexOf | 21.17x slower | 2.81x slower | — |
| string/includes | 18.74x slower | 2.91x slower | — |
| string/split | 34.84x slower | 4.54x slower | — |
| string/replace | 9.58x slower | 3.00x slower | — |
| string/case-convert | 1633.04x slower | 162.22x slower | — |
| string/substring | 890.07x slower | 10.61x slower | — |
| string/trim | 21.37x slower | 1.45x slower | — |
| string/startsWith-endsWith | 16.97x slower | 1.13x faster | — |
| array/push-pop | 1.11x slower | 1.14x faster | — |
| array/sort-i32 | 3.47x faster | 4.31x faster | — |
| array/map-filter | 2.16x slower | — | — |
| array/reduce | 1.71x faster | — | — |
| array/indexOf | 2.49x slower | 2.49x slower | — |
| array/slice | 2.00x slower | 1.74x slower | — |
| array/reverse | 1.67x faster | 1.65x faster | — |
| array/forEach | 1.36x slower | — | 4.13x faster |
| array/find | 2.11x slower | — | — |
| dom/create-elements | 2.19x faster | — | — |
| dom/set-attributes | 6.95x faster | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 8.19x faster | — | — |
| mixed/csv-parse | 45.95x slower | 2.80x slower | — |
| mixed/text-search | 67.29x slower | 5.54x slower | — |
| mixed/fibonacci | 1.04x slower | 1.23x faster | 1.84x slower |
| mixed/matrix-multiply | 1.81x slower | 1.25x faster | — |
| mixed/sieve | 1.10x faster | 1.33x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.67x slower |
| string/indexOf | 7.53x faster |
| string/includes | 6.43x faster |
| string/split | 7.68x faster |
| string/replace | 3.19x faster |
| string/case-convert | 10.07x faster |
| string/substring | 83.90x faster |
| string/trim | 14.75x faster |
| string/startsWith-endsWith | 19.20x faster |
| array/push-pop | 1.27x faster |
| array/sort-i32 | 1.24x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.15x faster |
| array/reverse | 1.01x slower |
| mixed/csv-parse | 16.42x faster |
| mixed/text-search | 12.15x faster |
| mixed/fibonacci | 1.27x faster |
| mixed/matrix-multiply | 2.27x faster |
| mixed/sieve | 1.20x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 283B | 4.2KB | — |
| string/concat-long | 325B | 4.2KB | — |
| string/indexOf | 337B | 4.2KB | — |
| string/includes | 348B | 4.2KB | — |
| string/split | 422B | 4.3KB | — |
| string/replace | 370B | 4.3KB | — |
| string/case-convert | 355B | 4.2KB | — |
| string/substring | 323B | 4.2KB | — |
| string/trim | 283B | 4.2KB | — |
| string/startsWith-endsWith | 436B | 4.4KB | — |
| array/push-pop | 516B | 4.5KB | — |
| array/sort-i32 | 1.7KB | 5.7KB | — |
| array/map-filter | 1.0KB | — | — |
| array/reduce | 567B | — | — |
| array/indexOf | 578B | 4.6KB | — |
| array/slice | 669B | 4.6KB | — |
| array/reverse | 602B | 4.6KB | — |
| array/forEach | 831B | — | 3.6KB |
| array/find | 860B | — | — |
| dom/create-elements | 391B | — | — |
| dom/set-attributes | 636B | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 451B | — | — |
| mixed/csv-parse | 886B | 4.9KB | — |
| mixed/text-search | 734B | 4.8KB | — |
| mixed/fibonacci | 323B | 4.2KB | 3.7KB |
| mixed/matrix-multiply | 1.1KB | 4.9KB | — |
| mixed/sieve | 1.0KB | 4.9KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 777.6ms | 384.1ms | — |
| string/concat-long | 239.8ms | 218.7ms | — |
| string/indexOf | 197.8ms | 204.0ms | — |
| string/includes | 192.5ms | 226.8ms | — |
| string/split | 214.0ms | 196.3ms | — |
| string/replace | 265.4ms | 215.2ms | — |
| string/case-convert | 296.6ms | 373.0ms | — |
| string/substring | 263.8ms | 211.4ms | — |
| string/trim | 211.5ms | 185.5ms | — |
| string/startsWith-endsWith | 210.5ms | 236.5ms | — |
| array/push-pop | 181.9ms | 187.9ms | — |
| array/sort-i32 | 253.1ms | 222.0ms | — |
| array/map-filter | 194.0ms | — | — |
| array/reduce | 212.9ms | — | — |
| array/indexOf | 183.8ms | 224.2ms | — |
| array/slice | 174.5ms | 184.1ms | — |
| array/reverse | 210.2ms | 196.5ms | — |
| array/forEach | 198.8ms | — | 182.4ms |
| array/find | 213.8ms | — | — |
| dom/create-elements | 244.7ms | — | — |
| dom/set-attributes | 241.8ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 361.2ms | — | — |
| mixed/csv-parse | 233.3ms | 237.7ms | — |
| mixed/text-search | 216.6ms | 188.2ms | — |
| mixed/fibonacci | 201.4ms | 183.6ms | 182.0ms |
| mixed/matrix-multiply | 204.2ms | 210.0ms | — |
| mixed/sieve | 186.4ms | 184.4ms | — |
