# js2wasm Benchmark Results

Date: 2026-09-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.053ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.024ms | gc-native |
| string/includes | 0.019ms | 0.126ms | 0.014ms | 0.038ms | gc-native |
| string/split | 0.424ms | 8.07ms | 2.67ms | FAILED | js |
| string/replace | 0.097ms | 0.586ms | 0.277ms | FAILED | js |
| string/case-convert | 0.058ms | 0.527ms | 0.243ms | FAILED | js |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.33ms | 2.38ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.53ms | 2.53ms | 0.553ms | js |
| array/push-pop | 1.66ms | 0.601ms | 0.604ms | FAILED | host-call |
| array/sort-i32 | 0.847ms | 0.303ms | 0.301ms | FAILED | gc-native |
| array/map-filter | 0.137ms | 0.066ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.38ms | 0.597ms | 0.597ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.017ms | 0.017ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.038ms | 0.102ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.241ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.137ms | — | — | js |
| dom/modify-text | 0.030ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.466ms | 8.04ms | 0.549ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.33ms | 2.50ms | 1.13ms | js |
| mixed/fibonacci | 0.125ms | 0.328ms | 0.327ms | 0.325ms | js |
| mixed/matrix-multiply | 0.185ms | 69.02ms | 67.43ms | 0.725ms | js |
| mixed/sieve | 1.77ms | 2.32ms | 2.32ms | FAILED | js |

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
| string/concat-short | 10000 | 3.04 | 5.30 | 4.53 | — |
| string/concat-long | 1000 | 4.09 | 5.10 | 3.66 | — |
| string/indexOf | 1000 | 18.96 | 63.97 | 12.25 | 24.22 |
| string/includes | 1000 | 18.70 | 125.78 | 13.87 | 38.02 |
| string/split | 10000 | 42.42 | 806.54 | 266.80 | — |
| string/replace | 1000 | 96.89 | 586.04 | 277.25 | — |
| string/case-convert | 2000 | 29.05 | 263.63 | 121.34 | — |
| string/substring | 10000 | 10.49 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.31 | 333.34 | 238.33 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 126.36 | 126.67 | 27.63 |
| array/map-filter | 30000 | 4.55 | 2.20 | 2.20 | — |
| array/indexOf | 1000 | 4458.82 | 2864.31 | 2860.81 | — |
| dom/create-elements | 2000 | 19.17 | 50.89 | — | — |
| dom/set-attributes | 6000 | 18.31 | 40.09 | — | — |
| dom/read-attributes | 3000 | 20.03 | 45.75 | — | — |
| dom/modify-text | 2000 | 15.24 | 57.15 | — | — |
| mixed/csv-parse | 11000 | 42.35 | 730.76 | 49.89 | — |
| mixed/text-search | 40000 | 10.07 | 108.30 | 62.43 | 28.22 |
| mixed/fibonacci | 10000 | 12.53 | 32.75 | 32.75 | 32.50 |
| mixed/matrix-multiply | 125000 | 1.48 | 552.18 | 539.44 | 5.80 |
| mixed/sieve | 200000 | 8.86 | 11.58 | 11.60 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.74x slower | 1.49x slower | — |
| string/concat-long | 1.25x slower | 1.12x faster | — |
| string/indexOf | 3.37x slower | 1.55x faster | 1.28x slower |
| string/includes | 6.73x slower | 1.35x faster | 2.03x slower |
| string/split | 19.01x slower | 6.29x slower | — |
| string/replace | 6.05x slower | 2.86x slower | — |
| string/case-convert | 9.08x slower | 4.18x slower | — |
| string/substring | 2.63x faster | 3.05x faster | — |
| string/trim | 19.26x slower | 13.77x slower | — |
| string/startsWith-endsWith | 6.12x slower | 6.14x slower | 1.34x slower |
| array/push-pop | 2.76x faster | 2.75x faster | — |
| array/sort-i32 | 2.80x faster | 2.81x faster | — |
| array/map-filter | 2.07x faster | 2.07x faster | — |
| array/reduce | 3.99x faster | 3.99x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.14x faster | 2.15x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.84x faster | 1.83x faster | — |
| array/find | 18.19x faster | 17.96x faster | 4.46x slower |
| dom/create-elements | 2.66x slower | — | — |
| dom/set-attributes | 2.19x slower | — | — |
| dom/read-attributes | 2.28x slower | — | — |
| dom/modify-text | 3.75x slower | — | — |
| mixed/csv-parse | 17.26x slower | 1.18x slower | — |
| mixed/text-search | 10.76x slower | 6.20x slower | 2.80x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 373.44x slower | 364.83x slower | 3.92x slower |
| mixed/sieve | 1.31x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.17x faster |
| string/concat-long | 1.40x faster |
| string/indexOf | 5.22x faster |
| string/includes | 9.07x faster |
| string/split | 3.02x faster |
| string/replace | 2.11x faster |
| string/case-convert | 2.17x faster |
| string/substring | 1.16x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.65x faster |
| mixed/text-search | 1.73x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x faster |
| mixed/sieve | 1.00x slower |

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
| array/sort-i32 | 3.3KB | 3.9KB | — |
| array/map-filter | 4.5KB | 5.0KB | — |
| array/reduce | 3.1KB | 3.6KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.5KB | 4.1KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1178.2ms | 627.6ms | — |
| string/concat-long | 447.4ms | 668.4ms | — |
| string/indexOf | 384.1ms | 676.5ms | 556.3ms |
| string/includes | 381.7ms | 692.8ms | 568.5ms |
| string/split | 518.0ms | 703.6ms | — |
| string/replace | 496.6ms | 759.1ms | — |
| string/case-convert | 512.4ms | 694.1ms | — |
| string/substring | 395.2ms | 475.2ms | — |
| string/trim | 477.2ms | 672.7ms | — |
| string/startsWith-endsWith | 482.6ms | 684.9ms | 633.5ms |
| array/push-pop | 494.4ms | 589.1ms | — |
| array/sort-i32 | 659.1ms | 743.6ms | — |
| array/map-filter | 691.2ms | 729.4ms | — |
| array/reduce | 614.0ms | 698.8ms | — |
| array/indexOf | 590.3ms | 682.7ms | — |
| array/slice | 544.7ms | 602.2ms | — |
| array/reverse | 502.1ms | 569.4ms | — |
| array/forEach | 663.1ms | 700.1ms | — |
| array/find | 492.7ms | 582.5ms | 562.1ms |
| dom/create-elements | 425.6ms | — | — |
| dom/set-attributes | 383.1ms | — | — |
| dom/read-attributes | 384.4ms | — | — |
| dom/modify-text | 388.9ms | — | — |
| mixed/csv-parse | 521.2ms | 684.3ms | — |
| mixed/text-search | 493.4ms | 682.1ms | 648.6ms |
| mixed/fibonacci | 460.7ms | 508.5ms | 484.6ms |
| mixed/matrix-multiply | 627.4ms | 675.4ms | 507.9ms |
| mixed/sieve | 593.8ms | 664.7ms | — |
