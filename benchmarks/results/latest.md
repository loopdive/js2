# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.039ms | 0.033ms | FAILED | js |
| string/concat-long | 0.003ms | 0.007ms | 0.007ms | FAILED | js |
| string/indexOf | 0.015ms | 0.063ms | 0.019ms | FAILED | js |
| string/includes | 0.015ms | 0.102ms | 0.018ms | FAILED | js |
| string/split | 0.328ms | 4.29ms | 1.16ms | FAILED | js |
| string/replace | 0.036ms | 0.167ms | 0.060ms | FAILED | js |
| string/case-convert | 0.048ms | 0.183ms | 0.090ms | FAILED | js |
| string/substring | 0.081ms | 1.55ms | 0.718ms | FAILED | js |
| string/trim | 0.135ms | 1.07ms | 0.562ms | FAILED | js |
| string/startsWith-endsWith | 0.332ms | 2.09ms | 0.408ms | FAILED | js |
| array/push-pop | 1.35ms | 2.05ms | 2.05ms | FAILED | js |
| array/sort-i32 | 0.657ms | 0.319ms | 0.322ms | FAILED | host-call |
| array/map-filter | 0.108ms | 0.540ms | 0.538ms | FAILED | js |
| array/reduce | 1.93ms | 2.02ms | 2.05ms | FAILED | js |
| array/indexOf | 3.45ms | 2.99ms | 2.99ms | FAILED | host-call |
| array/slice | 0.035ms | 0.021ms | 0.021ms | FAILED | host-call |
| array/reverse | 6.86ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/forEach | 0.044ms | 0.096ms | 0.096ms | FAILED | js |
| array/find | 0.221ms | 0.396ms | 0.396ms | 3.80ms | js |
| dom/create-elements | 0.166ms | 0.204ms | — | — | js |
| dom/set-attributes | 0.089ms | 0.300ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.141ms | — | — | js |
| dom/modify-text | 0.045ms | 0.130ms | — | — | js |
| mixed/csv-parse | 0.358ms | 5.18ms | 0.626ms | FAILED | js |
| mixed/text-search | 0.317ms | 4.18ms | 0.902ms | FAILED | js |
| mixed/fibonacci | 0.097ms | 0.236ms | 0.236ms | 0.234ms | js |
| mixed/matrix-multiply | 0.147ms | 0.440ms | 0.440ms | 1.57ms | js |
| mixed/sieve | 1.42ms | 1.16ms | 1.19ms | FAILED | host-call |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.67 | 3.93 | 3.34 | — |
| string/concat-long | 1000 | 3.19 | 6.64 | 7.21 | — |
| string/indexOf | 1000 | 14.75 | 62.83 | 18.50 | — |
| string/includes | 1000 | 14.52 | 101.65 | 17.75 | — |
| string/split | 10000 | 32.78 | 428.93 | 116.46 | — |
| string/replace | 1000 | 35.54 | 167.17 | 60.30 | — |
| string/case-convert | 2000 | 24.19 | 91.73 | 44.98 | — |
| string/substring | 10000 | 8.13 | 154.89 | 71.76 | — |
| string/trim | 10000 | 13.53 | 106.99 | 56.22 | — |
| string/startsWith-endsWith | 20000 | 16.62 | 104.28 | 20.40 | — |
| mixed/csv-parse | 11000 | 32.55 | 470.78 | 56.92 | — |
| mixed/text-search | 40000 | 7.92 | 104.62 | 22.55 | — |
| mixed/fibonacci | 10000 | 9.72 | 23.61 | 23.60 | 23.44 |
| mixed/matrix-multiply | 125000 | 1.17 | 3.52 | 3.52 | 12.57 |
| mixed/sieve | 200000 | 7.09 | 5.81 | 5.93 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.25x slower | — |
| string/concat-long | 2.08x slower | 2.26x slower | — |
| string/indexOf | 4.26x slower | 1.25x slower | — |
| string/includes | 7.00x slower | 1.22x slower | — |
| string/split | 13.09x slower | 3.55x slower | — |
| string/replace | 4.70x slower | 1.70x slower | — |
| string/case-convert | 3.79x slower | 1.86x slower | — |
| string/substring | 19.05x slower | 8.83x slower | — |
| string/trim | 7.91x slower | 4.16x slower | — |
| string/startsWith-endsWith | 6.27x slower | 1.23x slower | — |
| array/push-pop | 1.52x slower | 1.52x slower | — |
| array/sort-i32 | 2.06x faster | 2.04x faster | — |
| array/map-filter | 4.98x slower | 4.96x slower | — |
| array/reduce | 1.04x slower | 1.06x slower | — |
| array/indexOf | 1.16x faster | 1.15x faster | — |
| array/slice | 1.68x faster | 1.67x faster | — |
| array/reverse | 2.40x faster | 2.40x faster | — |
| array/forEach | 2.20x slower | 2.20x slower | — |
| array/find | 1.79x slower | 1.79x slower | 17.19x slower |
| dom/create-elements | 1.23x slower | — | — |
| dom/set-attributes | 3.37x slower | — | — |
| dom/read-attributes | 2.89x slower | — | — |
| dom/modify-text | 2.86x slower | — | — |
| mixed/csv-parse | 14.46x slower | 1.75x slower | — |
| mixed/text-search | 13.21x slower | 2.85x slower | — |
| mixed/fibonacci | 2.43x slower | 2.43x slower | 2.41x slower |
| mixed/matrix-multiply | 3.00x slower | 3.00x slower | 10.72x slower |
| mixed/sieve | 1.22x faster | 1.20x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x faster |
| string/concat-long | 1.08x slower |
| string/indexOf | 3.40x faster |
| string/includes | 5.73x faster |
| string/split | 3.68x faster |
| string/replace | 2.77x faster |
| string/case-convert | 2.04x faster |
| string/substring | 2.16x faster |
| string/trim | 1.90x faster |
| string/startsWith-endsWith | 5.11x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 8.27x faster |
| mixed/text-search | 4.64x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.02x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 1.7KB | — |
| string/concat-long | 233B | 1.9KB | — |
| string/indexOf | 412B | 2.3KB | — |
| string/includes | 398B | 2.3KB | — |
| string/split | 1.7KB | 3.4KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.4KB | 13.1KB | — |
| string/substring | 556B | 2.0KB | — |
| string/trim | 1.4KB | 2.8KB | — |
| string/startsWith-endsWith | 1.8KB | 3.7KB | — |
| array/push-pop | 956B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.0KB | 1.3KB | — |
| array/slice | 1.0KB | 1.3KB | — |
| array/reverse | 1020B | 1.3KB | — |
| array/forEach | 2.6KB | 2.9KB | — |
| array/find | 2.7KB | 3.0KB | 623B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.4KB | — |
| mixed/fibonacci | 297B | 1.3KB | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1013.7ms | 927.0ms | — |
| string/concat-long | 503.8ms | 797.9ms | — |
| string/indexOf | 614.3ms | 799.7ms | — |
| string/includes | 607.7ms | 807.9ms | — |
| string/split | 655.3ms | 823.7ms | — |
| string/replace | 637.4ms | 851.0ms | — |
| string/case-convert | 643.1ms | 862.3ms | — |
| string/substring | 573.2ms | 766.6ms | — |
| string/trim | 643.0ms | 829.1ms | — |
| string/startsWith-endsWith | 665.4ms | 779.6ms | — |
| array/push-pop | 619.2ms | 636.0ms | — |
| array/sort-i32 | 766.3ms | 768.2ms | — |
| array/map-filter | 759.2ms | 821.7ms | — |
| array/reduce | 667.8ms | 705.5ms | — |
| array/indexOf | 592.9ms | 655.4ms | — |
| array/slice | 596.7ms | 640.0ms | — |
| array/reverse | 604.1ms | 632.1ms | — |
| array/forEach | 718.5ms | 759.7ms | — |
| array/find | 707.1ms | 773.7ms | 653.3ms |
| dom/create-elements | 551.6ms | — | — |
| dom/set-attributes | 592.7ms | — | — |
| dom/read-attributes | 581.0ms | — | — |
| dom/modify-text | 575.1ms | — | — |
| mixed/csv-parse | 696.7ms | 811.3ms | — |
| mixed/text-search | 676.7ms | 813.7ms | — |
| mixed/fibonacci | 629.4ms | 702.5ms | 639.8ms |
| mixed/matrix-multiply | 675.3ms | 712.8ms | 621.7ms |
| mixed/sieve | 638.0ms | 705.0ms | — |
