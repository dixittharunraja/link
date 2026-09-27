# Revision log

Each entry contains the exact original and revised LaTeX. Highlight locations refer to the original eight-page Turnitin report. Changes outside highlights are explicitly identified. Equations, protocol steps, numerical measurements, and bibliography entries were not replaced to influence a detector.

## R01 — Abstract

**Report status:** First sentence highlighted; remainder revised for coherence.

**Original**

```latex
Modern multi-device environments, encompassing smartphones, personal computers and embedded endpoints, frequently demand tight local network interoperability for telemetry, continuous synchronization and remote peripheral control. However, establishing mutual trust among heterogeneous devices on a local area network (LAN) exposes a usable-security trilemma: system designers are forced to trade off decentralization (zero cloud dependency), cryptographic integrity (man-in-the-middle resistance and certificate pinning) and frictionless usability (constant human pairing effort per device). Existing solutions either rely on centralized identity providers that compromise user privacy and introduce wide-area failure modes, or enforce pairwise trust-on-first-use (TOFU), whose human pairing effort grows quadratically with the number of devices. This paper proposes Transitive Trust-on-First-Use (T-TOFU), a zero-coordinator trust propagation and state synchronization protocol tailored for personal device meshes. Under T-TOFU, a single human-gated authentication ceremony transitively enrolls an incoming node across the entire mesh. A deterministic canonical pool digest, coupled with anti-entropy heartbeat gossip, maintains pool-wide consistency without an online certificate authority or central ledger, and a cascaded revocation flood purges removed endpoints. T-TOFU is implemented in Link, a cross-platform mesh runtime for Windows and Android, and is evaluated for cryptographic robustness, protocol overhead and convergence. The results show that T-TOFU reduces the total human pairing effort from quadratic to linear in the mesh size, with a single ceremony per new device, while converging across a local mesh in well under one second with negligible bandwidth overhead.
```

**Revised**

```latex
Personal device meshes need local communication for telemetry, synchronization and remote peripheral control. Establishing trust across these devices requires balancing cloud independence, cryptographic authentication and the effort of manual pairing. Pairwise trust-on-first-use (TOFU) requires a separate ceremony for every pair in a fully connected mesh, so the total pairing effort grows quadratically with mesh size. We present Transitive Trust-on-First-Use (T-TOFU), a protocol that enrolls a new device through one human-gated pairing ceremony with an existing member. Trusted members then exchange certificate records over authenticated TLS connections. A canonical pool digest and anti-entropy heartbeat gossip detect and repair differences between trust tables without an online certificate authority or central ledger; a revocation flood removes a device from the reachable mesh. We implement T-TOFU in Link for Windows and Android and analyze its security under the stated adversary model. Building an $N$-device mesh requires $N-1$ human pairing ceremonies, with one ceremony for each additional device. In the four-node physical testbed, mean enrollment convergence was $48.2\,\text{ms}$ and revocation propagated in under $65\,\text{ms}$. A 98-byte heartbeat sent every 2 seconds accounts for about $0.05\,\text{KB/s}$ per connection.
```

**Reason:** Replace the generic opening and qualitative performance language with the protocol operations, ceremony count, and measurements already reported in Section V. State the fully connected baseline and distinguish security analysis from measurement.

**Category:** clarity; precision; author voice; unsupported/formulaic wording

## R02 — I. Introduction, paragraph 1

**Report status:** Not highlighted; adjacent context.

**Original**

```latex
The contemporary computing landscape is characterized by user ownership of multiple heterogeneous devices, including personal laptops, smartphones, tablets and smart displays \cite{brudy2019crossdevice}. Integrating these devices into a cohesive personal mesh enables critical functionalities such as bidirectional clipboard synchronization, seamless remote peripheral input, media control and user-space file-system virtualization.
```

**Revised**

```latex
Users often work across laptops, smartphones, tablets and smart displays \cite{brudy2019crossdevice}. A personal device mesh connects these endpoints to support bidirectional clipboard synchronization, remote peripheral input, media control and user-space file-system virtualization.
```

**Reason:** Name the devices and functions directly; remove the generic landscape opening and evaluative words such as critical and seamless.

**Category:** clarity; redundancy; unsupported/formulaic wording

## R03 — I. Introduction, paragraph 2

**Report status:** Both sentences highlighted.

**Original**

```latex
Despite the operational demand for continuous local interoperability, establishing secure and user-friendly trust across these endpoints remains fundamentally challenging. System architectures in this domain inevitably encounter the \textit{Usable-Security Trilemma}, illustrated in Fig.~\ref{fig:trilemma}, wherein no conventional architecture satisfies all three properties simultaneously:
```

