# js2wasm Benchmark Results

Date: 2026-10-11
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.046ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.065ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.119ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.416ms | 8.30ms | 2.90ms | FAILED | js |
| string/replace | 0.103ms | 0.685ms | 0.326ms | FAILED | js |
| string/case-convert | 0.056ms | 0.599ms | 0.284ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.169ms | 4.08ms | 2.81ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.98ms | 3.04ms | 0.558ms | js |
| array/push-pop | 1.38ms | 0.500ms | 0.503ms | FAILED | host-call |
| array/sort-i32 | 0.793ms | 0.292ms | 0.293ms | FAILED | host-call |
| array/map-filter | 0.126ms | 0.070ms | 0.070ms | FAILED | host-call |
| array/reduce | 1.34ms | 0.499ms | 0.504ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.027ms | 0.027ms | FAILED | host-call |
| array/find | 0.253ms | 0.015ms | 0.015ms | 1.08ms | host-call |
| dom/create-elements | 0.041ms | 0.100ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.218ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.122ms | — | — | js |
| dom/modify-text | 0.028ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.488ms | 8.88ms | 0.636ms | FAILED | js |
| mixed/text-search | 0.390ms | 5.34ms | 2.97ms | 1.09ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.157ms | 75.57ms | 76.51ms | 0.719ms | js |
| mixed/sieve | 1.52ms | 2.10ms | 2.09ms | FAILED | js |

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
| string/concat-short | 10000 | 3.47 | 4.61 | 4.36 | — |
| string/concat-long | 1000 | 3.56 | 4.53 | 3.61 | — |
| string/indexOf | 1000 | 19.16 | 65.41 | 12.02 | 14.77 |
| string/includes | 1000 | 19.19 | 118.50 | 14.74 | 16.21 |
| string/split | 10000 | 41.59 | 829.66 | 290.25 | — |
| string/replace | 1000 | 102.95 | 684.56 | 325.73 | — |
| string/case-convert | 2000 | 27.81 | 299.32 | 141.80 | — |
| string/substring | 10000 | 9.84 | 3.74 | 3.08 | — |
| string/trim | 10000 | 16.94 | 408.29 | 281.35 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 148.76 | 151.94 | 27.92 |
| array/map-filter | 30000 | 4.20 | 2.33 | 2.33 | — |
| array/indexOf | 1000 | 3949.40 | 2646.03 | 2644.33 | — |
| dom/create-elements | 2000 | 20.37 | 50.25 | — | — |
| dom/set-attributes | 6000 | 17.19 | 36.40 | — | — |
| dom/read-attributes | 3000 | 18.23 | 40.72 | — | — |
| dom/modify-text | 2000 | 14.15 | 57.46 | — | — |
| mixed/csv-parse | 11000 | 44.33 | 807.10 | 57.81 | — |
| mixed/text-search | 40000 | 9.75 | 133.50 | 74.30 | 27.22 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.32 | 28.14 |
| mixed/matrix-multiply | 125000 | 1.26 | 604.53 | 612.12 | 5.75 |
| mixed/sieve | 200000 | 7.58 | 10.48 | 10.47 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.33x slower | 1.26x slower | — |
| string/concat-long | 1.27x slower | 1.02x slower | — |
| string/indexOf | 3.41x slower | 1.59x faster | 1.30x faster |
| string/includes | 6.18x slower | 1.30x faster | 1.18x faster |
| string/split | 19.95x slower | 6.98x slower | — |
| string/replace | 6.65x slower | 3.16x slower | — |
| string/case-convert | 10.76x slower | 5.10x slower | — |
| string/substring | 2.63x faster | 3.20x faster | — |
| string/trim | 24.10x slower | 16.61x slower | — |
| string/startsWith-endsWith | 7.41x slower | 7.57x slower | 1.39x slower |
| array/push-pop | 2.76x faster | 2.74x faster | — |
| array/sort-i32 | 2.71x faster | 2.71x faster | — |
| array/map-filter | 1.81x faster | 1.81x faster | — |
| array/reduce | 2.67x faster | 2.65x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.12x slower | 1.12x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.76x faster | — |
| array/find | 16.56x faster | 16.52x faster | 4.25x slower |
| dom/create-elements | 2.47x slower | — | — |
| dom/set-attributes | 2.12x slower | — | — |
| dom/read-attributes | 2.23x slower | — | — |
| dom/modify-text | 4.06x slower | — | — |
| mixed/csv-parse | 18.21x slower | 1.30x slower | — |
| mixed/text-search | 13.69x slower | 7.62x slower | 2.79x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 481.14x slower | 487.19x slower | 4.58x slower |
| mixed/sieve | 1.38x slower | 1.38x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.06x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.44x faster |
| string/includes | 8.04x faster |
| string/split | 2.86x faster |
| string/replace | 2.10x faster |
| string/case-convert | 2.11x faster |
| string/substring | 1.21x faster |
| string/trim | 1.45x faster |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 13.96x faster |
| mixed/text-search | 1.80x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1115.3ms | 595.0ms | — |
| string/concat-long | 422.0ms | 644.0ms | — |
| string/indexOf | 360.0ms | 669.0ms | 551.8ms |
| string/includes | 364.0ms | 651.5ms | 540.0ms |
| string/split | 503.4ms | 688.5ms | — |
| string/replace | 496.8ms | 715.3ms | — |
| string/case-convert | 514.8ms | 599.2ms | — |
| string/substring | 380.6ms | 478.4ms | — |
| string/trim | 494.7ms | 668.5ms | — |
| string/startsWith-endsWith | 490.7ms | 689.4ms | 604.5ms |
| array/push-pop | 508.0ms | 565.9ms | — |
| array/sort-i32 | 675.9ms | 729.9ms | — |
| array/map-filter | 698.2ms | 719.5ms | — |
| array/reduce | 602.1ms | 691.5ms | — |
| array/indexOf | 574.0ms | 649.2ms | — |
| array/slice | 501.4ms | 587.9ms | — |
| array/reverse | 491.2ms | 575.3ms | — |
| array/forEach | 651.8ms | 669.5ms | — |
| array/find | 488.1ms | 563.2ms | 547.9ms |
| dom/create-elements | 400.1ms | — | — |
| dom/set-attributes | 377.3ms | — | — |
| dom/read-attributes | 378.0ms | — | — |
| dom/modify-text | 360.6ms | — | — |
| mixed/csv-parse | 506.6ms | 658.5ms | — |
| mixed/text-search | 498.9ms | 701.7ms | 599.9ms |
| mixed/fibonacci | 452.5ms | 491.8ms | 464.3ms |
| mixed/matrix-multiply | 630.2ms | 681.9ms | 506.2ms |
| mixed/sieve | 628.0ms | 677.7ms | — |
