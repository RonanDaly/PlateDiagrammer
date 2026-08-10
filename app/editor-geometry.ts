import { displayNodeDimensions, type DiagramElement, type DocumentV1, type Edge, type Plate, type PositionedElement, type VariableNode } from "./editor-model.ts";

export interface Point { x: number; y: number }
export interface Bounds { x: number; y: number; width: number; height: number }
export const BAR_HEAD_GAP = 4.5;
export const EDGE_LABEL_OFFSET = 26;
export const PLATE_HIT_STROKE_WIDTH = 14;

export function snap(value: number, gridSize = 20): number {
  return Math.round(value / gridSize) * gridSize;
}

export function variableBoundaryPoint(node: VariableNode, toward: Point): Point {
  const dx = toward.x - node.x;
  const dy = toward.y - node.y;
  if (dx === 0 && dy === 0) return { x: node.x, y: node.y };
  const dimensions = displayNodeDimensions(node);
  const radiusX = dimensions.width / 2;
  const radiusY = dimensions.height / 2;
  if (node.variableKind === "random" || node.variableKind === "double" || node.variableKind === "small-circle") {
    const scale = 1 / Math.sqrt((dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY));
    return { x: node.x + dx * scale, y: node.y + dy * scale };
  }
  if (node.variableKind === "diamond") {
    const scale = 1 / (Math.abs(dx) / radiusX + Math.abs(dy) / radiusY);
    return { x: node.x + dx * scale, y: node.y + dy * scale };
  }
  const scale = 1 / Math.max(Math.abs(dx) / radiusX, Math.abs(dy) / radiusY);
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

export function edgeEndpoints(edge: Edge, document: DocumentV1): { start: Point; end: Point } | null {
  const source = document.elements.find((item): item is VariableNode => item.id === edge.sourceId && item.type === "variable");
  const target = document.elements.find((item): item is VariableNode => item.id === edge.targetId && item.type === "variable");
  if (!source || !target) return null;
  const start = variableBoundaryPoint(source, target);
  const boundaryEnd = variableBoundaryPoint(target, source);
  if (edge.headStyle !== "bar") return { start, end: boundaryEnd };
  const dx = source.x - boundaryEnd.x;
  const dy = source.y - boundaryEnd.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return { start, end: boundaryEnd };
  const gap = Math.min(BAR_HEAD_GAP, distance / 3);
  return {
    start,
    end: {
      x: boundaryEnd.x + (dx / distance) * gap,
      y: boundaryEnd.y + (dy / distance) * gap,
    },
  };
}

export function straightPath(start: Point, end: Point): string {
  return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
}

function localPoint(start: Point, ux: number, uy: number, nx: number, ny: number, along: number, across: number): Point {
  return {
    x: start.x + ux * along + nx * across,
    y: start.y + uy * along + ny * across,
  };
}

function pathPoint(point: Point): string {
  return `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
}

export function squigglyPath(start: Point, end: Point, amplitude = 5, wavelength = 24): string {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return straightPath(start, end);
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  const halfWaves = Math.max(2, Math.round(length / (wavelength / 2)));
  const halfWave = length / halfWaves;
  const commands = [`M ${pathPoint(start)}`];
  for (let index = 0; index < halfWaves; index += 1) {
    const from = index * halfWave;
    const to = (index + 1) * halfWave;
    const sign = index % 2 === 0 ? 1 : -1;
    const controlOffset = sign * amplitude * (4 / 3);
    const control1 = localPoint(start, ux, uy, nx, ny, from + halfWave / 3, controlOffset);
    const terminalOffset = index === halfWaves - 1 ? 0 : controlOffset;
    const control2 = localPoint(start, ux, uy, nx, ny, from + (halfWave * 2) / 3, terminalOffset);
    const destination = localPoint(start, ux, uy, nx, ny, to, 0);
    commands.push(`C ${pathPoint(control1)} ${pathPoint(control2)} ${pathPoint(destination)}`);
  }
  return commands.join(" ");
}

export function edgeLabelPoint(start: Point, end: Point, offset = EDGE_LABEL_OFFSET): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return { ...start };
  let nx = -dy / length;
  let ny = dx / length;
  if (ny > 0 || (ny === 0 && nx > 0)) {
    nx *= -1;
    ny *= -1;
  }
  return {
    x: (start.x + end.x) / 2 + nx * offset,
    y: (start.y + end.y) / 2 + ny * offset,
  };
}

export function scaledMathDimensions(
  viewBoxWidth: number,
  viewBoxHeight: number,
  fontSize: number,
  maxWidth: number,
): { width: number; height: number } {
  const emScale = fontSize / 1000;
  let width = Math.max(1, viewBoxWidth) * emScale;
  let height = Math.max(1, viewBoxHeight) * emScale;
  if (width > maxWidth) {
    const fitScale = maxWidth / width;
    width = maxWidth;
    height *= fitScale;
  }
  return { width, height };
}

export function estimatedLabelDimensions(
  source: string,
  fontSize = 20,
  maxWidth = 360,
): { width: number; height: number } {
  const visible = source
    .replace(/\\\$/g, "\u0000")
    .replace(/\\(?:boldsymbol|mathbf|mathrm|mathit|text)\b/g, "")
    .replace(/\\[a-zA-Z]+/g, "M")
    .replace(/\\./g, "M")
    .replace(/[$^_{}]/g, "")
    .replace(/\u0000/g, "$");
  const glyphWidth = fontSize * 0.58;
  return {
    width: Math.min(maxWidth, Math.max(glyphWidth, visible.length * glyphWidth)),
    height: fontSize * 1.4,
  };
}

export function anchoredLabelBounds(
  x: number,
  y: number,
  width: number,
  height: number,
  anchor: "middle" | "end" = "middle",
  verticalAnchor: "middle" | "bottom" = "middle",
): Bounds {
  return {
    x: anchor === "end" ? x - width : x - width / 2,
    y: verticalAnchor === "bottom" ? y - height : y - height / 2,
    width,
    height,
  };
}

export function elementBounds(element: DiagramElement): Bounds | null {
  if (element.type === "edge") return null;
  if (element.type === "variable") {
    const dimensions = displayNodeDimensions(element);
    return {
      x: element.x - dimensions.width / 2,
      y: element.y - dimensions.height / 2,
      width: dimensions.width,
      height: dimensions.height,
    };
  }
  if (element.type === "plate") return { x: element.x, y: element.y, width: element.width, height: element.height };
  const dimensions = estimatedLabelDimensions(element.text);
  return anchoredLabelBounds(element.x, element.y, dimensions.width, dimensions.height);
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

export function contentBounds(document: DocumentV1, padding = 24): Bounds {
  const bounds = document.elements.flatMap((element): Bounds[] => {
    const positioned = elementBounds(element);
    if (positioned) return [positioned];
    if (element.type !== "edge") return [];
    const endpoints = edgeEndpoints(element, document);
    if (!endpoints) return [];
    const labelPoint = edgeLabelPoint(endpoints.start, endpoints.end);
    const labelDimensions = element.label ? estimatedLabelDimensions(element.label, 15, 240) : null;
    const minX = Math.min(endpoints.start.x, endpoints.end.x) - 8;
    const minY = Math.min(endpoints.start.y, endpoints.end.y) - 8;
    const maxX = Math.max(endpoints.start.x, endpoints.end.x) + 8;
    const maxY = Math.max(endpoints.start.y, endpoints.end.y) + 8;
    const pathBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    if (!labelDimensions) return [pathBounds];
    const labelBounds = anchoredLabelBounds(labelPoint.x, labelPoint.y, labelDimensions.width, labelDimensions.height);
    const x = Math.min(pathBounds.x, labelBounds.x);
    const y = Math.min(pathBounds.y, labelBounds.y);
    const right = Math.max(pathBounds.x + pathBounds.width, labelBounds.x + labelBounds.width);
    const bottom = Math.max(pathBounds.y + pathBounds.height, labelBounds.y + labelBounds.height);
    return [{ x, y, width: right - x, height: bottom - y }];
  });
  if (!bounds.length) return { x: 0, y: 0, width: document.canvas.width, height: document.canvas.height };
  const minX = Math.min(...bounds.map((item) => item.x)) - padding;
  const minY = Math.min(...bounds.map((item) => item.y)) - padding;
  const maxX = Math.max(...bounds.map((item) => item.x + item.width)) + padding;
  const maxY = Math.max(...bounds.map((item) => item.y + item.height)) + padding;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function positionOf(element: PositionedElement): Point {
  return { x: element.x, y: element.y };
}

export function resizePlate(
  plate: Plate,
  corner: "nw" | "ne" | "sw" | "se",
  dx: number,
  dy: number,
  snapToGrid: boolean,
  gridSize: number,
): Pick<Plate, "x" | "y" | "width" | "height"> {
  let left = plate.x;
  let top = plate.y;
  let right = plate.x + plate.width;
  let bottom = plate.y + plate.height;
  if (corner.includes("w")) left = Math.min(right - 80, left + dx);
  if (corner.includes("e")) right = Math.max(left + 80, right + dx);
  if (corner.includes("n")) top = Math.min(bottom - 60, top + dy);
  if (corner.includes("s")) bottom = Math.max(top + 60, bottom + dy);
  if (snapToGrid) {
    left = snap(left, gridSize);
    top = snap(top, gridSize);
    right = snap(right, gridSize);
    bottom = snap(bottom, gridSize);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
