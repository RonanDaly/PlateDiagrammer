"use client";
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { displayNodeDimensions, isCompactVariableKind, labelToTex, validateLabel, type DiagramElement, type DocumentV1, type Edge, type Plate, type VariableNode } from "./editor-model";
import { anchoredLabelBounds, edgeLabelPoint, edgeEndpoints, elementBounds, estimatedLabelDimensions, PLATE_HIT_STROKE_WIDTH, scaledMathDimensions, squigglyPath, straightPath, type Bounds, type Point } from "./editor-geometry";
type Overlay =
  | { kind: "none" }
  | { kind: "marquee"; start: Point; current: Point }
  | { kind: "connect"; start: Point; current: Point };

interface MathJaxApi {
  startup?: { promise?: Promise<unknown> };
  tex2svgPromise?: (source: string, options?: Record<string, unknown>) => Promise<HTMLElement>;
  typesetPromise?: (elements?: HTMLElement[]) => Promise<unknown>;
  typesetClear?: (elements?: HTMLElement[]) => void;
}

declare global {
  interface Window { MathJax?: MathJaxApi }
}

let mathRenderQueue: Promise<unknown> = Promise.resolve();

export function plainLabel(source: string): string {
  return source.replace(/\\\$/g, "\u0000").replace(/\$/g, "").replace(/\u0000/g, "$");
}

async function waitForMathJax(timeout = 60000): Promise<MathJaxApi | null> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (window.MathJax?.startup?.promise) {
      try {
        await window.MathJax.startup.promise;
        return window.MathJax;
      } catch {
        return null;
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 60));
  }
  return null;
}

function queuedTexToSvg(mathJax: MathJaxApi, source: string): Promise<HTMLElement> {
  const render = mathRenderQueue.then(async () => {
    if (!mathJax.typesetPromise) return mathJax.tex2svgPromise!(source, { display: false });
    const host = document.createElement("span");
    host.textContent = `\\(${source}\\)`;
    host.style.position = "fixed";
    host.style.left = "-10000px";
    host.style.top = "-10000px";
    host.style.display = "block";
    host.style.width = "10000px";
    host.style.whiteSpace = "nowrap";
    document.body.appendChild(host);
    try {
      await mathJax.typesetPromise([host]);
      const output = host.querySelector("mjx-container") as HTMLElement | null;
      if (!output) throw new Error("MathJax did not produce SVG output.");
      return output.cloneNode(true) as HTMLElement;
    } finally {
      mathJax.typesetClear?.([host]);
      host.remove();
    }
  });
  mathRenderQueue = render.then(() => undefined, () => undefined);
  return render;
}

