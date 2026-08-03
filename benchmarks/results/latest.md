# js2wasm Benchmark Results

Date: 2026-08-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.026ms | 0.042ms | 0.033ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.015ms | 0.060ms | 0.017ms | FAILED | js |
| string/includes | 0.015ms | 0.095ms | 0.016ms | FAILED | js |
| string/split | 0.328ms | 0.142ms | 0.164ms | FAILED | host-call |
| string/replace | 0.035ms | 0.010ms | 0.011ms | FAILED | host-call |
| string/case-convert | 0.048ms | 0.010ms | 0.011ms | FAILED | host-call |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.135ms | 0.142ms | 0.161ms | FAILED | js |
| string/startsWith-endsWith | 0.332ms | 0.148ms | 0.164ms | FAILED | host-call |
| array/push-pop | 1.33ms | 0.485ms | 0.474ms | FAILED | gc-native |
| array/sort-i32 | 0.656ms | 0.273ms | 0.268ms | FAILED | gc-native |
| array/map-filter | 0.109ms | 0.439ms | 0.451ms | FAILED | js |
| array/reduce | 1.30ms | 0.472ms | 0.490ms | FAILED | host-call |
| array/indexOf | 3.46ms | 0.009ms | 0.009ms | FAILED | host-call |
| array/slice | 0.031ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.044ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.221ms | 0.013ms | 0.013ms | 0.868ms | host-call |
| dom/create-elements | 0.179ms | 0.205ms | — | — | js |
| dom/set-attributes | 0.088ms | 0.292ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.140ms | — | — | js |
| dom/modify-text | 0.044ms | 0.127ms | — | — | js |
| mixed/csv-parse | 0.356ms | 0.643ms | 0.249ms | FAILED | gc-native |
| mixed/text-search | 0.314ms | 0.160ms | 0.181ms | FAILED | host-call |
| mixed/fibonacci | 0.097ms | 0.037ms | 0.037ms | 0.070ms | gc-native |
| mixed/matrix-multiply | 0.147ms | 0.404ms | 0.404ms | 0.563ms | js |
| mixed/sieve | 1.41ms | 1.18ms | 1.15ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.57 | 4.23 | 3.33 | — |
| string/concat-long | 1000 | 3.34 | 4.02 | 3.94 | — |
| string/indexOf | 1000 | 14.77 | 59.95 | 16.61 | — |
| string/includes | 1000 | 14.52 | 94.78 | 16.04 | — |
| string/split | 10000 | 32.78 | 14.21 | 16.38 | — |
| string/replace | 1000 | 35.26 | 9.81 | 10.98 | — |
| string/case-convert | 2000 | 24.12 | 4.85 | 5.54 | — |
| string/substring | 10000 | 8.08 | 3.10 | 2.67 | — |
| string/trim | 10000 | 13.45 | 14.23 | 16.14 | — |
| string/startsWith-endsWith | 20000 | 16.62 | 7.38 | 8.22 | — |
| mixed/csv-parse | 11000 | 32.38 | 58.47 | 22.63 | — |
| mixed/text-search | 40000 | 7.85 | 4.00 | 4.53 | — |
| mixed/fibonacci | 10000 | 9.72 | 3.72 | 3.72 | 7.05 |
| mixed/matrix-multiply | 125000 | 1.18 | 3.23 | 3.23 | 4.50 |
| mixed/sieve | 200000 | 7.04 | 5.91 | 5.77 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.65x slower | 1.30x slower | — |
| string/concat-long | 1.20x slower | 1.18x slower | — |
| string/indexOf | 4.06x slower | 1.12x slower | — |
| string/includes | 6.53x slower | 1.10x slower | — |
| string/split | 2.31x faster | 2.00x faster | — |
| string/replace | 3.59x faster | 3.21x faster | — |
| string/case-convert | 4.97x faster | 4.35x faster | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 1.06x slower | 1.20x slower | — |
| string/startsWith-endsWith | 2.25x faster | 2.02x faster | — |
| array/push-pop | 2.75x faster | 2.82x faster | — |
| array/sort-i32 | 2.40x faster | 2.45x faster | — |
| array/map-filter | 4.02x slower | 4.13x slower | — |
| array/reduce | 2.75x faster | 2.64x faster | — |
| array/indexOf | 368.22x faster | 364.66x faster | — |
| array/slice | 2.29x faster | 2.25x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.91x faster | 1.92x faster | — |
| array/find | 17.30x faster | 17.05x faster | 3.93x slower |
| dom/create-elements | 1.14x slower | — | — |
| dom/set-attributes | 3.31x slower | — | — |
| dom/read-attributes | 2.86x slower | — | — |
| dom/modify-text | 2.85x slower | — | — |
| mixed/csv-parse | 1.81x slower | 1.43x faster | — |
| mixed/text-search | 1.96x faster | 1.73x faster | — |
| mixed/fibonacci | 2.61x faster | 2.61x faster | 1.38x faster |
| mixed/matrix-multiply | 2.75x slower | 2.75x slower | 3.83x slower |
| mixed/sieve | 1.19x faster | 1.22x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.27x faster |
| string/concat-long | 1.02x faster |
| string/indexOf | 3.61x faster |
| string/includes | 5.91x faster |
| string/split | 1.15x slower |
| string/replace | 1.12x slower |
| string/case-convert | 1.14x slower |
| string/substring | 1.16x faster |
| string/trim | 1.13x slower |
| string/startsWith-endsWith | 1.11x slower |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.03x slower |
| array/reduce | 1.04x slower |
| array/indexOf | 1.01x slower |
| array/slice | 1.02x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 2.58x faster |
| mixed/text-search | 1.13x slower |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.02x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 401B | 1.3KB | — |
| string/includes | 388B | 1.3KB | — |
| string/split | 1.6KB | 2.7KB | — |
| string/replace | 1.5KB | 2.5KB | — |
| string/case-convert | 1.4KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 1.9KB | — |
| string/startsWith-endsWith | 1.6KB | 2.8KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.6KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 834B | 1.1KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 1.9KB | 4.0KB | — |
| mixed/text-search | 1.7KB | 3.2KB | — |
| mixed/fibonacci | 235B | 235B | 251B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 963.2ms | 861.9ms | — |
| string/concat-long | 526.3ms | 762.9ms | — |
| string/indexOf | 592.0ms | 772.4ms | — |
| string/includes | 598.2ms | 796.2ms | — |
| string/split | 637.4ms | 736.0ms | — |
| string/replace | 639.3ms | 687.4ms | — |
| string/case-convert | 629.8ms | 705.4ms | — |
| string/substring | 500.6ms | 568.5ms | — |
| string/trim | 633.5ms | 710.0ms | — |
| string/startsWith-endsWith | 628.1ms | 721.1ms | — |
| array/push-pop | 612.0ms | 653.8ms | — |
| array/sort-i32 | 756.6ms | 790.6ms | — |
| array/map-filter | 692.7ms | 780.9ms | — |
| array/reduce | 641.8ms | 699.8ms | — |
| array/indexOf | 587.0ms | 620.2ms | — |
| array/slice | 579.6ms | 647.3ms | — |
| array/reverse | 578.0ms | 636.4ms | — |
| array/forEach | 657.2ms | 726.1ms | — |
| array/find | 577.0ms | 654.1ms | 647.9ms |
| dom/create-elements | 548.5ms | — | — |
| dom/set-attributes | 566.4ms | — | — |
| dom/read-attributes | 593.7ms | — | — |
| dom/modify-text | 532.0ms | — | — |
| mixed/csv-parse | 646.9ms | 802.4ms | — |
| mixed/text-search | 657.7ms | 711.7ms | — |
| mixed/fibonacci | 593.0ms | 624.1ms | 561.2ms |
| mixed/matrix-multiply | 661.0ms | 676.3ms | 635.2ms |
| mixed/sieve | 631.8ms | 698.0ms | — |
