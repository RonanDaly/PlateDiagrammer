import { contentBounds, type Bounds } from "./editor-geometry";
import type { DocumentV1 } from "./editor-model";

export interface SerializedDiagram { source: string; bounds: Bounds }

export async function waitForRenderedLabels(svg: SVGSVGElement, timeout = 60000) {
  const started = Date.now();
  while (true) {
    const error = svg.querySelector('[data-math-error]');
    if (error) throw new Error(`Cannot render label: ${error.getAttribute("data-math-error")}`);
    if (!svg.querySelector('[data-math-pending]')) break;
    if (Date.now() - started >= timeout) throw new Error("Timed out rendering math labels.");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await document.fonts.ready;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

export function serializeSvg(svg: SVGSVGElement, diagram: DocumentV1): SerializedDiagram {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('[data-editor-ui="true"]').forEach((node) => node.remove());
  clone.querySelectorAll('[data-element-id]').forEach((node) => node.removeAttribute('data-element-id'));
  const bounds = contentBounds(diagram, 24);
  // Inline canvas dimensions otherwise override the cropped SVG dimensions.
  clone.removeAttribute("style");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
  clone.setAttribute("width", String(bounds.width));
  clone.setAttribute("height", String(bounds.height));
  clone.setAttribute("role", "img");
  clone.setAttribute("aria-label", "Statistical plate diagram");
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [key, value] of Object.entries(bounds)) background.setAttribute(key, String(value));
  background.setAttribute("fill", "#ffffff");
  clone.querySelector("defs")?.insertAdjacentElement("afterend", background);
  return { source: new XMLSerializer().serializeToString(clone), bounds };
}

export async function rasterizePng(serialized: SerializedDiagram, scale = 2): Promise<Blob> {
  const width = Math.ceil(serialized.bounds.width * scale);
  const height = Math.ceil(serialized.bounds.height * scale);
  if (!Number.isFinite(scale) || scale <= 0 || width > 32767 || height > 32767 || width * height > 268435456) {
    throw new Error("PNG dimensions exceed the supported canvas size; reduce --scale.");
  }
  const url = URL.createObjectURL(new Blob([serialized.source], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create PNG canvas.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode PNG."));
    }, "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}
