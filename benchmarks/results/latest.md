# js2wasm Benchmark Results

Date: 2026-08-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.026ms | 0.038ms | 0.033ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.046ms | 0.010ms | 0.022ms | gc-native |
| string/includes | 0.015ms | 0.076ms | 0.011ms | 0.013ms | gc-native |
| string/split | 0.337ms | 3.56ms | 0.392ms | FAILED | js |
| string/replace | 0.074ms | 0.173ms | 0.046ms | FAILED | gc-native |
| string/case-convert | 0.045ms | 0.210ms | 0.004ms | FAILED | gc-native |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.135ms | 0.726ms | 0.152ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 0.271ms | 0.239ms | 0.432ms | gc-native |
| array/push-pop | 1.29ms | 0.472ms | 0.473ms | FAILED | host-call |
| array/sort-i32 | 0.657ms | 0.237ms | 0.235ms | FAILED | gc-native |
| array/map-filter | 0.109ms | 0.052ms | 0.053ms | FAILED | host-call |
| array/reduce | 1.89ms | 0.480ms | 0.474ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.044ms | 0.023ms | 0.023ms | FAILED | host-call |
| array/find | 0.213ms | 0.012ms | 0.012ms | 0.933ms | gc-native |
| dom/create-elements | 0.031ms | FAILED | — | — | js |
| dom/set-attributes | 0.087ms | FAILED | — | — | js |
| dom/read-attributes | 0.050ms | FAILED | — | — | js |
| dom/modify-text | 0.023ms | FAILED | — | — | js |
| mixed/csv-parse | 0.368ms | 5.43ms | 0.241ms | FAILED | gc-native |
| mixed/text-search | 0.312ms | 1.00ms | 0.227ms | 0.859ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.244ms | 0.244ms | 0.241ms | js |
| mixed/matrix-multiply | 0.147ms | 0.166ms | 0.166ms | 0.559ms | js |
| mixed/sieve | 1.45ms | 1.18ms | 1.19ms | FAILED | host-call |

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
| dom/create-elements | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/set-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/read-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/modify-text | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.63 | 3.76 | 3.34 | — |
| string/concat-long | 1000 | 3.39 | 4.34 | 3.04 | — |
| string/indexOf | 1000 | 14.76 | 46.36 | 9.81 | 22.09 |
| string/includes | 1000 | 14.53 | 76.14 | 11.11 | 13.02 |
| string/split | 10000 | 33.68 | 355.93 | 39.16 | — |
| string/replace | 1000 | 74.16 | 172.50 | 45.64 | — |
| string/case-convert | 2000 | 22.46 | 104.95 | 2.02 | — |
| string/substring | 10000 | 8.08 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.47 | 72.57 | 15.23 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 13.53 | 11.94 | 21.61 |
| array/map-filter | 30000 | 3.63 | 1.75 | 1.76 | — |
| array/indexOf | 1000 | 3461.13 | 2219.38 | 2219.07 | — |
| dom/create-elements | 2000 | 15.32 | — | — | — |
| dom/set-attributes | 6000 | 14.53 | — | — | — |
| dom/read-attributes | 3000 | 16.57 | — | — | — |
| dom/modify-text | 2000 | 11.60 | — | — | — |
| mixed/csv-parse | 11000 | 33.44 | 493.28 | 21.92 | — |
| mixed/text-search | 40000 | 7.81 | 25.12 | 5.67 | 21.47 |
| mixed/fibonacci | 10000 | 9.71 | 24.43 | 24.43 | 24.07 |
| mixed/matrix-multiply | 125000 | 1.18 | 1.33 | 1.32 | 4.47 |
| mixed/sieve | 200000 | 7.23 | 5.88 | 5.93 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.43x slower | 1.27x slower | — |
| string/concat-long | 1.28x slower | 1.11x faster | — |
| string/indexOf | 3.14x slower | 1.50x faster | 1.50x slower |
| string/includes | 5.24x slower | 1.31x faster | 1.12x faster |
| string/split | 10.57x slower | 1.16x slower | — |
| string/replace | 2.33x slower | 1.62x faster | — |
| string/case-convert | 4.67x slower | 11.09x faster | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 5.39x slower | 1.13x slower | — |
| string/startsWith-endsWith | 1.18x faster | 1.34x faster | 1.35x slower |
| array/push-pop | 2.74x faster | 2.73x faster | — |
| array/sort-i32 | 2.77x faster | 2.79x faster | — |
| array/map-filter | 2.08x faster | 2.07x faster | — |
| array/reduce | 3.93x faster | 3.98x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.31x faster | 2.28x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.91x faster | 1.91x faster | — |
| array/find | 17.66x faster | 17.85x faster | 4.37x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 14.75x slower | 1.53x faster | — |
| mixed/text-search | 3.22x slower | 1.38x faster | 2.75x slower |
| mixed/fibonacci | 2.52x slower | 2.52x slower | 2.48x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.80x slower |
| mixed/sieve | 1.23x faster | 1.22x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x faster |
| string/concat-long | 1.43x faster |
| string/indexOf | 4.73x faster |
| string/includes | 6.85x faster |
| string/split | 9.09x faster |
| string/replace | 3.78x faster |
| string/case-convert | 51.83x faster |
| string/substring | 1.16x faster |
| string/trim | 4.77x faster |
| string/startsWith-endsWith | 1.13x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 22.50x faster |
| mixed/text-search | 4.43x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.7KB | 2.1KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1020.3ms | 835.4ms | — |
| string/concat-long | 501.8ms | 752.8ms | — |
| string/indexOf | 524.1ms | 763.2ms | 660.3ms |
| string/includes | 512.8ms | 773.7ms | 653.8ms |
| string/split | 610.0ms | 745.3ms | — |
| string/replace | 604.4ms | 795.2ms | — |
| string/case-convert | 607.7ms | 649.6ms | — |
| string/substring | 505.8ms | 569.5ms | — |
| string/trim | 673.2ms | 730.3ms | — |
| string/startsWith-endsWith | 578.1ms | 722.3ms | 685.4ms |
| array/push-pop | 599.6ms | 658.8ms | — |
| array/sort-i32 | 687.5ms | 776.4ms | — |
| array/map-filter | 719.0ms | 809.3ms | — |
| array/reduce | 637.6ms | 755.2ms | — |
| array/indexOf | 645.4ms | 711.1ms | — |
| array/slice | 582.6ms | 659.5ms | — |
| array/reverse | 592.1ms | 642.3ms | — |
| array/forEach | 677.7ms | 739.9ms | — |
| array/find | 587.9ms | 654.5ms | 649.4ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 611.5ms | 731.5ms | — |
| mixed/text-search | 595.2ms | 757.3ms | 679.8ms |
| mixed/fibonacci | 575.0ms | 615.3ms | 614.7ms |
| mixed/matrix-multiply | 660.2ms | 718.7ms | 618.0ms |
| mixed/sieve | 657.1ms | 713.3ms | — |
