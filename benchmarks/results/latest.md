# js2wasm Benchmark Results

Date: 2026-09-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.051ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.120ms | 0.014ms | 0.026ms | gc-native |
| string/split | 0.425ms | 7.73ms | 2.63ms | FAILED | js |
| string/replace | 0.094ms | 0.594ms | 0.280ms | FAILED | js |
| string/case-convert | 0.059ms | 0.621ms | 0.242ms | FAILED | js |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.174ms | 3.45ms | 2.38ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 2.49ms | 2.51ms | 0.559ms | js |
| array/push-pop | 1.63ms | 0.593ms | 0.596ms | FAILED | host-call |
| array/sort-i32 | 0.852ms | 0.298ms | 0.297ms | FAILED | gc-native |
| array/map-filter | 0.135ms | 0.065ms | 0.065ms | FAILED | gc-native |
| array/reduce | 2.36ms | 0.604ms | 0.598ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.017ms | 0.016ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.97ms | 3.98ms | FAILED | host-call |
| array/forEach | 0.094ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.038ms | 0.101ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.234ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.141ms | — | — | js |
| dom/modify-text | 0.029ms | 0.111ms | — | — | js |
| mixed/csv-parse | 1.32ms | 8.07ms | 0.547ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 4.27ms | 2.45ms | 1.10ms | js |
| mixed/fibonacci | 0.125ms | 0.328ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.184ms | 67.28ms | 72.73ms | 0.723ms | js |
| mixed/sieve | 1.76ms | 2.30ms | 2.32ms | FAILED | js |

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
| string/concat-short | 10000 | 3.46 | 5.07 | 4.60 | — |
| string/concat-long | 1000 | 3.94 | 4.96 | 3.43 | — |
| string/indexOf | 1000 | 19.01 | 59.84 | 12.28 | 16.11 |
| string/includes | 1000 | 18.73 | 120.28 | 13.72 | 26.19 |
| string/split | 10000 | 42.48 | 772.53 | 262.69 | — |
| string/replace | 1000 | 93.68 | 593.92 | 280.40 | — |
| string/case-convert | 2000 | 29.28 | 310.74 | 120.90 | — |
| string/substring | 10000 | 10.51 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.36 | 344.53 | 237.89 | — |
| string/startsWith-endsWith | 20000 | 20.61 | 124.55 | 125.74 | 27.94 |
| array/map-filter | 30000 | 4.51 | 2.18 | 2.17 | — |
| array/indexOf | 1000 | 4459.56 | 2864.97 | 2862.33 | — |
| dom/create-elements | 2000 | 19.06 | 50.50 | — | — |
| dom/set-attributes | 6000 | 17.98 | 39.02 | — | — |
| dom/read-attributes | 3000 | 19.24 | 46.99 | — | — |
| dom/modify-text | 2000 | 14.55 | 55.55 | — | — |
| mixed/csv-parse | 11000 | 119.61 | 733.52 | 49.72 | — |
| mixed/text-search | 40000 | 10.08 | 106.73 | 61.24 | 27.56 |
| mixed/fibonacci | 10000 | 12.54 | 32.75 | 32.75 | 32.49 |
| mixed/matrix-multiply | 125000 | 1.48 | 538.23 | 581.88 | 5.78 |
| mixed/sieve | 200000 | 8.80 | 11.48 | 11.61 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.33x slower | — |
| string/concat-long | 1.26x slower | 1.15x faster | — |
| string/indexOf | 3.15x slower | 1.55x faster | 1.18x faster |
| string/includes | 6.42x slower | 1.37x faster | 1.40x slower |
| string/split | 18.19x slower | 6.18x slower | — |
| string/replace | 6.34x slower | 2.99x slower | — |
| string/case-convert | 10.61x slower | 4.13x slower | — |
| string/substring | 2.64x faster | 3.06x faster | — |
| string/trim | 19.84x slower | 13.70x slower | — |
| string/startsWith-endsWith | 6.04x slower | 6.10x slower | 1.36x slower |
| array/push-pop | 2.75x faster | 2.74x faster | — |
| array/sort-i32 | 2.86x faster | 2.87x faster | — |
| array/map-filter | 2.07x faster | 2.08x faster | — |
| array/reduce | 3.91x faster | 3.95x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.04x faster | 2.05x faster | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 3.29x faster | 3.28x faster | — |
| array/find | 18.54x faster | 18.43x faster | 4.44x slower |
| dom/create-elements | 2.65x slower | — | — |
| dom/set-attributes | 2.17x slower | — | — |
| dom/read-attributes | 2.44x slower | — | — |
| dom/modify-text | 3.82x slower | — | — |
| mixed/csv-parse | 6.13x slower | 2.41x faster | — |
| mixed/text-search | 10.59x slower | 6.08x slower | 2.73x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 364.79x slower | 394.37x slower | 3.92x slower |
| mixed/sieve | 1.30x slower | 1.32x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.45x faster |
| string/indexOf | 4.87x faster |
| string/includes | 8.77x faster |
| string/split | 2.94x faster |
| string/replace | 2.12x faster |
| string/case-convert | 2.57x faster |
| string/substring | 1.16x faster |
| string/trim | 1.45x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.75x faster |
| mixed/text-search | 1.74x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.08x slower |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1085.3ms | 580.6ms | — |
| string/concat-long | 428.7ms | 614.9ms | — |
| string/indexOf | 363.5ms | 626.3ms | 533.9ms |
| string/includes | 362.4ms | 645.7ms | 537.3ms |
| string/split | 486.0ms | 655.4ms | — |
| string/replace | 478.7ms | 728.1ms | — |
| string/case-convert | 507.3ms | 576.3ms | — |
| string/substring | 399.5ms | 444.2ms | — |
| string/trim | 469.6ms | 654.2ms | — |
| string/startsWith-endsWith | 474.0ms | 668.6ms | 616.2ms |
| array/push-pop | 507.2ms | 590.7ms | — |
| array/sort-i32 | 648.3ms | 696.8ms | — |
| array/map-filter | 639.8ms | 724.5ms | — |
| array/reduce | 592.6ms | 665.3ms | — |
| array/indexOf | 588.8ms | 628.5ms | — |
| array/slice | 493.7ms | 593.5ms | — |
| array/reverse | 475.9ms | 571.3ms | — |
| array/forEach | 626.1ms | 659.5ms | — |
| array/find | 484.8ms | 574.9ms | 529.9ms |
| dom/create-elements | 411.0ms | — | — |
| dom/set-attributes | 375.7ms | — | — |
| dom/read-attributes | 370.5ms | — | — |
| dom/modify-text | 361.0ms | — | — |
| mixed/csv-parse | 519.4ms | 648.6ms | — |
| mixed/text-search | 483.1ms | 678.5ms | 595.7ms |
| mixed/fibonacci | 461.9ms | 466.3ms | 470.7ms |
| mixed/matrix-multiply | 609.6ms | 680.3ms | 505.5ms |
| mixed/sieve | 594.3ms | 687.4ms | — |
