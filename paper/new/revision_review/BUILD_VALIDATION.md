# Validation results

- Final `paper.pdf`: six A4 pages; fonts embedded; no undefined citations/references or overfull boxes.
- The full paper was rendered and inspected. The final reference-column break was adjusted from entry 12 to entry 15 for the revised pagination.
- All 10 displayed equations, 22 citation commands, 19 bibliography entries, three diagram bodies, the comparison table, four contribution bullets, and all list-environment counts are preserved.
- All 23 prose revisions and the one layout adjustment reconstruct the final source exactly from the backup via `changes.json`.
- Reported physical-testbed measurements are retained at the author’s instruction. Experiments were not rerun.
- ZIP integrity passed; its `paper.tex` and `IEEEtran.cls` match the working files. Original files are in `../revision_backup/`.

The local build used Tectonic 0.17.0 with an OT1-encoding wrapper to match the original pdfLaTeX/IEEEtran Times font selection. Use pdfLaTeX for the Overleaf project. The wrapper is outside the source archive. Remaining build warnings concern loose line/column spacing, a non-UTF-8 character in an external algorithmic.sty package, and the temporary wrapper’s absolute source path. No replacement character appears in the rendered paper text.

These checks establish preservation and successful typesetting. They do not establish the unresolved scientific claims in AUTHOR_REVIEW.md, reproduce the measurements, or predict a Turnitin score.
