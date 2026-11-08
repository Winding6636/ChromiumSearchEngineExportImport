/*
 * 検索エンジン バックアップ / 復元ツール (Chromium 系ブラウザ用)
 *
 * 使い方:
 *   1. ****://settings/searchEngines を開く
 *   2. F12 で DevTools → Sources → Snippets に本ファイルを貼って保存 (初回のみ)
 *   3. スニペットを右クリック → Run (または Ctrl+Enter)
 *   4. 右下に出るパネルから「バックアップ」「復元」を実行
 *
 * 設定画面自身が使う内部 API (chrome.send) を呼ぶので、ブラウザ側の
 * 正規の追加処理 (url_hash 計算など) がそのまま行われる。DB を直接いじらない。
 */
(() => {
  'use strict';

  const LS_KEY = 'searchEngineRestore.backup';
  const PANEL_ID = 'se-restore-panel';
  const SEARCH_ENGINE_SETTINGS = 2; // ChoiceMadeLocation.SEARCH_ENGINE_SETTINGS
  const NEW_ENGINE_ID = 0;          // DEFAULT_MODEL_ID (新規追加)

  const onSettings = /^[a-z-]+:\/\/settings\//.test(location.href) || window.__seRestoreTest;
  if (!onSettings ||typeof chrome?.send !== 'function' || !window.cr) {
    alert('このスクリプトは設定ページ (…://settings/searchEngines) の DevTools で実行してください。');
    return;
  }

  // ---- WebUI 呼び出し ---------------------------------------------------
  const pending = new Map();
  if (!window.cr.__seRestoreHooked) {
    const orig = window.cr.webUIResponse;
    window.cr.webUIResponse = function (id, isSuccess, response) {
      const p = pending.get(id);
      if (p) {
        pending.delete(id);
        return isSuccess ? p.resolve(response) : p.reject(response);
      }
      return orig.apply(this, arguments);
    };
    window.cr.__seRestoreHooked = true;
    window.cr.__seRestorePending = pending;
  }
  const pendingMap = window.cr.__seRestorePending;

  let uid = 0;
  function sendWithPromise(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = `seRestore_${method}_${Date.now()}_${uid++}`;
      pendingMap.set(id, { resolve, reject });
      chrome.send(method, [id, ...args]);
      setTimeout(() => {
        if (pendingMap.delete(id)) reject(new Error(`${method}: 応答がありません`));
      }, 5000);
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 応答から {id, keyword, url} を持つオブジェクトを全部拾う (API 形状の差異に強くする)
  function flatten(info) {
    const out = [];
    const seen = new Set();
    (function walk(node, group) {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, group));
      if (!node || typeof node !== 'object') return;
      if ('keyword' in node && 'url' in node && 'id' in node) {
        if (!seen.has(node.id)) { seen.add(node.id); out.push({ ...node, _group: group }); }
        return;
      }
      for (const [k, v] of Object.entries(node)) walk(v, group ?? k);
    })(info, null);
    return out;
  }

  async function listEngines() {
    let info;
    try { info = await sendWithPromise('getSearchEnginesList'); }
    catch { info = await sendWithPromise('getCategorizedTemplateUrls'); }
    return flatten(info);
  }

  const isActive = (e) => (typeof e.isActive === 'boolean' ? e.isActive : e._group !== 'others');
  const norm = (s) => String(s ?? '').trim().toLowerCase();

  // ---- バックアップ -----------------------------------------------------
  async function makeBackup() {
    const all = await listEngines();
    const engines = all
      .filter((e) => !e.isOmniboxExtension && e._group !== 'extensions' && !e.isStarterPack)
      .map((e) => ({
        name: e.name,
        keyword: e.keyword,
        url: e.url,
        active: isActive(e),
        isDefault: !!e.isDefault,
        prepopulated: !!e.isPrepopulated,
        group: e._group,
      }));
    return {
      tool: 'search-engine-restore',
      version: 1,
      exportedAt: new Date().toISOString(),
      origin: location.origin,
      engines,
    };
  }

  function download(obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `search-engines-${obj.exportedAt.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function saveLocal(obj) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); return true; } catch { return false; }
  }
  function loadLocal() {
    try { const s = localStorage.getItem(LS_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
  }

  // ---- 復元 -------------------------------------------------------------
  // dryRun=true なら何も変更せず計画だけ返す
  async function restore(backup, { updateChanged = true, restoreActive = true, restoreDefault = true, dryRun = false } = {}) {
    if (!backup || !Array.isArray(backup.engines)) throw new Error('バックアップの形式が不正です');
    const plan = { add: [], update: [], activate: [], deactivate: [], setDefault: null, skipped: [] };

    let current = await listEngines();
    const byKw = () => new Map(current.map((e) => [norm(e.keyword), e]));
    let map = byKw();

    for (const b of backup.engines) {
      if (!b.keyword || !b.url) continue;
      const cur = map.get(norm(b.keyword));
      if (!cur) { plan.add.push(b); continue; }
      const changed = cur.url !== b.url || cur.name !== b.name;
      if (changed && updateChanged) {
        if (cur.canBeEdited === false || cur.isManaged) plan.skipped.push({ ...b, reason: '編集不可' });
        else plan.update.push({ ...b, id: cur.id });
      }
    }
    if (dryRun) return plan;

    for (const b of plan.add) {
      chrome.send('searchEngineEditStarted', [NEW_ENGINE_ID]);
      chrome.send('searchEngineEditCompleted', [b.name || b.keyword, b.keyword, b.url]);
      await sleep(80);
    }
    for (const b of plan.update) {
      chrome.send('searchEngineEditStarted', [b.id]);
      chrome.send('searchEngineEditCompleted', [b.name || b.keyword, b.keyword, b.url]);
      await sleep(80);
    }

    // 追加・更新後の状態で有効/無効・既定を合わせる
    await sleep(300);
    current = await listEngines();
    map = byKw();

    if (restoreActive) {
      for (const b of backup.engines) {
        if (typeof b.active !== 'boolean') continue;
        const cur = map.get(norm(b.keyword));
        if (!cur || cur.isDefault) continue;
        const now = isActive(cur);
        if (b.active && !now && cur.canBeActivated !== false) {
          chrome.send('setIsActiveSearchEngine', [cur.id, true]); plan.activate.push(b);
        } else if (!b.active && now && cur.canBeDeactivated) {
          chrome.send('setIsActiveSearchEngine', [cur.id, false]); plan.deactivate.push(b);
        }
        await sleep(30);
      }
    }

    if (restoreDefault) {
      const want = backup.engines.find((e) => e.isDefault);
      const cur = want && map.get(norm(want.keyword));
      if (cur && !cur.isDefault && cur.canBeDefault !== false) {
        chrome.send('setDefaultSearchEngine', [cur.id, SEARCH_ENGINE_SETTINGS, null]);
        plan.setDefault = want;
      }
    }
    return plan;
  }

  function summarize(plan, dry) {
    const l = (arr) => arr.map((e) => `  ${e.keyword}  (${e.name})`).join('\n');
    const parts = [];
    if (plan.add.length) parts.push(`追加 ${plan.add.length} 件:\n${l(plan.add)}`);
    if (plan.update.length) parts.push(`更新 ${plan.update.length} 件:\n${l(plan.update)}`);
    if (plan.activate.length) parts.push(`有効化 ${plan.activate.length} 件`);
    if (plan.deactivate.length) parts.push(`無効化 ${plan.deactivate.length} 件`);
    if (plan.setDefault) parts.push(`既定を ${plan.setDefault.name} に変更`);
    if (plan.skipped.length) parts.push(`スキップ ${plan.skipped.length} 件:\n${l(plan.skipped)}`);
    if (!parts.length) return dry ? '差分はありません。' : '変更はありませんでした。';
    return parts.join('\n\n');
  }

  // ---- UI ---------------------------------------------------------------
  document.getElementById(PANEL_ID)?.remove();
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'background:#fff', 'color:#202124', 'border:1px solid #dadce0', 'border-radius:8px',
    'box-shadow:0 2px 10px rgba(0,0,0,.2)', 'padding:12px', 'font:13px system-ui,sans-serif',
    'display:flex', 'flex-direction:column', 'gap:6px', 'min-width:240px',
  ].join(';');
  if (matchMedia('(prefers-color-scheme: dark)').matches) {
    panel.style.background = '#292a2d'; panel.style.color = '#e8eaed'; panel.style.borderColor = '#5f6368';
  }

  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;opacity:.8;white-space:pre-wrap;max-height:160px;overflow:auto';

  function btn(label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:6px 10px;border-radius:4px;border:1px solid #8883;background:transparent;color:inherit;cursor:pointer;text-align:left';
    b.onclick = async () => {
      panel.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try { await fn(); } catch (e) { console.error(e); status.textContent = `エラー: ${e.message || e}`; }
      finally { panel.querySelectorAll('button').forEach((x) => (x.disabled = false)); }
    };
    return b;
  }

  function showLocalInfo() {
    const lb = loadLocal();
    status.textContent = lb
      ? `保存済みバックアップ: ${new Date(lb.exportedAt).toLocaleString()} (${lb.engines.length} 件)`
      : '保存済みバックアップ: なし';
  }

  async function runRestore(backup) {
    const plan = await restore(backup, { dryRun: true });
    const msg = summarize(plan, true);
    if (!plan.add.length && !plan.update.length) {
      // 有効/既定の差分だけの可能性もあるので確認してから実行
      if (!confirm(`${msg}\n\n有効/無効・既定エンジンの状態を合わせますか?`)) return;
    } else if (!confirm(`${msg}\n\n(有効/無効・既定エンジンも合わせます)\n実行しますか?`)) return;
    const done = await restore(backup);
    status.textContent = `復元完了\n${summarize(done, false)}`;
    console.log('[search-engine-restore] 結果', done);
  }

  const title = document.createElement('div');
  title.textContent = '検索エンジン バックアップ/復元';
  title.style.cssText = 'font-weight:600;display:flex;justify-content:space-between;align-items:center';
  const close = document.createElement('span');
  close.textContent = '×'; close.style.cssText = 'cursor:pointer;padding:0 4px';
  close.onclick = () => panel.remove();
  title.appendChild(close);

  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = '.json,application/json'; fileInput.style.display = 'none';
  fileInput.onchange = async () => {
    const f = fileInput.files[0]; fileInput.value = '';
    if (!f) return;
    try { await runRestore(JSON.parse(await f.text())); }
    catch (e) { console.error(e); status.textContent = `エラー: ${e.message || e}`; }
  };

  panel.append(
    title,
    btn('💾 バックアップ (ブラウザ内に保存 + JSON ダウンロード)', async () => {
      const b = await makeBackup();
      const ok = saveLocal(b);
      download(b);
      status.textContent = `バックアップ: ${b.engines.length} 件${ok ? '' : ' (ブラウザ内保存は失敗)'}`;
    }),
    btn('♻ 保存済みバックアップから復元', async () => {
      const b = loadLocal();
      if (!b) { status.textContent = '保存済みバックアップがありません。JSON から復元してください。'; return; }
      await runRestore(b);
    }),
    btn('📂 JSON ファイルから復元', async () => fileInput.click()),
    fileInput,
    status,
  );
  document.body.appendChild(panel);
  showLocalInfo();

  // コンソールからも使えるように
  window.seRestore = { listEngines, makeBackup, restore, download, loadLocal, saveLocal };
  console.log('[search-engine-restore] パネルを表示しました。window.seRestore からも操作できます。');
})();