function MathLabel({
  source,
  x,
  y,
  maxWidth = 280,
  fontSize = 20,
  className = "diagram-label",
  anchor = "middle",
  verticalAnchor = "middle",
  interactive = false,
  selected = false,
}: {
  source: string;
  x: number;
  y: number;
  maxWidth?: number;
  fontSize?: number;
  className?: string;
  anchor?: "middle" | "end";
  verticalAnchor?: "middle" | "bottom";
  interactive?: boolean;
  selected?: boolean;
}) {
  const [renderedMath, setRenderedMath] = useState<{
    source: string;
    markup: string;
    width: number;
    height: number;
  } | null>(null);
  const [renderError, setRenderError] = useState<{ source: string; message: string } | null>(null);
  const labelError = validateLabel(source);
  const shouldTypeset = Boolean(source.trim()) && !labelError;

  useEffect(() => {
    let cancelled = false;
    if (!shouldTypeset) return;
    void (async () => {
      const mathJax = await waitForMathJax();
      if (!mathJax?.tex2svgPromise || cancelled) return;
      try {
        const output = await queuedTexToSvg(mathJax, labelToTex(source));
        const svg = output.querySelector("svg")?.cloneNode(true) as SVGSVGElement | undefined;
        if (!svg || cancelled) return;
        if (svg.querySelector("[data-mjx-error], [data-mml-node=merror], merror")) throw new Error("Invalid math label");
        const viewBox = (svg.getAttribute("viewBox") || "0 0 1000 500")
          .split(/\s+/)
          .map(Number);
        const { width: renderWidth, height: renderHeight } = scaledMathDimensions(
          viewBox[2],
          viewBox[3],
          fontSize,
          maxWidth,
        );
        svg.removeAttribute("style");
        svg.removeAttribute("role");
        svg.removeAttribute("focusable");
        svg.setAttribute("x", String(anchor === "end" ? -renderWidth : -renderWidth / 2));
        svg.setAttribute("y", String(verticalAnchor === "bottom" ? -renderHeight : -renderHeight / 2));
        svg.setAttribute("width", String(renderWidth));
        svg.setAttribute("height", String(renderHeight));
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svg.setAttribute("aria-hidden", "true");
        setRenderedMath({ source, markup: svg.outerHTML, width: renderWidth, height: renderHeight });
      } catch (error) {
        if (!cancelled) setRenderError({ source, message: error instanceof Error ? error.message : "Math rendering failed." });
      }
    })();
    return () => { cancelled = true; };
  }, [anchor, fontSize, maxWidth, shouldTypeset, source, verticalAnchor]);

  const rendered = renderedMath?.source === source ? renderedMath : null;
  const interactionRect = (bounds: Bounds) => interactive ? (
    <rect
      data-editor-ui="true"
      data-label-hit-box="true"
      x={bounds.x}
      y={bounds.y}
      width={bounds.width}
      height={bounds.height}
      rx="3"
      fill={selected ? "#e6f4f3" : "transparent"}
      stroke={selected ? "#0c7a84" : "none"}
      strokeWidth={selected ? "1.5" : undefined}
      strokeDasharray={selected ? "4 3" : undefined}
      pointerEvents="all"
    />
  ) : null;

  if (rendered) {
    const bounds = anchoredLabelBounds(0, 0, rendered.width, rendered.height, anchor, verticalAnchor);
    return (
      <g
        transform={`translate(${x} ${y})`}
        data-math-rendered="true"
        color="#20282e"
      >
        {interactionRect(bounds)}
        <g pointerEvents="none" dangerouslySetInnerHTML={{ __html: rendered.markup }} />
      </g>
    );
  }

  const fallbackDimensions = estimatedLabelDimensions(source, fontSize, maxWidth);
  const fallbackBounds = anchoredLabelBounds(x, y, fallbackDimensions.width, fallbackDimensions.height, anchor, verticalAnchor);
  return (
    <g data-math-pending={shouldTypeset || undefined} data-math-error={labelError || (renderError?.source === source ? renderError.message : undefined)}>
      {interactionRect(fallbackBounds)}
      <text
        x={x}
        y={y}
        className={className}
        textAnchor={anchor}
        dominantBaseline={verticalAnchor === "middle" ? "central" : "auto"}
        pointerEvents="none"
        fill="#20282e"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontSize={fontSize}
      >
        {plainLabel(source)}
      </text>
    </g>
  );
}

function diamondPoints(node: VariableNode, extra = 0): string {
  const dimensions = displayNodeDimensions(node);
  const radiusX = dimensions.width / 2 + extra;
  const radiusY = dimensions.height / 2 + extra;
  return [
    `${node.x},${node.y - radiusY}`,
    `${node.x + radiusX},${node.y}`,
    `${node.x},${node.y + radiusY}`,
    `${node.x - radiusX},${node.y}`,
  ].join(" ");
}

