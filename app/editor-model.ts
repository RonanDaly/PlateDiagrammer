export const CANVAS_WIDTH = 1200;
export const CANVAS_HEIGHT = 800;
export const GRID_SIZE = 20;

export type VariableKind = "random" | "deterministic";
export type LineStyle = "straight" | "squiggly";
export type HeadStyle = "arrow" | "bar";

export interface CanvasSettings {
  width: number;
  height: number;
  background: string;
  gridSize: number;
  snapToGrid: boolean;
}

export interface VariableNode {
  id: string;
  type: "variable";
  variableKind: VariableKind;
  x: number;
  y: number;
  size: number;
  observed: boolean;
  label: string;
}

export interface TextNode {
  id: string;
  type: "text";
  x: number;
  y: number;
  text: string;
}

export interface Plate {
  id: string;
  type: "plate";
  x: number;
  y: number;
  width: number;
  height: number;
  cornerRadius: number;
}

export interface Edge {
  id: string;
  type: "edge";
  sourceId: string;
  targetId: string;
  lineStyle: LineStyle;
  headStyle: HeadStyle;
}

export type PositionedElement = VariableNode | TextNode | Plate;
export type DiagramElement = PositionedElement | Edge;

export interface DiagramGroup {
  id: string;
  memberIds: string[];
}

export interface DocumentV1 {
  version: 1;
  canvas: CanvasSettings;
  elements: DiagramElement[];
  groups: DiagramGroup[];
}

export type DocumentAction =
  | { type: "replace"; document: DocumentV1 }
  | { type: "add"; element: DiagramElement }
  | { type: "update"; id: string; patch: Partial<DiagramElement> }
  | { type: "setPositions"; positions: Record<string, { x: number; y: number }> }
  | { type: "delete"; ids: string[] }
  | { type: "group"; id: string; memberIds: string[] }
  | { type: "ungroup"; groupIds: string[] }
  | { type: "setSnap"; value: boolean };

