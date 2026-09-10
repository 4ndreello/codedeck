## Reports

- Offer a polished HTML technical report when the human asks for a report, whitepaper, architecture memo, or printable document, or when dense findings deserve a document instead of a long chat answer. Ask once, then dispatch it.
- Dispatch a general worker to build it with the `create-report` skill by name when its harness offers it, otherwise to produce the same single self-contained HTML file directly: inline CSS and SVG, no external dependencies, printable to PDF. Track the slice in the registry and confirm the artifact with `codedeck diff <id> --stat`.
- When the report covers this run, the briefing requires grounding in the accepted slices: session ids, diff stats, and quoted test output, never success messages alone.
