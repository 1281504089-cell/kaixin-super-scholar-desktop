const assert = require('node:assert/strict');
const {mkdirSync} = require('node:fs');
const {join} = require('node:path');

// Uses an existing browser/Electron Page; it never starts an app or calls a model.
async function verifyScience(page, {origin, seed, screenshotsDir, viewports = [[390,844],[844,390],[1366,900],[1920,1080]]}) {
  const views = [], errors = [];
  const onError = error => errors.push(String(error));
  page.on('pageerror', onError);
  mkdirSync(screenshotsDir, {recursive: true});
  async function open(path, selector, expected, name) {
    await page.goto(origin + path, {waitUntil: 'domcontentloaded', timeout: 120000});
    await page.waitForFunction(({selector, count}) => document.querySelectorAll(selector + ' .katex').length >= count,
      {selector, count: expected.length}, {timeout: 120000});
    const annotations = await page.locator(selector + ' annotation[encoding="application/x-tex"]').allTextContents();
    for (const formula of expected) assert(annotations.includes(formula), name + ' missing original formula ' + formula);
    assert.equal(await page.locator(selector + ' .katex-error').count(), 0, name);
  }
  async function snapshots(selector, name) {
    for (const [width, height] of viewports) {
      await page.setViewportSize({width, height});
      await page.waitForTimeout(200);
      const result = await page.evaluate(selector => ({
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        formulas: document.querySelectorAll(selector + ' .katex').length,
        rawCommands: [...document.querySelectorAll(selector + ' .katex-html')].some(node => /\\(?:ce|pu|vec|frac)/.test(node.textContent)),
        chemistryArrows: [...document.querySelectorAll(selector + ' math mo')].map(node => node.textContent).filter(text => ['⇌','→','↓','↑'].includes(text))
      }), selector);
      assert(!result.horizontalOverflow, name + ' horizontal overflow');
      assert(!result.rawCommands, name + ' raw commands');
      if (name !== 'mistakes-physics') for (const arrow of ['⇌','→','↓','↑']) assert(result.chemistryArrows.includes(arrow), name + ' missing ' + arrow);
      await page.screenshot({path: join(screenshotsDir, `${name}-${width}x${height}.png`)});
      views.push({surface: name, width, height, ...result});
    }
  }
  try {
    await open('/chat/' + seed.session + '?dt_workspace=', '.md-renderer', seed.cases.map(row => row[1]), 'chat');
    await snapshots('.md-renderer', 'chat');
    await open('/co-writer/' + seed.note + '?dt_workspace=', '.bn-editor', seed.cases.map(row => row[1]), 'notes');
    await snapshots('.bn-editor', 'notes');
    await page.locator('.dt-note-inline-math button').first().click();
    const input = page.locator('.dt-note-inline-math input').first();
    await input.waitFor();
    assert.equal(await input.inputValue(), seed.cases[0][1]);
    await input.press('Tab');
    await open('/co-writer/' + seed.saved_note + '?dt_workspace=', '.bn-editor', seed.saved_cases.map(row => row[1]), 'saved-notes');
    await page.screenshot({path: join(screenshotsDir, 'saved-notes.png')});
    for (const subject of ['chemistry', 'physics']) {
      const expected = seed.cases.filter(row => row[0].startsWith(subject)).map(row => row[1]);
      await open('/mistakes?record=' + seed.mistakes[subject] + '&dt_workspace=', 'article', expected, 'mistakes-' + subject);
      await snapshots('article', 'mistakes-' + subject);
      await page.getByRole('button', {name: '补充与分类'}).click();
      const raw = await page.getByRole('textbox', {name: '题目或片段'}).inputValue();
      for (const formula of expected) assert(raw.includes(formula));
      await page.getByRole('button', {name: '取消', exact: true}).click();
    }
    assert.equal(errors.length, 0, JSON.stringify(errors));
    return {passed: true, actualApplicationPages: true, cases: seed.cases, views,
      savedInlineFormulas: true, noteAndMistakeSourceEditPreserved: true,
      consoleErrors: errors, realStudentData: false, paidModelCalls: 0};
  } finally {
    page.off('pageerror', onError);
  }
}
async function verifyScienceNative(view, evidenceDir, seed) {
  const {writeFileSync} = require('node:fs');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (fn, ...args) => view.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const origin = new URL(view.getURL()).origin;
  const originalViewport = await js(() => ({width: innerWidth, height: innerHeight}));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Use an isolated local QA application');
  assert.equal(seed.cases.length, 12, 'Missing science fixture');
  const debuggerHandle = view.debugger;
  assert(!debuggerHandle.isAttached(), 'Use a QA WebContents without another debugger client');
  let attached = false;
  let result;
  const views = [], edits = [];
  mkdirSync(evidenceDir, {recursive: true});
  writeFileSync(join(evidenceDir, 'native-science.json'), JSON.stringify({passed: false, status: 'running'}) + '\n');
  async function wait(fn, args, label, timeout = 90000) {
    const deadline = Date.now() + timeout;
    while (!await js(fn, ...args)) {
      assert(Date.now() < deadline, label);
      await pause(150);
    }
  }
  async function open(path, selector, expected, name) {
    await view.loadURL(new URL(path, origin).href);
    await wait((selector, count) => document.querySelectorAll(selector + ' .katex').length >= count,
      [selector, expected.length], name + ' formulas did not render');
    const annotations = await js(selector => [...document.querySelectorAll(selector + ' annotation[encoding="application/x-tex"]')].map(node => node.textContent), selector);
    for (const formula of expected) assert(annotations.includes(formula), name + ' missing original formula ' + formula);
    assert.equal(await js(selector => document.querySelectorAll(selector + ' .katex-error').length, selector), 0, name);
  }
  async function resize(width, height) {
    await debuggerHandle.sendCommand('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
    await wait((width, height) => innerWidth === width && innerHeight === height, [width, height],
      'Renderer viewport did not match ' + width + 'x' + height, 5000);
    return js(() => ({width: innerWidth, height: innerHeight}));
  }
  async function snapshot(selector, name, width, height) {
    const actual = await resize(width, height);
    await wait(() => document.fonts.status === 'loaded', [], 'Formula fonts did not load', 10000);
    const result = await js(selector => ({
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      formulas: document.querySelectorAll(selector + ' .katex').length,
      errors: document.querySelectorAll(selector + ' .katex-error').length,
      rawCommands: [...document.querySelectorAll(selector + ' .katex-html')].some(node => /\\(?:ce|pu|vec|frac)/.test(node.textContent)),
      chemistryArrows: [...document.querySelectorAll(selector + ' math mo')].map(node => node.textContent).filter(text => ['⇌','→','↓','↑'].includes(text)),
      chargeSuperscript: [...document.querySelectorAll(selector + ' math msup')].some(node => node.textContent.includes('3+'))
    }), selector);
    assert(!result.horizontalOverflow, name + ' horizontal overflow');
    assert(!result.rawCommands && result.errors === 0, name + ' raw command or KaTeX error');
    if (name !== 'mistakes-physics') {
      for (const arrow of ['⇌','→','↓','↑']) assert(result.chemistryArrows.includes(arrow), name + ' missing ' + arrow);
      assert(result.chargeSuperscript, name + ' charge lost its superscript');
    }
    const png = (await view.capturePage()).toPNG();
    assert(png.length > 8, 'Empty native screenshot');
    writeFileSync(join(evidenceDir, `native-science-${name}-${width}x${height}.png`), png);
    views.push({surface: name, target: {width, height}, actual, ...result});
  }
  async function snapshots(selector, name) {
    for (const [width, height] of [[390,844],[844,390],[1366,900],[1920,1080]]) await snapshot(selector, name, width, height);
  }
  async function checkNoteEdits(formulas, name) {
    for (const formula of formulas) {
      await js(formula => {
        const item = [...document.querySelectorAll('.dt-note-inline-math')].find(node => node.querySelector('annotation')?.textContent === formula);
        if (!item?.querySelector('button')) throw new Error('Missing editable original: ' + formula);
        item.querySelector('button').click();
      }, formula);
      await wait(() => Boolean(document.querySelector('.dt-note-inline-math input')), [], 'Note formula editor did not open', 5000);
      const original = await js(() => document.querySelector('.dt-note-inline-math input').value);
      assert.equal(original, formula, name + ' changed original source');
      await js(() => document.querySelector('.dt-note-inline-math input').blur());
      await wait(() => !document.querySelector('.dt-note-inline-math input'), [], 'Note formula editor did not close', 5000);
      edits.push({surface: name, formula, unchanged: true});
    }
  }
  try {
    debuggerHandle.attach('1.3');
    attached = true;
    await open('/chat/' + encodeURIComponent(seed.session) + '?dt_workspace=', '.md-renderer', seed.cases.map(row => row[1]), 'chat');
    await snapshots('.md-renderer', 'chat');
    await open('/co-writer/' + encodeURIComponent(seed.note) + '?dt_workspace=', '.bn-editor', seed.cases.map(row => row[1]), 'notes');
    await snapshots('.bn-editor', 'notes');
    await checkNoteEdits(seed.cases.map(row => row[1]), 'notes');
    await open('/co-writer/' + encodeURIComponent(seed.saved_note) + '?dt_workspace=', '.bn-editor', seed.saved_cases.map(row => row[1]), 'saved-notes');
    await checkNoteEdits(seed.saved_cases.map(row => row[1]), 'saved-notes');
    writeFileSync(join(evidenceDir, 'native-science-saved-notes.png'), (await view.capturePage()).toPNG());
    for (const subject of ['chemistry', 'physics']) {
      const expected = seed.cases.filter(row => row[0].startsWith(subject)).map(row => row[1]);
      await open('/mistakes?record=' + encodeURIComponent(seed.mistakes[subject]) + '&dt_workspace=', 'article', expected, 'mistakes-' + subject);
      await snapshots('article', 'mistakes-' + subject);
      await js(() => {
        const button = [...document.querySelectorAll('button')].find(node => node.offsetHeight && node.textContent.trim() === '补充与分类');
        if (!button) throw new Error('Missing mistake edit action');
        button.click();
      });
      await wait(() => Boolean(document.querySelector('[data-student-mistake-form] textarea')), [], 'Mistake editor missing', 5000);
      const raw = await js(() => document.querySelector('[data-student-mistake-form] textarea').value);
      for (const formula of expected) assert(raw.includes(formula), subject + ' original source changed');
      edits.push({surface: 'mistakes-' + subject, formulas: expected, unchanged: true});
      await js(() => {
        const button = [...document.querySelectorAll('[data-student-mistake-form] button')].find(node => node.textContent.trim() === '取消');
        if (!button) throw new Error('Missing cancel action');
        button.click();
      });
      await wait(() => !document.querySelector('[data-student-mistake-form]'), [], 'Mistake editor did not close', 5000);
    }
    result = {passed: true, interface: 'Electron WebContents', viewportMode: 'CDP Emulation.setDeviceMetricsOverride',
      native_platform: process.platform, native_arch: process.arch,
      views, originalEdits: edits, cases: seed.cases, paidModelCalls: 0, originalStudentData: false};
  } catch (error) {
    const actual = await js(() => ({width: innerWidth, height: innerHeight})).catch(() => null);
    writeFileSync(join(evidenceDir, 'native-science-failure.json'), JSON.stringify({passed: false, error: String(error), actual, url: view.getURL(), views, edits}, null, 2) + '\n');
    throw error;
  } finally {
    if (attached) {
      try { await debuggerHandle.sendCommand('Emulation.clearDeviceMetricsOverride'); }
      finally { debuggerHandle.detach(); }
    }
  }
  assert(!debuggerHandle.isAttached(), 'QA debugger did not detach');
  await wait((width, height) => innerWidth === width && innerHeight === height,
    [originalViewport.width, originalViewport.height], 'QA viewport did not restore', 5000);
  result.cleanup = {deviceMetricsCleared: true, debuggerDetached: true, originalViewport,
    restoredViewport: await js(() => ({width: innerWidth, height: innerHeight}))};
  writeFileSync(join(evidenceDir, 'native-science.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
module.exports = {verifyScience, verifyScienceNative};
