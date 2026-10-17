# js2wasm Benchmark Results

Date: 2026-10-17
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.047ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.132ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.412ms | 8.46ms | 2.85ms | FAILED | js |
| string/replace | 0.101ms | 0.690ms | 0.331ms | FAILED | js |
| string/case-convert | 0.056ms | 0.644ms | 0.283ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.10ms | 2.92ms | FAILED | js |
| string/startsWith-endsWith | 0.403ms | 2.93ms | 3.27ms | 0.560ms | js |
| array/push-pop | 1.41ms | 0.512ms | 0.507ms | FAILED | gc-native |
| array/sort-i32 | 0.802ms | 0.293ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.128ms | 0.071ms | 0.070ms | FAILED | gc-native |
| array/reduce | 1.33ms | 0.500ms | 0.500ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.029ms | FAILED | host-call |
| array/find | 0.258ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.037ms | 0.094ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.219ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.132ms | — | — | js |
| dom/modify-text | 0.030ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.487ms | 8.79ms | 0.644ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.08ms | 2.88ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 74.97ms | 77.87ms | 0.718ms | js |
| mixed/sieve | 1.58ms | 2.12ms | 2.14ms | FAILED | js |

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
| string/concat-short | 10000 | 3.23 | 4.72 | 4.54 | — |
| string/concat-long | 1000 | 3.59 | 4.50 | 3.74 | — |
| string/indexOf | 1000 | 19.17 | 63.75 | 12.31 | 14.59 |
| string/includes | 1000 | 19.18 | 132.21 | 14.83 | 15.39 |
| string/split | 10000 | 41.22 | 845.91 | 285.33 | — |
| string/replace | 1000 | 101.31 | 689.85 | 330.78 | — |
| string/case-convert | 2000 | 27.91 | 322.10 | 141.45 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.98 | 410.38 | 292.28 | — |
| string/startsWith-endsWith | 20000 | 20.15 | 146.52 | 163.44 | 28.00 |
| array/map-filter | 30000 | 4.26 | 2.36 | 2.32 | — |
| array/indexOf | 1000 | 3949.07 | 2648.95 | 2643.64 | — |
| dom/create-elements | 2000 | 18.47 | 47.21 | — | — |
| dom/set-attributes | 6000 | 17.61 | 36.51 | — | — |
| dom/read-attributes | 3000 | 19.20 | 44.11 | — | — |
| dom/modify-text | 2000 | 14.89 | 53.87 | — | — |
| mixed/csv-parse | 11000 | 44.27 | 799.26 | 58.51 | — |
| mixed/text-search | 40000 | 9.73 | 127.00 | 71.92 | 26.98 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.27 | 599.74 | 622.99 | 5.74 |
| mixed/sieve | 200000 | 7.88 | 10.61 | 10.71 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.46x slower | 1.41x slower | — |
| string/concat-long | 1.25x slower | 1.04x slower | — |
| string/indexOf | 3.33x slower | 1.56x faster | 1.31x faster |
| string/includes | 6.89x slower | 1.29x faster | 1.25x faster |
| string/split | 20.52x slower | 6.92x slower | — |
| string/replace | 6.81x slower | 3.27x slower | — |
| string/case-convert | 11.54x slower | 5.07x slower | — |
| string/substring | 2.64x faster | 3.20x faster | — |
| string/trim | 24.17x slower | 17.21x slower | — |
| string/startsWith-endsWith | 7.27x slower | 8.11x slower | 1.39x slower |
| array/push-pop | 2.76x faster | 2.78x faster | — |
| array/sort-i32 | 2.73x faster | 2.72x faster | — |
| array/map-filter | 1.81x faster | 1.84x faster | — |
| array/reduce | 2.65x faster | 2.65x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.08x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.65x faster | — |
| array/find | 15.91x faster | 15.77x faster | 4.20x slower |
| dom/create-elements | 2.56x slower | — | — |
| dom/set-attributes | 2.07x slower | — | — |
| dom/read-attributes | 2.30x slower | — | — |
| dom/modify-text | 3.62x slower | — | — |
| mixed/csv-parse | 18.05x slower | 1.32x slower | — |
| mixed/text-search | 13.05x slower | 7.39x slower | 2.77x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 473.17x slower | 491.52x slower | 4.53x slower |
| mixed/sieve | 1.35x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 5.18x faster |
| string/includes | 8.92x faster |
| string/split | 2.96x faster |
| string/replace | 2.09x faster |
| string/case-convert | 2.28x faster |
| string/substring | 1.22x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.12x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.02x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.04x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 13.66x faster |
| mixed/text-search | 1.77x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.04x slower |
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
| string/concat-short | 1143.0ms | 616.2ms | — |
| string/concat-long | 438.4ms | 647.6ms | — |
| string/indexOf | 382.5ms | 672.0ms | 551.5ms |
| string/includes | 392.6ms | 654.1ms | 544.3ms |
| string/split | 518.7ms | 675.8ms | — |
| string/replace | 509.1ms | 748.4ms | — |
| string/case-convert | 571.8ms | 593.3ms | — |
| string/substring | 393.0ms | 449.6ms | — |
| string/trim | 483.9ms | 668.1ms | — |
| string/startsWith-endsWith | 482.7ms | 661.4ms | 626.8ms |
| array/push-pop | 519.5ms | 568.8ms | — |
| array/sort-i32 | 650.0ms | 706.7ms | — |
| array/map-filter | 684.5ms | 707.5ms | — |
| array/reduce | 592.8ms | 689.6ms | — |
| array/indexOf | 595.1ms | 672.4ms | — |
| array/slice | 503.7ms | 589.9ms | — |
| array/reverse | 493.7ms | 578.5ms | — |
| array/forEach | 637.1ms | 696.2ms | — |
| array/find | 492.3ms | 596.6ms | 548.8ms |
| dom/create-elements | 428.3ms | — | — |
| dom/set-attributes | 389.0ms | — | — |
| dom/read-attributes | 411.2ms | — | — |
| dom/modify-text | 368.2ms | — | — |
| mixed/csv-parse | 528.6ms | 669.0ms | — |
| mixed/text-search | 503.7ms | 697.0ms | 638.9ms |
| mixed/fibonacci | 439.2ms | 490.0ms | 495.0ms |
| mixed/matrix-multiply | 625.8ms | 711.0ms | 508.0ms |
| mixed/sieve | 609.1ms | 678.8ms | — |