**Revised**

```latex
These functions require devices to establish trust while keeping setup manageable. We frame this design problem as the \textit{Usable-Security Trilemma} in Fig.~\ref{fig:trilemma}, with three requirements:
```

**Reason:** Replace the unsupported universal impossibility claim with the paper's design framing. The same three requirements remain below.

**Category:** precision; unsupported/formulaic wording

## R04 — Figure 1 caption

**Report status:** Final sentence highlighted.

**Original**

```latex
\caption{The Usable-Security Trilemma in Device Meshes: Prior paradigms trade off between cloud dependency, pairing friction, or cryptographic integrity. T-TOFU reconciles all three vertices.}
```

**Revised**

```latex
\caption{Design tradeoffs in personal device meshes: cloud dependence, manual pairing effort and cryptographic authentication. T-TOFU combines local trust propagation with one human pairing ceremony per new device.}
```

**Reason:** Describe the proposed mechanism instead of repeating the absolute reconciles-all-three assertion.

**Category:** clarity; precision; unsupported/formulaic wording

## R05 — I-A. Limitations of Current Paradigms, paragraph 1

**Report status:** Continuation on report page 4 highlighted; opening on page 3 not highlighted.

**Original**

```latex
Commercial ecosystems (e.g., Apple Continuity/AirDrop, Google Quick Share, Microsoft Phone Link) resolve the usability challenge by delegating trust to centralized cloud identity infrastructures (Apple ID, Google Accounts, Microsoft Entra). While this offers an effortless out-of-the-box experience, it mandates WAN connectivity, introduces single points of failure, exposes personal metadata to cloud providers and nearby observers \cite{celosia2020discontinued, stute2019billion}, and enforces proprietary vendor lock-in.
```

**Revised**

```latex
Cloud identity services simplify device enrollment by associating devices with a user account, but make trust management dependent on an external provider. Commercial device integration suites include Apple Continuity/AirDrop, Google Quick Share and Microsoft Phone Link. Privacy also depends on the local discovery and communication protocols: studies of Apple Continuity and Apple Wireless Direct Link document information leakage and attacks involving nearby devices \cite{celosia2020discontinued, stute2019billion}. These findings motivate keeping trust establishment local while authenticating the participating devices.
```

**Reason:** Separate cloud dependence from the local privacy findings supported by the two cited Apple studies. Remove the blanket WAN, effortless-use, vendor-lock-in and Microsoft Entra assertions that those references do not establish. This is an evidence-based qualification, not a stylistic change to a protocol.

**Category:** precision; unsupported/formulaic wording

## R06 — I-A. Limitations of Current Paradigms, paragraph 2

**Report status:** First sentence and beginning of second sentence highlighted; highlight stops at requires, with a separate highlight over the numerator N in the binomial coefficient.

**Original**

```latex
Conversely, open-source peer-to-peer (P2P) systems (e.g., KDE Connect \cite{kdeconnect}, SSH-based local tooling, standard Bluetooth pairing \cite{antonioli2023bluffs}) adopt a Trust-on-First-Use (TOFU) model using self-signed cryptographic certificates or pre-shared keys. While these systems achieve zero-cloud privacy, they suffer from an $\mathcal{O}(N^2)$ human pairing bottleneck: enrolling $N$ devices requires $\binom{N}{2} = \frac{N(N-1)}{2}$ independent, manual PIN verification or QR code scanning ceremonies. For an ordinary user with five personal devices, completing ten discrete manual pairing operations introduces severe friction, and in practice users rarely perform the fingerprint verification that TOFU relies on \cite{neef2022ssh}.
```

**Revised**

```latex
Pairwise approaches establish trust separately between devices. Examples include KDE Connect \cite{kdeconnect}, SSH-based local tooling and Bluetooth pairing \cite{antonioli2023bluffs}, although their authentication mechanisms differ. In a fully connected mesh using manual pairwise TOFU, enrolling $N$ devices requires $\binom{N}{2} = \frac{N(N-1)}{2}$ pairing ceremonies. Five devices therefore require ten ceremonies. Manual fingerprint checking also depends on user attention; SSH users may accept an unfamiliar host key without verifying it \cite{neef2022ssh}.
```

**Reason:** Make the fully connected assumption explicit, retain the exact count, and avoid classifying every Bluetooth method as TOFU. Replace the unmeasured severity claim and universal user-behavior claim with the SSH-specific issue discussed by the cited paper.

