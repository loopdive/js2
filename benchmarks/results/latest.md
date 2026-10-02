# js2wasm Benchmark Results

Date: 2026-10-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.050ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.135ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.416ms | 8.39ms | 2.84ms | FAILED | js |
| string/replace | 0.108ms | 0.675ms | 0.352ms | FAILED | js |
| string/case-convert | 0.056ms | 0.673ms | 0.272ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 3.97ms | 2.82ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 3.10ms | 3.06ms | 0.563ms | js |
| array/push-pop | 1.45ms | 0.509ms | 0.520ms | FAILED | host-call |
| array/sort-i32 | 0.792ms | 0.294ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.071ms | 0.072ms | FAILED | host-call |
| array/reduce | 1.41ms | 0.514ms | 0.516ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.029ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.050ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.036ms | 0.095ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.218ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.122ms | — | — | js |
| dom/modify-text | 0.031ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.493ms | 8.90ms | 0.652ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.12ms | 2.98ms | 1.10ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.289ms | js |
| mixed/matrix-multiply | 0.158ms | 76.47ms | 79.45ms | 0.724ms | js |
| mixed/sieve | 1.61ms | 2.13ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.61 | 5.01 | 4.61 | — |
| string/concat-long | 1000 | 3.71 | 4.54 | 3.88 | — |
| string/indexOf | 1000 | 19.20 | 64.27 | 12.33 | 17.15 |
| string/includes | 1000 | 19.23 | 135.29 | 14.83 | 15.38 |
| string/split | 10000 | 41.62 | 838.79 | 284.18 | — |
| string/replace | 1000 | 108.30 | 675.40 | 351.83 | — |
| string/case-convert | 2000 | 28.24 | 336.50 | 135.92 | — |
| string/substring | 10000 | 9.93 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.06 | 397.33 | 281.99 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 154.93 | 153.07 | 28.16 |
| array/map-filter | 30000 | 4.48 | 2.37 | 2.39 | — |
| array/indexOf | 1000 | 3952.78 | 2647.25 | 2644.75 | — |
| dom/create-elements | 2000 | 17.98 | 47.38 | — | — |
| dom/set-attributes | 6000 | 17.60 | 36.42 | — | — |
| dom/read-attributes | 3000 | 19.39 | 40.66 | — | — |
| dom/modify-text | 2000 | 15.32 | 54.01 | — | — |
| mixed/csv-parse | 11000 | 44.85 | 809.10 | 59.27 | — |
| mixed/text-search | 40000 | 9.72 | 128.04 | 74.52 | 27.56 |
| mixed/fibonacci | 10000 | 12.02 | 28.32 | 28.31 | 28.94 |
| mixed/matrix-multiply | 125000 | 1.26 | 611.77 | 635.57 | 5.79 |
| mixed/sieve | 200000 | 8.05 | 10.66 | 10.59 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.39x slower | 1.28x slower | — |
| string/concat-long | 1.22x slower | 1.04x slower | — |
| string/indexOf | 3.35x slower | 1.56x faster | 1.12x faster |
| string/includes | 7.04x slower | 1.30x faster | 1.25x faster |
| string/split | 20.15x slower | 6.83x slower | — |
| string/replace | 6.24x slower | 3.25x slower | — |
| string/case-convert | 11.92x slower | 4.81x slower | — |
| string/substring | 2.66x faster | 3.23x faster | — |
| string/trim | 23.28x slower | 16.52x slower | — |
| string/startsWith-endsWith | 7.72x slower | 7.63x slower | 1.40x slower |
| array/push-pop | 2.84x faster | 2.78x faster | — |
| array/sort-i32 | 2.69x faster | 2.69x faster | — |
| array/map-filter | 1.89x faster | 1.88x faster | — |
| array/reduce | 2.73x faster | 2.73x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.08x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.77x faster | — |
| array/find | 16.03x faster | 15.82x faster | 4.26x slower |
| dom/create-elements | 2.63x slower | — | — |
| dom/set-attributes | 2.07x slower | — | — |
| dom/read-attributes | 2.10x slower | — | — |
| dom/modify-text | 3.53x slower | — | — |
| mixed/csv-parse | 18.04x slower | 1.32x slower | — |
| mixed/text-search | 13.17x slower | 7.67x slower | 2.84x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.41x slower |
| mixed/matrix-multiply | 484.16x slower | 502.99x slower | 4.58x slower |
| mixed/sieve | 1.32x slower | 1.32x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x faster |
| string/concat-long | 1.17x faster |
| string/indexOf | 5.21x faster |
| string/includes | 9.12x faster |
| string/split | 2.95x faster |
| string/replace | 1.92x faster |
| string/case-convert | 2.48x faster |
| string/substring | 1.22x faster |
| string/trim | 1.41x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 13.65x faster |
| mixed/text-search | 1.72x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.04x slower |
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
| string/concat-short | 1168.3ms | 644.1ms | — |
| string/concat-long | 459.6ms | 671.6ms | — |
| string/indexOf | 395.7ms | 675.8ms | 569.6ms |
| string/includes | 380.4ms | 694.5ms | 563.9ms |
| string/split | 511.8ms | 705.4ms | — |
| string/replace | 523.7ms | 764.8ms | — |
| string/case-convert | 581.8ms | 628.5ms | — |
| string/substring | 393.9ms | 490.6ms | — |
| string/trim | 501.8ms | 716.0ms | — |
| string/startsWith-endsWith | 495.4ms | 732.9ms | 646.3ms |
| array/push-pop | 513.0ms | 595.1ms | — |
| array/sort-i32 | 681.9ms | 790.7ms | — |
| array/map-filter | 710.8ms | 768.3ms | — |
| array/reduce | 619.0ms | 721.8ms | — |
| array/indexOf | 619.9ms | 708.7ms | — |
| array/slice | 537.6ms | 619.8ms | — |
| array/reverse | 499.2ms | 592.8ms | — |
| array/forEach | 647.3ms | 705.3ms | — |
| array/find | 506.4ms | 608.6ms | 558.6ms |
| dom/create-elements | 411.8ms | — | — |
| dom/set-attributes | 406.4ms | — | — |
| dom/read-attributes | 390.3ms | — | — |
| dom/modify-text | 382.0ms | — | — |
| mixed/csv-parse | 531.9ms | 682.7ms | — |
| mixed/text-search | 508.4ms | 720.2ms | 647.0ms |
| mixed/fibonacci | 457.5ms | 513.6ms | 465.3ms |
| mixed/matrix-multiply | 654.1ms | 716.1ms | 535.0ms |
| mixed/sieve | 628.5ms | 710.5ms | — |
