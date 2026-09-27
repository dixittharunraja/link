#!/usr/bin/env python3
"""Pre-submission compliance checker for the ICAECA 2026 paper (IEEE conference format).

Usage: python3 validate_paper.py [paper.pdf]
Checks the compiled PDF, the LaTeX log, the sources and the bibliography. Exit code 1 on any FAIL.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PDF = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "paper.pdf")
TEX = os.path.join(HERE, "paper.tex")
BIB = os.path.join(HERE, "references.bib")
LOG = os.path.join(HERE, "paper.log")
BBL = os.path.join(HERE, "paper.bbl")
results = []


def check(name, ok, detail=""):
    results.append((ok, name, detail))


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout


tex = open(TEX, encoding="utf-8").read()
bib = open(BIB, encoding="utf-8").read()

# ---------------- PDF-level checks (what the conference and IEEE PDF eXpress look at) ----------------
info = run(["pdfinfo", PDF])
pages = int(re.search(r"Pages:\s+(\d+)", info).group(1))
check("Page count is 4-6 (ICAECA hard limit: >6 rejected)", 4 <= pages <= 6, f"{pages} pages")
size = re.search(r"Page size:\s+([\d.]+) x ([\d.]+)", info)
w, h = float(size.group(1)), float(size.group(2))
check("Paper size is A4 (595 x 842 pt)", abs(w - 595.28) < 2 and abs(h - 841.89) < 2, f"{w} x {h} pt")

fonts = run(["pdffonts", PDF]).splitlines()[2:]
not_embedded = [f for f in fonts if len(f.split()) >= 5 and f.split()[-5] != "yes"]
type3 = [f for f in fonts if "Type 3" in f]
check("All fonts embedded", not not_embedded, f"{len(fonts)} fonts" + ("; missing: " + "; ".join(not_embedded) if not_embedded else ""))
check("No Type 3 (bitmap) fonts", not type3, "; ".join(type3))

imgs = run(["pdfimages", "-list", PDF]).splitlines()[2:]
low = []
for line in imgs:
    p = line.split()
    if len(p) > 13 and p[12].isdigit() and int(p[12]) < 300:
        low.append(line)
check("Raster images >= 300 dpi (vector preferred)", not low, f"{len(imgs)} raster images" + ("; low: " + str(low) if low else ""))

text_pages = []
for i in range(1, pages + 1):
    text_pages.append(run(["pdftotext", "-layout", "-f", str(i), "-l", str(i), PDF, "-"]))
numbered = [i + 1 for i, t in enumerate(text_pages) if re.fullmatch(r"\s*\d+\s*", (t.strip().splitlines() or [""])[-1])]
check("No page numbers printed (ICAECA rule)", not numbered, f"pages with a trailing number: {numbered}")
alltext = "\n".join(text_pages)
check("No unresolved references (??)", "??" not in alltext)
check("No template placeholder text", not re.search(r"Conference Paper Title|Given Name Surname|dept\. name of organization|Identify applicable funding", alltext))

# ---------------- LaTeX log ----------------
log = open(LOG, encoding="utf-8", errors="ignore").read() if os.path.exists(LOG) else ""
over = [float(x) for x in re.findall(r"Overfull \\hbox \(([\d.]+)pt too wide\)", log)]
check("No overfull boxes > 1 pt", all(x <= 1.0 for x in over), f"{len(over)} overfull, max {max(over) if over else 0:.1f} pt")
check("No undefined citations/references in log", not re.search(r"(Citation|Reference) `[^']+' .*undefined", log))

# ---------------- Title, abstract, keywords (IEEE template rules) ----------------
title = re.search(r"\\title\{(.+?)\}\s*\n", tex, re.S).group(1)
check("Title has no math, symbols or footnotes", not re.search(r"[$\\^_~%&#]|\\thanks|\\footnote", title), title)
check("Title length <= 20 words", len(title.split()) <= 20, f"{len(title.split())} words")
abstract = re.search(r"\\begin\{abstract\}(.+?)\\end\{abstract\}", tex, re.S).group(1)
abs_plain = re.sub(r"\\[A-Za-z]+", "N", abstract)
check("Abstract has no math, footnotes or special symbols", not re.search(r"[$^_%&#]|\\footnote|\\cite", abstract))
nwords = len(abs_plain.split())
check("Abstract is 150-250 words", 150 <= nwords <= 250, f"{nwords} words")
check("Index Terms present (4-10)", 4 <= len(re.search(r"\\begin\{IEEEkeywords\}(.+?)\\end", tex, re.S).group(1).split(",")) <= 10)

# ---------------- Citations and cross-references ----------------
cited = []
for grp in re.findall(r"\\cite\{([^}]+)\}", tex):
    for k in grp.split(","):
        k = k.strip()
        if k not in cited:
            cited.append(k)
bibkeys = re.findall(r"@\w+\{([^,]+),", bib)
check("Every \\cite key exists in references.bib", not (set(cited) - set(bibkeys)), str(set(cited) - set(bibkeys)))
check("Every bibliography entry is cited", not (set(bibkeys) - set(cited)), str(set(bibkeys) - set(cited)))
check("Reference count suitable for a 6-page paper (15-30)", 15 <= len(bibkeys) <= 30, f"{len(bibkeys)} references")
years = [int(y) for y in re.findall(r"year\s*=\s*\{(\d{4})\}", bib)]
recent = sum(1 for y in years if y >= 2022)
check("Majority of references from 2022 or later (or standards)", recent >= len(years) // 2, f"{recent}/{len(years)} from 2022+; median year {sorted(years)[len(years)//2]}")
for kind in ["fig", "tab", "alg"]:
    labels = re.findall(r"\\label\{(%s:[^}]+)\}" % kind, tex)
    unref = [l for l in labels if not re.search(r"\\ref\{%s\}" % re.escape(l), tex)]
    check(f"Every {kind} label is referenced in the text", not unref, str(unref))
eqs = tex.count("\\begin{equation}")
check("Equations present and numbered", eqs >= 5, f"{eqs} numbered equations")

# ---------------- Reference verification: every DOI must resolve on Crossref ----------------
dois = re.findall(r"doi\s*=\s*\{([^}]+)\}", bib)
bad = []
for d in dois:
    try:
        req = urllib.request.Request("https://api.crossref.org/works/" + d, headers={"User-Agent": "validate_paper/1.0 (mailto:arcclub@kpriet.ac.in)"})
        with urllib.request.urlopen(req, timeout=20) as r:
            json.load(r)
    except Exception as e:  # noqa: BLE001
        bad.append(f"{d} ({e})")
check("All DOIs resolve on Crossref (no fabricated references)", not bad, f"{len(dois)} DOIs checked" + ("; failed: " + "; ".join(bad) if bad else ""))

# ---------------- Report ----------------
w = max(len(n) for _, n, _ in results)
fails = 0
for ok, name, detail in results:
    fails += not ok
    print(f"[{'PASS' if ok else 'FAIL'}] {name.ljust(w)}  {detail}")
print(f"\n{len(results) - fails}/{len(results)} checks passed")
sys.exit(1 if fails else 0)
