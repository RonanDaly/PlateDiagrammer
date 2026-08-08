import assert from "node:assert/strict";
import test from "node:test";
import {
  documentReducer,
  emptyDocument,
  labelToTex,
  sampleDocument,
  validateDocument,
  validateLabel,
} from "../app/editor-model.ts";
import {
  edgeEndpoints,
  resizePlate,
  snap,
  squigglyPath,
  variableBoundaryPoint,
} from "../app/editor-geometry.ts";

test("snaps values and plate resize handles to the grid", () => {
  assert.equal(snap(29, 20), 20);
  assert.equal(snap(31, 20), 40);
  const resized = resizePlate(
    { id: "p", type: "plate", x: 20, y: 20, width: 100, height: 80, cornerRadius: 10 },
    "se",
    13,
    17,
    true,
    20,
  );
  assert.deepEqual(resized, { x: 20, y: 20, width: 120, height: 100 });
});

test("finds circle and square boundary intersections", () => {
  const circle = { id: "a", type: "variable", variableKind: "random", x: 100, y: 100, size: 40, observed: false, label: "$a$" };
  const square = { ...circle, id: "b", variableKind: "deterministic" };
  assert.deepEqual(variableBoundaryPoint(circle, { x: 200, y: 100 }), { x: 120, y: 100 });
  assert.deepEqual(variableBoundaryPoint(square, { x: 200, y: 200 }), { x: 120, y: 120 });
});

test("computes attached edge endpoints and a non-linear squiggly path", () => {
  const document = sampleDocument();
  const edge = document.elements.find((item) => item.type === "edge");
  const endpoints = edgeEndpoints(edge, document);
  assert.ok(endpoints);
  assert.ok(endpoints.start.x < endpoints.end.x);
  const path = squigglyPath(endpoints.start, endpoints.end);
  assert.match(path, /^M /);
  assert.ok(path.split("L").length > 8);
  assert.notEqual(path, `M ${endpoints.start.x} ${endpoints.start.y} L ${endpoints.end.x} ${endpoints.end.y}`);
});

test("deleting a variable cascades to incident connections", () => {
  const document = sampleDocument();
  const next = documentReducer(document, { type: "delete", ids: ["node-theta"] });
  assert.equal(next.elements.some((item) => item.id === "node-theta"), false);
  assert.equal(next.elements.some((item) => item.id === "edge-sample"), false);
  assert.equal(next.elements.some((item) => item.id === "node-x"), true);
});

test("flat groups preserve relative spacing when positions are updated", () => {
  let document = sampleDocument();
  document = documentReducer(document, { type: "group", id: "g1", memberIds: ["node-theta", "node-x"] });
  assert.deepEqual(document.groups[0].memberIds, ["node-theta", "node-x"]);
  document = documentReducer(document, {
    type: "setPositions",
    positions: { "node-theta": { x: 490, y: 390 }, "node-x": { x: 720, y: 390 } },
  });
  const theta = document.elements.find((item) => item.id === "node-theta");
  const x = document.elements.find((item) => item.id === "node-x");
  assert.equal(x.x - theta.x, 230);
  const ungrouped = documentReducer(document, { type: "ungroup", groupIds: ["g1"] });
  assert.equal(ungrouped.groups.length, 0);
});

test("validates safe mixed labels and converts them to TeX", () => {
  assert.equal(validateLabel("Mean $\\boldsymbol{\\theta}_n$"), null);
  assert.match(labelToTex("Mean $\\alpha_n$"), /\\text\{Mean \}/);
  assert.match(labelToTex("Mean $\\alpha_n$"), /\\alpha_n/);
  assert.match(validateLabel("$x_n"), /closing/);
  assert.match(validateLabel("$\\href{javascript:x}{x}$"), /not available/);
});

test("accepts valid version-one documents and rejects malformed graphs", () => {
  assert.equal(validateDocument(sampleDocument()).ok, true);
  assert.equal(validateDocument({ ...emptyDocument(), version: 2 }).ok, false);
  const broken = sampleDocument();
  broken.elements = broken.elements.filter((item) => item.id !== "node-x");
  const validation = validateDocument(broken);
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.match(validation.error, /missing variable/);
});
