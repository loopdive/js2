# Deno core bootstrap fixture

These files are unchanged copies of Deno's core bootstrap sources at commit
`1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44` (Deno 2.9.2,
`deno_core` 0.407.0):

| Upstream path | SHA-256 | FNV-1a64 bytes |
| --- | --- | --- |
| `libs/core/00_primordials.js` | `5a2dfbdc4bb81412575d035901a11788001c7e0110e3f736d16289891af44a52` | `0x49d0171d7d2c3f4d` |
| `libs/core/00_infra.js` | `33984000be930f3b02a2d1149ac0319724e8d95891623c8cc74699da4ce97287` | `0xe1a2673875ca364c` |
| `libs/core/02_timers.js` | `305596528c679be30d0ac61fa049ec0f1777c287054d119ff4b341575afac7f9` | `0xcbd26ee0c68dcb66` |
| `libs/core/01_core.js` | `6e67972322cc5385a2b642a4f7e941fccb6f992c9de662a5111d11fd0aaf1a3a` | `0xd2f9d9c62c037a70` |
| `libs/core/mod.js` | `6850db621a5325d8737ad87d2d24cbc35b7010d5e5f36c88dc53c16610cc40e5` | `0xcb8eac5051e421a4` |
| `libs/core/examples/hello_world.rs` `<usage>` raw-string payload | `33bf6b9698833319ad98c0cf88f2fb4dd7634859816ec784aa8902b3eeba1804` | `0xd9c8b2cb5b20c3bc` |

They are retained verbatim so the integration test cannot silently replace
Deno's real wrappers with a reduced reproduction. Deno distributes these
sources under the MIT license; see the copyright and license notice in each
file and Deno's repository-level `LICENSE.md`. `hello_world_usage.js` is the
exact raw-string payload passed to `execute_script("<usage>", ...)`, including
its leading and trailing newline; the probe adds its callable function envelope
outside those verified bytes.