**Category:** clarity; precision; unsupported/formulaic wording

## R07 — I-B. Contributions, opening paragraph

**Report status:** Not highlighted; adjacent context.

**Original**

```latex
To resolve this trilemma, we present \textbf{Transitive Trust-on-First-Use (T-TOFU)}, a zero-coordinator trust federation framework designed specifically for personal device meshes. Our contributions are summarized as follows:
```

**Revised**

```latex
We present \textbf{Transitive Trust-on-First-Use (T-TOFU)}, a protocol for propagating trust within a personal device mesh without a coordinator. The contributions are:
```

**Reason:** Introduce the contribution directly and avoid repeating the universal trilemma-resolution claim. The four contribution items are unchanged.

**Category:** clarity; redundancy; author voice

## R08 — Figure 2 caption

**Report status:** Caption text after the figure number highlighted.

**Original**

```latex
\caption{Protocol Sequence Diagram of Transitive Trust-on-First-Use (T-TOFU): A single human-gated verification between New Node $C$ and Gateway $B$ transitively enrolls $C$ across the entire mesh, verified via canonical pool digest convergence ($\text{PoolHash}$).}
```

**Revised**

```latex
\caption{T-TOFU enrollment: new node $C$ pairs with member $B$ through human verification. Certificate exchange then establishes trust between $C$ and existing peer $A$, and heartbeat digests compare their pool views.}
```

**Reason:** Explain the displayed sequence and distinguish human authentication from digest comparison; matching digests do not independently prove authentication.

**Category:** clarity; precision

## R09 — III-A. Cryptographic Identity, item 2

**Report status:** Highlighted.

**Original**

```latex
A self-signed X.509 certificate $\text{Cert}_i$ carrying a 2048-bit RSA key pair.
```

**Revised**

```latex
A 2048-bit RSA key pair and a corresponding self-signed X.509 certificate $\text{Cert}_i$.
```

**Reason:** A certificate contains the public key, not the private key of the pair. Correct the wording while preserving the key size and certificate type.

**Category:** precision

## R10 — III-A. Certificate-pinning paragraph

**Report status:** Entire paragraph highlighted.

**Original**

```latex
All inter-device communication is transported over TLS; version 1.3 \cite{rfc8446} is negotiated by default and version 1.2 is the minimum accepted. During the TLS handshake, peer certificates are validated not against a public CA root, but strictly against pinned fingerprints stored within the local \textit{TrustStore} \cite{pradeep2022pinning}. If a remote device presents a certificate whose fingerprint differs from the stored pinned value, the connection is instantly aborted with an alert.
```

**Revised**

```latex
Trust-management communication uses TLS, with version 1.3 \cite{rfc8446} negotiated by default and version 1.2 as the minimum accepted version. For a paired peer, certificate validation compares its fingerprint with the value pinned in the local \textit{TrustStore}, rather than a public CA root \cite{pradeep2022pinning}. A fingerprint mismatch aborts the connection and raises an alert.
```

**Reason:** State the validation check directly, scope the TLS statement to trust-management traffic, and scope pinning to paired peers, consistent with the UDP discovery and unpinned initial handshake in the sequence diagram and III-B. Preserve both TLS versions and citations.

**Category:** clarity; precision

## R11 — III-B. OOB gate, opening paragraph

**Report status:** Entire paragraph highlighted.

**Original**

```latex
When an unauthenticated device $C$ initiates contact with an existing mesh member $B$, they execute an initial handshake over an unpinned TLS channel. To prevent active MitM interception, the protocol derives an ephemeral visual verification code:
```

**Revised**

```latex
An unauthenticated device $C$ first connects to mesh member $B$ over an unpinned TLS channel. The endpoints derive a visual verification code for the user to check for active MitM interception:
```

**Reason:** Make the order and purpose of the initial handshake explicit. Preserve the code formula without modification.

**Category:** clarity; author voice

## R12 — III-B. OOB gate, paragraph after Equation 3

**Report status:** Entire explanation highlighted across the two columns.

**Original**

```latex
where $\text{K}_B$ and $\text{K}_C$ denote the DER-encoded public keys of the respective endpoints, ordered byte-wise so that both sides compute the same value, and Salt is the timestamp of the pairing session. This 8-character token is displayed simultaneously on both physical screens. Once the human operator confirms code equality, device $B$ registers $C$ into its active trust store $\mathcal{T}_B$, and $C$ registers $B$ into $\mathcal{T}_C$.
```

**Revised**

