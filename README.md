# Plate Studio

Plate Studio is a fully vibe-coded browser-based editor for creating publication-ready statistical plate diagrams. It uses a custom SVG scene so the editing canvas and exported artwork share the same geometry.

## Features

- Circle, square, double-circle, diamond, small-square, and small-circle nodes
- Known/unknown shading and TeX-style math labels
- Text-node hit and selection boxes fitted to rendered glyphs
- Resizable square/rounded plates with solid/dashed borders and attached corner labels
- Straight or sinusoidal, solid or dashed connections with arrow, switch-bar, or undirected ends
- Compact arrowheads, spaced edge labels, matched plain/TeX sizing, and horizontal-only node label auto-fit
- Multi-selection, flat grouping, deletion cascades, and grid snapping
- Shift-drag snap override for precise free positioning
- Editable canvas width and height stored with each document
- Local autosave and versioned JSON import/export
- Content-cropped SVG and 2× PNG export

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run lint
npm test
```

The application is client-side and does not require accounts, a backend, or remote storage. MathJax is served locally in the browser for self-contained SVG math rendering.

## Render saved JSON from the command line

Install dependencies and Chromium once:

```bash
npm install
npx playwright install chromium
```

Render a saved diagram from this repository:

```bash
npm run render -- diagram.json --output diagram.svg
npm run render -- diagram.json --output diagram.png --scale 2
```

The output extension selects SVG or PNG. PNG defaults to 2× resolution; `--scale`
accepts a positive number and applies only to PNG. Images have a white background
and are cropped to the diagram content with 24 units of padding, just like editor
exports. Existing files are protected; add `--force` to replace one. Use
`npm run render -- --help` for usage.

Rendering runs offline after installation, using a temporary local server,
headless Chromium, and the same scene and export helpers as the editor. You do
not need to start the app or use a hosted service. MathJax and its dynamic font
assets are pinned npm dependencies, copied into ignored `public/vendor` assets
on installation and before development/builds. The CLI also prepares these
assets automatically.

Invalid input, failed math rendering, missing Chromium, and rendering that takes
longer than 60 seconds produce an error on stderr and a nonzero exit status.
No output is written unless rendering succeeds. If Chromium is missing, rerun
`npx playwright install chromium`; on Linux, Playwright may also require system
libraries installed with `npx playwright install --with-deps chromium`.

Run the CLI integration checks with `npm run test:cli`. These require Chromium
and block all non-local browser requests to verify offline rendering. The full
`npm test` suite includes these checks.
