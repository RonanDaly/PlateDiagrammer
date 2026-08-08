"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  documentReducer,
  emptyDocument,
  isPositioned,
  labelToTex,
  sampleDocument,
  uid,
  validateDocument,
  validateLabel,
  type DiagramElement,
  type DocumentV1,
  type Edge,
  type Plate,
  type PositionedElement,
  type VariableKind,
  type VariableNode,
} from "./editor-model";
import {
  boundsIntersect,
  contentBounds,
  edgeLabelPoint,
  edgeEndpoints,
  elementBounds,
  resizePlate,
  scaledMathDimensions,
  snap,
  squigglyPath,
  straightPath,
  type Bounds,
  type Point,
} from "./editor-geometry";

type Tool = "select" | "connect";
type PaletteKind = VariableKind | "plate" | "text";

interface MathJaxApi {
  startup?: { promise?: Promise<unknown> };
  tex2svgPromise?: (source: string, options?: Record<string, unknown>) => Promise<HTMLElement>;
  typesetPromise?: (elements?: HTMLElement[]) => Promise<unknown>;
  typesetClear?: (elements?: HTMLElement[]) => void;
}

declare global {
  interface Window { MathJax?: MathJaxApi }
}

type PointerInteraction =
  | {
      kind: "move";
      pointerId: number;
      start: Point;
      ids: string[];
      positions: Record<string, Point>;
      anchorId: string;
    }
  | {
      kind: "marquee";
      pointerId: number;
      start: Point;
      additive: boolean;
      previous: string[];
    }
  | {
      kind: "connect";
      pointerId: number;
      start: Point;
      sourceId: string;
    }
  | {
      kind: "resize";
      pointerId: number;
      start: Point;
      plate: Plate;
      corner: "nw" | "ne" | "sw" | "se";
    };

type Overlay =
  | { kind: "none" }
  | { kind: "marquee"; start: Point; current: Point }
  | { kind: "connect"; start: Point; current: Point };

const STORAGE_KEY = "plate-studio-document-v1";
const MIME_TYPE = "application/x-plate-studio-element";
let mathRenderQueue: Promise<unknown> = Promise.resolve();

function hasMath(source: string): boolean {
  let escaped = false;
  for (const char of source) {
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === "$") return true;
  }
  return false;
}

function plainLabel(source: string): string {
  return source.replace(/\\\$/g, "\u0000").replace(/\$/g, "").replace(/\u0000/g, "$");
}

async function waitForMathJax(timeout = 5000): Promise<MathJaxApi | null> {
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
}: {
  source: string;
  x: number;
  y: number;
  maxWidth?: number;
  fontSize?: number;
  className?: string;
  anchor?: "middle" | "end";
  verticalAnchor?: "middle" | "bottom";
}) {
  const [renderedMath, setRenderedMath] = useState<{ source: string; markup: string } | null>(null);
  const labelError = validateLabel(source);
  const shouldTypeset = hasMath(source) && !labelError;

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
        setRenderedMath({ source, markup: svg.outerHTML });
      } catch {
        // Invalid or unavailable math falls back to a readable source label.
      }
    })();
    return () => { cancelled = true; };
  }, [anchor, fontSize, maxWidth, shouldTypeset, source, verticalAnchor]);

  const markup = renderedMath?.source === source ? renderedMath.markup : null;
  if (markup) {
    return (
      <g
        transform={`translate(${x} ${y})`}
        data-math-rendered="true"
        pointerEvents="none"
        color="#20282e"
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    );
  }

  return (
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
  );
}

function IconButton({
  children,
  label,
  onClick,
  active = false,
  disabled = false,
  danger = false,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button${active ? " is-active" : ""}${danger ? " is-danger" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function SegmentButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`segment-button${active ? " is-active" : ""}`} onClick={onClick} aria-pressed={active}>
      {children}
    </button>
  );
}

function diamondPoints(node: VariableNode, extra = 0): string {
  const radius = node.size / 2 + extra;
  return [
    `${node.x},${node.y - radius}`,
    `${node.x + radius},${node.y}`,
    `${node.x},${node.y + radius}`,
    `${node.x - radius},${node.y}`,
  ].join(" ");
}

function NodeGlyph({ node }: { node: VariableNode }) {
  const fill = node.observed ? "#aeb9bc" : "#ffffff";
  const radius = node.size / 2;
  if (node.variableKind === "random") {
    return <circle cx={node.x} cy={node.y} r={radius} fill={fill} stroke="#27313a" strokeWidth="2.2" />;
  }
  if (node.variableKind === "double") {
    return (
      <g>
        <circle cx={node.x} cy={node.y} r={radius} fill={fill} stroke="#27313a" strokeWidth="2.2" />
        <circle cx={node.x} cy={node.y} r={Math.max(2, radius - 6)} fill="none" stroke="#27313a" strokeWidth="1.7" />
      </g>
    );
  }
  if (node.variableKind === "diamond") {
    return <polygon points={diamondPoints(node)} fill={fill} stroke="#27313a" strokeWidth="2.2" strokeLinejoin="round" />;
  }
  if (node.variableKind === "factor") {
    return (
      <rect
        x={node.x - radius}
        y={node.y - radius}
        width={node.size}
        height={node.size}
        fill="#27313a"
        stroke="#27313a"
        strokeWidth="1"
      />
    );
  }
  return (
    <rect
      x={node.x - radius}
      y={node.y - radius}
      width={node.size}
      height={node.size}
      rx="2"
      fill={fill}
      stroke="#27313a"
      strokeWidth="2.2"
    />
  );
}

