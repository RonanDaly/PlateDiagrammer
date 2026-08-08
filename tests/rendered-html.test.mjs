import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Plate Studio editor shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Plate Studio — Statistical diagram editor<\/title>/i);
  assert.match(html, /Plate Studio/);
  assert.match(html, /Statistical diagram editor/);
  assert.match(html, /Circle node/);
  assert.match(html, /Square node/);
  assert.match(html, /Double circle node/);
  assert.match(html, /Diamond node/);
  assert.match(html, /Factor node/);
  assert.doesNotMatch(html, /Random variable|Non-random variable|Rounded container/);
  assert.match(html, /Save JSON/);
  assert.match(html, /Editable statistical plate diagram/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});
