import type { DiagramElement, DocumentV1, Edge, Plate, PositionedElement, VariableNode } from "./editor-model";

export interface Point { x: number; y: number }
export interface Bounds { x: number; y: number; width: number; height: number }

export function snap(value: number, gridSize = 20): number {
  return Math.round(value / gridSize) * gridSize;
}

export function variableBoundaryPoint(node: VariableNode, toward: Point): Point {
  const dx = toward.x - node.x;
  const dy = toward.y - node.y;
  if (dx === 0 && dy === 0) return { x: node.x, y: node.y };
  const radius = node.size / 2;
  if (node.variableKind === "random") {
    const distance = Math.hypot(dx, dy);
    return { x: node.x + (dx / distance) * radius, y: node.y + (dy / distance) * radius };
  }
  const scale = radius / Math.max(Math.abs(dx), Math.abs(dy));
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

export function edgeEndpoints(edge: Edge, document: DocumentV1): { start: Point; end: Point } | null {
  const source = document.elements.find((item): item is VariableNode => item.id === edge.sourceId && item.type === "variable");
  const target = document.elements.find((item): item is VariableNode => item.id === edge.targetId && item.type === "variable");
  if (!source || !target) return null;
  return {
    start: variableBoundaryPoint(source, target),
    end: variableBoundaryPoint(target, source),
  };
}

export function straightPath(start: Point, end: Point): string {
  return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
}

export function squigglyPath(start: Point, end: Point, amplitude = 5, wavelength = 18): string {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return straightPath(start, end);
  const ux = dx / length;
  const uy = dy / length;
  const nx = -uy;
  const ny = ux;
  const steps = Math.max(8, Math.ceil(length / 6));
  const points = Array.from({ length: steps + 1 }, (_, index) => {
    const distance = (length * index) / steps;
    const envelope = Math.sin((Math.PI * distance) / length);
    const offset = Math.sin((distance / wavelength) * Math.PI * 2) * amplitude * envelope;
    return {
      x: start.x + ux * distance + nx * offset,
      y: start.y + uy * distance + ny * offset,
    };
  });
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

export function elementBounds(element: DiagramElement): Bounds | null {
  if (element.type === "edge") return null;
  if (element.type === "variable") {
    return { x: element.x - element.size / 2, y: element.y - element.size / 2, width: element.size, height: element.size };
  }
  if (element.type === "plate") return { x: element.x, y: element.y, width: element.width, height: element.height };
  const width = Math.max(34, element.text.replace(/\\./g, "x").length * 9.5);
  return { x: element.x - width / 2, y: element.y - 16, width, height: 32 };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

export function contentBounds(document: DocumentV1, padding = 24): Bounds {
  const bounds = document.elements.map(elementBounds).filter((item): item is Bounds => Boolean(item));
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

