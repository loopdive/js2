# js2wasm Benchmark Results

Date: 2026-10-18
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.049ms | 0.048ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.070ms | 0.013ms | 0.022ms | gc-native |
| string/includes | 0.019ms | 0.121ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.433ms | 8.11ms | 2.93ms | FAILED | js |
| string/replace | 0.101ms | 0.681ms | 0.343ms | FAILED | js |
| string/case-convert | 0.056ms | 0.612ms | 0.271ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.10ms | 2.76ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 3.13ms | 2.99ms | 0.561ms | js |
| array/push-pop | 1.46ms | 0.503ms | 0.506ms | FAILED | host-call |
| array/sort-i32 | 0.799ms | 0.295ms | 0.295ms | FAILED | gc-native |
| array/map-filter | 0.140ms | 0.073ms | 0.073ms | FAILED | gc-native |
| array/reduce | 1.43ms | 0.515ms | 0.511ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.65ms | 2.65ms | FAILED | gc-native |
| array/slice | 0.031ms | 0.032ms | 0.032ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.258ms | 0.016ms | 0.018ms | 1.08ms | host-call |
| dom/create-elements | 0.041ms | 0.154ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.218ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.120ms | — | — | js |
| dom/modify-text | 0.033ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.483ms | 8.57ms | 0.652ms | FAILED | js |
| mixed/text-search | 0.389ms | 4.76ms | 2.88ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.282ms | js |
| mixed/matrix-multiply | 0.162ms | 73.34ms | 76.13ms | 0.722ms | js |
| mixed/sieve | 1.61ms | 2.14ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 3.74 | 4.86 | 4.78 | — |
| string/concat-long | 1000 | 3.86 | 4.65 | 4.26 | — |
| string/indexOf | 1000 | 19.28 | 69.51 | 12.65 | 21.79 |
| string/includes | 1000 | 19.33 | 121.31 | 15.00 | 15.45 |
| string/split | 10000 | 43.26 | 811.21 | 292.67 | — |
| string/replace | 1000 | 100.98 | 680.90 | 343.09 | — |
| string/case-convert | 2000 | 28.18 | 306.17 | 135.25 | — |
| string/substring | 10000 | 9.88 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.00 | 409.67 | 275.96 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 156.37 | 149.69 | 28.05 |
| array/map-filter | 30000 | 4.67 | 2.44 | 2.43 | — |
| array/indexOf | 1000 | 3954.06 | 2648.48 | 2645.89 | — |
| dom/create-elements | 2000 | 20.65 | 77.23 | — | — |
| dom/set-attributes | 6000 | 18.23 | 36.40 | — | — |
| dom/read-attributes | 3000 | 19.28 | 39.99 | — | — |
| dom/modify-text | 2000 | 16.52 | 54.34 | — | — |
| mixed/csv-parse | 11000 | 43.88 | 779.14 | 59.31 | — |
| mixed/text-search | 40000 | 9.72 | 118.98 | 71.93 | 27.10 |
| mixed/fibonacci | 10000 | 12.01 | 28.31 | 28.31 | 28.17 |
| mixed/matrix-multiply | 125000 | 1.29 | 586.72 | 609.01 | 5.77 |
| mixed/sieve | 200000 | 8.06 | 10.70 | 10.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.30x slower | 1.28x slower | — |
| string/concat-long | 1.20x slower | 1.10x slower | — |
| string/indexOf | 3.61x slower | 1.52x faster | 1.13x slower |
| string/includes | 6.28x slower | 1.29x faster | 1.25x faster |
| string/split | 18.75x slower | 6.77x slower | — |
| string/replace | 6.74x slower | 3.40x slower | — |
| string/case-convert | 10.86x slower | 4.80x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 24.10x slower | 16.23x slower | — |
| string/startsWith-endsWith | 7.79x slower | 7.46x slower | 1.40x slower |
| array/push-pop | 2.90x faster | 2.89x faster | — |
| array/sort-i32 | 2.71x faster | 2.71x faster | — |
| array/map-filter | 1.92x faster | 1.92x faster | — |
| array/reduce | 2.79x faster | 2.81x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.03x slower | 1.03x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.82x faster | — |
| array/find | 15.72x faster | 14.69x faster | 4.18x slower |
| dom/create-elements | 3.74x slower | — | — |
| dom/set-attributes | 2.00x slower | — | — |
| dom/read-attributes | 2.07x slower | — | — |
| dom/modify-text | 3.29x slower | — | — |
| mixed/csv-parse | 17.75x slower | 1.35x slower | — |
| mixed/text-search | 12.24x slower | 7.40x slower | 2.79x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 453.39x slower | 470.62x slower | 4.46x slower |
| mixed/sieve | 1.33x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x faster |
| string/concat-long | 1.09x faster |
| string/indexOf | 5.50x faster |
| string/includes | 8.09x faster |
| string/split | 2.77x faster |
| string/replace | 1.98x faster |
| string/case-convert | 2.26x faster |
| string/substring | 1.22x faster |
| string/trim | 1.48x faster |
| string/startsWith-endsWith | 1.04x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.03x faster |
| array/find | 1.07x slower |
| mixed/csv-parse | 13.14x faster |
| mixed/text-search | 1.65x faster |
| mixed/fibonacci | 1.00x slower |
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
| string/concat-short | 1153.9ms | 597.0ms | — |
| string/concat-long | 436.0ms | 641.0ms | — |
| string/indexOf | 374.0ms | 678.2ms | 553.2ms |
| string/includes | 367.5ms | 676.0ms | 549.2ms |
| string/split | 508.4ms | 682.9ms | — |
| string/replace | 492.6ms | 764.7ms | — |
| string/case-convert | 524.5ms | 599.1ms | — |
| string/substring | 393.3ms | 450.7ms | — |
| string/trim | 485.9ms | 703.1ms | — |
| string/startsWith-endsWith | 489.1ms | 667.0ms | 649.2ms |
| array/push-pop | 503.1ms | 580.7ms | — |
| array/sort-i32 | 654.1ms | 721.5ms | — |
| array/map-filter | 664.2ms | 738.6ms | — |
| array/reduce | 631.4ms | 706.8ms | — |
| array/indexOf | 602.6ms | 655.2ms | — |
| array/slice | 515.4ms | 609.1ms | — |
| array/reverse | 515.6ms | 573.6ms | — |
| array/forEach | 634.2ms | 710.4ms | — |
| array/find | 499.4ms | 613.1ms | 535.3ms |
| dom/create-elements | 428.9ms | — | — |
| dom/set-attributes | 381.3ms | — | — |
| dom/read-attributes | 382.9ms | — | — |
| dom/modify-text | 377.2ms | — | — |
| mixed/csv-parse | 536.8ms | 680.8ms | — |
| mixed/text-search | 516.9ms | 676.8ms | 615.9ms |
| mixed/fibonacci | 449.1ms | 502.8ms | 503.2ms |
| mixed/matrix-multiply | 626.3ms | 698.8ms | 515.6ms |
| mixed/sieve | 611.2ms | 672.1ms | — |