function NodeSelection({ node }: { node: VariableNode }) {
  if (node.variableKind === "random" || node.variableKind === "double") {
    return <circle data-editor-ui="true" cx={node.x} cy={node.y} r={node.size / 2 + 3} fill="none" stroke="#0c7a84" strokeWidth="2.5" pointerEvents="none" />;
  }
  if (node.variableKind === "diamond") {
    return <polygon data-editor-ui="true" points={diamondPoints(node, 4)} fill="none" stroke="#0c7a84" strokeWidth="2.5" strokeLinejoin="round" pointerEvents="none" />;
  }
  const extra = node.variableKind === "factor" ? 4 : 3;
  return (
    <rect
      data-editor-ui="true"
      x={node.x - node.size / 2 - extra}
      y={node.y - node.size / 2 - extra}
      width={node.size + extra * 2}
      height={node.size + extra * 2}
      rx={node.variableKind === "factor" ? 2 : 4}
      fill="none"
      stroke="#0c7a84"
      strokeWidth="2.5"
      pointerEvents="none"
    />
  );
}

function findGroupFor(document: DocumentV1, id: string) {
  return document.groups.find((group) => group.memberIds.includes(id));
}

function expandedSelection(document: DocumentV1, id: string): string[] {
  return findGroupFor(document, id)?.memberIds ?? [id];
}

function makeElement(kind: PaletteKind, point: Point, document: DocumentV1): PositionedElement {
  const grid = document.canvas.gridSize;
  const useSnap = document.canvas.snapToGrid;
  const px = useSnap ? snap(point.x, grid) : point.x;
  const py = useSnap ? snap(point.y, grid) : point.y;
  if (kind === "plate") {
    return {
      id: uid("plate"),
      type: "plate",
      x: useSnap ? snap(px - 150, grid) : px - 150,
      y: useSnap ? snap(py - 100, grid) : py - 100,
      width: 300,
      height: 200,
      cornerRadius: 10,
      label: "$N$",
    };
  }
  if (kind === "text") return { id: uid("text"), type: "text", x: px, y: py, text: "$x_n$" };
  return {
    id: uid("node"),
    type: "variable",
    variableKind: kind,
    x: px,
    y: py,
    size: kind === "factor" ? 14 : 56,
    observed: false,
    label: kind === "factor" ? "" : kind === "random" || kind === "double" ? "$z$" : "$f$",
  };
}

