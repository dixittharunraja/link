# Benchmark harness for the ICAECA 2026 paper

Every number in `paper.tex` comes from these scripts via `../gen_macros.py`. The harness executes the
**unmodified** Link desktop core (`electron/core/*`), bundled for plain Node.js.

## Build the bundle (once)

```bash
cd paper/bench
NODE_PATH=../../desktop/node_modules ../../desktop/node_modules/.bin/esbuild entry.ts \
  --bundle --platform=node --format=cjs --external:electron --outfile=linkcore.js
node gen_certs.js 17          # RSA-2048 self-signed identities, generated exactly as Link does
```

`node_modules/electron/index.js` is a stub (`safeStorage` unavailable), so trust stores are written unencrypted.

## Experiments

| Script | What it measures | Paper |
|---|---|---|
| `exp_trust.js` | Enrollment/revocation convergence (full mesh, chain, N=2..16) and idle anti-entropy traffic (original vs. view digest) | Fig. 3, Table II |
| `unshare -rn node exp_net.js all` | Bulk goodput/CPU (raw TCP, Plane 2, Base64-in-control) and 120 Hz input latency under load with `tc netem` | Table III, Fig. 4 |
| `exp_micro.js` | Pool digest, SAS, AES-256-GCM and Opus cost | Sec. VI-E |
| `exp_attack.js` | Unpaired device injecting `pool.sync` / `pool.remove` (unmodified core vs. trusted-sender rule) | Sec. VII |
| `exp_persist.js` | Trust-store write cost (ext4 vs. tmpfs) | Sec. VI-A note |

`exp_net.js` must run inside an unprivileged network namespace (`unshare -rn`) so that `tc netem` shapes
only a private loopback; it sets MTU 1500 and a 1500-byte GSO limit to emulate Ethernet/Wi-Fi framing.
`fixes.js` applies the trusted-sender rule of Algorithm 1 as a harness-level patch; `exp_trust.js` also
evaluates the view digest `H(V_i)` by overriding `TrustStore.computePoolHash` per instance.

## Regenerate figures, macros and the PDF

```bash
cd paper
python3 gen_macros.py bench/results && python3 generate_figures.py bench/results
pdflatex paper && bibtex paper && pdflatex paper && pdflatex paper
python3 validate_paper.py
```

Test host used for the reported numbers: AMD Ryzen 7 5800H (16 threads), 15 GiB RAM, Linux 6.8, Node.js 22.17.1.
