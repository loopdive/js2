# js2wasm Benchmark Results

Date: 2026-09-16
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.046ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.065ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.147ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.412ms | 8.19ms | 2.74ms | FAILED | js |
| string/replace | 0.113ms | 0.703ms | 0.311ms | FAILED | js |
| string/case-convert | 0.056ms | 0.572ms | 0.279ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.06ms | 2.93ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.97ms | 3.06ms | 0.561ms | js |
| array/push-pop | 1.41ms | 0.500ms | 0.502ms | FAILED | host-call |
| array/sort-i32 | 0.797ms | 0.293ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.135ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.17ms | 0.507ms | 0.511ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.86ms | 3.54ms | 3.54ms | FAILED | gc-native |
| array/forEach | 0.057ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.255ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.041ms | 0.100ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.218ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.128ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.491ms | 8.55ms | 0.614ms | FAILED | js |
| mixed/text-search | 0.388ms | 5.08ms | 2.86ms | 1.10ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.157ms | 71.56ms | 71.95ms | 0.719ms | js |
| mixed/sieve | 1.55ms | 2.10ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 2.79 | 4.64 | 4.18 | — |
| string/concat-long | 1000 | 3.56 | 4.55 | 3.64 | — |
| string/indexOf | 1000 | 19.19 | 64.58 | 12.26 | 14.81 |
| string/includes | 1000 | 19.21 | 146.79 | 14.76 | 15.40 |
| string/split | 10000 | 41.20 | 819.00 | 273.86 | — |
| string/replace | 1000 | 112.62 | 702.74 | 311.14 | — |
| string/case-convert | 2000 | 27.95 | 286.18 | 139.41 | — |
| string/substring | 10000 | 9.92 | 3.74 | 3.08 | — |
| string/trim | 10000 | 16.97 | 405.52 | 292.97 | — |
| string/startsWith-endsWith | 20000 | 20.10 | 148.43 | 153.12 | 28.07 |
| array/map-filter | 30000 | 4.48 | 2.33 | 2.32 | — |
| array/indexOf | 1000 | 3948.47 | 2644.23 | 2638.73 | — |
| dom/create-elements | 2000 | 20.46 | 50.06 | — | — |
| dom/set-attributes | 6000 | 17.17 | 36.25 | — | — |
| dom/read-attributes | 3000 | 18.47 | 42.55 | — | — |
| dom/modify-text | 2000 | 14.60 | 54.74 | — | — |
| mixed/csv-parse | 11000 | 44.63 | 777.17 | 55.84 | — |
| mixed/text-search | 40000 | 9.70 | 127.05 | 71.55 | 27.62 |
| mixed/fibonacci | 10000 | 12.18 | 28.30 | 28.32 | 28.09 |
| mixed/matrix-multiply | 125000 | 1.26 | 572.51 | 575.63 | 5.76 |
| mixed/sieve | 200000 | 7.73 | 10.52 | 10.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.66x slower | 1.49x slower | — |
| string/concat-long | 1.28x slower | 1.02x slower | — |
| string/indexOf | 3.36x slower | 1.57x faster | 1.30x faster |
| string/includes | 7.64x slower | 1.30x faster | 1.25x faster |
| string/split | 19.88x slower | 6.65x slower | — |
| string/replace | 6.24x slower | 2.76x slower | — |
| string/case-convert | 10.24x slower | 4.99x slower | — |
| string/substring | 2.66x faster | 3.22x faster | — |
| string/trim | 23.90x slower | 17.27x slower | — |
| string/startsWith-endsWith | 7.38x slower | 7.62x slower | 1.40x slower |
| array/push-pop | 2.83x faster | 2.82x faster | — |
| array/sort-i32 | 2.72x faster | 2.72x faster | — |
| array/map-filter | 1.93x faster | 1.93x faster | — |
| array/reduce | 4.27x faster | 4.24x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.02x faster | 2.03x faster | — |
| array/find | 16.45x faster | 16.00x faster | 4.21x slower |
| dom/create-elements | 2.45x slower | — | — |
| dom/set-attributes | 2.11x slower | — | — |
| dom/read-attributes | 2.30x slower | — | — |
| dom/modify-text | 3.75x slower | — | — |
| mixed/csv-parse | 17.41x slower | 1.25x slower | — |
| mixed/text-search | 13.10x slower | 7.38x slower | 2.85x slower |
| mixed/fibonacci | 2.32x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 455.66x slower | 458.14x slower | 4.58x slower |
| mixed/sieve | 1.36x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.11x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.27x faster |
| string/includes | 9.95x faster |
| string/split | 2.99x faster |
| string/replace | 2.26x faster |
| string/case-convert | 2.05x faster |
| string/substring | 1.21x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.03x slower |
| mixed/csv-parse | 13.92x faster |
| mixed/text-search | 1.78x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.7KB | 3.2KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.3KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1136.5ms | 618.8ms | — |
| string/concat-long | 433.5ms | 683.8ms | — |
| string/indexOf | 374.4ms | 638.0ms | 566.0ms |
| string/includes | 365.4ms | 680.8ms | 559.5ms |
| string/split | 504.9ms | 702.6ms | — |
| string/replace | 487.2ms | 752.5ms | — |
| string/case-convert | 492.1ms | 579.4ms | — |
| string/substring | 386.8ms | 545.9ms | — |
| string/trim | 473.7ms | 686.2ms | — |
| string/startsWith-endsWith | 467.3ms | 685.9ms | 604.7ms |
| array/push-pop | 485.7ms | 577.8ms | — |
| array/sort-i32 | 641.4ms | 689.8ms | — |
| array/map-filter | 661.0ms | 745.9ms | — |
| array/reduce | 596.1ms | 667.1ms | — |
| array/indexOf | 556.9ms | 669.5ms | — |
| array/slice | 502.7ms | 564.5ms | — |
| array/reverse | 495.9ms | 559.4ms | — |
| array/forEach | 610.2ms | 719.0ms | — |
| array/find | 484.4ms | 548.9ms | 541.8ms |
| dom/create-elements | 419.2ms | — | — |
| dom/set-attributes | 388.5ms | — | — |
| dom/read-attributes | 375.7ms | — | — |
| dom/modify-text | 371.8ms | — | — |
| mixed/csv-parse | 506.0ms | 636.6ms | — |
| mixed/text-search | 499.1ms | 678.0ms | 614.3ms |
| mixed/fibonacci | 460.0ms | 486.0ms | 473.4ms |
| mixed/matrix-multiply | 620.5ms | 700.6ms | 509.4ms |
| mixed/sieve | 566.8ms | 658.5ms | — |
