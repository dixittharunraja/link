# T-TOFU paper revision package

The full revised paper is `../paper.tex`. The existing `../ICAECA2026_TTOFU_Overleaf.zip` contains the matching source and IEEEtran class, ready to import into Overleaf. The original source, PDF, build files and archive are preserved in `../revision_backup/`.

- [Complete revised sections](REVISED_SECTIONS.md): abstract, introduction, protocol architecture, implementation, convergence/overhead and conclusion, including unchanged context and exact LaTeX.
- [Revision log](REVISION_LOG.md): 23 prose revisions and one reference-column layout adjustment, each with original text, revised text, reason, category and highlight status.
- [Report analysis](REPORT_ANALYSIS.md): exact highlighted passages and retained technical wording, with report-page references.
- [Detector assumptions](DETECTOR_ASSUMPTIONS.md): sourced distinction between disclosed information and speculation.
- [Author review](AUTHOR_REVIEW.md): pre-existing scientific and implementation discrepancies that prose editing cannot settle. Measurements are retained at the author’s instruction.
- [Source diff](paper_prose.diff) and [preservation checks](source_checks.json).
- [Highlight geometry](highlight_geometry.json) and [extracted highlight lines](HIGHLIGHT_LINES.txt).

The archive intentionally contains only submission source files. Review notes and original Turnitin reports remain outside it. No detector-score reduction is asserted, and no new experiment or detector evaluation was performed.

Use pdfLaTeX when compiling the Overleaf project, as in the original build. Local validation uses Tectonic with a temporary OT1-encoding wrapper to preserve IEEEtran’s Times font selection; the wrapper is not part of the source archive.

The updated [six-page PDF](../paper.pdf) and [build validation](BUILD_VALIDATION.md) are available.
