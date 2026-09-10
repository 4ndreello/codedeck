---
name: create-report
description: 'Report: generate a polished long-form HTML technical report with engineering-paper styling, editorial typography, dense content, and a diagram in every major section. Use when the human asks for a report, technical document, whitepaper, architecture memo, research report, or printable PDF-ready HTML, or when dense findings deserve a document instead of a chat answer. Triggers: report, relatorio, whitepaper, architecture memo, technical document, long-form HTML.'
---

Generate a professional long-form HTML report.

The output must feel like a real technical document designed for serious reading.

The visual style should resemble:

* a printed engineering paper
* a Word document
* an internal architecture memo
* an academic or research report
* a technical whitepaper
* a well-formatted PDF exported from Notion or Google Docs

The result must NOT look like:

* a startup landing page
* a SaaS dashboard
* a marketing website
* a pitch deck
* a modern card UI
* a Dribbble concept
* a colorful analytics interface

This is a REPORT.

The reader should feel like reading a serious technical document.

---

# Output

Produce a single self-contained HTML file: inline CSS, inline SVG diagrams, no external stylesheets, scripts, fonts, or network dependencies. It must read correctly from `file://` and print cleanly to PDF on A4.

Name it `<topic>-report.html` in the workspace unless the human names another path. Say which path you wrote.

---

# Codedeck grounding

When the report covers work that ran through codedeck, ground every claim:

* cite the session id plus `codedeck diff <id> --stat` (what actually changed)
* quote the relevant lines from `codedeck logs <id>`
* quote the exact test or verification commands and their output

A success message is a claim, the diff is the fact. Record the stat, never the claim alone. Name what was not covered.

---

# Primary objective

Generate a highly readable HTML report with:

* excellent typography
* strong information hierarchy
* dense technical content
* diagrams throughout
* structured sections
* elegant document formatting

The report must prioritize:

1. clarity
2. readability
3. information density
4. visual explanation
5. document aesthetics

Visual restraint matters more than decoration.

---

# Core design philosophy

The page should feel like PAPER.

Use:

* white background
* dark text
* subtle borders
* minimal colors
* restrained styling
* proper margins
* centered reading column
* generous whitespace between sections
* long-form readability

Avoid:

* gradients
* glowing effects
* glassmorphism
* oversized shadows
* floating cards
* colorful widgets
* playful UI
* excessive rounded corners
* animated dashboard aesthetics
* AI startup design patterns

Do NOT build a web app interface.

Build a document.

---

# Typography rules

Typography is the PRIMARY visual system.

Rely on:

* title hierarchy
* spacing
* rhythm
* indentation
* section organization
* captions
* tables
* code formatting
* figure placement

Use clear hierarchy:

* large bold title
* subtitle
* section headings
* subsection headings
* body paragraphs
* bullet lists
* quotes
* technical notes
* captions
* references
* code blocks

The typography should feel editorial and professional.

Think:

* technical documentation
* engineering RFC
* research paper
* architecture review

NOT:

* landing page typography
* marketing copy
* startup branding

---

# CRITICAL: visual content is REQUIRED

Visual explanations are mandatory.

Do NOT generate a text-only report.

Every major section carries at least one visual element. If a section has no visual support, treat the section as incomplete.

Use visuals such as:

* architecture diagrams
* system flows
* sequence diagrams
* timelines
* process illustrations
* conceptual diagrams
* comparison visuals
* entity relationship diagrams
* pipelines
* technical schemas
* infrastructure layouts
* data flow visuals
* annotated graphics
* charts when useful

Visuals are part of the CONTENT, not decoration.

---

# Visual generation priority

When explaining concepts, prefer in this order:

1. diagram
2. architecture visualization
3. flow illustration
4. comparison table
5. structured explanation

before writing large blocks of text.

The report should teach visually. Generate visuals proactively without waiting for explicit requests. Draw them as inline SVG so the file stays self-contained.

---

# Diagram style

All diagrams must be:

* minimal
* technical
* clean
* readable
* low-color
* monochromatic or restrained palette

Preferred inspiration:

* Excalidraw
* Mermaid
* Whimsical
* Notion diagrams
* engineering architecture docs
* system design interviews
* technical whitepapers

Avoid:

* corporate illustration people
* cartoon graphics
* flashy infographics
* 3D assets
* decorative abstract art
* marketing visuals

Diagrams communicate systems and relationships clearly.

---

# Layout structure

The document flows vertically like a real report.

Use:

* centered content container
* realistic document width
* strong section separation
* proper vertical rhythm
* figure captions
* references
* semantic grouping
* optional sticky table of contents
* print-friendly spacing

The page should feel exportable to PDF. Design for permanence and readability, not interactivity.

---

# Content density

Dense technical content is GOOD.

Assume the audience consists of:

* engineers
* developers
* architects
* technical stakeholders

Do NOT oversimplify. Do NOT use excessive filler text. Do NOT repeat generic explanations.

The report should feel valuable enough to save, reference, and revisit later.

---

# HTML requirements

Generate semantic HTML.

Prefer elements such as:

* article
* section
* header
* nav
* figure
* figcaption
* table
* pre
* code
* blockquote
* aside

Keep the HTML clean and structured. Avoid excessive wrapper divs.

---

# CSS philosophy

CSS should be restrained and editorial.

Focus on:

* spacing
* typography
* readability
* alignment
* document rhythm

Avoid:

* over-engineering
* excessive utility classes
* flashy animations
* interactive-heavy components
* UI-centric styling

The report should feel timeless.

---

# Tables

Tables should resemble technical documentation tables.

Use:

* subtle borders
* compact spacing
* readable typography
* proper alignment

Avoid dashboard-style data cards.

---

# Code blocks

Code blocks should resemble real documentation.

Use:

* monospace font
* restrained syntax highlighting
* subtle background
* proper spacing
* readable formatting

Avoid exaggerated styling.

---

# Images

Images support understanding.

Use images for:

* architecture
* workflows
* systems
* concepts
* comparisons
* infrastructure
* lifecycle explanations

Images should feel at home inside a technical document, not inside a marketing website. Prefer inline SVG; reference external image files only when the human asks for them, and name each file in the report.

---

# Tone

The tone should be:

* technical
* direct
* intelligent
* structured
* professional

Avoid:

* hype language
* marketing tone
* exaggerated excitement
* startup buzzwords

---

# Final quality check

Before finalizing, verify:

* it feels like a real document
* it looks printable
* visuals are integrated throughout
* typography does most of the visual work
* it avoids dashboard aesthetics
* it resembles an engineering whitepaper
* it opens from `file://` with no missing assets

The final impression should be a serious technical report, not a modern SaaS UI.

<!-- Ported from ~/.claude/skills/create-report/SKILL.md, adapted for codedeck: self-contained output plus codedeck grounding. -->
