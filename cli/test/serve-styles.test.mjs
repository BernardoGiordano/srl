import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { serveApplication } from '../dev/serve.mjs';
import { inlineTailwindSource } from '../dev/tailwind-source.mjs';

/**
 * One stylesheet for both compilers. The build compiles `src/app.css` with the
 * Tailwind CLI, and the development server hands the same file to the browser
 * compiler through an empty, named input block. ADR-0137.
 */

const INDEX = `<!doctype html>
<html>
  <head>
    <style type="text/tailwindcss" data-source="src/app.css"></style>
  </head>
  <body><app-root></app-root></body>
</html>
`;

const APP_CSS = `@import '../../node_modules/@srljs/core/components/style.css';
@import 'tailwindcss' source(none);
@import './theme.css';

@source '../src/**/*.js';
@source not '../src/legacy';
@source inline("underline");

body { color: var(--color-ink); }
`;

const THEME_CSS = `@theme { --color-ink: #111; }
@custom-variant dark (&:where(.dark, .dark *));
`;

/**
 * @param {(dir: string) => Promise<void>} run
 */
async function inApplication(run) {
  const dir = await mkdtemp(join(tmpdir(), 'srl-styles-'));
  try {
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'index.html'), INDEX);
    await writeFile(join(dir, 'src', 'app.css'), APP_CSS);
    await writeFile(join(dir, 'src', 'theme.css'), THEME_CSS);
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test('fills a named Tailwind block with the stylesheet the build compiles', async () => {
  await inApplication(async (dir) => {
    const html = await inlineTailwindSource(INDEX, dir);
    assert.ok(html !== null);
    const block = /<style type="text\/tailwindcss" data-source="src\/app.css">([\s\S]*?)<\/style>/u.exec(html)?.[1] ?? '';

    assert.doesNotMatch(block, /@import/u, 'the compiler adds tailwindcss to an input with no import');
    assert.match(block, /--color-ink: #111/u, 'a relative import inside the application is inlined');
    assert.match(block, /@custom-variant dark/u);
    assert.match(block, /body \{ color: var\(--color-ink\); \}/u);
    assert.match(block, /@source inline\("underline"\);/u, 'an inline source adds classes and stays');
    assert.doesNotMatch(block, /@source '/u, 'path sources are dropped, because the page is scanned');
    assert.doesNotMatch(block, /@import '\.\.\/\.\.\/node_modules/u, 'an import outside the application is dropped');
  });
});

void test('leaves a document with no named block alone', async () => {
  await inApplication(async (dir) => {
    assert.equal(await inlineTailwindSource('<style type="text/tailwindcss">@theme {}</style>', dir), null);
    assert.equal(await inlineTailwindSource('<p>no styles</p>', dir), null);
  });
});

void test('refuses a stylesheet outside the application, and stops at an import cycle', async () => {
  await inApplication(async (dir) => {
    await assert.rejects(
      inlineTailwindSource('<style type="text/tailwindcss" data-source="../escape.css"></style>', dir),
      /outside the application/u,
    );

    await writeFile(join(dir, 'src', 'theme.css'), `@import './app.css';\n${THEME_CSS}`);
    const html = (await inlineTailwindSource(INDEX, dir)) ?? '';
    assert.match(html, /already inlined above/u);
  });
});

void test('the development server sends the filled block for the entry and the fallback', async () => {
  await inApplication(async (dir) => {
    const server = await serveApplication({
      app: { name: 'styles', dir },
      port: 0,
      host: '127.0.0.1',
      watch: false,
    });
    try {
      for (const path of ['/', '/deep/link']) {
        const response = await fetch(new URL(path, server.url), { headers: { accept: 'text/html' } });
        assert.equal(response.status, 200, path);
        const body = await response.text();
        assert.match(body, /--color-ink: #111/u, path);
      }
    } finally {
      await server.close();
    }
  });
});
