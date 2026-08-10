# js2wasm Benchmark Results

Date: 2026-08-09
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.026ms | 0.037ms | 0.031ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.047ms | gc-native |
| string/includes | 0.015ms | 0.090ms | 0.011ms | 0.052ms | gc-native |
| string/split | 0.324ms | 3.65ms | 0.392ms | FAILED | js |
| string/replace | 0.077ms | 0.185ms | 0.053ms | FAILED | gc-native |
| string/case-convert | 0.045ms | 0.175ms | 0.004ms | FAILED | gc-native |
| string/substring | 0.082ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.135ms | 0.718ms | 0.153ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.87ms | 0.238ms | 0.433ms | gc-native |
| array/push-pop | 1.32ms | 0.481ms | 0.472ms | FAILED | gc-native |
| array/sort-i32 | 0.658ms | 0.254ms | 0.248ms | FAILED | gc-native |
| array/map-filter | 0.067ms | 0.052ms | 0.052ms | FAILED | gc-native |
| array/reduce | 1.91ms | 0.479ms | 0.478ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.23ms | FAILED | host-call |
| array/slice | 0.032ms | 0.015ms | 0.015ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | host-call |
| array/find | 0.213ms | 0.012ms | 0.012ms | 0.940ms | gc-native |
| dom/create-elements | 0.028ms | 0.122ms | — | — | js |
| dom/set-attributes | 0.084ms | 0.425ms | — | — | js |
| dom/read-attributes | 0.051ms | 0.105ms | — | — | js |
| dom/modify-text | 0.024ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.364ms | 5.11ms | 0.472ms | FAILED | js |
| mixed/text-search | 0.312ms | 1.76ms | 0.228ms | 0.872ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.101ms | 0.101ms | 0.037ms | linear-memory |
| mixed/matrix-multiply | 0.146ms | 0.164ms | 0.164ms | 0.562ms | js |
| mixed/sieve | 1.46ms | 1.15ms | 1.17ms | FAILED | host-call |

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
| string/concat-short | 10000 | 2.58 | 3.69 | 3.12 | — |
| string/concat-long | 1000 | 2.98 | 4.18 | 2.93 | — |
| string/indexOf | 1000 | 14.77 | 47.05 | 10.00 | 46.87 |
| string/includes | 1000 | 14.52 | 90.27 | 11.48 | 52.50 |
| string/split | 10000 | 32.40 | 365.29 | 39.24 | — |
| string/replace | 1000 | 77.00 | 185.27 | 53.47 | — |
| string/case-convert | 2000 | 22.53 | 87.55 | 2.03 | — |
| string/substring | 10000 | 8.16 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.46 | 71.81 | 15.25 | — |
| string/startsWith-endsWith | 20000 | 16.02 | 93.27 | 11.89 | 21.63 |
| array/map-filter | 30000 | 2.24 | 1.74 | 1.73 | — |
| array/indexOf | 1000 | 3459.50 | 2223.00 | 2229.18 | — |
| dom/create-elements | 2000 | 13.93 | 60.78 | — | — |
| dom/set-attributes | 6000 | 14.04 | 70.85 | — | — |
| dom/read-attributes | 3000 | 16.83 | 35.15 | — | — |
| dom/modify-text | 2000 | 11.84 | 43.82 | — | — |
| mixed/csv-parse | 11000 | 33.11 | 464.89 | 42.93 | — |
| mixed/text-search | 40000 | 7.81 | 43.89 | 5.70 | 21.79 |
| mixed/fibonacci | 10000 | 9.72 | 10.08 | 10.08 | 3.70 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.31 | 1.31 | 4.50 |
| mixed/sieve | 200000 | 7.32 | 5.77 | 5.84 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.43x slower | 1.21x slower | — |
| string/concat-long | 1.40x slower | 1.02x faster | — |
| string/indexOf | 3.19x slower | 1.48x faster | 3.17x slower |
| string/includes | 6.22x slower | 1.27x faster | 3.62x slower |
| string/split | 11.28x slower | 1.21x slower | — |
| string/replace | 2.41x slower | 1.44x faster | — |
| string/case-convert | 3.89x slower | 11.09x faster | — |
| string/substring | 2.64x faster | 3.06x faster | — |
| string/trim | 5.33x slower | 1.13x slower | — |
| string/startsWith-endsWith | 5.82x slower | 1.35x faster | 1.35x slower |
| array/push-pop | 2.74x faster | 2.79x faster | — |
| array/sort-i32 | 2.59x faster | 2.65x faster | — |
| array/map-filter | 1.29x faster | 1.29x faster | — |
| array/reduce | 3.99x faster | 4.00x faster | — |
| array/indexOf | 1.56x faster | 1.55x faster | — |
| array/slice | 2.23x faster | 2.15x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.88x faster | 1.87x faster | — |
| array/find | 17.31x faster | 17.75x faster | 4.41x slower |
| dom/create-elements | 4.36x slower | — | — |
| dom/set-attributes | 5.05x slower | — | — |
| dom/read-attributes | 2.09x slower | — | — |
| dom/modify-text | 3.70x slower | — | — |
| mixed/csv-parse | 14.04x slower | 1.30x slower | — |
| mixed/text-search | 5.62x slower | 1.37x faster | 2.79x slower |
| mixed/fibonacci | 1.04x slower | 1.04x slower | 2.63x faster |
| mixed/matrix-multiply | 1.12x slower | 1.12x slower | 3.85x slower |
| mixed/sieve | 1.27x faster | 1.25x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x faster |
| string/concat-long | 1.43x faster |
| string/indexOf | 4.71x faster |
| string/includes | 7.86x faster |
| string/split | 9.31x faster |
| string/replace | 3.47x faster |
| string/case-convert | 43.11x faster |
| string/substring | 1.16x faster |
| string/trim | 4.71x faster |
| string/startsWith-endsWith | 7.85x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.04x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.03x faster |
| mixed/csv-parse | 10.83x faster |
| mixed/text-search | 7.70x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 427B | 1.1KB | 10.4KB |
| string/includes | 414B | 1.1KB | 10.4KB |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 3.9KB | — |
| string/case-convert | 1.6KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | 1.7KB |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1021.0ms | 840.0ms | — |
| string/concat-long | 505.0ms | 758.7ms | — |
| string/indexOf | 617.2ms | 734.9ms | 654.1ms |
| string/includes | 631.4ms | 747.3ms | 661.2ms |
| string/split | 598.7ms | 755.8ms | — |
| string/replace | 663.7ms | 848.1ms | — |
| string/case-convert | 626.2ms | 650.3ms | — |
| string/substring | 510.2ms | 583.9ms | — |
| string/trim | 576.5ms | 734.3ms | — |
| string/startsWith-endsWith | 573.5ms | 775.7ms | 716.7ms |
| array/push-pop | 607.7ms | 645.8ms | — |
| array/sort-i32 | 718.7ms | 790.3ms | — |
| array/map-filter | 703.3ms | 779.7ms | — |
| array/reduce | 640.0ms | 691.8ms | — |
| array/indexOf | 698.1ms | 739.1ms | — |
| array/slice | 577.6ms | 708.9ms | — |
| array/reverse | 590.5ms | 633.7ms | — |
| array/forEach | 679.3ms | 738.8ms | — |
| array/find | 583.4ms | 622.4ms | 643.9ms |
| dom/create-elements | 482.8ms | — | — |
| dom/set-attributes | 552.9ms | — | — |
| dom/read-attributes | 547.1ms | — | — |
| dom/modify-text | 491.2ms | — | — |
| mixed/csv-parse | 632.4ms | 773.2ms | — |
| mixed/text-search | 581.0ms | 756.4ms | 700.2ms |
| mixed/fibonacci | 607.0ms | 659.6ms | 574.0ms |
| mixed/matrix-multiply | 659.8ms | 736.6ms | 646.9ms |
| mixed/sieve | 639.1ms | 700.8ms | — |