export function uid(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function emptyDocument(): DocumentV1 {
  return {
    version: 1,
    canvas: {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      background: "#ffffff",
      gridSize: GRID_SIZE,
      snapToGrid: true,
    },
    elements: [],
    groups: [],
  };
}

export function sampleDocument(): DocumentV1 {
  return {
    ...emptyDocument(),
    elements: [
      {
        id: "plate-sample",
        type: "plate",
        x: 320,
        y: 200,
        width: 520,
        height: 340,
        cornerRadius: 10,
      },
      {
        id: "node-theta",
        type: "variable",
        variableKind: "random",
        x: 480,
        y: 360,
        size: 56,
        observed: false,
        label: "$\\theta$",
      },
      {
        id: "node-x",
        type: "variable",
        variableKind: "random",
        x: 720,
        y: 360,
        size: 56,
        observed: true,
        label: "$x_n$",
      },
      {
        id: "edge-sample",
        type: "edge",
        sourceId: "node-theta",
        targetId: "node-x",
        lineStyle: "straight",
        headStyle: "arrow",
      },
      {
        id: "text-sample",
        type: "text",
        x: 760,
        y: 500,
        text: "$n = 1, \\ldots, N$",
      },
    ],
    groups: [],
  };
}

export function isPositioned(element: DiagramElement): element is PositionedElement {
  return element.type !== "edge";
}

export function documentReducer(document: DocumentV1, action: DocumentAction): DocumentV1 {
  switch (action.type) {
    case "replace":
      return action.document;
    case "add":
      return { ...document, elements: [...document.elements, action.element] };
    case "update":
      return {
        ...document,
        elements: document.elements.map((element) =>
          element.id === action.id ? ({ ...element, ...action.patch } as DiagramElement) : element,
        ),
      };
    case "setPositions":
      return {
        ...document,
        elements: document.elements.map((element) => {
          const next = action.positions[element.id];
          return next && isPositioned(element) ? { ...element, ...next } : element;
        }),
      };
    case "delete": {
      const deletion = new Set(action.ids);
      const selectedGroups = document.groups.filter((group) =>
        group.memberIds.some((id) => deletion.has(id)),
      );
      for (const group of selectedGroups) {
        if (group.memberIds.every((id) => deletion.has(id))) {
          group.memberIds.forEach((id) => deletion.add(id));
        }
      }
      const removedVariableIds = new Set(
        document.elements
          .filter((element) => deletion.has(element.id) && element.type === "variable")
          .map((element) => element.id),
      );
      const elements = document.elements.filter((element) => {
        if (deletion.has(element.id)) return false;
        return !(
          element.type === "edge" &&
          (removedVariableIds.has(element.sourceId) || removedVariableIds.has(element.targetId))
        );
      });
      return {
        ...document,
        elements,
        groups: document.groups
          .map((group) => ({
            ...group,
            memberIds: group.memberIds.filter((id) => !deletion.has(id)),
          }))
          .filter((group) => group.memberIds.length > 1),
      };
    }
    case "group": {
      const members = [...new Set(action.memberIds)].filter((id) =>
        document.elements.some((element) => element.id === id && element.type !== "edge"),
      );
      if (members.length < 2) return document;
      const memberSet = new Set(members);
      return {
        ...document,
        groups: [
          ...document.groups
            .map((group) => ({
              ...group,
              memberIds: group.memberIds.filter((id) => !memberSet.has(id)),
            }))
            .filter((group) => group.memberIds.length > 1),
          { id: action.id, memberIds: members },
        ],
      };
    }
    case "ungroup": {
      const ids = new Set(action.groupIds);
      return { ...document, groups: document.groups.filter((group) => !ids.has(group.id)) };
    }
    case "setSnap":
      return { ...document, canvas: { ...document.canvas, snapToGrid: action.value } };
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasBase(value: unknown): value is Record<string, unknown> & { id: string; type: string } {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.type === "string";
}

export function validateDocument(value: unknown): { ok: true; document: DocumentV1 } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "The file is not a diagram document." };
  const root = value as Record<string, unknown>;
  if (root.version !== 1) return { ok: false, error: "Only plate diagram format version 1 is supported." };
  if (!root.canvas || typeof root.canvas !== "object") return { ok: false, error: "Canvas settings are missing." };
  const canvas = root.canvas as Record<string, unknown>;
  if (
    !finiteNumber(canvas.width) ||
    !finiteNumber(canvas.height) ||
    !finiteNumber(canvas.gridSize) ||
    typeof canvas.background !== "string" ||
    typeof canvas.snapToGrid !== "boolean"
  ) {
    return { ok: false, error: "Canvas settings are invalid." };
  }
  if (!Array.isArray(root.elements) || !Array.isArray(root.groups)) {
    return { ok: false, error: "Elements or groups are missing." };
  }

  const ids = new Set<string>();
  const variableIds = new Set<string>();
  for (const raw of root.elements) {
    if (!hasBase(raw) || ids.has(raw.id)) return { ok: false, error: "Every element needs a unique ID." };
    ids.add(raw.id);
    const item = raw as Record<string, unknown>;
    if (item.type === "variable") {
      if (
        !["random", "deterministic"].includes(String(item.variableKind)) ||
        !finiteNumber(item.x) || !finiteNumber(item.y) || !finiteNumber(item.size) ||
        typeof item.observed !== "boolean" || typeof item.label !== "string"
      ) return { ok: false, error: `Variable ${item.id} is invalid.` };
      variableIds.add(item.id as string);
    } else if (item.type === "text") {
      if (!finiteNumber(item.x) || !finiteNumber(item.y) || typeof item.text !== "string")
        return { ok: false, error: `Text element ${item.id} is invalid.` };
    } else if (item.type === "plate") {
      if (
        !finiteNumber(item.x) || !finiteNumber(item.y) || !finiteNumber(item.width) ||
        !finiteNumber(item.height) || !finiteNumber(item.cornerRadius)
      ) return { ok: false, error: `Plate ${item.id} is invalid.` };
    } else if (item.type === "edge") {
      if (
        typeof item.sourceId !== "string" || typeof item.targetId !== "string" ||
        item.sourceId === item.targetId || !["straight", "squiggly"].includes(String(item.lineStyle)) ||
        !["arrow", "bar"].includes(String(item.headStyle))
      ) return { ok: false, error: `Connection ${item.id} is invalid.` };
    } else {
      return { ok: false, error: `Unknown element type: ${String(item.type)}.` };
    }
  }

  for (const raw of root.elements as Array<Record<string, unknown>>) {
    if (raw.type === "edge" && (!variableIds.has(String(raw.sourceId)) || !variableIds.has(String(raw.targetId)))) {
      return { ok: false, error: `Connection ${String(raw.id)} refers to a missing variable.` };
    }
  }

  const grouped = new Set<string>();
  for (const raw of root.groups) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "A group is invalid." };
    const group = raw as Record<string, unknown>;
    if (typeof group.id !== "string" || !Array.isArray(group.memberIds) || group.memberIds.length < 2) {
      return { ok: false, error: "Groups need an ID and at least two members." };
    }
    for (const member of group.memberIds) {
      if (typeof member !== "string" || !ids.has(member) || grouped.has(member)) {
        return { ok: false, error: "Group members must exist and can belong to only one group." };
      }
      const element = (root.elements as Array<Record<string, unknown>>).find((entry) => entry.id === member);
      if (element?.type === "edge") return { ok: false, error: "Connections cannot be grouped." };
      grouped.add(member);
    }
  }

  return { ok: true, document: value as DocumentV1 };
}

export function validateLabel(source: string): string | null {
  let inMath = false;
  let escaped = false;
  for (const char of source) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "$") inMath = !inMath;
  }
  if (inMath) return "Add a closing $ to finish the math expression.";
  if (/\\(?:href|url|style|class|cssId|require|htmlId|htmlClass)\b/.test(source)) {
    return "That TeX command is not available in safe labels.";
  }
  return null;
}

export function labelToTex(source: string): string {
  const segments: Array<{ math: boolean; value: string }> = [];
  let current = "";
  let inMath = false;
  let escaped = false;
  for (const char of source) {
    if (escaped) {
      current += char === "$" ? "$" : `\\${char}`;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "$") {
      if (current) segments.push({ math: inMath, value: current });
      current = "";
      inMath = !inMath;
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (current) segments.push({ math: inMath, value: current });
  return segments
    .map((segment) => {
      if (segment.math) return segment.value;
      const text = segment.value
        .replace(/\\/g, "\\textbackslash ")
        .replace(/([{}%#&_])/g, "\\$1")
        .replace(/\^/g, "\\textasciicircum ")
        .replace(/~/g, "\\textasciitilde ");
      return `\\text{${text}}`;
    })
    .join("\\,");
}
