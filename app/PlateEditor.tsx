"use client";

import { DiagramScene, plainLabel } from "./DiagramScene";
import { serializeSvg, rasterizePng, waitForRenderedLabels } from "./diagram-export";

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
  MAX_CANVAS_SIZE,
  MIN_CANVAS_SIZE,
  documentReducer,
  emptyDocument,
  isCompactVariableKind,
  isPositioned,
  sampleDocument,
  uid,
  validateDocument,
  validateLabel,
  type DiagramElement,
  type DocumentV1,
  type Plate,
  type PositionedElement,
  type VariableKind,
  type VariableNode,
} from "./editor-model";
import {
  boundsIntersect,
  elementBounds,
  resizePlate,
  snap,
  type Bounds,
  type Point,
} from "./editor-geometry";

type Tool = "select" | "connect";
type PaletteKind = VariableKind | "plate" | "text";

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
      strokeStyle: "solid",
    };
  }
  if (kind === "text") return { id: uid("text"), type: "text", x: px, y: py, text: "$x_n$" };
  const compact = isCompactVariableKind(kind);
  return {
    id: uid("node"),
    type: "variable",
    variableKind: kind,
    x: px,
    y: py,
    size: compact ? 14 : 56,
    observed: false,
    label: compact ? "" : kind === "random" || kind === "double" ? "$z$" : "$f$",
    autoFit: false,
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
      x: ((event.clientX - rect.left) / rect.width) * diagram.canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * diagram.canvas.height,
    };
  }, [diagram.canvas.height, diagram.canvas.width]);

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
      const isClick = marquee.width < 4 && marquee.height < 4;
      const hits = diagram.elements
        .filter((element) => element.type !== "edge")
        .filter((element) => {
          if (element.type === "plate" && isClick) return false;
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
            strokeStyle: "solid",
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
    if (!["random", "deterministic", "double", "diamond", "factor", "small-circle", "plate", "text"].includes(kind)) return;
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

  const exportImage = useCallback(async (format: "svg" | "png") => {
    try {
      const svg = canvasRef.current;
      if (!svg) return;
      await waitForRenderedLabels(svg, 8000);
      const serialized = serializeSvg(svg, diagram);
      const blob = format === "svg"
        ? new Blob([serialized.source], { type: "image/svg+xml;charset=utf-8" })
        : await rasterizePng(serialized, 2);
      downloadBlob(blob, format === "svg" ? "plate-diagram.svg" : "plate-diagram@2x.png");
      showToast(`${format.toUpperCase()} downloaded.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Image export failed.");
    }
  }, [diagram, showToast]);

  const updateElement = useCallback((id: string, patch: Partial<DiagramElement>) => {
    dispatch({ type: "update", id, patch });
  }, []);


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
          <button type="button" className="text-button export-button" onClick={() => void exportImage("svg")}>Export SVG</button>
          <button type="button" className="text-button" onClick={() => void exportImage("png")}>PNG</button>
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
              ["factor", "Small square node", "small-square", ""],
              ["small-circle", "Small circle node", "small-circle", ""],
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
            <button type="button" className="canvas-size-link" onClick={() => setSelection([])} title="Edit canvas size">
              {diagram.canvas.width} × {diagram.canvas.height}
            </button>
          </div>
          <div className="canvas-scroll">
            <div className="canvas-stage" style={{ width: diagram.canvas.width, height: diagram.canvas.height }}>
              <svg
                ref={canvasRef}
                id="diagram-canvas"
                viewBox={`0 0 ${diagram.canvas.width} ${diagram.canvas.height}`}
                style={{ width: diagram.canvas.width, height: diagram.canvas.height }}
                role="application"
                aria-label="Editable statistical plate diagram"
                onPointerDown={onCanvasPointerDown}
                onPointerMove={onCanvasPointerMove}
                onPointerUp={finishPointer}
                onPointerCancel={() => { pointerRef.current = null; setOverlay({ kind: "none" }); }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                onDrop={onCanvasDrop}
              >
                <DiagramScene diagram={diagram} selection={selection} tool={tool} overlay={overlay} beginElementPointer={beginElementPointer} beginResize={beginResize} />
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
              <h2>Canvas size</h2>
              <p>Set the dimensions of the drawing area. Existing elements keep their positions.</p>
              <CanvasSizeControls
                key={`${diagram.canvas.width}x${diagram.canvas.height}`}
                width={diagram.canvas.width}
                height={diagram.canvas.height}
                onApply={(width, height) => dispatch({ type: "setCanvasSize", width, height })}
              />
              <dl>
                <div><dt>Select an element</dt><dd>Edit properties</dd></div>
                <div><dt>Shift + click</dt><dd>Add to selection</dd></div>
                <div><dt>Delete</dt><dd>Remove selection</dd></div>
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
      const wasCompact = isCompactVariableKind(element.variableKind);
      const compact = isCompactVariableKind(kind);
      const defaultLabel = kind === "random" || kind === "double" ? "$z$" : "$f$";
      onUpdate(element.id, {
        variableKind: kind,
        size: compact ? 14 : wasCompact ? 56 : element.size,
        observed: compact ? false : element.observed,
        label: compact ? "" : element.label || defaultLabel,
        autoFit: compact ? false : element.autoFit,
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
            <SegmentButton active={element.variableKind === "factor"} onClick={() => setNodeKind("factor")}>Small square</SegmentButton>
            <SegmentButton active={element.variableKind === "small-circle"} onClick={() => setNodeKind("small-circle")}>Small circle</SegmentButton>
          </div>
        </div>
        {!isCompactVariableKind(element.variableKind) && (
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
            <div className="field-group">
              <label>Fit label</label>
              <div className="segment-control">
                <SegmentButton active={!element.autoFit} onClick={() => onUpdate(element.id, { autoFit: false })}>Fixed</SegmentButton>
                <SegmentButton active={Boolean(element.autoFit)} onClick={() => onUpdate(element.id, { autoFit: true })}>Expand</SegmentButton>
              </div>
              <p className="field-help">Expand widens the node as needed while keeping its height fixed.</p>
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
        <div className="field-group">
          <label>Border</label>
          <div className="segment-control">
            <SegmentButton active={(element.strokeStyle ?? "solid") === "solid"} onClick={() => onUpdate(element.id, { strokeStyle: "solid" })}>Solid</SegmentButton>
            <SegmentButton active={element.strokeStyle === "dashed"} onClick={() => onUpdate(element.id, { strokeStyle: "dashed" })}>Dashed</SegmentButton>
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
        <label>Stroke</label>
        <div className="segment-control">
          <SegmentButton active={(element.strokeStyle ?? "solid") === "solid"} onClick={() => onUpdate(element.id, { strokeStyle: "solid" })}>Solid</SegmentButton>
          <SegmentButton active={element.strokeStyle === "dashed"} onClick={() => onUpdate(element.id, { strokeStyle: "dashed" })}>Dashed</SegmentButton>
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

function CanvasSizeControls({
  width,
  height,
  onApply,
}: {
  width: number;
  height: number;
  onApply: (width: number, height: number) => void;
}) {
  const [draftWidth, setDraftWidth] = useState(String(width));
  const [draftHeight, setDraftHeight] = useState(String(height));

  const nextWidth = Number(draftWidth);
  const nextHeight = Number(draftHeight);
  const valid = Number.isInteger(nextWidth) && Number.isInteger(nextHeight) &&
    nextWidth >= MIN_CANVAS_SIZE && nextWidth <= MAX_CANVAS_SIZE &&
    nextHeight >= MIN_CANVAS_SIZE && nextHeight <= MAX_CANVAS_SIZE;

  return (
    <form
      className="canvas-size-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onApply(nextWidth, nextHeight);
      }}
    >
      <div className="two-fields">
        <label className="number-field">
          <span>Width</span>
          <input
            type="number"
            min={MIN_CANVAS_SIZE}
            max={MAX_CANVAS_SIZE}
            step="20"
            value={draftWidth}
            onChange={(event) => setDraftWidth(event.target.value)}
          />
        </label>
        <label className="number-field">
          <span>Height</span>
          <input
            type="number"
            min={MIN_CANVAS_SIZE}
            max={MAX_CANVAS_SIZE}
            step="20"
            value={draftHeight}
            onChange={(event) => setDraftHeight(event.target.value)}
          />
        </label>
      </div>
      <button type="submit" className="primary-wide-button" disabled={!valid}>Apply size</button>
      <p className={`field-help${valid ? "" : " is-error"}`}>
        Use whole numbers from {MIN_CANVAS_SIZE} to {MAX_CANVAS_SIZE} units.
      </p>
    </form>
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
