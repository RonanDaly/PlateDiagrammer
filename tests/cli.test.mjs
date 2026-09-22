import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseOptions, loadDocument, ensureOutputAvailable, renderDocument } from '../cli/render.mjs';
import { sampleDocument, emptyDocument, validateDocument } from '../app/editor-model.ts';
import { contentBounds } from '../app/editor-geometry.ts';

const exec = promisify(execFile);

test('CLI options enforce formats, scale, and required arguments', () => {
  assert.equal(parseOptions(['--help']).help, true);
  assert.equal(parseOptions(['in.json', '-o', 'out.png']).scale, 2);
  assert.equal(parseOptions(['in.json', '-o', 'out.png', '--scale', '0.5']).scale, 0.5);
  for (const args of [[], ['in.json'], ['in.json', '-o', 'out.jpg'],
    ['in.json', '-o', 'out.svg', '--scale', '2'],
    ...['0', '-1', 'NaN', 'Infinity', ''].map((scale) => ['in.json', '-o', 'out.png', '--scale', scale]),
    ['in.json', 'extra.json', '-o', 'out.svg'], ['--unknown'],
  ]) assert.throws(() => parseOptions(args));
});

test('input validation and overwrite protection fail before browser launch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plate-cli-'));
  try {
    const input = join(dir, 'input.json');
    const output = join(dir, 'output.svg');
    await writeFile(input, '{');
    await assert.rejects(loadDocument(input), /valid JSON/);
    await writeFile(input, JSON.stringify({ version: 9 }));
    await assert.rejects(loadDocument(input), /version 1/);
    await writeFile(input, JSON.stringify(sampleDocument()));
    assert.deepEqual(await loadDocument(input), sampleDocument());
    await ensureOutputAvailable(output, false);
    await writeFile(output, 'keep');
    await assert.rejects(ensureOutputAvailable(output, false), /--force/);
    await ensureOutputAvailable(output, true);
    await assert.rejects(exec(process.execPath, ['--experimental-strip-types', 'cli/render.mjs', input, '-o', output]), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--force/);
      return true;
    });
    assert.equal(await readFile(output, 'utf8'), 'keep');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function fixture() {
  const diagram = sampleDocument();
  diagram.elements[0].strokeStyle = 'dashed';
  diagram.elements.push({ ...diagram.elements[0], id: 'square-plate', x: 100, y: 550, width: 650, height: 120, cornerRadius: 0, strokeStyle: 'solid', label: 'replicates' });
  for (const [i, variableKind] of ['deterministic', 'double', 'diamond', 'factor', 'small-circle'].entries()) {
    diagram.elements.push({ ...diagram.elements[1], id: `kind-${i}`, variableKind, x: 200 + 140 * i, y: 600, label: i < 3 ? '$\\alpha_i$' : 'hidden label' });
  }
  diagram.elements.push({ id: 'text', type: 'text', x: 550, y: 130, text: 'Model $\\mathbb{R} \\xrightarrow{a} \\mathscr{F}$' });
  for (const [i, headStyle] of ['bar', 'none'].entries()) {
    diagram.elements.push({ ...diagram.elements[3], id: `edge-${i}`, sourceId: `kind-${i}`, targetId: `kind-${i + 1}`, headStyle, lineStyle: 'squiggly', strokeStyle: 'dashed', label: '$p$' });
  }
  assert.equal(validateDocument(diagram).ok, true);
  return diagram;
}

