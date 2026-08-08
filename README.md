# Plate Studio

Plate Studio is a browser-based editor for creating publication-ready statistical plate diagrams. It uses a custom SVG scene so the editing canvas and exported artwork share the same geometry.

## Features

- Circle, square, double-circle, diamond, and compact factor nodes
- Known/unknown shading and TeX-style math labels
- Resizable square/rounded plates with attached corner labels and free text nodes
- Straight or sinusoidal connections with arrow, switch-bar, or undirected ends and attached labels
- Multi-selection, flat grouping, deletion cascades, and grid snapping
- Shift-drag snap override for precise free positioning
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
