// Synthetic native acceptance against the exact updated production renderer.
const assert = require('node:assert/strict');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');
module.exports = async function verifyMaterials(view, evidence, mathFixture) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (fn, ...args) => view.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  async function wait(code, label) {
    const deadline = Date.now() + 180000;
    while (!await view.executeJavaScript(code)) {
      assert.ok(Date.now() < deadline, label);
      await pause(250);
    }
  }
  const click = async text => {
    await wait(`([...document.querySelectorAll('button,a,[role="menuitem"]')].some(node => node.offsetHeight && node.textContent.trim() === ${JSON.stringify(text)}))`, 'Missing visible action: ' + text);
    return js(text => {
    const node = [...document.querySelectorAll('button,a,[role="menuitem"]')].find(node => node.offsetHeight && node.textContent.trim() === text);
    if (!node) throw new Error('Missing visible action: ' + text);
    node.click();
    }, text);
  };
  async function chat() {
    await js(() => {
      const link = [...document.querySelectorAll('a[href^="/chat"]')].find(node => node.offsetHeight);
      if (!link) throw new Error('No visible chat navigation');
      link.click();
    });
    await wait('location.pathname.startsWith("/chat") && Boolean(document.querySelector("textarea")?.offsetHeight)', 'Chat navigation failed');
  }
  async function library() {
    await click('资料');
    await click('资料库 · 教材与长期资料');
    await wait('location.pathname === "/space" && Boolean(document.querySelector(\'input[aria-label="选择要长期保存的资料"]\'))', 'Library navigation failed');
  }
  await view.loadURL(new URL('/space?dt_workspace=', view.getURL()).href);
  await wait('Boolean(document.querySelector(\'input[aria-label="选择要长期保存的资料"]\'))', 'Updated library did not expose bulk upload');
  const originals = Array.from({ length: 20 }, (_, index) => ({ name: `native-background-${index.toString().padStart(2, '0')}.txt`, text: `SYNTHETIC NATIVE ORIGINAL ${index}\n切换页面后继续保存。` }));
  originals.push({ name: 'native-listening.html', text: '<!DOCTYPE html><html><body><h1>Synthetic listening</h1><div class="row"><span class="text">Hello student.</span><button onclick="speakOne(0)">Play one</button></div><script>window.attachmentExecuted=true</script><a href="https://example.com">external</a></body></html>' });
  await js(() => {
    window.__materialsDocument = 'same-document';
    const original = window.fetch.bind(window);
    window.__materialsPosts = [];
    window.__materialsHeld = false;
    const held = new Promise(resolve => { window.__materialsRelease = resolve; });
    window.fetch = async (...args) => {
      const url = String(args[0]);
      if (args[1]?.method === 'POST') window.__materialsPosts.push(url);
      if (!window.__materialsHeld && /\/uploads\/[^/]+\/chunks\/0/.test(url)) {
        window.__materialsHeld = true;
        await held;
      }
      const response = await original(...args);
      if (url.includes('/materials/attach') && response.ok) window.__materialsAttached = await response.clone().json();
      return response;
    };
  });
  async function select(files) {
    assert.equal(await js(files => {
      const input = document.querySelector('input[aria-label="选择要长期保存的资料"]');
      const data = new DataTransfer();
      for (const file of files) data.items.add(new File([file.text], file.name, { type: file.name.endsWith('.html') ? 'text/html' : 'text/plain' }));
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.multiple;
    }, files), true);
  }
  await select(originals.slice(0, 20));
  await wait('window.__materialsHeld', 'The real first upload chunk was not held');
  await chat();
  await js(() => {
    const profile = [...document.querySelectorAll('button')].find(node => node.offsetHeight && node.textContent.trim() === '开心动力超级学霸');
    if (!profile) throw new Error('Profile menu missing');
    profile.click();
  });
  await click('设置');
  await wait('location.pathname === "/settings/general" && document.body.innerText.includes("常规")', 'Settings navigation failed');
  await click('返回应用');
  await wait('location.pathname.startsWith("/chat")', 'Return from settings failed');
  await library();
  await wait('document.body.innerText.includes("已保存 0/20 份")', 'Queue did not survive page changes');
  await select(originals.slice(20));
  await wait('document.body.innerText.includes("已保存 0/21 份")', 'Could not append to active queue');
  await chat();
  const draft = 'SYNTHETIC retained draft; never send to a model.';
  await js(draft => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, draft);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.__materialsRelease();
  }, draft);
  await wait('document.body.innerText.includes("资料上传完成：已保存 21 份，已自动加入资料库。")', 'Background upload did not finish in chat');
  assert.equal(await js(() => document.querySelector('textarea').value), draft);
  await library();
  await wait('document.body.innerText.includes("已保存 21/21 份")', 'Returning library did not refresh');
  assert.equal(await js(() => window.__materialsDocument), 'same-document');
  const retained = await js(async originals => {
    const response = await fetch('/api/student/attachments/uploads/library?dt_workspace=');
    if (!response.ok) throw new Error('Library catalogue failed');
    const uploads = (await response.json()).uploads;
    for (const file of originals) {
      const upload = uploads.find(row => row.retention === 'library' && row.records.some(row => row.filename === file.name));
      if (!upload) throw new Error('Missing retained original: ' + file.name);
      const record = upload.records.find(row => row.filename === file.name);
      const raw = await fetch(record.url);
      if (!raw.ok || await raw.text() !== file.text) throw new Error('Original changed: ' + file.name);
      if (![...document.querySelectorAll('article h2')].some(node => node.textContent === file.name)) throw new Error('Saved card missing: ' + file.name);
    }
    return uploads.length;
  }, originals);
  await js(() => {
    const card = [...document.querySelectorAll('article')].find(node => node.querySelector('h2')?.textContent === 'native-listening.html');
    [...card.querySelectorAll('button')].find(node => node.textContent.trim() === '打开原件').click();
  });
  await wait('Boolean(document.querySelector(\'iframe[title="native-listening.html"]\')?.srcdoc)', 'HTML did not render an isolated page');
  const safe = await js(() => {
    const frame = document.querySelector('iframe[title="native-listening.html"]');
    return frame.sandbox.value === 'allow-scripts' && !frame.srcdoc.includes('window.attachmentExecuted=true') && !frame.srcdoc.includes('href="https://example.com"') && frame.srcdoc.includes("connect-src 'none'");
  });
  assert.equal(safe, true);
  let frame;
  const frameDeadline = Date.now() + 30000;
  while (!(frame = view.mainFrame.framesInSubtree.find(frame => frame.url === 'about:srcdoc'))) {
    assert.ok(Date.now() < frameDeadline, 'Missing native HTML subframe: ' + JSON.stringify(view.mainFrame.framesInSubtree.map(frame => frame.url)));
    await pause(100);
  }
  const speech = await frame.executeJavaScript(`(async () => {
    let parentBlocked = false; try { parent.document.body } catch { parentBlocked = true }
    let networkBlocked = false; try { await fetch('https://example.com/kaixin-isolation-probe') } catch { networkBlocked = true }
    return { available: typeof speechSynthesis === 'object', parentBlocked, networkBlocked, attachmentScriptBlocked: !window.attachmentExecuted, noNode: typeof require === 'undefined', noDesktopIPC: !window.kaixinDesktop, localVoices: speechSynthesis.getVoices().filter(v => v.localService).length };
  })()`, true);
  assert.ok(speech.available && speech.parentBlocked && speech.networkBlocked && speech.attachmentScriptBlocked && speech.noNode && speech.noDesktopIPC);
  speech.diagnostic = await require('./native-html-speech-diagnostic.cjs')(frame);
  speech.observedStatus = speech.diagnostic.observedStatus;
  speech.playbackVerified = speech.diagnostic.nativeEnded;
  speech.diagnosticOnly = true;
  await writeFile(path.join(evidence, 'native-html-preview.png'), (await view.capturePage()).toPNG());
  await click('源码');
  await wait('Boolean(document.querySelector("pre")?.textContent.includes("window.attachmentExecuted=true"))', 'HTML source toggle failed');
  await js(() => document.querySelector('button[aria-label="关闭原件预览"]')?.click());
  await wait('!document.querySelector(\'button[aria-label="关闭原件预览"]\')', 'Preview did not close');
  await chat();
  await js(() => { document.querySelector('button[aria-label="资源"]').click(); });
  await wait('document.body.innerText.includes("从资料库选择")', 'Composer library action missing');
  await js(() => [...document.querySelectorAll('button')].find(node => node.offsetHeight && node.textContent.includes('从资料库选择')).click());
  await wait('Boolean(document.querySelector(\'[aria-label="搜索资料库"]\')) && [...document.querySelectorAll(\'[role="dialog"] button\')].some(node => node.textContent.includes("native-background-00.txt"))', 'Library picker did not list original');
  const postsBefore = await js(() => window.__materialsPosts.length);
  await js(() => [...document.querySelectorAll('[role="dialog"] button')].find(node => node.textContent.includes('native-background-00.txt')).click());
  await wait('Boolean(window.__materialsAttached) && !document.querySelector(\'[aria-label="搜索资料库"]\')', 'Library reference failed');
  assert.equal(await js(() => document.querySelector('textarea').value), draft);
  await js(async (original, retained, postsBefore) => {
    const file = window.__materialsAttached;
    const raw = await fetch(file.url);
    if (file.filename !== original.name || !raw.ok || await raw.text() !== original.text) throw new Error('Referenced original changed');
    const response = await fetch('/api/student/attachments/uploads/library?dt_workspace=');
    if ((await response.json()).uploads.length !== retained) throw new Error('Reference duplicated a library upload');
    if (window.__materialsPosts.slice(postsBefore).some(url => /\/uploads|\/sessions$/.test(url))) throw new Error('Reference created an upload or conversation');
  }, originals[0], retained, postsBefore);
  await writeFile(path.join(evidence, 'native-library-reference.png'), (await view.capturePage()).toPNG());
  if (mathFixture) {
    for (const [key, route, selector, count] of [
      ['note', '/co-writer/', '.bn-editor .katex', 9],
      ['saved_note', '/co-writer/', '.bn-editor table .katex', 2],
      ['mistake', '/mistakes?record=', 'article .katex', 9],
    ]) {
      await view.loadURL(new URL(route + encodeURIComponent(mathFixture[key]), view.getURL()).href);
      await wait(`document.querySelectorAll(${JSON.stringify(selector)}).length >= ${count}`, 'Native math rendering failed: ' + key);
      assert.equal(await js(() => document.querySelectorAll('.katex-error').length), 0);
      assert.equal(await js(() => document.documentElement.scrollWidth <= innerWidth), true);
      await writeFile(path.join(evidence, 'native-math-' + key + '.png'), (await view.capturePage()).toPNG());
    }
  }
  const report = { multiple: true, saved_files: 21, library_retention: true, originals_byte_identical: true, original_preview_opened: true,
    held_real_chunk: true, chat_and_settings_navigation: true, appended_while_active: true, completed_in_chat: true,
    document_not_reloaded: true, draft_preserved: true, picker_reference_byte_identical: true, no_duplicate_upload_or_new_chat: true,
    html_safe_preview: true, source_toggle: true, device_speech: speech, native_math_display: Boolean(mathFixture), real_model_calls: 0 };
  await writeFile(path.join(evidence, 'library-bulk.json'), JSON.stringify(report, null, 2));
  return report;
};
