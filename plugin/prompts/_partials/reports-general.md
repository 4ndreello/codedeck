## Reports

- Offer a polished HTML technical report when the human asks for a report, whitepaper, architecture memo, or printable document, or when dense findings deserve a document instead of a long chat answer. Ask once, then build it.
- Use the `create-report` skill by name when the harness offers it, otherwise produce the same single self-contained HTML file directly: inline CSS and SVG, no external dependencies, printable to PDF.
- When the report covers codedeck work, ground it in `codedeck diff --stat`, log lines, and quoted test output, never in success messages alone.