function rectangleFromPoints(a: Point, b: Point): Bounds {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PlateEditor() {
  const [diagram, dispatch] = useReducer(documentReducer, undefined, sampleDocument);
  const [selection, setSelection] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const [toast, setToast] = useState<string | null>(null);
  const canvasRef = useRef<SVGSVGElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pointerRef = useRef<PointerInteraction | null>(null);
  const hydratedRef = useRef(false);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => current === message ? null : current), 2800);
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const validated = validateDocument(JSON.parse(raw));
        if (validated.ok) dispatch({ type: "replace", document: validated.document });
      }
    } catch {
      // A damaged autosave should never prevent the editor from starting.
    }
    hydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const savingTimer = window.setTimeout(() => setSaveState("saving"), 0);
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(diagram));
      setSaveState("saved");
    }, 250);
    return () => {
      window.clearTimeout(savingTimer);
      window.clearTimeout(timer);
    };
  }, [diagram]);

  const deleteSelection = useCallback(() => {
    if (!selection.length) return;
    dispatch({ type: "delete", ids: selection });
    setSelection([]);
  }, [selection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      }
      if (event.key === "Escape") {
        pointerRef.current = null;
        setOverlay({ kind: "none" });
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelection]);

  const elementsById = useMemo(
    () => new Map(diagram.elements.map((element) => [element.id, element])),
    [diagram.elements],
  );
  const selectedElements = useMemo(
    () => selection.map((id) => elementsById.get(id)).filter((value): value is DiagramElement => Boolean(value)),
    [elementsById, selection],
  );
  const selectedGroups = useMemo(
    () => diagram.groups.filter((group) => group.memberIds.some((id) => selection.includes(id))),
    [diagram.groups, selection],
  );

  const canvasPoint = useCallback((event: { clientX: number; clientY: number }): Point => {
    const svg = canvasRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
    };
  }, []);

  const beginElementPointer = useCallback((event: ReactPointerEvent<SVGGElement | SVGPathElement>, element: DiagramElement) => {
    event.stopPropagation();
    const point = canvasPoint(event);
    if (tool === "connect") {
      if (element.type !== "variable") {
        showToast("Connections begin and end on variable nodes.");
        return;
      }
      pointerRef.current = { kind: "connect", pointerId: event.pointerId, start: point, sourceId: element.id };
      setOverlay({ kind: "connect", start: point, current: point });
      canvasRef.current?.setPointerCapture(event.pointerId);
      return;
    }

    const groupIds = expandedSelection(diagram, element.id);
    const toggleModifier = event.metaKey || event.ctrlKey;
    if (toggleModifier) {
      const allSelected = groupIds.every((id) => selection.includes(id));
      setSelection((current) =>
        allSelected
          ? current.filter((id) => !groupIds.includes(id))
          : [...new Set([...current, ...groupIds])],
      );
      return;
    }

    const nextSelection = event.shiftKey
      ? [...new Set([...selection, ...groupIds])]
      : selection.includes(element.id) ? selection : groupIds;
    setSelection(nextSelection);
    if (!isPositioned(element)) return;
    const moveIds = nextSelection.filter((id) => {
      const candidate = elementsById.get(id);
      return candidate && isPositioned(candidate);
    });
    const positions: Record<string, Point> = {};
    for (const id of moveIds) {
      const candidate = elementsById.get(id);
      if (candidate && isPositioned(candidate)) positions[id] = { x: candidate.x, y: candidate.y };
    }
    pointerRef.current = {
      kind: "move",
      pointerId: event.pointerId,
      start: point,
      ids: moveIds,
      positions,
      anchorId: element.id,
    };
    canvasRef.current?.setPointerCapture(event.pointerId);
  }, [canvasPoint, diagram, elementsById, selection, showToast, tool]);

  const beginResize = useCallback((
    event: ReactPointerEvent<SVGCircleElement>,
    plate: Plate,
    corner: "nw" | "ne" | "sw" | "se",
  ) => {
    event.stopPropagation();
    pointerRef.current = {
      kind: "resize",
      pointerId: event.pointerId,
      start: canvasPoint(event),
      plate,
      corner,
    };
    canvasRef.current?.setPointerCapture(event.pointerId);
  }, [canvasPoint]);

  const onCanvasPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (tool === "connect") return;
    const point = canvasPoint(event);
    const additive = event.metaKey || event.ctrlKey || event.shiftKey;
    if (!additive) setSelection([]);
    pointerRef.current = {
      kind: "marquee",
      pointerId: event.pointerId,
      start: point,
      additive,
      previous: additive ? selection : [],
    };
    setOverlay({ kind: "marquee", start: point, current: point });
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [canvasPoint, selection, tool]);

  const onCanvasPointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const interaction = pointerRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const point = canvasPoint(event);
    if (interaction.kind === "marquee") {
      setOverlay({ kind: "marquee", start: interaction.start, current: point });
      return;
    }
    if (interaction.kind === "connect") {
      setOverlay({ kind: "connect", start: interaction.start, current: point });
      return;
    }
    if (interaction.kind === "resize") {
      const next = resizePlate(
        interaction.plate,
        interaction.corner,
        point.x - interaction.start.x,
        point.y - interaction.start.y,
        diagram.canvas.snapToGrid && !event.shiftKey,
        diagram.canvas.gridSize,
      );
      dispatch({ type: "update", id: interaction.plate.id, patch: next });
      return;
    }
    let dx = point.x - interaction.start.x;
    let dy = point.y - interaction.start.y;
    if (diagram.canvas.snapToGrid && !event.shiftKey) {
      const anchor = interaction.positions[interaction.anchorId] ?? interaction.positions[interaction.ids[0]];
      if (anchor) {
        dx = snap(anchor.x + dx, diagram.canvas.gridSize) - anchor.x;
        dy = snap(anchor.y + dy, diagram.canvas.gridSize) - anchor.y;
      }
    }
    const positions = Object.fromEntries(
      interaction.ids.map((id) => [id, {
        x: interaction.positions[id].x + dx,
        y: interaction.positions[id].y + dy,
      }]),
    );
    dispatch({ type: "setPositions", positions });
  }, [canvasPoint, diagram.canvas.gridSize, diagram.canvas.snapToGrid]);

  const finishPointer = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const interaction = pointerRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const point = canvasPoint(event);
    if (interaction.kind === "marquee") {
      const marquee = rectangleFromPoints(interaction.start, point);
      const hits = diagram.elements
        .filter((element) => element.type !== "edge")
        .filter((element) => {
          const bounds = elementBounds(element);
          return bounds && boundsIntersect(marquee, bounds);
        })
        .flatMap((element) => expandedSelection(diagram, element.id));
      setSelection([...new Set([...interaction.previous, ...hits])]);
    } else if (interaction.kind === "connect") {
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<SVGGElement>("[data-element-id]")
        ?.dataset.elementId;
      const targetElement = target ? elementsById.get(target) : undefined;
      if (targetElement?.type === "variable" && targetElement.id !== interaction.sourceId) {
        dispatch({
          type: "add",
          element: {
            id: uid("edge"),
            type: "edge",
            sourceId: interaction.sourceId,
            targetId: targetElement.id,
            lineStyle: "straight",
            headStyle: "arrow",
            label: "",
          },
        });
        setTool("select");
      } else if (targetElement?.id === interaction.sourceId) {
        showToast("A variable cannot connect to itself.");
      } else {
        showToast("Drop the connection on another variable node.");
      }
    }
    pointerRef.current = null;
    setOverlay({ kind: "none" });
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) canvasRef.current.releasePointerCapture(event.pointerId);
  }, [canvasPoint, diagram, elementsById, showToast]);

  const onCanvasDrop = useCallback((event: DragEvent<SVGSVGElement>) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData(MIME_TYPE) as PaletteKind;
    if (!["random", "deterministic", "double", "diamond", "factor", "plate", "text"].includes(kind)) return;
    const element = makeElement(kind, canvasPoint(event), diagram);
    dispatch({ type: "add", element });
    setSelection([element.id]);
    setTool("select");
  }, [canvasPoint, diagram]);

  const groupSelection = useCallback(() => {
    const groupable = selection.filter((id) => {
      const element = elementsById.get(id);
      return element && element.type !== "edge";
    });
    if (groupable.length < 2) {
      showToast("Select at least two nodes, plates, or text elements to group.");
      return;
    }
    dispatch({ type: "group", id: uid("group"), memberIds: groupable });
    showToast(`${groupable.length} elements grouped.`);
  }, [elementsById, selection, showToast]);

  const ungroupSelection = useCallback(() => {
    if (!selectedGroups.length) return;
    dispatch({ type: "ungroup", groupIds: selectedGroups.map((group) => group.id) });
    showToast("Group released.");
  }, [selectedGroups, showToast]);

  const resetDocument = useCallback(() => {
    if (diagram.elements.length && !window.confirm("Replace the current diagram with a new blank document?")) return;
    dispatch({ type: "replace", document: emptyDocument() });
    setSelection([]);
    showToast("New diagram ready.");
  }, [diagram.elements.length, showToast]);

  const saveJson = useCallback(() => {
    downloadBlob(new Blob([JSON.stringify(diagram, null, 2)], { type: "application/json" }), "plate-diagram.json");
    showToast("Editable diagram downloaded.");
  }, [diagram, showToast]);

  const openJson = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const validated = validateDocument(JSON.parse(await file.text()));
      if (!validated.ok) {
        showToast(validated.error);
        return;
      }
      if (diagram.elements.length && !window.confirm("Replace the current diagram with the selected file?")) return;
      dispatch({ type: "replace", document: validated.document });
      setSelection([]);
      showToast("Diagram opened.");
    } catch {
      showToast("That file is not valid JSON.");
    }
  }, [diagram.elements.length, showToast]);

  const serializeSvg = useCallback((): { source: string; bounds: Bounds } | null => {
    const svg = canvasRef.current;
    if (!svg) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.querySelectorAll('[data-editor-ui="true"]').forEach((node) => node.remove());
    clone.querySelectorAll("[data-element-id]").forEach((node) => node.removeAttribute("data-element-id"));
    const bounds = contentBounds(diagram, 24);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
    clone.setAttribute("width", String(bounds.width));
    clone.setAttribute("height", String(bounds.height));
    clone.setAttribute("role", "img");
    clone.setAttribute("aria-label", "Statistical plate diagram");
    const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    background.setAttribute("x", String(bounds.x));
    background.setAttribute("y", String(bounds.y));
    background.setAttribute("width", String(bounds.width));
    background.setAttribute("height", String(bounds.height));
    background.setAttribute("fill", "#ffffff");
    const defs = clone.querySelector("defs");
    defs?.insertAdjacentElement("afterend", background);
    return { source: new XMLSerializer().serializeToString(clone), bounds };
  }, [diagram]);

  const waitForRenderedLabels = useCallback(async () => {
    const mathCount = diagram.elements.filter((element) => {
      if (element.type === "variable") return hasMath(element.label) && !validateLabel(element.label);
      if (element.type === "text") return hasMath(element.text) && !validateLabel(element.text);
      if (element.type === "plate") return hasMath(element.label ?? "") && !validateLabel(element.label ?? "");
      if (element.type === "edge") return hasMath(element.label ?? "") && !validateLabel(element.label ?? "");
      return false;
    }).length;
    if (!mathCount) return true;
    const mathJax = await waitForMathJax();
    if (!mathJax) return false;
    const started = Date.now();
    while (Date.now() - started < 3000) {
      if ((canvasRef.current?.querySelectorAll('[data-math-rendered="true"]').length ?? 0) >= mathCount) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    }
    return false;
  }, [diagram.elements]);

  const exportSvg = useCallback(async () => {
    if (!(await waitForRenderedLabels())) showToast("Math is still loading; the visible fallback text will be exported.");
    const serialized = serializeSvg();
    if (!serialized) return;
    downloadBlob(new Blob([serialized.source], { type: "image/svg+xml;charset=utf-8" }), "plate-diagram.svg");
    showToast("Publication-ready SVG downloaded.");
  }, [serializeSvg, showToast, waitForRenderedLabels]);

  const exportPng = useCallback(async () => {
    if (!(await waitForRenderedLabels())) showToast("Math is still loading; the visible fallback text will be exported.");
    const serialized = serializeSvg();
    if (!serialized) return;
    const url = URL.createObjectURL(new Blob([serialized.source], { type: "image/svg+xml;charset=utf-8" }));
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(serialized.bounds.width * 2);
      canvas.height = Math.ceil(serialized.bounds.height * 2);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, "plate-diagram@2x.png");
        URL.revokeObjectURL(url);
        showToast("High-resolution PNG downloaded.");
      }, "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      showToast("The browser could not rasterize this diagram. SVG export is still available.");
    };
    image.src = url;
  }, [serializeSvg, showToast, waitForRenderedLabels]);

  const updateElement = useCallback((id: string, patch: Partial<DiagramElement>) => {
    dispatch({ type: "update", id, patch });
  }, []);

  const plates = diagram.elements.filter((element): element is Plate => element.type === "plate");
  const edges = diagram.elements.filter((element): element is Edge => element.type === "edge");
  const foreground = diagram.elements.filter((element) => element.type === "variable" || element.type === "text");
  const singlePlate = selectedElements.length === 1 && selectedElements[0].type === "plate" ? selectedElements[0] : null;

  return (
    <main className="editor-shell">
      <header className="topbar">
        <div className="brand-block" aria-label="Plate Studio">
          <span className="brand-mark"><span /></span>
          <div>
            <strong>Plate Studio</strong>
            <small>Statistical diagram editor</small>
          </div>
        </div>

        <div className="topbar-section file-actions" aria-label="File actions">
          <button type="button" className="text-button" onClick={resetDocument}>New</button>
          <button type="button" className="text-button" onClick={() => fileInputRef.current?.click()}>Open</button>
          <button type="button" className="text-button" onClick={saveJson}>Save JSON</button>
          <span className="toolbar-divider" />
          <button type="button" className="text-button export-button" onClick={() => void exportSvg()}>Export SVG</button>
          <button type="button" className="text-button" onClick={() => void exportPng()}>PNG</button>
          <input ref={fileInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => void openJson(event)} />
        </div>

        <div className="topbar-section edit-actions" aria-label="Editing actions">
          <button
            type="button"
            className={`snap-toggle${diagram.canvas.snapToGrid ? " is-on" : ""}`}
            onClick={() => dispatch({ type: "setSnap", value: !diagram.canvas.snapToGrid })}
            aria-pressed={diagram.canvas.snapToGrid}
          >
            <span className="snap-dot-grid" aria-hidden="true" />
            Snap
          </button>
          <IconButton label="Group selection" onClick={groupSelection} disabled={selectedElements.filter((item) => item.type !== "edge").length < 2}>⌘</IconButton>
          <IconButton label="Ungroup selection" onClick={ungroupSelection} disabled={!selectedGroups.length}>↗</IconButton>
          <IconButton label="Delete selection" onClick={deleteSelection} disabled={!selection.length} danger>⌫</IconButton>
          <span className={`save-indicator${saveState === "saving" ? " is-saving" : ""}`}>
            <i /> {saveState === "saving" ? "Saving…" : "Saved locally"}
          </span>
        </div>
      </header>

      <div className="editor-body">
        <aside className="palette-panel" aria-label="Element palette">
          <div className="panel-heading">
            <span>Elements</span>
            <small>Drag to canvas</small>
          </div>
          <div className="palette-list">
            {([
              ["random", "Circle node", "circle", ""],
              ["deterministic", "Square node", "square", ""],
              ["double", "Double circle node", "double", ""],
              ["diamond", "Diamond node", "diamond", ""],
              ["factor", "Factor node", "factor", "Small black square"],
              ["plate", "Plate", "plate", ""],
              ["text", "Text / math", "text", "Plain or $math$"],
            ] as const).map(([kind, label, preview, description]) => (
              <button
                key={kind}
                type="button"
                className="palette-item"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(MIME_TYPE, kind);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onDoubleClick={() => {
                  const offset = diagram.elements.length * 16;
                  const element = makeElement(kind, { x: 520 + offset % 160, y: 320 + offset % 120 }, diagram);
                  dispatch({ type: "add", element });
                  setSelection([element.id]);
                }}
              >
                <span className={`element-preview preview-${preview}`} aria-hidden="true">
                  {preview === "text" ? "xₙ" : null}
                </span>
                <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
                <span className="drag-grip" aria-hidden="true">⠿</span>
              </button>
            ))}
          </div>

          <div className="panel-heading connection-heading"><span>Connections</span></div>
          <button
            type="button"
            className={`connection-tool${tool === "connect" ? " is-active" : ""}`}
            onClick={() => setTool((current) => current === "connect" ? "select" : "connect")}
            aria-pressed={tool === "connect"}
          >
            <span className="connection-preview" aria-hidden="true"><i /><b>›</b></span>
            <span><strong>Edge</strong><small>Drag node to node</small></span>
          </button>

          <div className="palette-tip">
            <span>Tip</span>
            <p>Shift-click adds to selection. While Snap is on, Shift-drag moves freely.</p>
          </div>
        </aside>

        <section className={`canvas-panel tool-${tool}`} aria-label="Diagram canvas workspace">
          <div className="canvas-meta">
            <span><b>{diagram.elements.filter((item) => item.type !== "edge").length}</b> elements</span>
            <span>{CANVAS_WIDTH} × {CANVAS_HEIGHT}</span>
          </div>
          <div className="canvas-scroll">
            <div className="canvas-stage">
              <svg
                ref={canvasRef}
                id="diagram-canvas"
                viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
                role="application"
                aria-label="Editable statistical plate diagram"
                onPointerDown={onCanvasPointerDown}
                onPointerMove={onCanvasPointerMove}
                onPointerUp={finishPointer}
                onPointerCancel={() => { pointerRef.current = null; setOverlay({ kind: "none" }); }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                onDrop={onCanvasDrop}
              >
                <defs>
                  <pattern id="minor-grid" width={diagram.canvas.gridSize} height={diagram.canvas.gridSize} patternUnits="userSpaceOnUse">
                    <circle cx="1" cy="1" r="1" fill="#cbd2da" />
                  </pattern>
                  <marker id="arrow-head" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto" markerUnits="strokeWidth">
                    <path d="M 1 1 L 9 5.5 L 1 10" fill="none" stroke="#27313a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </marker>
                  <marker id="bar-head" markerWidth="10" markerHeight="14" refX="5" refY="7" orient="auto" markerUnits="strokeWidth">
                    <path d="M 5 1 L 5 13" fill="none" stroke="#27313a" strokeWidth="2" strokeLinecap="round" />
                  </marker>
                </defs>
                <rect width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="#ffffff" />
                <rect data-editor-ui="true" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="url(#minor-grid)" />

                <g className="plate-layer">
                  {plates.map((plate) => (
                    <g
                      key={plate.id}
                      data-element-id={plate.id}
                      className="diagram-element plate-element"
                      onPointerDown={(event) => beginElementPointer(event, plate)}
                    >
                      <rect
                        x={plate.x}
                        y={plate.y}
                        width={plate.width}
                        height={plate.height}
                        rx={plate.cornerRadius}
                        fill="rgba(255,255,255,0.34)"
                        stroke="#34414a"
                        strokeWidth="2"
                        pointerEvents="stroke"
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
                        <path d={path} fill="none" stroke="transparent" strokeWidth="16" onPointerDown={(event) => beginElementPointer(event, edge)} />
                        <path
                          d={path}
                          fill="none"
                          stroke="#27313a"
                          strokeWidth="2.1"
                          strokeLinecap="round"
                          strokeLinejoin="round"
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
                      const bounds = elementBounds(element)!;
                      return (
                        <g
                          key={element.id}
                          data-element-id={element.id}
                          className="diagram-element text-element"
                          onPointerDown={(event) => beginElementPointer(event, element)}
                        >
                          <rect
                            data-editor-ui="true"
                            x={bounds.x - 8}
                            y={bounds.y - 4}
                            width={bounds.width + 16}
                            height={bounds.height + 8}
                            fill="transparent"
                            stroke="none"
                            pointerEvents="all"
                          />
                          {selected && (
                            <rect
                              data-editor-ui="true"
                              x={bounds.x - 6}
                              y={bounds.y - 2}
                              width={bounds.width + 12}
                              height={bounds.height + 4}
                              rx="5"
                              fill="#e6f4f3"
                              stroke="#0c7a84"
                              strokeWidth="1.5"
                              strokeDasharray="4 3"
                            />
                          )}
                          <MathLabel source={element.text} x={element.x} y={element.y} maxWidth={360} fontSize={20} />
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
                        {element.variableKind === "factor" && (
                          <rect
                            data-editor-ui="true"
                            x={element.x - 14}
                            y={element.y - 14}
                            width="28"
                            height="28"
                            fill="transparent"
                            pointerEvents="all"
                          />
                        )}
                        <NodeGlyph node={element} />
                        {selected && <NodeSelection node={element} />}
                        {element.variableKind !== "factor" && element.label && (
                          <MathLabel source={element.label} x={element.x} y={element.y} maxWidth={element.size - 12} fontSize={17} className="node-label" />
                        )}
                        {tool === "connect" && (
                          <circle data-editor-ui="true" cx={element.x} cy={element.y} r={element.size / 2 + 7} fill="none" stroke="#0c7a84" strokeWidth="2" strokeDasharray="3 4" pointerEvents="none" />
                        )}
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
              </svg>
            </div>
          </div>
          <div className="canvas-legend">
            <span><i className="legend-circle" /> Circle</span>
            <span><i className="legend-square" /> Square</span>
            <span><i className="legend-observed" /> Known value</span>
          </div>
        </section>

        <aside className="inspector-panel" aria-label="Properties inspector">
          <div className="panel-heading inspector-heading">
            <span>Inspector</span>
            {selectedElements.length > 0 && <small>{selectedElements.length === 1 ? selectedElements[0].type : `${selectedElements.length} selected`}</small>}
          </div>
          {selectedElements.length === 0 ? (
            <div className="empty-inspector">
              <span className="empty-inspector-icon" aria-hidden="true">◎</span>
              <h2>Select an element</h2>
              <p>Choose a node, arrow, plate, or text label to edit its properties.</p>
              <dl>
                <div><dt>Shift + click</dt><dd>Add to selection</dd></div>
                <div><dt>Delete</dt><dd>Remove selection</dd></div>
                <div><dt>Esc</dt><dd>Cancel connection</dd></div>
              </dl>
            </div>
          ) : selectedElements.length > 1 ? (
            <div className="inspector-content">
              <div className="selection-summary">
                <strong>{selectedElements.length}</strong>
                <span>elements selected</span>
              </div>
              <div className="inspector-button-stack">
                <button type="button" className="primary-wide-button" onClick={groupSelection} disabled={selectedElements.filter((item) => item.type !== "edge").length < 2}>Group selection</button>
                <button type="button" className="secondary-wide-button" onClick={ungroupSelection} disabled={!selectedGroups.length}>Ungroup</button>
                <button type="button" className="danger-wide-button" onClick={deleteSelection}>Delete elements</button>
              </div>
              <p className="inspector-note">Grouped elements move and delete as one. Connections continue to follow their nodes.</p>
            </div>
          ) : (
            <ElementInspector
              element={selectedElements[0]}
              diagram={diagram}
              onUpdate={updateElement}
              onDelete={deleteSelection}
            />
          )}
        </aside>
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

function ElementInspector({
  element,
  diagram,
  onUpdate,
  onDelete,
}: {
  element: DiagramElement;
  diagram: DocumentV1;
  onUpdate: (id: string, patch: Partial<DiagramElement>) => void;
  onDelete: () => void;
}) {
  if (element.type === "variable") {
    const labelError = validateLabel(element.label);
    const setNodeKind = (kind: VariableKind) => {
      const leavingFactor = element.variableKind === "factor" && kind !== "factor";
      const defaultLabel = kind === "random" || kind === "double" ? "$z$" : "$f$";
      onUpdate(element.id, {
        variableKind: kind,
        size: kind === "factor" ? 14 : leavingFactor ? 56 : element.size,
        observed: kind === "factor" ? false : element.observed,
        label: kind === "factor" ? "" : element.label || defaultLabel,
      });
    };
    return (
      <div className="inspector-content">
        <div className="field-group">
          <label>Node type</label>
          <div className="segment-control node-shape-control">
            <SegmentButton active={element.variableKind === "random"} onClick={() => setNodeKind("random")}>Circle</SegmentButton>
            <SegmentButton active={element.variableKind === "deterministic"} onClick={() => setNodeKind("deterministic")}>Square</SegmentButton>
            <SegmentButton active={element.variableKind === "double"} onClick={() => setNodeKind("double")}>Double</SegmentButton>
            <SegmentButton active={element.variableKind === "diamond"} onClick={() => setNodeKind("diamond")}>Diamond</SegmentButton>
            <SegmentButton active={element.variableKind === "factor"} onClick={() => setNodeKind("factor")}>Factor</SegmentButton>
          </div>
        </div>
        {element.variableKind !== "factor" && (
          <>
            <div className="field-group">
              <label htmlFor="node-label">Label</label>
              <textarea id="node-label" value={element.label} onChange={(event) => onUpdate(element.id, { label: event.target.value })} rows={3} spellCheck={false} />
              <p className={`field-help${labelError ? " is-error" : ""}`}>{labelError ?? "Wrap math in dollar signs, for example $x_n$ or $\\boldsymbol{\\theta}$."}</p>
            </div>
            <div className="field-group">
              <label>Value state</label>
              <div className="segment-control">
                <SegmentButton active={!element.observed} onClick={() => onUpdate(element.id, { observed: false })}>Unknown</SegmentButton>
                <SegmentButton active={element.observed} onClick={() => onUpdate(element.id, { observed: true })}>Known</SegmentButton>
              </div>
            </div>
          </>
        )}
        <PositionFields element={element} onUpdate={onUpdate} />
        <button type="button" className="danger-wide-button" onClick={onDelete}>Delete node</button>
      </div>
    );
  }

  if (element.type === "text") {
    const labelError = validateLabel(element.text);
    return (
      <div className="inspector-content">
        <div className="field-group">
          <label htmlFor="text-content">Text</label>
          <textarea id="text-content" value={element.text} onChange={(event) => onUpdate(element.id, { text: event.target.value })} rows={5} spellCheck={false} />
          <p className={`field-help${labelError ? " is-error" : ""}`}>{labelError ?? "Plain text and $TeX$ can be mixed in the same label."}</p>
        </div>
        <PositionFields element={element} onUpdate={onUpdate} />
        <button type="button" className="danger-wide-button" onClick={onDelete}>Delete text</button>
      </div>
    );
  }

  if (element.type === "plate") {
    const labelError = validateLabel(element.label ?? "");
    return (
      <div className="inspector-content">
        <div className="field-group">
          <label htmlFor="plate-label">Plate label</label>
          <textarea id="plate-label" value={element.label ?? ""} onChange={(event) => onUpdate(element.id, { label: event.target.value })} rows={3} spellCheck={false} />
          <p className={`field-help${labelError ? " is-error" : ""}`}>{labelError ?? "The label stays attached to the bottom-right corner of the plate."}</p>
        </div>
        <div className="field-group">
          <label>Dimensions</label>
          <div className="two-fields">
            <NumberField label="Width" value={element.width} min={80} onChange={(value) => onUpdate(element.id, { width: value })} />
            <NumberField label="Height" value={element.height} min={60} onChange={(value) => onUpdate(element.id, { height: value })} />
          </div>
        </div>
        <div className="field-group">
          <label>Corners</label>
          <div className="segment-control">
            <SegmentButton active={element.cornerRadius === 0} onClick={() => onUpdate(element.id, { cornerRadius: 0 })}>Square</SegmentButton>
            <SegmentButton active={element.cornerRadius > 0} onClick={() => onUpdate(element.id, { cornerRadius: 10 })}>Rounded</SegmentButton>
          </div>
        </div>
        <PositionFields element={element} onUpdate={onUpdate} />
        <p className="inspector-note">Plates stay behind other elements. Group a plate with its contents when you want them to move together.</p>
        <button type="button" className="danger-wide-button" onClick={onDelete}>Delete plate</button>
      </div>
    );
  }

  const source = diagram.elements.find((item): item is VariableNode => item.id === element.sourceId && item.type === "variable");
  const target = diagram.elements.find((item): item is VariableNode => item.id === element.targetId && item.type === "variable");
  const labelError = validateLabel(element.label ?? "");
  return (
    <div className="inspector-content">
      <div className="connection-summary">
        <span>{plainLabel(source?.label || "Source")}</span><b>{element.headStyle === "none" ? "—" : element.headStyle === "bar" ? "⊣" : "→"}</b><span>{plainLabel(target?.label || "Target")}</span>
      </div>
      <div className="field-group">
        <label htmlFor="edge-label">Edge label</label>
        <textarea id="edge-label" value={element.label ?? ""} onChange={(event) => onUpdate(element.id, { label: event.target.value })} rows={3} spellCheck={false} />
        <p className={`field-help${labelError ? " is-error" : ""}`}>{labelError ?? "The label follows the midpoint of the edge; $TeX$ is supported."}</p>
      </div>
      <div className="field-group">
        <label>Line</label>
        <div className="segment-control">
          <SegmentButton active={element.lineStyle === "straight"} onClick={() => onUpdate(element.id, { lineStyle: "straight" })}>Straight</SegmentButton>
          <SegmentButton active={element.lineStyle === "squiggly"} onClick={() => onUpdate(element.id, { lineStyle: "squiggly" })}>Squiggly</SegmentButton>
        </div>
      </div>
      <div className="field-group">
        <label>Target head</label>
        <div className="segment-control segment-control-three">
          <SegmentButton active={element.headStyle === "arrow"} onClick={() => onUpdate(element.id, { headStyle: "arrow" })}>Arrow</SegmentButton>
          <SegmentButton active={element.headStyle === "bar"} onClick={() => onUpdate(element.id, { headStyle: "bar" })}>Switch bar</SegmentButton>
          <SegmentButton active={element.headStyle === "none"} onClick={() => onUpdate(element.id, { headStyle: "none" })}>None</SegmentButton>
        </div>
      </div>
      <button type="button" className="danger-wide-button" onClick={onDelete}>Delete connection</button>
    </div>
  );
}

function PositionFields({
  element,
  onUpdate,
}: {
  element: PositionedElement;
  onUpdate: (id: string, patch: Partial<DiagramElement>) => void;
}) {
  return (
    <div className="field-group">
      <label>Position</label>
      <div className="two-fields">
        <NumberField label="X" value={element.x} onChange={(value) => onUpdate(element.id, { x: value })} />
        <NumberField label="Y" value={element.y} onChange={(value) => onUpdate(element.id, { y: value })} />
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        type="number"
        value={Math.round(value)}
        min={min}
        max={max}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next)));
        }}
      />
    </label>
  );
}
