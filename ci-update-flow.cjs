// Test-only entry in a disposable Electron copy; production modules remain unchanged.
const { app, BrowserWindow, dialog, session } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const home = process.env.OPEN_DEEPTUTOR_TEST_HOME;
const output = process.env.KX_UPDATE_FLOW_RESULT;
const before = JSON.parse(readFileSync(path.join(home, 'active.json')));
let installed = false, current = false, accepted = 0, invokeError = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  if (options.message === '发现开心动力超级学霸新版') {
    accepted++;
    return { response: 1 };
  }
  if (options.message === '更新已安装') installed = true;
  else if (options.message === '已是最新版本') current = true;
  else if (options.type === 'error' || options.type === 'warning') {
    throw new Error(options.message + ': ' + options.detail);
  }
  return { response: 0 };
};
dialog.showErrorBox = (title, detail) => { console.error(title + ': ' + detail); app.exit(1); };
const timer = setTimeout(() => { console.error('Native update flow timed out'); app.exit(1); }, 1300000);
async function content() {
  for (const window of BrowserWindow.getAllWindows()) {
    const found = window.contentView.children.find(view => view.webContents?.getURL().startsWith('http://127.0.0.1:'));
    if (found && await found.webContents.executeJavaScript('Boolean(window.kaixinDesktop?.checkForUpdates)').catch(() => false)) return found.webContents;
  }
}
(async () => {
  try {
    await app.whenReady();
    const updates = session.fromPartition('kaixin-updates');
    const originalFetch = updates.fetch.bind(updates);
    updates.fetch = async (url, options) => {
      const tag = process.env.KX_CANDIDATE_TAG;
      const original = String(url);
      const mapped = original.replace('/tags/core-updates', '/tags/' + tag).replace('/download/core-updates/', '/download/' + tag + '/');
      const ciOptions = new URL(mapped).hostname === 'api.github.com' && process.env.GH_TOKEN
        ? { ...options, headers: { ...options?.headers, Authorization: `Bearer ${process.env.GH_TOKEN}` } } : options;
      const response = await originalFetch(mapped, ciOptions);
      if (original.includes('/tags/core-updates') && response.ok) {
        const metadata = await response.json();
        return Response.json({ ...metadata, tag_name: 'core-updates' });
      }
      return response;
    };
    await import(pathToFileURL(path.join(__dirname, 'main.mjs')));
    await app.whenReady();
    let view;
    const readyDeadline = Date.now() + 120000;
    while (!(view = await content())) {
      assert.ok(Date.now() < readyDeadline, 'The old installed core did not open the update test interface');
      await pause(500);
    }
    await pause(1000);
    void view.executeJavaScript('window.kaixinDesktop.checkForUpdates()').catch(error => { invokeError = error.message; });
    while (!installed) await pause(500);
    const after = JSON.parse(readFileSync(path.join(home, 'active.json')));
    assert.notEqual(after.runtimeId, before.runtimeId);
    assert.ok(after.builtAt > (before.builtAt ?? 0));
    assert.equal(accepted, 1);
    const transaction = JSON.parse(readFileSync(path.join(home, 'upgrade.json')));
    assert.equal(transaction.phase, 'complete');
    assert.equal(transaction.previous.runtimeId, before.runtimeId);
    await pause(500);
    view = await content();
    assert.ok(view, 'Updated page did not expose the trusted desktop bridge');
    const uiDeadline = Date.now() + 60000;
    while (!await view.executeJavaScript('Boolean(document.querySelector("textarea")?.offsetHeight) && document.body.innerText.includes("默认学习助手") && !document.body.innerText.includes("加载中...")')) {
      assert.ok(Date.now() < uiDeadline, 'The updated learning interface did not finish rendering');
      await pause(200);
    }
    const menu = await view.executeJavaScript(`(() => { document.querySelector('button[aria-label="资源"]')?.click(); return document.body.innerText; })()`);
    for (const label of ['收藏夹', '学习日志', '题库', '书籍', '阅读']) assert.ok(!menu.split('\n').includes(label), label);
    await view.executeJavaScript(`document.querySelector('button[aria-label="资源"]')?.click()`);
    await require('node:fs/promises').writeFile(path.join(path.dirname(output), 'native-ui-updated.png'), (await view.capturePage()).toPNG());
    const fixture = JSON.parse(readFileSync(path.join(home, 'attachment-fixture.json')));
    const library = await require('./materials-ui.cjs')(view, path.dirname(output), fixture);
    const audio = await require('./ci-chat-audio-ui.cjs')(view, path.dirname(output), fixture.audio);
    const science = await require('./science-ui.cjs').verifyScienceNative(view, path.dirname(output), fixture.science);
    assert.equal(audio.passed, true);
    assert.equal(science.passed, true);
    await view.executeJavaScript('window.kaixinDesktop.checkForUpdates()');
    assert.equal(current, true);
    writeFileSync(output, JSON.stringify({
      native_platform: process.platform, native_arch: process.arch,
      entry: 'renderer IPC desktop:check-release', native_dialogs_auto_confirmed: true,
      production_main_unchanged: true, candidate_feed_routed_only_in_test: true, from_runtime: before.runtimeId, to_runtime: after.runtimeId,
      actual_download_install_backup_restart: 'passed', transaction: transaction.phase,
      check_again_current: true, old_renderer_closed_after_update: Boolean(invokeError),
      library_bulk_upload: library, chat_audio: audio, science_formulas: science,
    }, null, 2));
    clearTimeout(timer);
    app.quit();
  } catch (error) {
    console.error(error.message);
    clearTimeout(timer);
    app.exit(1);
  }
})();