```latex
where $\text{K}_B$ and $\text{K}_C$ are the endpoints' DER-encoded public keys. Byte-wise ordering gives both endpoints the same input, and Salt is the pairing-session timestamp. Both screens display the 8-character token. After the user confirms that the codes match, $B$ adds $C$ to $\mathcal{T}_B$ and $C$ adds $B$ to $\mathcal{T}_C$.
```

**Reason:** Separate key encoding, ordering, timestamp and user confirmation into direct statements. Keep the timestamp, token length and bilateral trust-store update exactly as specified.

**Category:** clarity; precision; author voice

## R13 — III-C. Canonical Pool Digest, opening paragraph

**Report status:** Highlighted.

**Original**

```latex
To maintain decentralized state agreement across all mesh members without a consensus leader (e.g., Raft or Paxos), T-TOFU defines a canonical pool representation.
```

**Revised**

```latex
T-TOFU uses a canonical representation of pool membership so that nodes can compare their trust tables without a consensus leader such as Raft or Paxos.
```

**Reason:** Describe the digest's comparison role without implying that a hash alone implements consensus. The canonicalization algorithm and all equations remain unchanged.

**Category:** clarity; precision

## R14 — III-D. Anti-Entropy Gossip, item 1

**Report status:** Only the second sentence highlighted.

**Original**

```latex
Node $A$ transmits packet \texttt{link.pool.sync} containing its serialized trust table $\mathcal{T}_A = \{ (\text{ID}_k, \text{Cert}_k) \}$. Because heartbeats flow in both directions, $B$ does the same.
```

**Revised**

```latex
Node $A$ sends its serialized trust table $\mathcal{T}_A = \{ (\text{ID}_k, \text{Cert}_k) \}$ in a \texttt{link.pool.sync} packet. Node $B$ sends its table in response to the mismatch detected through the heartbeat exchange in the opposite direction.
```

**Reason:** Identify what B sends and the trigger for the reverse exchange; retain the same packet and trust-table representation.

**Category:** clarity; precision

## R15 — III-D. Anti-Entropy Gossip, item 2

**Report status:** Highlighted.

**Original**

```latex
Node $B$ iterates through each entry $k \in \mathcal{T}_A$. For any entry where $\text{ID}_k \notin \mathcal{T}_B$, node $B$ verifies that $A \in \mathcal{T}_B$, auto-ingests $\text{Cert}_k$, and pins $\text{FP}_k$.
```

**Revised**

```latex
Node $B$ examines each entry $k \in \mathcal{T}_A$. If $\text{ID}_k \notin \mathcal{T}_B$, it verifies that the sender $A \in \mathcal{T}_B$, adds $\text{Cert}_k$ to its trust store and pins $\text{FP}_k$.
```

**Reason:** Replace auto-ingests with the actual trust-store operation while retaining the sender check, membership condition and pinning step.

**Category:** clarity; precision

## R16 — III-D. Anti-Entropy Gossip, item 3

**Report status:** Highlighted.

**Original**

```latex
Node $B$ updates its canonical pool hash and broadcasts \texttt{link.pool.sync} to all other currently connected peers.
```

**Revised**

```latex
Node $B$ recomputes its canonical pool hash and broadcasts \texttt{link.pool.sync} to its other connected peers.
```

**Reason:** Use recomputes for the digest operation and remove redundant qualifiers; the recipients and packet type are unchanged.

**Category:** clarity; redundancy

## R17 — III-E. Revocation, opening sentence

**Report status:** Highlighted.

**Original**

```latex
When a user initiates an unpair action on device $A$ targeting device $X$, node $A$ executes the following sequence:
```

**Revised**

```latex
When the user unpairs device $X$ from device $A$, revocation proceeds as follows:
```

**Reason:** State the user action directly while keeping the initiating and target devices explicit.

**Category:** clarity; redundancy

## R18 — III-E. Revocation, item 1

**Report status:** Highlighted.

**Original**

```latex
$A$ removes $X$ from its local $\mathcal{T}_A$ and severs any active sockets.
```

**Revised**

```latex
$A$ removes $X$ from its local $\mathcal{T}_A$ and closes its active sockets to $X$.
```

**Reason:** Clarify that the closed sockets belong to the removed peer; the next step needs connections to other peers for flooding.

**Category:** precision

## R19 — III-E. Revocation, item 2 lead-in

**Report status:** Highlighted, including the displayed frame.

**Original**

```latex
$A$ constructs a revocation frame, carried only over authenticated TLS channels:
```

**Revised**

