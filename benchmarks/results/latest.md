# js2wasm Benchmark Results

Date: 2026-08-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.026ms | 0.038ms | 0.033ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.015ms | 0.048ms | 0.019ms | FAILED | js |
| string/includes | 0.015ms | 0.093ms | 0.019ms | FAILED | js |
| string/split | 0.325ms | 4.12ms | 0.392ms | FAILED | js |
| string/replace | 0.076ms | 0.175ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.045ms | 0.177ms | 0.090ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 0.726ms | 0.205ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.92ms | 0.238ms | FAILED | gc-native |
| array/push-pop | 1.35ms | 0.474ms | 0.476ms | FAILED | host-call |
| array/sort-i32 | 0.654ms | 0.255ms | 0.242ms | FAILED | gc-native |
| array/map-filter | 0.108ms | 0.049ms | 0.050ms | FAILED | host-call |
| array/reduce | 1.89ms | 0.476ms | 0.477ms | FAILED | host-call |
| array/indexOf | 3.46ms | 2.94ms | 2.94ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.015ms | 0.015ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.220ms | 0.013ms | 0.013ms | 0.936ms | gc-native |
| dom/create-elements | 0.031ms | 0.163ms | — | — | js |
| dom/set-attributes | 0.085ms | 0.411ms | — | — | js |
| dom/read-attributes | 0.048ms | 0.117ms | — | — | js |
| dom/modify-text | 0.040ms | 0.100ms | — | — | js |
| mixed/csv-parse | 0.366ms | 5.84ms | 0.473ms | FAILED | js |
| mixed/text-search | 0.312ms | 1.75ms | 0.277ms | FAILED | gc-native |
| mixed/fibonacci | 0.097ms | 0.101ms | 0.101ms | 0.037ms | linear-memory |
| mixed/matrix-multiply | 0.146ms | 0.155ms | 0.155ms | 0.563ms | js |
| mixed/sieve | 1.40ms | 1.15ms | 1.15ms | FAILED | host-call |

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
| string/concat-short | 10000 | 2.55 | 3.77 | 3.31 | — |
| string/concat-long | 1000 | 3.25 | 4.11 | 3.86 | — |
| string/indexOf | 1000 | 14.88 | 47.89 | 18.98 | — |
| string/includes | 1000 | 14.51 | 93.03 | 18.91 | — |
| string/split | 10000 | 32.50 | 411.70 | 39.16 | — |
| string/replace | 1000 | 75.71 | 174.91 | 55.86 | — |
| string/case-convert | 2000 | 22.49 | 88.59 | 45.15 | — |
| string/substring | 10000 | 8.09 | 3.09 | 2.67 | — |
| string/trim | 10000 | 13.43 | 72.59 | 20.54 | — |
| string/startsWith-endsWith | 20000 | 15.98 | 96.11 | 11.89 | — |
| array/map-filter | 30000 | 3.60 | 1.64 | 1.65 | — |
| array/indexOf | 1000 | 3464.91 | 2937.37 | 2936.86 | — |
| dom/create-elements | 2000 | 15.29 | 81.36 | — | — |
| dom/set-attributes | 6000 | 14.19 | 68.58 | — | — |
| dom/read-attributes | 3000 | 16.00 | 38.99 | — | — |
| dom/modify-text | 2000 | 20.05 | 49.76 | — | — |
| mixed/csv-parse | 11000 | 33.25 | 531.16 | 43.01 | — |
| mixed/text-search | 40000 | 7.81 | 43.85 | 6.92 | — |
| mixed/fibonacci | 10000 | 9.71 | 10.08 | 10.09 | 3.70 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.24 | 1.24 | 4.50 |
| mixed/sieve | 200000 | 7.02 | 5.77 | 5.77 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.30x slower | — |
| string/concat-long | 1.27x slower | 1.19x slower | — |
| string/indexOf | 3.22x slower | 1.28x slower | — |
| string/includes | 6.41x slower | 1.30x slower | — |
| string/split | 12.67x slower | 1.20x slower | — |
| string/replace | 2.31x slower | 1.36x faster | — |
| string/case-convert | 3.94x slower | 2.01x slower | — |
| string/substring | 2.62x faster | 3.03x faster | — |
| string/trim | 5.41x slower | 1.53x slower | — |
| string/startsWith-endsWith | 6.01x slower | 1.34x faster | — |
| array/push-pop | 2.85x faster | 2.84x faster | — |
| array/sort-i32 | 2.56x faster | 2.71x faster | — |
| array/map-filter | 2.19x faster | 2.18x faster | — |
| array/reduce | 3.97x faster | 3.96x faster | — |
| array/indexOf | 1.18x faster | 1.18x faster | — |
| array/slice | 2.27x faster | 2.28x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.89x faster | 1.89x faster | — |
| array/find | 17.13x faster | 17.21x faster | 4.25x slower |
| dom/create-elements | 5.32x slower | — | — |
| dom/set-attributes | 4.83x slower | — | — |
| dom/read-attributes | 2.44x slower | — | — |
| dom/modify-text | 2.48x slower | — | — |
| mixed/csv-parse | 15.98x slower | 1.29x slower | — |
| mixed/text-search | 5.61x slower | 1.13x faster | — |
| mixed/fibonacci | 1.04x slower | 1.04x slower | 2.63x faster |
| mixed/matrix-multiply | 1.06x slower | 1.06x slower | 3.85x slower |
| mixed/sieve | 1.22x faster | 1.22x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.07x faster |
| string/indexOf | 2.52x faster |
| string/includes | 4.92x faster |
| string/split | 10.51x faster |
| string/replace | 3.13x faster |
| string/case-convert | 1.96x faster |
| string/substring | 1.16x faster |
| string/trim | 3.53x faster |
| string/startsWith-endsWith | 8.08x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.06x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 12.35x faster |
| mixed/text-search | 6.34x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 974.1ms | 843.0ms | — |
| string/concat-long | 496.8ms | 767.7ms | — |
| string/indexOf | 600.4ms | 802.0ms | — |
| string/includes | 612.4ms | 752.6ms | — |
| string/split | 578.7ms | 767.8ms | — |
| string/replace | 652.4ms | 843.2ms | — |
| string/case-convert | 614.8ms | 826.9ms | — |
| string/substring | 496.3ms | 566.1ms | — |
| string/trim | 563.8ms | 775.2ms | — |
| string/startsWith-endsWith | 601.0ms | 740.2ms | — |
| array/push-pop | 597.8ms | 674.4ms | — |
| array/sort-i32 | 741.6ms | 829.5ms | — |
| array/map-filter | 704.2ms | 833.0ms | — |
| array/reduce | 673.5ms | 692.5ms | — |
| array/indexOf | 665.6ms | 700.3ms | — |
| array/slice | 619.1ms | 639.6ms | — |
| array/reverse | 599.0ms | 643.2ms | — |
| array/forEach | 672.5ms | 711.6ms | — |
| array/find | 577.6ms | 625.4ms | 622.7ms |
| dom/create-elements | 457.9ms | — | — |
| dom/set-attributes | 539.3ms | — | — |
| dom/read-attributes | 531.9ms | — | — |
| dom/modify-text | 525.2ms | — | — |
| mixed/csv-parse | 602.3ms | 766.3ms | — |
| mixed/text-search | 588.7ms | 756.5ms | — |
| mixed/fibonacci | 646.8ms | 644.2ms | 555.8ms |
| mixed/matrix-multiply | 612.6ms | 680.2ms | 615.2ms |
| mixed/sieve | 634.3ms | 669.8ms | — |