function NodeGlyph({ node }: { node: VariableNode }) {
  const fill = node.observed ? "#aeb9bc" : "#ffffff";
  const dimensions = displayNodeDimensions(node);
  const radiusX = dimensions.width / 2;
  const radiusY = dimensions.height / 2;
  if (node.variableKind === "random") {
    return <ellipse cx={node.x} cy={node.y} rx={radiusX} ry={radiusY} fill={fill} stroke="#27313a" strokeWidth="2.2" />;
  }
  if (node.variableKind === "double") {
    return (
      <g>
        <ellipse cx={node.x} cy={node.y} rx={radiusX} ry={radiusY} fill={fill} stroke="#27313a" strokeWidth="2.2" />
        <ellipse cx={node.x} cy={node.y} rx={Math.max(2, radiusX - 6)} ry={Math.max(2, radiusY - 6)} fill="none" stroke="#27313a" strokeWidth="1.7" />
      </g>
    );
  }
  if (node.variableKind === "diamond") {
    return <polygon points={diamondPoints(node)} fill={fill} stroke="#27313a" strokeWidth="2.2" strokeLinejoin="round" />;
  }
  if (node.variableKind === "factor") {
    return (
      <rect
        x={node.x - radiusX}
        y={node.y - radiusY}
        width={dimensions.width}
        height={dimensions.height}
        fill="#27313a"
        stroke="#27313a"
        strokeWidth="1"
      />
    );
  }
  if (node.variableKind === "small-circle") {
    return <circle cx={node.x} cy={node.y} r={radiusX} fill="#27313a" stroke="#27313a" strokeWidth="1" />;
  }
  return (
    <rect
      x={node.x - radiusX}
      y={node.y - radiusY}
      width={dimensions.width}
      height={dimensions.height}
      rx="2"
      fill={fill}
      stroke="#27313a"
      strokeWidth="2.2"
    />
  );
}

function NodeSelection({ node }: { node: VariableNode }) {
  const dimensions = displayNodeDimensions(node);
  if (node.variableKind === "random" || node.variableKind === "double" || node.variableKind === "small-circle") {
    const extra = node.variableKind === "small-circle" ? 4 : 3;
    return <ellipse data-editor-ui="true" cx={node.x} cy={node.y} rx={dimensions.width / 2 + extra} ry={dimensions.height / 2 + extra} fill="none" stroke="#0c7a84" strokeWidth="2.5" pointerEvents="none" />;
  }
  if (node.variableKind === "diamond") {
    return <polygon data-editor-ui="true" points={diamondPoints(node, 4)} fill="none" stroke="#0c7a84" strokeWidth="2.5" strokeLinejoin="round" pointerEvents="none" />;
  }
  const extra = node.variableKind === "factor" ? 4 : 3;
  return (
    <rect
      data-editor-ui="true"
      x={node.x - dimensions.width / 2 - extra}
      y={node.y - dimensions.height / 2 - extra}
      width={dimensions.width + extra * 2}
      height={dimensions.height + extra * 2}
      rx={node.variableKind === "factor" ? 2 : 4}
      fill="none"
      stroke="#0c7a84"
      strokeWidth="2.5"
      pointerEvents="none"
    />
  );
}

function rectangleFromPoints(a: Point, b: Point): Bounds {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}


