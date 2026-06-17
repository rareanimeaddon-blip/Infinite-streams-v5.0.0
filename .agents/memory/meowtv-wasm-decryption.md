---
name: MeowTV WASM decryption
description: MeowTV stream decryption changed from SHA-256 XOR to WebAssembly-based AES-CTR; how it works and pitfalls.
---

# MeowTV WASM Decryption

## The rule
MeowTV (meowtv.ru) uses a WebAssembly module to deobfuscate stream URLs. The WASM binary is AES-CTR-encrypted on the CDN and must be decrypted before use. The decrypted WASM is hardcoded as base64 in `artifacts/api-server/src/providers/meowtv.ts` (`MEOW_WASM_B64`).

**Why:** The old SHA-256 XOR scheme (`DECRYPTION_KEY = "9b7e3d1a4f6c2e8d0a5f1c7b3e9d4a6f"`) was replaced by the site. Any stream request will return `{n, d}` ciphertext that must be passed to WASM `deobfuscate(nonce, data)` → JSON string with `{url, language, headers}`.

**How to apply:** If MeowTV streams break again, re-derive the WASM:
1. Fetch `https://meowtv.ru/assets/k{0-3}-*.js` → four 8-byte base64 key chunks
2. Fetch `https://meowtv.ru/assets/payload-*.js` → C (encrypted WASM, `const J=…`) and V (counter, `,Q=…`)
3. AES key = XOR(concat(k0,k1,k2,k3), SHA-256("objectobjectstringfunction"))
4. AES-CTR-decrypt C with key and counter V (length=64) → raw WASM bytes
5. Base64-encode and replace `MEOW_WASM_B64` in `meowtv.ts`
6. Use `node /home/runner/workspace/artifacts/api-server/src/providers/meowtv.ts`-style test to verify first

## WASM memory interface (AssemblyScript runtime)
- `__new(size, id=2)` → allocates string
- `__pin(ptr)` / `__unpin(ptr)` → GC pins
- `memory.buffer` → shared ArrayBuffer; use `Uint16Array` to read/write UTF-16 strings
- `deobfuscate(noncePtr, dataPtr)` → result pointer

## Critical pitfall
**Never paste large base64 strings directly into a `write` tool call** — the write tool truncates/corrupts strings over ~8 KB. Instead:
1. Save the base64 to `/tmp/some.b64` via a bash script
2. Use a Node.js script with `readFileSync` + regex replace to inject it into the source file
3. Verify with `Buffer.from(b64, 'base64').length` and magic-bytes check (`0061736d` for WASM)

## Server list (as of June 2026)
`lynx`, `pseudo`, `tik`, `ipcloud`, `v4:English`, `v5:Hindi`, `v4:Hindi`, `v6:Hindi`
`lynx` and `ipcloud` often return 502; the rest work fine.

## Ticket handling
Each server call gets its own fresh ticket (altcha PoW → POST /streams/ticket). Tickets are single-use — never share one across requests.
