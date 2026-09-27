# Scientific issues for author review

The requested prose revision is complete. The following issues predate the edit and affect whether the paper as a whole is ready for submission. They were found while checking that the revised text corresponds to the available work. No application code, protocol equation, or experiment result was changed to resolve them.

## Reported physical-testbed measurements

At the author’s explicit instruction during this revision, retain the four-device setup, 48.2 ms mean convergence, revocation under 65 ms, 98-byte heartbeats, two-second interval, approximately 0.05 KB/s per connection, and the approximately 5 KB / 1.3 KB payload figures as reported. These measurements were not independently reproduced. The paper does not state the physical testbed’s trial count, dispersion, timing instrumentation or software revision. Do not infer those details from the separate local benchmark files.

`paper/bench/exp_trust.js` and `paper/bench/results/trust.json` describe another evaluation, including harness-side modifications. Those results were not substituted for the physical measurements. The abstract and conclusion only reuse values already present in Section V-B.

## Canonical pool definition versus the checked-in implementation

Section III-C includes the local device in P. However, [`electron/core/trust.ts::computePoolHash`](../../../electron/core/trust.ts) hashes stored peer records, and the current Android `LinkTrustStore.java::computePoolHash` likewise iterates stored peers. The sync list adds the local identity separately; that does not add it to the hash input. The existing benchmark explicitly provides `viewDigest` and a `fixedDigest` variant that includes the local identity. Confirm which source revision produced the stated physical experiment and whether its digest matches the paper. The specified canonicalization equations remain unchanged.

## Trusted-sender enforcement

The paper requires sync and removal frames to come from already-trusted peers. The current desktop packet handlers and Android sync handler do not visibly enforce that condition at those dispatch points; the benchmark’s [`paper/bench/fixes.js::applyTrustedSenderRule`](../../bench/fixes.js) adds such a gate. This is a code-review finding, not a newly performed exploit test. Confirm the evaluated implementation’s authorization checks before treating the implementation as evidence of the stated security invariant. The intended rule and equations were preserved in the paper.

## Security scope and disconnected revocation

The current text presents formal invariants, while ProVerif verification remains future work. Clarify the assumptions about compromised trusted members: an existing member has authority to introduce others, so outsider MitM resistance is different from protection against a malicious member. Also check how a node that misses a revocation during a partition is prevented from reintroducing a stale record after reconnection. Section III-E specifies a reachable-peer flood, but no durable revocation tombstone or ordering rule is given. The separate existing draft `paper/paper.tex`, Section VI, also discusses stale-record reintroduction and the trusted-sender guard. These are issues in the existing work, not proposed algorithm changes or newly reproduced experimental results.

## Comparison claims and citation scope

The introduction now attaches the Apple Continuity/AWDL citations to local privacy and attack findings. Those papers do not support a universal WAN requirement, vendor-lock-in claim or Microsoft Entra attribution across all named products. [Celosia and Cunche’s paper](https://doi.org/10.2478/popets-2020-0003), [Stute et al.’s paper](https://www.usenix.org/conference/usenixsecurity19/presentation/stute).

The SSH sentence now describes the risk of accepting an unfamiliar host key without verification. It no longer attributes a universal “users rarely verify” measurement to a study primarily measuring DNS SSHFP deployment. [Neef and Wisiol’s paper](https://arxiv.org/abs/2208.08846).

Table I and the interior labels of Figure 1 were preserved as requested. They still contain broad claims about commercial systems, TLS 1.3 and satisfying all three properties. Table I also mixes total O(N²) pairwise effort with marginal O(1) enrollment effort. Its comparison basis should be clarified in a separate substantive pass. The revised abstract, introduction and conclusion explicitly distinguish total N−1 ceremonies from one ceremony per added device.

The title’s “Defeating” and the remaining formal-guarantee language were not silently replaced. The introduction now presents the trilemma as the paper’s design framing rather than a proved impossibility theorem. Review the broader title, figure and security claims against the actual evidence before submission.
