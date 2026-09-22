import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { DiagramScene } from "../app/DiagramScene";
import { serializeSvg, rasterizePng, waitForRenderedLabels } from "../app/diagram-export";
import { mathJaxConfig, mathJaxScriptUrl } from "../app/mathjax-config";
import type { DocumentV1 } from "../app/editor-model";

const config = document.createElement("script");
config.textContent = mathJaxConfig;
document.head.appendChild(config);
const script = document.createElement("script");
script.src = mathJaxScriptUrl;
const mathReady = new Promise<void>((resolve, reject) => {
  script.onload = () => resolve();
  script.onerror = () => reject(new Error("Could not load local MathJax assets."));
});
document.head.appendChild(script);
// Attach immediately so a startup failure cannot become an unhandled rejection.
void mathReady.catch(() => {});
const root = createRoot(document.getElementById("root")!);

declare global {
  interface Window {
    renderDiagram: (diagram: DocumentV1, format: "svg" | "png", scale: number) => Promise<string>;
  }
}

window.renderDiagram = async (diagram, format, scale) => {
  await mathReady;
  await window.MathJax?.startup?.promise;
  flushSync(() => root.render(
    <svg id="diagram-canvas" viewBox={`0 0 ${diagram.canvas.width} ${diagram.canvas.height}`}>
      <DiagramScene diagram={diagram} />
    </svg>,
  ));
  const svg = document.querySelector<SVGSVGElement>("#diagram-canvas")!;
  await waitForRenderedLabels(svg);
  const serialized = serializeSvg(svg, diagram);
  if (format === "svg") return serialized.source;
  const blob = await rasterizePng(serialized, scale);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read PNG bytes."));
    reader.readAsDataURL(blob);
  });
};
