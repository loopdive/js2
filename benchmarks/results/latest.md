# js2wasm Benchmark Results

Date: 2026-08-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.024ms | 0.040ms | 0.033ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.015ms | 0.048ms | 0.019ms | FAILED | js |
| string/includes | 0.015ms | 0.092ms | 0.019ms | FAILED | js |
| string/split | 0.325ms | 3.98ms | 0.392ms | FAILED | js |
| string/replace | 0.075ms | 0.172ms | 0.055ms | FAILED | gc-native |
| string/case-convert | 0.045ms | 0.177ms | 0.088ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 0.727ms | 0.204ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.89ms | 0.238ms | FAILED | gc-native |
| array/push-pop | 1.32ms | 0.474ms | 0.467ms | FAILED | gc-native |
| array/sort-i32 | 0.655ms | 0.242ms | 0.244ms | FAILED | host-call |
| array/map-filter | 0.115ms | 0.052ms | 0.052ms | FAILED | gc-native |
| array/reduce | 1.89ms | 0.471ms | 0.469ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.94ms | 2.94ms | FAILED | gc-native |
| array/slice | 0.032ms | 0.014ms | 0.015ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.221ms | 0.013ms | 0.013ms | 0.938ms | host-call |
| dom/create-elements | 0.030ms | 0.134ms | — | — | js |
| dom/set-attributes | 0.085ms | 0.430ms | — | — | js |
| dom/read-attributes | 0.048ms | 0.118ms | — | — | js |
| dom/modify-text | 0.040ms | 0.100ms | — | — | js |
| mixed/csv-parse | 0.364ms | 6.15ms | 0.476ms | FAILED | js |
| mixed/text-search | 0.304ms | 1.77ms | 0.276ms | FAILED | gc-native |
| mixed/fibonacci | 0.097ms | 0.101ms | 0.101ms | 0.037ms | linear-memory |
| mixed/matrix-multiply | 0.146ms | 0.155ms | 0.155ms | 0.562ms | js |
| mixed/sieve | 1.39ms | 1.14ms | 1.19ms | FAILED | host-call |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | mid-loop | memory access out of bounds |
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
| string/concat-short | 10000 | 2.37 | 3.97 | 3.30 | — |
| string/concat-long | 1000 | 3.22 | 3.98 | 3.78 | — |
| string/indexOf | 1000 | 14.75 | 48.00 | 18.67 | — |
| string/includes | 1000 | 14.51 | 92.16 | 18.74 | — |
| string/split | 10000 | 32.50 | 398.36 | 39.24 | — |
| string/replace | 1000 | 75.17 | 172.41 | 55.07 | — |
| string/case-convert | 2000 | 22.47 | 88.74 | 44.12 | — |
| string/substring | 10000 | 8.09 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.41 | 72.67 | 20.42 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 94.42 | 11.90 | — |
| array/map-filter | 30000 | 3.83 | 1.73 | 1.73 | — |
| array/indexOf | 1000 | 3459.31 | 2937.65 | 2937.29 | — |
| dom/create-elements | 2000 | 15.15 | 67.24 | — | — |
| dom/set-attributes | 6000 | 14.11 | 71.62 | — | — |
| dom/read-attributes | 3000 | 16.14 | 39.18 | — | — |
| dom/modify-text | 2000 | 20.22 | 50.03 | — | — |
| mixed/csv-parse | 11000 | 33.13 | 558.93 | 43.26 | — |
| mixed/text-search | 40000 | 7.60 | 44.30 | 6.91 | — |
| mixed/fibonacci | 10000 | 9.71 | 10.09 | 10.08 | 3.70 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.24 | 1.24 | 4.49 |
| mixed/sieve | 200000 | 6.93 | 5.71 | 5.97 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.68x slower | 1.39x slower | — |
| string/concat-long | 1.23x slower | 1.17x slower | — |
| string/indexOf | 3.26x slower | 1.27x slower | — |
| string/includes | 6.35x slower | 1.29x slower | — |
| string/split | 12.26x slower | 1.21x slower | — |
| string/replace | 2.29x slower | 1.37x faster | — |
| string/case-convert | 3.95x slower | 1.96x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 5.42x slower | 1.52x slower | — |
| string/startsWith-endsWith | 5.90x slower | 1.35x faster | — |
| array/push-pop | 2.80x faster | 2.84x faster | — |
| array/sort-i32 | 2.70x faster | 2.68x faster | — |
| array/map-filter | 2.21x faster | 2.21x faster | — |
| array/reduce | 4.02x faster | 4.04x faster | — |
| array/indexOf | 1.18x faster | 1.18x faster | — |
| array/slice | 2.31x faster | 2.16x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.87x faster | 1.87x faster | — |
| array/find | 17.25x faster | 17.05x faster | 4.25x slower |
| dom/create-elements | 4.44x slower | — | — |
| dom/set-attributes | 5.07x slower | — | — |
| dom/read-attributes | 2.43x slower | — | — |
| dom/modify-text | 2.47x slower | — | — |
| mixed/csv-parse | 16.87x slower | 1.31x slower | — |
| mixed/text-search | 5.83x slower | 1.10x faster | — |
| mixed/fibonacci | 1.04x slower | 1.04x slower | 2.62x faster |
| mixed/matrix-multiply | 1.06x slower | 1.06x slower | 3.85x slower |
| mixed/sieve | 1.21x faster | 1.16x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.20x faster |
| string/concat-long | 1.05x faster |
| string/indexOf | 2.57x faster |
| string/includes | 4.92x faster |
| string/split | 10.15x faster |
| string/replace | 3.13x faster |
| string/case-convert | 2.01x faster |
| string/substring | 1.16x faster |
| string/trim | 3.56x faster |
| string/startsWith-endsWith | 7.94x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.07x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 12.92x faster |
| mixed/text-search | 6.41x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.04x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 427B | 1.3KB | — |
| string/includes | 414B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.1KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.1KB | 1.4KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 972.0ms | 842.2ms | — |
| string/concat-long | 501.4ms | 769.6ms | — |
| string/indexOf | 617.0ms | 780.8ms | — |
| string/includes | 608.7ms | 778.5ms | — |
| string/split | 582.8ms | 773.8ms | — |
| string/replace | 656.9ms | 821.1ms | — |
| string/case-convert | 618.4ms | 849.0ms | — |
| string/substring | 511.2ms | 559.5ms | — |
| string/trim | 589.9ms | 767.3ms | — |
| string/startsWith-endsWith | 582.7ms | 766.8ms | — |
| array/push-pop | 595.0ms | 646.9ms | — |
| array/sort-i32 | 730.2ms | 767.8ms | — |
| array/map-filter | 704.3ms | 800.6ms | — |
| array/reduce | 648.0ms | 715.4ms | — |
| array/indexOf | 634.6ms | 692.5ms | — |
| array/slice | 579.3ms | 646.5ms | — |
| array/reverse | 593.4ms | 627.3ms | — |
| array/forEach | 646.9ms | 672.6ms | — |
| array/find | 565.7ms | 642.6ms | 632.9ms |
| dom/create-elements | 505.7ms | — | — |
| dom/set-attributes | 558.3ms | — | — |
| dom/read-attributes | 534.4ms | — | — |
| dom/modify-text | 534.1ms | — | — |
| mixed/csv-parse | 599.5ms | 761.2ms | — |
| mixed/text-search | 609.7ms | 776.5ms | — |
| mixed/fibonacci | 608.0ms | 655.4ms | 562.6ms |
| mixed/matrix-multiply | 636.1ms | 702.5ms | 612.6ms |
| mixed/sieve | 648.1ms | 662.7ms | — |