export function DiagramScene({ diagram, selection = [], tool = "select", overlay = { kind: "none" }, beginElementPointer = () => {}, beginResize = () => {} }: {
  diagram: DocumentV1;
  selection?: string[];
  tool?: "select" | "connect";
  overlay?: Overlay;
  beginElementPointer?: (event: ReactPointerEvent<SVGGElement | SVGPathElement>, element: DiagramElement) => void;
  beginResize?: (event: ReactPointerEvent<SVGCircleElement>, plate: Plate, corner: "nw" | "ne" | "sw" | "se") => void;
}) {
  const plates = diagram.elements.filter((element): element is Plate => element.type === "plate");
  const edges = diagram.elements.filter((element): element is Edge => element.type === "edge");
  const foreground = diagram.elements.filter((element) => element.type === "variable" || element.type === "text");
  const elementsById = new Map(diagram.elements.map((element) => [element.id, element]));
  const selectedElements = diagram.elements.filter((element) => selection.includes(element.id));
  const singlePlate = selectedElements.length === 1 && selectedElements[0].type === "plate" ? selectedElements[0] : null;
  return <>
    <defs>
      <pattern id="minor-grid" width={diagram.canvas.gridSize} height={diagram.canvas.gridSize} patternUnits="userSpaceOnUse">
        <circle cx="1" cy="1" r="1" fill="#cbd2da" />
      </pattern>
      <marker id="arrow-head" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth">
        <path d="M 0.8 0.8 L 6 3.5 L 0.8 6.2" fill="none" stroke="#27313a" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </marker>
      <marker id="bar-head" markerWidth="10" markerHeight="14" refX="5" refY="7" orient="auto" markerUnits="strokeWidth">
        <path d="M 5 1 L 5 13" fill="none" stroke="#27313a" strokeWidth="2" strokeLinecap="round" />
      </marker>
    </defs>
    <rect width={diagram.canvas.width} height={diagram.canvas.height} fill="#ffffff" />
    <rect data-editor-ui="true" width={diagram.canvas.width} height={diagram.canvas.height} fill="url(#minor-grid)" />

    <g className="plate-layer">
      {plates.map((plate) => (
        <g
          key={plate.id}
          data-element-id={plate.id}
          className="diagram-element plate-element"
          onPointerDown={(event) => beginElementPointer(event, plate)}
        >
          <rect
            data-editor-ui="true"
            x={plate.x}
            y={plate.y}
            width={plate.width}
            height={plate.height}
            rx={plate.cornerRadius}
            fill="none"
            stroke="transparent"
            strokeWidth={PLATE_HIT_STROKE_WIDTH}
            pointerEvents="stroke"
          />
          <rect
            x={plate.x}
            y={plate.y}
            width={plate.width}
            height={plate.height}
            rx={plate.cornerRadius}
            fill="none"
            stroke="#34414a"
            strokeWidth="2"
            strokeDasharray={plate.strokeStyle === "dashed" ? "10 7" : undefined}
            pointerEvents="none"
          />
          {selection.includes(plate.id) && (
            <rect
              data-editor-ui="true"
              x={plate.x}
              y={plate.y}
              width={plate.width}
              height={plate.height}
              rx={plate.cornerRadius}
              fill="none"
              stroke="#0c7a84"
              strokeWidth="3"
              pointerEvents="none"
            />
          )}
          {plate.label && (
            <MathLabel
              source={plate.label}
              x={plate.x + plate.width - 12}
              y={plate.y + plate.height - 10}
              maxWidth={Math.max(40, plate.width - 24)}
              fontSize={15}
              anchor="end"
              verticalAnchor="bottom"
            />
          )}
        </g>
      ))}
    </g>

    <g className="edge-layer">
      {edges.map((edge) => {
        const endpoints = edgeEndpoints(edge, diagram);
        if (!endpoints) return null;
        const path = edge.lineStyle === "squiggly"
          ? squigglyPath(endpoints.start, endpoints.end)
          : straightPath(endpoints.start, endpoints.end);
        const markerEnd = edge.headStyle === "none"
          ? undefined
          : `url(#${edge.headStyle === "arrow" ? "arrow-head" : "bar-head"})`;
        const labelPoint = edgeLabelPoint(endpoints.start, endpoints.end);
        const selected = selection.includes(edge.id);
        return (
          <g key={edge.id} data-element-id={edge.id} className="diagram-element edge-element">
            <path data-editor-ui="true" d={path} fill="none" stroke="transparent" strokeWidth="16" onPointerDown={(event) => beginElementPointer(event, edge)} />
            <path
              d={path}
              fill="none"
              stroke="#27313a"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={edge.strokeStyle === "dashed" ? "8 6" : undefined}
              markerEnd={markerEnd}
              pointerEvents="none"
            />
            {selected && (
              <path
                data-editor-ui="true"
                d={path}
                fill="none"
                stroke="#0c7a84"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                pointerEvents="none"
              />
            )}
            {edge.label && (
              <MathLabel
                source={edge.label}
                x={labelPoint.x}
                y={labelPoint.y}
                maxWidth={240}
                fontSize={15}
              />
            )}
          </g>
        );
      })}
      {overlay.kind === "connect" && (
        <path
          data-editor-ui="true"
          d={straightPath(overlay.start, overlay.current)}
          fill="none"
          stroke="#0c7a84"
          strokeWidth="2.5"
          strokeDasharray="7 6"
          markerEnd="url(#arrow-head)"
          pointerEvents="none"
        />
      )}
    </g>

    <g className="foreground-layer">
      {foreground.map((element) => {
        if (element.type === "text") {
          const selected = selection.includes(element.id);
          return (
            <g
              key={element.id}
              data-element-id={element.id}
              className="diagram-element text-element"
              onPointerDown={(event) => beginElementPointer(event, element)}
            >
              <MathLabel
                source={element.text}
                x={element.x}
                y={element.y}
                maxWidth={360}
                fontSize={20}
                interactive
                selected={selected}
              />
            </g>
          );
        }
        const selected = selection.includes(element.id);
        return (
          <g
            key={element.id}
            data-element-id={element.id}
            className="diagram-element variable-element"
            onPointerDown={(event) => beginElementPointer(event, element)}
          >
            {isCompactVariableKind(element.variableKind) && (
              element.variableKind === "small-circle" ? (
                <circle
                  data-editor-ui="true"
                  cx={element.x}
                  cy={element.y}
                  r="14"
                  fill="transparent"
                  pointerEvents="all"
                />
              ) : (
                <rect
                  data-editor-ui="true"
                  x={element.x - 14}
                  y={element.y - 14}
                  width="28"
                  height="28"
                  fill="transparent"
                  pointerEvents="all"
                />
              )
            )}
            <NodeGlyph node={element} />
            {selected && <NodeSelection node={element} />}
            {!isCompactVariableKind(element.variableKind) && element.label && (
              <MathLabel source={element.label} x={element.x} y={element.y} maxWidth={displayNodeDimensions(element).width - 16} fontSize={17} className="node-label" />
            )}
            {tool === "connect" && (() => {
              const dimensions = displayNodeDimensions(element);
              return <ellipse data-editor-ui="true" cx={element.x} cy={element.y} rx={dimensions.width / 2 + 7} ry={dimensions.height / 2 + 7} fill="none" stroke="#0c7a84" strokeWidth="2" strokeDasharray="3 4" pointerEvents="none" />;
            })()}
          </g>
        );
      })}
    </g>

    <g data-editor-ui="true" className="selection-layer" pointerEvents="none">
      {diagram.groups.map((group) => {
        if (!group.memberIds.every((id) => selection.includes(id))) return null;
        const memberBounds = group.memberIds
          .map((id) => elementsById.get(id))
          .map((element) => element && elementBounds(element))
          .filter((bounds): bounds is Bounds => Boolean(bounds));
        if (!memberBounds.length) return null;
        const x = Math.min(...memberBounds.map((item) => item.x)) - 12;
        const y = Math.min(...memberBounds.map((item) => item.y)) - 12;
        const right = Math.max(...memberBounds.map((item) => item.x + item.width)) + 12;
        const bottom = Math.max(...memberBounds.map((item) => item.y + item.height)) + 12;
        return <rect key={group.id} x={x} y={y} width={right - x} height={bottom - y} rx="8" fill="none" stroke="#0c7a84" strokeWidth="1.5" strokeDasharray="8 5" />;
      })}
      {overlay.kind === "marquee" && (() => {
        const bounds = rectangleFromPoints(overlay.start, overlay.current);
        return <rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} fill="rgba(12,122,132,.10)" stroke="#0c7a84" strokeWidth="1.5" strokeDasharray="5 4" />;
      })()}
    </g>

    {singlePlate && (
      <g data-editor-ui="true" className="resize-layer">
        {([
          ["nw", singlePlate.x, singlePlate.y],
          ["ne", singlePlate.x + singlePlate.width, singlePlate.y],
          ["sw", singlePlate.x, singlePlate.y + singlePlate.height],
          ["se", singlePlate.x + singlePlate.width, singlePlate.y + singlePlate.height],
        ] as const).map(([corner, x, y]) => (
          <circle
            key={corner}
            cx={x}
            cy={y}
            r="6"
            fill="#ffffff"
            stroke="#0c7a84"
            strokeWidth="2"
            className={`resize-handle resize-${corner}`}
            onPointerDown={(event) => beginResize(event, singlePlate, corner)}
          />
        ))}
      </g>
    )}

  </>;
}
