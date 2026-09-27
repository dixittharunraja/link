# Code fixes required before submission

The paper (Algorithm 1, Sections IV and VII) specifies two rules that the current source code does
not yet implement. Both were found by the evaluation harness in `paper/bench/`. Apply them on
**both** platforms together — the digest format must stay byte-identical between desktop and Android.

## 1. Security: accept membership messages only from trusted peers (CRITICAL)

**Problem.** `link.pool.sync` and `link.pool.remove` are handled *before* the `if (!peer.trusted) return;`
gate. Any unpaired device that opens a TLS connection to port 1739 can:

- send `link.pool.sync` listing its own identity and certificate → it is written to the trust store and
  its connection is upgraded to trusted **without any PIN**;
- send `link.pool.remove` → a legitimate member is evicted from the pool.

Reproduced with the unmodified core: `node paper/bench/exp_attack.js`
(`unmodified core: attacker enrolled=true trusted-link=true | member evicted=true`).

**Desktop — `electron/core/device-manager.ts`**, inside `attach()` → `conn.on('packet', …)`:

```ts
      if (packet.type === 'link.pool.sync') {
        if (!peer.trusted) return; // membership may only come from an already-trusted peer
        const senderIp = …
        this.handlePoolSyncPacket(packet.body, deviceId, senderIp);
        return;
      }

      if (packet.type === 'link.pool.remove') {
        if (!peer.trusted) return; // a stranger must not be able to evict members
        …
      }
```

**Android — `LinkDeviceManager.java`**, inside `onPacket(...)`, before the `link.pool.sync` branch:

```java
                if ((packet.type.equals("link.pool.sync") || packet.type.equals("link.pool.remove"))
                        && !peer.trusted) {
                    return; // membership may only come from an already-trusted peer
                }
```

## 2. Efficiency: compute the pool digest over the membership view (includes the local device)

**Problem.** `computePoolHash()` hashes the trust store `T_i`, which never contains the local device.
Two members therefore never have equal digests, so every heartbeat (every 2 s) triggers two full
`pool.sync` transfers per connection: `2N(N−1)` messages per cycle — 9.7 MiB every 2 s (≈ 40.8 Mbit/s)
for a 16-device pool (Table II). With the view digest this drops to zero.

**Desktop — `electron/core/trust.ts`:**

```ts
  computePoolHash(self: { deviceId: string; certPem: string }): string {
    const entries = [...this.devices.values()].map((d) => ({ id: d.deviceId, pem: d.certPem }));
    entries.push({ id: self.deviceId, pem: self.certPem });
    entries.sort((a, b) => a.id.localeCompare(b.id));
    const canonical = entries.map((e) => `${e.id}:${certFingerprint(e.pem)}`).join('|');
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').substring(0, 16);
  }
```

and in `device-manager.ts` pass the local identity at the three call sites
(`conn.getPoolHash`, the `'heartbeat'` handler, `runHeartbeatCycle`):

```ts
const self = { deviceId: this.opts.myIdentity.deviceId, certPem: this.opts.cert };
this.trustStore.computePoolHash(self)
```

**Android — `LinkTrustStore.java`:** add the local device id and certificate to the sorted list
before hashing (same `id:fingerprint` entries joined with `|`), e.g.
`public String computePoolHash(String selfId, X509Certificate selfCert)`, and update the three call
sites in `LinkDeviceManager.java` (lines ~100, ~104, ~593).

> Note: `String.compareTo` (Java) and `localeCompare` (JS) agree for the lowercase-hex device ids Link
> generates, so the sort order matches across platforms.

## 3. Recommended hardening (described as limitations/future work in the paper)

- **Sticky revocation:** keep signed tombstones for removed devices so a stale `pool.sync` cannot re-add them.
- **Authenticated input datagrams:** UDP port 1717 is authorised by source address only; add a
  per-session key (like the audio plane's AES-256-GCM key).
- **Hardware re-check:** after applying fixes 1–2, re-verify the A-pairs-B, C-via-B auto-mesh flow on
  real Windows ↔ Android hardware (the docs record this for the earlier Ed25519 pool engine only).
