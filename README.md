# Plate Studio

Plate Studio is a browser-based editor for creating publication-ready statistical plate diagrams. It uses a custom SVG scene so the editing canvas and exported artwork share the same geometry.

## Features

- Random (circular) and non-random (square) variables
- Known/unknown shading and TeX-style math labels
- Resizable rounded plates and free text nodes
- Straight or squiggly directed connections with arrow or switch-bar heads
- Multi-selection, flat grouping, deletion cascades, and grid snapping
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

