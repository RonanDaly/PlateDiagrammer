# Plate Studio

Plate Studio is a fully vibe-coded browser-based editor for creating publication-ready statistical plate diagrams. It uses a custom SVG scene so the editing canvas and exported artwork share the same geometry.

## Features

- Circle, square, double-circle, diamond, small-square, and small-circle nodes
- Known/unknown shading and TeX-style math labels
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

The application is client-side and does not require accounts, a backend, or remote storage. MathJax is loaded in the browser for self-contained SVG math rendering.
