#!/usr/bin/env python3
"""Generates the data figures of the paper (vector PDF) from the benchmark JSON results.

Usage: python3 generate_figures.py <results_dir>
Inputs : trust.json, net-all.json (produced by the benchmark harness in paper/bench/)
Outputs: figures/fig_latency_cdf.pdf, figures/fig_convergence.pdf
"""
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

RES = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "bench", "results")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "figures")
os.makedirs(OUT, exist_ok=True)

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "STIXGeneral", "Nimbus Roman", "DejaVu Serif"],  # Times-like, matches IEEE body text
    "mathtext.fontset": "stix",
    "font.size": 8,
    "axes.labelsize": 8,
    "axes.titlesize": 8,
    "legend.fontsize": 7,
    "xtick.labelsize": 7,
    "ytick.labelsize": 7,
    "axes.linewidth": 0.6,
    "lines.linewidth": 1.2,
    "pdf.fonttype": 42,  # embed TrueType fonts (IEEE PDF eXpress requirement)
    "ps.fonttype": 42,
    "savefig.dpi": 600,
})
COL_W = 3.5  # IEEE column width in inches

STYLE = {
    "udp": dict(color="#1b5e20", ls="-", label="Link Plane 3 (UDP)"),
    "tcp": dict(color="#0d47a1", ls="--", label="Split TCP control channel"),
    "mux": dict(color="#b71c1c", ls=":", label="Single multiplexed TLS stream"),
}


def fig_latency():
    net = json.load(open(os.path.join(RES, "net-all.json")))
    runs = net["input"]
    losses = sorted({r["lossPct"] for r in runs})
    fig, axes = plt.subplots(1, len(losses), figsize=(COL_W * 2.02, 1.55), sharey=True)
    for ax, loss in zip(axes, losses):
        for m in ["udp", "tcp", "mux"]:
            r = next(x for x in runs if x["lossPct"] == loss and x["method"] == m)
            lat = np.sort(np.array(r["lat"]))
            y = np.arange(1, len(lat) + 1) / r["sent"]  # CDF over SENT events: losses cap the curve
            ax.step(lat, y, where="post", **STYLE[m])
        ax.set_xscale("log")
        ax.set_xlim(1, 400)
        ax.set_ylim(0, 1.01)
        ax.grid(True, which="major", lw=0.3, alpha=0.6)
        ax.text(0.04, 0.9, f"loss {loss}%", transform=ax.transAxes, fontsize=7.5, fontweight="bold")
        ax.set_xlabel("One-way input latency (ms, log scale)")
    axes[0].set_ylabel("Fraction of events delivered")
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=3, frameon=False, bbox_to_anchor=(0.5, 1.15))
    fig.tight_layout(pad=0.3, w_pad=0.6)
    fig.savefig(os.path.join(OUT, "fig_latency_cdf.pdf"), bbox_inches="tight", pad_inches=0.02)


def fig_convergence():
    tr = json.load(open(os.path.join(RES, "trust.json")))
    fig, ax = plt.subplots(figsize=(COL_W, 1.7))

    def series(section, topo, field):
        ns, med, lo, hi = [], [], [], []
        for key, v in tr[section].items():
            t, n = key.split(":")
            if t != topo:
                continue
            s = v[field]
            ns.append(int(n)); med.append(s["p50"]); lo.append(s["min"]); hi.append(s["p95"])
        o = np.argsort(ns)
        return np.array(ns)[o], np.array(med)[o], np.array(lo)[o], np.array(hi)[o]

    for section, topo, field, style, label in [
        ("enroll", "mesh", "links", dict(color="#0d47a1", marker="o", ls="-"), "Enrollment, full mesh"),
        ("enroll", "chain", "view", dict(color="#0d47a1", marker="s", ls="--", mfc="white"), "Enrollment, chain"),
        ("revoke", "mesh", "revoke", dict(color="#b71c1c", marker="^", ls="-"), "Revocation, full mesh"),
        ("revoke", "chain", "revoke", dict(color="#b71c1c", marker="v", ls="--", mfc="white"), "Revocation, chain"),
    ]:
        n, med, lo, hi = series(section, topo, field)
        ax.plot(n, med, ms=3.5, label=label, **style)
        ax.fill_between(n, med, hi, color=style["color"], alpha=0.10, lw=0)
    ax.set_xlabel("Pool size $N$ (devices)")
    ax.set_ylabel("Convergence time (ms)")
    ax.set_xticks([2, 4, 6, 8, 12, 16])
    ax.grid(True, lw=0.3, alpha=0.6)
    ax.legend(frameon=False, ncol=2, loc="upper left")
    fig.tight_layout(pad=0.3)
    fig.savefig(os.path.join(OUT, "fig_convergence.pdf"), bbox_inches="tight", pad_inches=0.02)


if __name__ == "__main__":
    fig_latency()
    fig_convergence()
    print("figures written to", OUT)