```latex
$A$ constructs the following revocation frame for transmission over authenticated TLS channels only:
```

**Reason:** Clarify transmission while retaining the channel restriction and the exact revocation-frame equation.

**Category:** clarity

## R20 — III-E. Revocation, item 4

**Report status:** Highlighted.

**Original**

```latex
Upon receiving $\mathcal{R}$, peer $j$ checks if $\text{ID}_X \in \mathcal{T}_j$. If present, it purges $X$'s certificate, recalculates its $\text{PoolHash}$, and propagates $\mathcal{R}$ to its remaining active neighbors.
```

**Revised**

```latex
Upon receiving $\mathcal{R}$, peer $j$ checks whether $\text{ID}_X \in \mathcal{T}_j$. If the entry is present, $j$ removes $X$'s certificate, recomputes its $\text{PoolHash}$ and forwards $\mathcal{R}$ to its remaining active neighbors.
```

**Reason:** Make the membership condition and acting peer explicit without changing removal, digest recalculation or forwarding.

**Category:** clarity; precision

## R21 — IV. System Implementation, opening paragraph

**Report status:** First sentence highlighted; the second sentence is not highlighted.

**Original**

```latex
We implemented the complete T-TOFU protocol in \textit{Link}, an open-source cross-platform device mesh runtime. The implementation spans two major operating systems:
```

**Revised**

```latex
We implemented T-TOFU in \textit{Link}, an open-source device mesh runtime for Windows and Android. The platform components are described below.
```

**Reason:** Name the two implemented platforms directly and remove the unqualified complete claim.

**Category:** clarity; redundancy; author voice

## R22 — V-B. Convergence Latency

**Report status:** Not highlighted; precision correction supporting the abstract and conclusion.

**Original**

```latex
Upon completing an OOB PIN confirmation between a smartphone and a PC, the \texttt{link.pool.sync} payload (about 5\,KB for four members, or 1.3\,KB per member record) propagated across all four physical nodes in an average of $48.2\,\text{ms}$, resulting in immediate, sub-100\,ms pool-wide mesh convergence.
```

**Revised**

```latex
After OOB code confirmation between a smartphone and a PC, the \texttt{link.pool.sync} payload (about 5\,KB for four members, or 1.3\,KB per member record) propagated across all four physical nodes in an average of $48.2\,\text{ms}$.
```

**Reason:** Use code to match the 8-character verification token. Preserve the reported average and payload sizes; remove immediate and the unsupported implication that an average establishes a per-trial upper bound.

**Category:** precision; redundancy

## R23 — VII. Conclusion and Future Work, paragraph 1

**Report status:** Not highlighted; revised at the user's explicit request.

**Original**

```latex
This paper presented \textbf{Transitive Trust-on-First-Use (T-TOFU)}, a decentralized trust federation protocol that resolves the classical Usable-Security Trilemma in personal device meshes. By combining human-gated root pairing, canonical pool digest gossip and cascaded revocation, T-TOFU eliminates the $\mathcal{O}(N^2)$ pairing barrier while preserving zero-cloud decentralization and strict cryptographic integrity. We verified T-TOFU through a reference implementation across Windows and Android, demonstrating sub-second convergence and resilience against local network adversaries.
```

**Revised**

```latex
T-TOFU establishes trust in a personal device mesh through human-verified pairing with one existing member, followed by certificate propagation over authenticated TLS connections. Canonical pool digests support anti-entropy repair, and cascaded revocation removes a device from the reachable mesh. This design requires $N-1$ human ceremonies to build an $N$-device mesh, compared with $N(N-1)/2$ for fully connected pairwise TOFU, while keeping trust management local. In the four-node Windows and Android testbed, mean enrollment convergence was $48.2\,\text{ms}$ and revocation propagated in under $65\,\text{ms}$. These measurements characterize the evaluated testbed; the security analysis addresses local network adversaries under the stated assumptions.
```

**Reason:** Summarize the mechanism, exact ceremony counts and reported observations. Replace sweeping resolution and verified-resilience language with the scope of the implementation, testbed and security analysis. Future work remains unchanged.

**Category:** clarity; precision; author voice; unsupported/formulaic wording

## R24 — Reference-column balancing command

**Report status:** Not highlighted; layout-only adjustment.

**Original**

```latex
\IEEEtriggeratref{12}
```

**Revised**

```latex
\IEEEtriggeratref{15}
```

**Reason:** Rebalance the final page after the prose changes moved the bibliography. All 19 bibliography entries and their order remain unchanged.

**Category:** clarity (layout)