test('offline SVG covers shapes, dynamic math assets, cropping, and empty documents', { timeout: 90000 }, async () => {
  const diagram = fixture();
  const svg = (await renderDocument(diagram, { format: 'svg' })).toString();
  const bounds = contentBounds(diagram, 24);
  assert.ok(svg.includes(`viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}"`));
  assert.match(svg, /data-math-rendered="true"/);
  assert.match(svg, /data-mml-node="math"/);
  assert.match(svg, /<polygon/);
  assert.match(svg, /stroke-dasharray="8 6"/);
  assert.doesNotMatch(svg, /data-editor-ui|data-element-id|data-math-pending|data-math-error|stroke="transparent"/);
  assert.doesNotMatch(svg, /(?:href|src)="https?:/);
  const blank = (await renderDocument(emptyDocument(), { format: 'svg' })).toString();
  assert.match(blank, /fill="#ffffff"/);
  assert.doesNotMatch(blank, /data-math-pending/);
});

test('PNG has expected dimensions at default and custom scales', { timeout: 90000 }, async () => {
  const diagram = sampleDocument();
  const bounds = contentBounds(diagram, 24);
  for (const scale of [2, 0.5]) {
    const png = await renderDocument(diagram, { format: 'png', scale });
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), Math.ceil(bounds.width * scale));
    assert.equal(png.readUInt32BE(20), Math.ceil(bounds.height * scale));
  }
});

test('math failure, deadline, and interruption clean up and allow subsequent rendering', { timeout: 90000 }, async () => {
  const invalid = sampleDocument();
  invalid.elements[1].label = '$\\notARealCommand$';
  await assert.rejects(renderDocument(invalid, { format: 'svg' }), /Invalid math label/);
  await assert.rejects(renderDocument(sampleDocument(), { format: 'svg' }, { timeout: 1 }), /timed out/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderDocument(sampleDocument(), { format: 'svg' }, { signal: controller.signal }), /interrupted/);
  assert.match((await renderDocument(emptyDocument(), { format: 'svg' })).toString(), /<svg/);
});

test('CLI artwork matches the editor SVG and PNG downloads', { timeout: 90000 }, async () => {
  const [{ createServer }, { createServer: http }, { chromium }, { default: config }, { fileURLToPath }] = await Promise.all([
    import('vite'), import('node:http'), import('playwright'), import('../cli/vite.config.mjs'), import('node:url'),
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'plate-parity-'));
  const httpServer = http();
  let server;
  let browser;
  try {
    server = await createServer({ ...config, root: fileURLToPath(new URL('..', import.meta.url)),
      server: { ...config.server, hmr: { server: httpServer } },
    });
    httpServer.on('request', server.middlewares);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch();
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${httpServer.address().port}`;
    await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/tests/browser/editor.html`);
    for (const format of ['svg', 'png']) {
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: format === 'svg' ? 'Export SVG' : 'PNG', exact: true }).click();
      const download = await downloadPromise;
      const path = join(dir, `editor.${format}`);
      await download.saveAs(path);
      const editor = await readFile(path);
      const cli = await renderDocument(sampleDocument(), { format });
      if (format === 'png') assert.deepEqual(cli, editor);
      else {
        // React and MathJax allocate IDs independently in each page.
        const normalize = (bytes) => bytes.toString().replace(/ id="diagram-canvas"/g, '').replace(/MJX-\d+/g, 'MJX-ID');
        const canonical = (source) => page.evaluate((source) => {
          const tree = new DOMParser().parseFromString(source, 'image/svg+xml');
          function visit(node) {
            if (node.nodeType === 3) return node.textContent;
            return [node.nodeName, [...(node.attributes ?? [])].map((a) => [a.name, a.value]).sort((a, b) => a[0].localeCompare(b[0])), [...node.childNodes].map(visit)];
          }
          return JSON.stringify(visit(tree.documentElement));
        }, source);
        const actual = await canonical(normalize(cli));
        const expected = await canonical(normalize(editor));
        const firstDifference = [...actual].findIndex((char, i) => char !== expected[i]);
        assert.ok(actual === expected, `SVG differs near ${firstDifference}: ${actual.slice(firstDifference, firstDifference + 120)} vs ${expected.slice(firstDifference, firstDifference + 120)}`);
      }
    }
  } finally {
    await browser?.close();
    httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
