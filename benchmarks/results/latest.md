# js2wasm Benchmark Results

Date: 2026-09-18
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.055ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.120ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.438ms | 7.78ms | 2.58ms | FAILED | js |
| string/replace | 0.097ms | 0.570ms | 0.283ms | FAILED | js |
| string/case-convert | 0.058ms | 0.546ms | 0.234ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.28ms | 2.35ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.48ms | 2.44ms | 0.553ms | js |
| array/push-pop | 1.61ms | 0.592ms | 0.591ms | FAILED | gc-native |
| array/sort-i32 | 0.842ms | 0.296ms | 0.305ms | FAILED | host-call |
| array/map-filter | 0.134ms | 0.066ms | 0.065ms | FAILED | gc-native |
| array/reduce | 1.59ms | 0.597ms | 0.594ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.98ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.12ms | gc-native |
| dom/create-elements | 0.226ms | 0.105ms | — | — | host-call |
| dom/set-attributes | 0.113ms | 0.240ms | — | — | js |
| dom/read-attributes | 0.063ms | 0.137ms | — | — | js |
| dom/modify-text | 0.033ms | 0.117ms | — | — | js |
| mixed/csv-parse | 0.491ms | 8.33ms | 0.547ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.39ms | 2.62ms | 1.13ms | js |
| mixed/fibonacci | 0.125ms | 0.328ms | 0.327ms | 0.325ms | js |
| mixed/matrix-multiply | 0.186ms | 63.67ms | 64.74ms | 0.722ms | js |
| mixed/sieve | 1.79ms | 2.34ms | 2.32ms | FAILED | js |

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
| string/concat-short | 10000 | 3.46 | 5.47 | 4.49 | — |
| string/concat-long | 1000 | 4.13 | 5.39 | 3.53 | — |
| string/indexOf | 1000 | 18.98 | 59.86 | 12.16 | 17.31 |
| string/includes | 1000 | 18.71 | 119.52 | 13.81 | 16.84 |
| string/split | 10000 | 43.80 | 778.47 | 257.70 | — |
| string/replace | 1000 | 96.55 | 570.48 | 283.44 | — |
| string/case-convert | 2000 | 29.01 | 272.79 | 117.24 | — |
| string/substring | 10000 | 10.44 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.30 | 328.37 | 235.16 | — |
| string/startsWith-endsWith | 20000 | 20.67 | 124.16 | 122.08 | 27.66 |
| array/map-filter | 30000 | 4.48 | 2.19 | 2.18 | — |
| array/indexOf | 1000 | 4460.11 | 2863.07 | 2861.06 | — |
| dom/create-elements | 2000 | 113.08 | 52.47 | — | — |
| dom/set-attributes | 6000 | 18.81 | 39.98 | — | — |
| dom/read-attributes | 3000 | 21.04 | 45.66 | — | — |
| dom/modify-text | 2000 | 16.48 | 58.27 | — | — |
| mixed/csv-parse | 11000 | 44.60 | 757.45 | 49.76 | — |
| mixed/text-search | 40000 | 10.07 | 109.65 | 65.40 | 28.32 |
| mixed/fibonacci | 10000 | 12.53 | 32.77 | 32.75 | 32.50 |
| mixed/matrix-multiply | 125000 | 1.49 | 509.36 | 517.95 | 5.77 |
| mixed/sieve | 200000 | 8.95 | 11.71 | 11.61 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.58x slower | 1.30x slower | — |
| string/concat-long | 1.31x slower | 1.17x faster | — |
| string/indexOf | 3.15x slower | 1.56x faster | 1.10x faster |
| string/includes | 6.39x slower | 1.36x faster | 1.11x faster |
| string/split | 17.77x slower | 5.88x slower | — |
| string/replace | 5.91x slower | 2.94x slower | — |
| string/case-convert | 9.40x slower | 4.04x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 18.98x slower | 13.60x slower | — |
| string/startsWith-endsWith | 6.01x slower | 5.90x slower | 1.34x slower |
| array/push-pop | 2.72x faster | 2.72x faster | — |
| array/sort-i32 | 2.84x faster | 2.76x faster | — |
| array/map-filter | 2.04x faster | 2.05x faster | — |
| array/reduce | 2.66x faster | 2.67x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.18x faster | 2.18x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.81x faster | 1.81x faster | — |
| array/find | 18.39x faster | 18.48x faster | 4.11x slower |
| dom/create-elements | 2.16x faster | — | — |
| dom/set-attributes | 2.12x slower | — | — |
| dom/read-attributes | 2.17x slower | — | — |
| dom/modify-text | 3.54x slower | — | — |
| mixed/csv-parse | 16.98x slower | 1.12x slower | — |
| mixed/text-search | 10.89x slower | 6.50x slower | 2.81x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 342.93x slower | 348.72x slower | 3.89x slower |
| mixed/sieve | 1.31x slower | 1.30x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x faster |
| string/concat-long | 1.53x faster |
| string/indexOf | 4.92x faster |
| string/includes | 8.65x faster |
| string/split | 3.02x faster |
| string/replace | 2.01x faster |
| string/case-convert | 2.33x faster |
| string/substring | 1.16x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.02x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.03x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 15.22x faster |
| mixed/text-search | 1.68x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.7KB | 3.3KB | — |
| string/replace | 1.8KB | 4.3KB | — |
| string/case-convert | 1.6KB | 2.4KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.4KB | 2.9KB | — |
| string/startsWith-endsWith | 1.9KB | 3.8KB | 1.7KB |
| array/push-pop | 1.1KB | 1.5KB | — |
| array/sort-i32 | 3.2KB | 3.8KB | — |
| array/map-filter | 4.4KB | 4.9KB | — |
| array/reduce | 2.9KB | 3.5KB | — |
| array/indexOf | 2.0KB | 2.4KB | — |
| array/slice | 1.1KB | 1.6KB | — |
| array/reverse | 1.1KB | 1.5KB | — |
| array/forEach | 3.3KB | 4.0KB | — |
| array/find | 1.1KB | 1.5KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.4KB | 4.4KB | — |
| mixed/text-search | 2.1KB | 4.2KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.8KB | 3.5KB | 991B |
| mixed/sieve | 1.9KB | 2.3KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1129.2ms | 701.4ms | — |
| string/concat-long | 433.0ms | 643.7ms | — |
| string/indexOf | 378.6ms | 661.5ms | 547.7ms |
| string/includes | 381.2ms | 651.7ms | 551.7ms |
| string/split | 497.7ms | 704.3ms | — |
| string/replace | 499.2ms | 754.5ms | — |
| string/case-convert | 500.3ms | 591.8ms | — |
| string/substring | 403.7ms | 450.6ms | — |
| string/trim | 475.3ms | 663.9ms | — |
| string/startsWith-endsWith | 476.8ms | 695.5ms | 610.9ms |
| array/push-pop | 501.0ms | 558.1ms | — |
| array/sort-i32 | 633.6ms | 674.9ms | — |
| array/map-filter | 653.7ms | 715.3ms | — |
| array/reduce | 637.6ms | 679.1ms | — |
| array/indexOf | 587.0ms | 697.8ms | — |
| array/slice | 498.2ms | 609.0ms | — |
| array/reverse | 486.1ms | 586.2ms | — |
| array/forEach | 635.6ms | 697.0ms | — |
| array/find | 489.6ms | 564.4ms | 541.4ms |
| dom/create-elements | 422.5ms | — | — |
| dom/set-attributes | 397.6ms | — | — |
| dom/read-attributes | 379.7ms | — | — |
| dom/modify-text | 378.2ms | — | — |
| mixed/csv-parse | 514.1ms | 667.2ms | — |
| mixed/text-search | 500.3ms | 686.7ms | 617.4ms |
| mixed/fibonacci | 481.2ms | 499.3ms | 545.2ms |
| mixed/matrix-multiply | 628.8ms | 699.1ms | 525.0ms |
| mixed/sieve | 584.5ms | 686.6ms | — |
