# js2wasm Benchmark Results

Date: 2026-09-27
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.041ms | 0.040ms | FAILED | js |
| string/concat-long | 0.003ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.013ms | gc-native |
| string/includes | 0.015ms | 0.098ms | 0.011ms | 0.013ms | gc-native |
| string/split | 0.327ms | 6.11ms | 2.04ms | FAILED | js |
| string/replace | 0.075ms | 0.460ms | 0.213ms | FAILED | js |
| string/case-convert | 0.046ms | 0.437ms | 0.188ms | FAILED | js |
| string/substring | 0.083ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.136ms | 2.69ms | 1.89ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.98ms | 1.95ms | 0.434ms | js |
| array/push-pop | 1.36ms | 0.478ms | 0.480ms | FAILED | host-call |
| array/sort-i32 | 0.655ms | 0.238ms | 0.238ms | FAILED | host-call |
| array/map-filter | 0.111ms | 0.054ms | 0.054ms | FAILED | gc-native |
| array/reduce | 1.96ms | 0.492ms | 0.490ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.015ms | 0.015ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.045ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.214ms | 0.012ms | 0.013ms | 0.944ms | host-call |
| dom/create-elements | 0.031ms | 0.124ms | — | — | js |
| dom/set-attributes | 0.087ms | 0.186ms | — | — | js |
| dom/read-attributes | 0.050ms | 0.106ms | — | — | js |
| dom/modify-text | 0.024ms | 0.090ms | — | — | js |
| mixed/csv-parse | 0.365ms | 6.58ms | 0.436ms | FAILED | js |
| mixed/text-search | 0.312ms | 3.18ms | 1.91ms | 0.872ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.148ms | 54.00ms | 54.37ms | 0.563ms | js |
| mixed/sieve | 1.39ms | 1.84ms | 1.82ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.76 | 4.06 | 3.96 | — |
| string/concat-long | 1000 | 3.49 | 4.56 | 3.09 | — |
| string/indexOf | 1000 | 14.87 | 46.89 | 10.01 | 13.00 |
| string/includes | 1000 | 14.61 | 98.17 | 11.22 | 13.38 |
| string/split | 10000 | 32.67 | 610.52 | 203.90 | — |
| string/replace | 1000 | 74.90 | 460.10 | 213.40 | — |
| string/case-convert | 2000 | 23.09 | 218.64 | 94.24 | — |
| string/substring | 10000 | 8.29 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.57 | 268.64 | 189.17 | — |
| string/startsWith-endsWith | 20000 | 16.00 | 99.09 | 97.59 | 21.69 |
| array/map-filter | 30000 | 3.69 | 1.81 | 1.79 | — |
| array/indexOf | 1000 | 3461.78 | 2222.59 | 2221.64 | — |
| dom/create-elements | 2000 | 15.63 | 61.80 | — | — |
| dom/set-attributes | 6000 | 14.55 | 31.03 | — | — |
| dom/read-attributes | 3000 | 16.74 | 35.19 | — | — |
| dom/modify-text | 2000 | 11.85 | 45.24 | — | — |
| mixed/csv-parse | 11000 | 33.22 | 597.77 | 39.68 | — |
| mixed/text-search | 40000 | 7.81 | 79.62 | 47.84 | 21.79 |
| mixed/fibonacci | 10000 | 9.72 | 25.40 | 25.40 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.18 | 432.02 | 434.93 | 4.51 |
| mixed/sieve | 200000 | 6.93 | 9.21 | 9.11 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.43x slower | — |
| string/concat-long | 1.31x slower | 1.13x faster | — |
| string/indexOf | 3.15x slower | 1.49x faster | 1.14x faster |
| string/includes | 6.72x slower | 1.30x faster | 1.09x faster |
| string/split | 18.69x slower | 6.24x slower | — |
| string/replace | 6.14x slower | 2.85x slower | — |
| string/case-convert | 9.47x slower | 4.08x slower | — |
| string/substring | 2.68x faster | 3.11x faster | — |
| string/trim | 19.80x slower | 13.94x slower | — |
| string/startsWith-endsWith | 6.20x slower | 6.10x slower | 1.36x slower |
| array/push-pop | 2.85x faster | 2.84x faster | — |
| array/sort-i32 | 2.76x faster | 2.75x faster | — |
| array/map-filter | 2.04x faster | 2.06x faster | — |
| array/reduce | 3.98x faster | 3.99x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.31x faster | 2.34x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.92x faster | 1.93x faster | — |
| array/find | 17.54x faster | 16.84x faster | 4.41x slower |
| dom/create-elements | 3.95x slower | — | — |
| dom/set-attributes | 2.13x slower | — | — |
| dom/read-attributes | 2.10x slower | — | — |
| dom/modify-text | 3.82x slower | — | — |
| mixed/csv-parse | 18.00x slower | 1.19x slower | — |
| mixed/text-search | 10.20x slower | 6.13x slower | 2.79x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 365.98x slower | 368.44x slower | 3.82x slower |
| mixed/sieve | 1.33x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.48x faster |
| string/indexOf | 4.68x faster |
| string/includes | 8.75x faster |
| string/split | 2.99x faster |
| string/replace | 2.16x faster |
| string/case-convert | 2.32x faster |
| string/substring | 1.16x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.02x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.04x slower |
| mixed/csv-parse | 15.07x faster |
| mixed/text-search | 1.66x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 871.4ms | 488.1ms | — |
| string/concat-long | 346.1ms | 513.1ms | — |
| string/indexOf | 302.4ms | 532.5ms | 432.2ms |
| string/includes | 307.3ms | 518.6ms | 437.7ms |
| string/split | 418.6ms | 547.2ms | — |
| string/replace | 396.0ms | 591.0ms | — |
| string/case-convert | 411.9ms | 478.2ms | — |
| string/substring | 314.0ms | 384.5ms | — |
| string/trim | 391.2ms | 541.1ms | — |
| string/startsWith-endsWith | 505.4ms | 562.5ms | 477.6ms |
| array/push-pop | 391.3ms | 448.1ms | — |
| array/sort-i32 | 517.5ms | 547.1ms | — |
| array/map-filter | 540.1ms | 571.0ms | — |
| array/reduce | 497.4ms | 528.6ms | — |
| array/indexOf | 473.7ms | 536.7ms | — |
| array/slice | 396.5ms | 475.0ms | — |
| array/reverse | 386.1ms | 455.2ms | — |
| array/forEach | 493.5ms | 558.8ms | — |
| array/find | 384.0ms | 464.0ms | 417.6ms |
| dom/create-elements | 336.6ms | — | — |
| dom/set-attributes | 301.1ms | — | — |
| dom/read-attributes | 308.2ms | — | — |
| dom/modify-text | 298.9ms | — | — |
| mixed/csv-parse | 403.4ms | 527.0ms | — |
| mixed/text-search | 405.6ms | 552.1ms | 484.4ms |
| mixed/fibonacci | 367.6ms | 395.2ms | 378.3ms |
| mixed/matrix-multiply | 506.3ms | 558.9ms | 418.6ms |
| mixed/sieve | 492.0ms | 543.2ms | — |
