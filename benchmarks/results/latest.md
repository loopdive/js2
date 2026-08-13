# js2wasm Benchmark Results

Date: 2026-08-13
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.024ms | 0.038ms | 0.034ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.046ms | 0.010ms | 0.031ms | gc-native |
| string/includes | 0.015ms | 0.086ms | 0.011ms | 0.032ms | gc-native |
| string/split | 0.331ms | 3.63ms | 0.392ms | FAILED | js |
| string/replace | 0.075ms | 0.175ms | 0.053ms | FAILED | gc-native |
| string/case-convert | 0.046ms | 0.176ms | 0.004ms | FAILED | gc-native |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 0.729ms | 0.153ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 0.260ms | 0.239ms | 0.433ms | gc-native |
| array/push-pop | 1.35ms | 0.476ms | 0.479ms | FAILED | host-call |
| array/sort-i32 | 0.658ms | 0.238ms | 0.266ms | FAILED | host-call |
| array/map-filter | 0.108ms | 0.053ms | 0.053ms | FAILED | host-call |
| array/reduce | 1.29ms | 0.476ms | 0.477ms | FAILED | host-call |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.035ms | 0.015ms | 0.015ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.213ms | 0.012ms | 0.013ms | 0.940ms | host-call |
| dom/create-elements | 0.032ms | 0.117ms | — | — | js |
| dom/set-attributes | 0.086ms | 0.422ms | — | — | js |
| dom/read-attributes | 0.051ms | 0.104ms | — | — | js |
| dom/modify-text | 0.023ms | 0.089ms | — | — | js |
| mixed/csv-parse | 0.861ms | 5.09ms | 0.244ms | FAILED | gc-native |
| mixed/text-search | 0.312ms | 1.05ms | 0.226ms | 1.34ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.244ms | 0.244ms | 0.241ms | js |
| mixed/matrix-multiply | 0.147ms | 0.163ms | 0.163ms | 0.561ms | js |
| mixed/sieve | 1.43ms | 1.16ms | 1.19ms | FAILED | host-call |

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
| string/concat-short | 10000 | 2.38 | 3.75 | 3.38 | — |
| string/concat-long | 1000 | 3.32 | 4.49 | 3.00 | — |
| string/indexOf | 1000 | 14.75 | 46.44 | 9.97 | 31.47 |
| string/includes | 1000 | 14.53 | 86.41 | 11.30 | 32.13 |
| string/split | 10000 | 33.08 | 362.69 | 39.22 | — |
| string/replace | 1000 | 75.49 | 174.57 | 53.21 | — |
| string/case-convert | 2000 | 22.84 | 87.87 | 2.03 | — |
| string/substring | 10000 | 8.13 | 3.10 | 2.66 | — |
| string/trim | 10000 | 13.44 | 72.91 | 15.30 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 13.02 | 11.95 | 21.66 |
| array/map-filter | 30000 | 3.60 | 1.75 | 1.75 | — |
| array/indexOf | 1000 | 3460.60 | 2220.28 | 2219.96 | — |
| dom/create-elements | 2000 | 16.16 | 58.60 | — | — |
| dom/set-attributes | 6000 | 14.41 | 70.27 | — | — |
| dom/read-attributes | 3000 | 16.90 | 34.71 | — | — |
| dom/modify-text | 2000 | 11.71 | 44.35 | — | — |
| mixed/csv-parse | 11000 | 78.27 | 462.35 | 22.18 | — |
| mixed/text-search | 40000 | 7.81 | 26.30 | 5.66 | 33.50 |
| mixed/fibonacci | 10000 | 9.72 | 24.44 | 24.45 | 24.13 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.30 | 1.30 | 4.49 |
| mixed/sieve | 200000 | 7.13 | 5.81 | 5.95 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.58x slower | 1.42x slower | — |
| string/concat-long | 1.35x slower | 1.11x faster | — |
| string/indexOf | 3.15x slower | 1.48x faster | 2.13x slower |
| string/includes | 5.95x slower | 1.29x faster | 2.21x slower |
| string/split | 10.97x slower | 1.19x slower | — |
| string/replace | 2.31x slower | 1.42x faster | — |
| string/case-convert | 3.85x slower | 11.26x faster | — |
| string/substring | 2.62x faster | 3.05x faster | — |
| string/trim | 5.42x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.23x faster | 1.34x faster | 1.35x slower |
| array/push-pop | 2.83x faster | 2.81x faster | — |
| array/sort-i32 | 2.77x faster | 2.47x faster | — |
| array/map-filter | 2.05x faster | 2.05x faster | — |
| array/reduce | 2.71x faster | 2.70x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.27x faster | 2.28x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.88x faster | 1.88x faster | — |
| array/find | 17.44x faster | 16.66x faster | 4.41x slower |
| dom/create-elements | 3.63x slower | — | — |
| dom/set-attributes | 4.88x slower | — | — |
| dom/read-attributes | 2.05x slower | — | — |
| dom/modify-text | 3.79x slower | — | — |
| mixed/csv-parse | 5.91x slower | 3.53x faster | — |
| mixed/text-search | 3.37x slower | 1.38x faster | 4.29x slower |
| mixed/fibonacci | 2.51x slower | 2.52x slower | 2.48x slower |
| mixed/matrix-multiply | 1.11x slower | 1.11x slower | 3.83x slower |
| mixed/sieve | 1.23x faster | 1.20x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.11x faster |
| string/concat-long | 1.50x faster |
| string/indexOf | 4.66x faster |
| string/includes | 7.65x faster |
| string/split | 9.25x faster |
| string/replace | 3.28x faster |
| string/case-convert | 43.33x faster |
| string/substring | 1.16x faster |
| string/trim | 4.76x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.12x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.05x slower |
| mixed/csv-parse | 20.84x faster |
| mixed/text-search | 4.65x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.02x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.6KB | 3.9KB | — |
| string/case-convert | 1.4KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.5KB | 2.8KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.6KB | 1.9KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.8KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 405B | 405B | 386B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1027.1ms | 876.4ms | — |
| string/concat-long | 500.2ms | 781.5ms | — |
| string/indexOf | 540.0ms | 778.5ms | 683.5ms |
| string/includes | 528.4ms | 764.3ms | 681.6ms |
| string/split | 611.5ms | 765.9ms | — |
| string/replace | 601.0ms | 851.9ms | — |
| string/case-convert | 622.1ms | 681.0ms | — |
| string/substring | 522.4ms | 640.7ms | — |
| string/trim | 604.0ms | 786.5ms | — |
| string/startsWith-endsWith | 615.5ms | 781.0ms | 730.5ms |
| array/push-pop | 613.4ms | 678.3ms | — |
| array/sort-i32 | 737.2ms | 774.1ms | — |
| array/map-filter | 754.4ms | 802.7ms | — |
| array/reduce | 675.3ms | 704.8ms | — |
| array/indexOf | 666.4ms | 719.3ms | — |
| array/slice | 625.0ms | 666.1ms | — |
| array/reverse | 621.9ms | 711.2ms | — |
| array/forEach | 714.5ms | 744.3ms | — |
| array/find | 603.7ms | 698.7ms | 691.7ms |
| dom/create-elements | 521.8ms | — | — |
| dom/set-attributes | 606.9ms | — | — |
| dom/read-attributes | 591.2ms | — | — |
| dom/modify-text | 521.7ms | — | — |
| mixed/csv-parse | 661.6ms | 803.1ms | — |
| mixed/text-search | 625.7ms | 822.7ms | 729.4ms |
| mixed/fibonacci | 696.4ms | 717.3ms | 651.7ms |
| mixed/matrix-multiply | 668.6ms | 728.4ms | 646.4ms |
| mixed/sieve | 675.6ms | 715.1ms | — |
