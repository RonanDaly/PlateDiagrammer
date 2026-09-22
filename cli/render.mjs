#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { parseArgs } from 'node:util';
import { readFile, writeFile, access } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDocument } from '../app/editor-model.ts';

export const help = `Usage: npm run render -- <diagram.json> --output <image.svg|image.png> [--scale 2] [--force]

  --output, -o  Destination SVG or PNG file (required)
  --scale       Positive PNG scale (default: 2; PNG only)
  --force       Replace an existing output file
  --help, -h    Show this help

Setup: npm install && npx playwright install chromium
`;

export function parseOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    output: { type: 'string', short: 'o' }, scale: { type: 'string' },
    force: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return { help: true };
  if (positionals.length !== 1 || !values.output) throw new Error('Provide one JSON input file and --output. Use --help for usage.');
  const format = extname(values.output).slice(1).toLowerCase();
  if (!['svg', 'png'].includes(format)) throw new Error('Output extension must be .svg or .png.');
  if (format === 'svg' && values.scale !== undefined) throw new Error('--scale is only supported for PNG.');
  const scale = values.scale === undefined ? 2 : Number(values.scale);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('--scale must be a positive finite number.');
  const input = resolve(positionals[0]);
  const output = resolve(values.output);
  if (input === output) throw new Error('Input and output must be different files.');
  return { input, output, format, scale, force: values.force };
}

export async function loadDocument(input) {
  let value;
  try { value = JSON.parse(await readFile(input, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Input is not valid JSON.');
    throw error;
  }
  const validated = validateDocument(value);
  if (!validated.ok) throw new Error(validated.error);
  return validated.document;
}

export async function ensureOutputAvailable(output, force) {
  if (force) return;
  try { await access(output); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Output already exists; use --force to overwrite it.');
}

// Exported for integration tests; production commands always use the 60-second deadline.
export async function renderDocument(diagram, { format, scale = 2 }, { timeout = 60000, signal } = {}) {
  let server;
  let browser;
  let httpServer;
  let stopped = false;
  let timer;
  let onAbort;
  const close = async () => {
    httpServer?.closeAllConnections();
    await Promise.allSettled([browser?.close(), server?.close(),
      httpServer && new Promise((resolve) => httpServer.close(resolve)),
    ]);
  };
  const cancelled = new Promise((_, reject) => {
    const stop = (message) => { stopped = true; reject(new Error(message)); };
    timer = setTimeout(() => stop(`Rendering timed out after ${timeout / 1000} seconds.`), timeout);
    onAbort = () => stop('Rendering interrupted.');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  const work = async () => {
    const [{ createServer }, { chromium }, { default: config }, { prepareMathJax }] = await Promise.all([
      import('vite'), import('playwright'), import('./vite.config.mjs'), import('../scripts/prepare-mathjax.mjs'),
    ]);
    if (stopped) return;
    await prepareMathJax();
    if (stopped) return;
    httpServer = createHttpServer();
    server = await createServer({ ...config, server: { ...config.server, hmr: { server: httpServer } } });
    if (stopped) { await close(); return; }
    httpServer.on("request", server.middlewares);
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    if (stopped) { await close(); return; }
    const address = httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { throw new Error(`Could not launch Chromium. Run "npx playwright install chromium". ${error.message}`); }
    if (stopped) { await close(); return; }
    const page = await browser.newPage();
    // All renderer requests must stay local, including MathJax's dynamic assets.
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      return route.abort('blockedbyclient');
    });
    await page.goto(origin);
    await page.waitForFunction(() => typeof window.renderDiagram === 'function');
    return await page.evaluate(({ diagram, format, scale }) => window.renderDiagram(diagram, format, scale), { diagram, format, scale });
  };
  try {
    const result = await Promise.race([cancelled, work()]);
    return format === 'svg' ? Buffer.from(result, 'utf8') : Buffer.from(result, 'base64');
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await close();
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { console.log(help); return; }
  const diagram = await loadDocument(options.input);
  await ensureOutputAvailable(options.output, options.force);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const bytes = await renderDocument(diagram, options, { signal: controller.signal });
    if (controller.signal.aborted) throw new Error('Rendering interrupted.');
    await writeFile(options.output, bytes, { flag: options.force ? 'w' : 'wx' });
    console.log(`Wrote ${options.output}`);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`plate-diagram: ${error.message}`); process.exitCode = 1; });
}
