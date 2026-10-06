/*
 * ChatGPT Export - content-export.js
 * Version: v7.0.0
 * Patch: p24
 * Développeur : @NoXoZ.be
 * Export local du chat courant, des projets et de tous les chats du compte.
 */
(function cgxInit() {
  'use strict';

  const VERSION = '7.0.0';
  const PATCH = 'p24';
  const WIDGET_ID = 'cgx-widget';
  const LOADED_KEY = '__CGX_EXPORT_V503_LOADED__';
  const STORAGE_KEY = 'cgx.v3.state';
  const DEFAULTS_REVISION = 'v6.1.1-all-chat';
  const DEFAULTS = {
    mode: 'mini',
    dev: false,
    visible: true,
    exportMode: 'full',
    projectFullUi: false,
    allFullUi: false,
    projectSourcesUi: false,
    exportUploadedFiles: true,
    exportDownloadedFiles: false,
    messages: 25,
    chatsPerZip: 50,
    timeout: 600,
    askSave: true,
    defaultsRevision: DEFAULTS_REVISION,
    positions: {},
    sizes: {}
  };

  if (window[LOADED_KEY]) {
    const existing = document.getElementById(WIDGET_ID);
    if (existing) existing.remove();
  }
  window[LOADED_KEY] = true;

  let widget = null;
  let state = structuredCloneSafe(DEFAULTS);
  let runtime = { exporting: false, stop: false, status: 'Prêt', logs: [], folderHandle: null, batchFolderPrepared: false, downloadTarget: '', metrics: createMetrics(), clickedExpandKeys: new Set() };
  const conversationDataCache = new Map();
  let drag = null;
  let resizeDrag = null;
  let repeatTimer = null;
  let repeatInterval = null;
  let buttonClickTimer = null;
  let suppressClickUntil = 0;
  let initPromise = null;

  function structuredCloneSafe(value) { return JSON.parse(JSON.stringify(value)); }
  function now() { return Date.now(); }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function norm(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
  function clamp(n, min, max, fallback) {
    const x = Number(n);
    if (!Number.isFinite(x)) return fallback;
    return Math.max(min, Math.min(max, Math.round(x)));
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(keys, (data) => resolve(data || {})); } catch { resolve({}); }
    });
  }
  function storageSet(data) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(data, () => resolve()); } catch { resolve(); }
    });
  }

  async function loadState() {
    const data = await storageGet([STORAGE_KEY]);
    const saved = data && data[STORAGE_KEY] ? data[STORAGE_KEY] : null;
    const savedDefaultsRevision = saved?.defaultsRevision || 'legacy';
    if (saved) {
      state = Object.assign(structuredCloneSafe(DEFAULTS), saved);
      state.positions = state.positions && typeof state.positions === 'object' ? state.positions : {};
      state.sizes = state.sizes && typeof state.sizes === 'object' ? state.sizes : {};
    }
    state.sizes = state.sizes && typeof state.sizes === 'object' ? state.sizes : {};
    state.messages = clamp(state.messages, 1, 9999, DEFAULTS.messages);
    state.chatsPerZip = clamp(state.chatsPerZip, 1, 9999, DEFAULTS.chatsPerZip);
    state.timeout = clamp(state.timeout, 1, 9999, DEFAULTS.timeout);
    if (!['button', 'mini', 'maxi'].includes(state.mode)) state.mode = 'mini';
    if (!['full', 'start', 'end'].includes(state.exportMode)) state.exportMode = 'full';
    if (typeof state.projectFullUi !== 'boolean') state.projectFullUi = false;
    if (typeof state.allFullUi !== 'boolean') state.allFullUi = false;
    if (typeof state.projectSourcesUi !== 'boolean') state.projectSourcesUi = false;
    if (typeof state.exportUploadedFiles !== 'boolean') state.exportUploadedFiles = true;
    if (typeof state.exportDownloadedFiles !== 'boolean') state.exportDownloadedFiles = false;

    // v5.0.18 : réduit légèrement l’ancienne largeur Maxi par défaut sans
    // écraser une largeur réellement personnalisée par l’utilisateur.
    const oldMaxiWidth = Number(state.sizes?.maxi?.width || 0);
    if (oldMaxiWidth === 286 || oldMaxiWidth === 326) {
      state.sizes.maxi.width = 274;
    }

    // Migration par défaut v4.0.3 : Mini/Maxi utilisent par défaut Export complet + Enregistrer sous = Oui.
    // Sans cela, un stockage navigateur d’une ancienne version pourrait conserver FIN/Non indéfiniment.
    if (savedDefaultsRevision !== DEFAULTS_REVISION) {
      state.exportMode = 'full';
      state.projectFullUi = false;
      state.allFullUi = false;
      state.projectSourcesUi = false;
      state.askSave = true;
      state.defaultsRevision = DEFAULTS_REVISION;
    }
  }

  async function saveState() { await storageSet({ [STORAGE_KEY]: state }); }

  const BATCH_FOLDER_DB = 'cgx-export-batch-folder-v1';
  const BATCH_FOLDER_STORE = 'handles';
  const BATCH_FOLDER_KEY = 'active';

  function openBatchFolderDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('INDEXEDDB_UNAVAILABLE')); return; }
      const request = window.indexedDB.open(BATCH_FOLDER_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BATCH_FOLDER_STORE)) db.createObjectStore(BATCH_FOLDER_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('INDEXEDDB_OPEN_FAILED'));
    });
  }

  async function storeBatchFolderHandle(handle, stamp, kind) {
    if (!handle || !stamp) return;
    const db = await openBatchFolderDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(BATCH_FOLDER_STORE, 'readwrite');
        tx.objectStore(BATCH_FOLDER_STORE).put({ handle, stamp: String(stamp), kind: String(kind || ''), savedAt: Date.now() }, BATCH_FOLDER_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('BATCH_FOLDER_STORE_FAILED'));
        tx.onabort = () => reject(tx.error || new Error('BATCH_FOLDER_STORE_ABORTED'));
      });
    } finally { db.close(); }
  }

  async function loadBatchFolderHandle(stamp) {
    if (!stamp) return null;
    const db = await openBatchFolderDb();
    try {
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction(BATCH_FOLDER_STORE, 'readonly');
        const req = tx.objectStore(BATCH_FOLDER_STORE).get(BATCH_FOLDER_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('BATCH_FOLDER_LOAD_FAILED'));
      });
      if (!record?.handle || String(record.stamp || '') !== String(stamp)) return null;
      return record.handle;
    } finally { db.close(); }
  }

  async function clearBatchFolderHandle(stamp = '') {
    try {
      const db = await openBatchFolderDb();
      try {
        if (stamp) {
          const record = await new Promise((resolve, reject) => {
            const tx = db.transaction(BATCH_FOLDER_STORE, 'readonly');
            const req = tx.objectStore(BATCH_FOLDER_STORE).get(BATCH_FOLDER_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error || new Error('BATCH_FOLDER_LOAD_FAILED'));
          });
          if (record && String(record.stamp || '') !== String(stamp)) return;
        }
        await new Promise((resolve, reject) => {
          const tx = db.transaction(BATCH_FOLDER_STORE, 'readwrite');
          tx.objectStore(BATCH_FOLDER_STORE).delete(BATCH_FOLDER_KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('BATCH_FOLDER_CLEAR_FAILED'));
          tx.onabort = () => reject(tx.error || new Error('BATCH_FOLDER_CLEAR_ABORTED'));
        });
      } finally { db.close(); }
    } catch { /* au mieux */ }
  }

  async function prepareBatchFolderFromStartGesture(forceAskSave = false, forceChat = false) {
    // p18 : les noms de ZIP Projet/TOUS incluent le nom du chat (ou le premier et le dernier nom pour les lots multi-chats).
    // Chaque partie ZIP est enregistrée automatiquement via chrome.downloads sous le dossier
    // Téléchargements par défaut du navigateur. Les exports du chat courant conservent leur flux historique.
    const batchedExport = !forceChat && (state.projectFullUi || state.allFullUi);
    if (batchedExport) {
      runtime.folderHandle = null;
      runtime.batchFolderPrepared = false;
      return true;
    }
    return true;
  }

  async function chooseBatchFolder(stamp, kind, askForLocation) {
    // p14 : aucun sélecteur volontairement pour Projet/TOUS. La destination est un
    // chemin relatif sous le dossier Téléchargements par défaut du navigateur.
    runtime.folderHandle = null;
    runtime.batchFolderPrepared = false;
    return null;
  }

  async function restoreBatchFolder(stamp) {
    // Conservé comme opération neutre de compatibilité pour les anciens travaux persistés.
    runtime.folderHandle = null;
    return null;
  }

  function underscoreToken(value, fallback = 'Export') {
    return safeFilenameBase(value || fallback)
      .trim()
      .replace(/\s+/g, '_')
      .replace(/-+/g, '_')
      .replace(/_+/g, '_');
  }

  async function detectBrowserName() {
    try {
      if (navigator.brave && typeof navigator.brave.isBrave === 'function' && await navigator.brave.isBrave()) return 'Brave';
    } catch { /* ignorer */ }
    const ua = String(navigator.userAgent || '');
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) return 'Chrome';
    return 'Browser';
  }

  function batchDownloadFolder(kind, projectName = '', accountName = '', browserName = '') {
    const browserPart = underscoreToken(browserName || 'Browser', 'Browser');
    const accountPart = underscoreToken(accountName || 'ChatGPT Account', 'ChatGPT_Account');
    const leaf = kind === 'project'
      ? underscoreToken(projectName || 'Project', 'Project')
      : 'ALL_Full_Chat';
    return `ChatGPT-Export/${browserPart}/${accountPart}/${leaf}`;
  }

  function bytesToBase64Chunk(bytes) {
    let binary = '';
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const step = 0x8000;
    for (let i = 0; i < view.length; i += step) {
      binary += String.fromCharCode(...view.subarray(i, Math.min(view.length, i + step)));
    }
    return btoa(binary);
  }

  async function saveBatchZipToDownloads(filename, bytes, kind, projectName = '', accountName = '', browserName = '') {
    const folder = batchDownloadFolder(kind, projectName, accountName, browserName);
    const askSave = Boolean(state.askSave);
    const relativePath = askSave ? filename : `${folder}/${filename}`;
    const transferId = `cgx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const chunkSize = 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(view.length / chunkSize));
    runtime.downloadTarget = askSave ? 'Boîte de dialogue Enregistrer sous' : `Downloads/${folder}/`;

    try {
      const prep = await runtimeMessage({ type: 'CGX_PREPARE_OFFSCREEN_DOWNLOAD' });
      if (!prep?.ok) throw new Error(prep?.error || 'OFFSCREEN_PREPARE_FAILED');

      let response = await runtimeMessage({
        target: 'offscreen',
        type: 'CGX_OFFSCREEN_ZIP_BEGIN',
        transferId,
        relativePath,
        totalBytes: view.length,
        totalChunks
      });
      if (!response?.ok) throw new Error(response?.error || 'OFFSCREEN_BEGIN_FAILED');

      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * chunkSize;
        const end = Math.min(view.length, start + chunkSize);
        const base64 = bytesToBase64Chunk(view.subarray(start, end));
        response = await runtimeMessage({
          target: 'offscreen',
          type: 'CGX_OFFSCREEN_ZIP_CHUNK',
          transferId,
          index,
          base64
        });
        if (!response?.ok) throw new Error(response?.error || `OFFSCREEN_CHUNK_${index}_FAILED`);
      }

      const committed = await runtimeMessage({
        target: 'offscreen',
        type: 'CGX_OFFSCREEN_ZIP_COMMIT',
        transferId
      });
      if (!committed?.ok || !committed.url) throw new Error(committed?.error || 'OFFSCREEN_COMMIT_FAILED');

      const saved = await runtimeMessage({
        type: 'CGX_DOWNLOAD_BATCH_ZIP',
        url: committed.url,
        filename,
        relativePath,
        saveAs: askSave,
        transferId
      });
      if (!saved?.ok) throw new Error(saved?.error || 'BATCH_DOWNLOAD_FAILED');
      log(`batch save complete mode=${askSave ? 'save-as' : 'autosave'} ${relativePath}${saved.downloadId ? ` downloadId=${saved.downloadId}` : ''}`);
      return saved;
    } catch (error) {
      try {
        await runtimeMessage({ target: 'offscreen', type: 'CGX_OFFSCREEN_ZIP_ABORT', transferId });
      } catch { /* au mieux */ }
      throw error;
    }
  }

  function setStatus(text) {
    runtime.status = String(text || '');
    render();
  }

  function log(text) {
    runtime.logs.push(`${new Date().toLocaleTimeString()} ${text}`);
    if (runtime.logs.length > 120) runtime.logs.splice(0, runtime.logs.length - 120);
  }

  function createMetrics() {
    return {
      exportStartedAt: 'n/a',
      exportMode: 'n/a',
      scrollElement: 'n/a',
      crawlScrollElement: 'n/a',
      topLoadIterations: 0,
      crawlSteps: 0,
      expandPasses: 0,
      showMoreRounds: 0,
      showMoreClicked: 0,
      expandErrors: 0,
      collectErrors: 0,
      domArticleTurns: 0,
      domRoleNodes: 0,
      domGenericMessageNodes: 0,
      containersSeen: 0,
      messagesCollected: 0,
      messagesAfterRange: 0,
      markdownChars: 0,
      filename: 'n/a',
      loopBreakReason: 'n/a',
      projectName: 'n/a',
      projectChatsDiscovered: 0,
      projectChatsCompleted: 0,
      projectChatsFailed: 0,
      projectTotalMessages: 0,
      projectUserMessages: 0,
      projectAgentMessages: 0,
      projectAttachmentsFound: 0,
      projectAttachmentsDownloaded: 0,
      projectAttachmentsFailed: 0,
      projectDownloadsFound: 0,
      projectDownloadsDownloaded: 0,
      projectDownloadsFailed: 0,
      projectZipBytes: 0,
      projectZipFilename: 'n/a'
    };
  }

  function resetMetrics(exportMode = state.exportMode) {
    runtime.metrics = createMetrics();
    runtime.metrics.exportStartedAt = new Date().toLocaleTimeString();
    runtime.metrics.exportMode = exportMode;
  }

  function indexLogLine() {
    const m = runtime.metrics || createMetrics();
    return `index showMoreClicked=${m.showMoreClicked} showMoreRounds=${m.showMoreRounds} expandErrors=${m.expandErrors} collectErrors=${m.collectErrors} containersSeen=${m.containersSeen} messagesCollected=${m.messagesCollected} messagesAfterRange=${m.messagesAfterRange} markdownChars=${m.markdownChars} loopBreakReason=${m.loopBreakReason}`;
  }

  function header() {
    const displayVersion = state.dev ? `v${VERSION} ${PATCH}` : `v${VERSION}`;
    const first = `ChatGPT Export  @NoXoZ.be - ${displayVersion}`;
    return `
      <div class="cgx-header" data-drag="true">
        <div class="cgx-title-row"><div class="cgx-title">${esc(first)}</div></div>
        <div class="cgx-controls-row">
          <button class="cgx-head-btn ${state.dev ? 'on' : ''}" data-action="toggle-dev">${state.dev ? 'Utilisateur' : 'Dev'}</button>
          ${state.dev ? '<button class="cgx-head-btn reload" data-action="reload">Recharger ext.</button>' : ''}
          <button class="cgx-head-btn" data-action="mode-up" title="Bouton → Mini → Maxi">‹</button>
          <button class="cgx-head-btn ${state.mode === 'maxi' ? 'on' : ''}" data-mode="maxi">Maxi</button>
          <button class="cgx-head-btn ${state.mode === 'mini' ? 'on' : ''}" data-mode="mini">Mini</button>
          <span class="cgx-spacer"></span>
          <button class="cgx-head-btn dot" data-action="mode-down" title="Maxi → Mini → Bouton">•</button>
        </div>
      </div>`;
  }

  function rangeButton(mode, label) {
    return `<button class="cgx-range ${!state.projectFullUi && !state.allFullUi && !state.projectSourcesUi && state.exportMode === mode ? 'selected' : ''}" data-range="${mode}">${esc(label)}</button>`;
  }

  function allFullUiButton(label, mini = false) {
    return `<button class="cgx-range ${mini ? 'cgx-mini-project ' : ''}${state.allFullUi ? 'selected' : ''}" data-all-ui="true">${esc(label)}</button>`;
  }

  function projectUiButton(label, mini = false) {
    return `<button class="cgx-range ${mini ? 'cgx-mini-project ' : ''}${state.projectFullUi ? 'selected' : ''}" data-project-ui="true">${esc(label)}</button>`;
  }

  function projectSourcesUiButton(label) {
    return `<button class="cgx-range ${state.projectSourcesUi ? 'selected' : ''}" data-project-sources-ui="true">${esc(label)}</button>`;
  }

  function fileExportToggleButton(kind, label, mini = false) {
    const enabled = kind === 'uploaded' ? state.exportUploadedFiles : state.exportDownloadedFiles;
    return `<button class="cgx-range ${mini ? 'cgx-mini-project ' : ''}${enabled ? 'selected' : ''}" data-file-export-toggle="${kind}">${esc(label)}</button>`;
  }

  function rangeBlock() {
    return `
      <div class="cgx-section">Paramètres d’export</div>
      <div class="cgx-ranges">
        ${allFullUiButton('Exporter tous les chats complets')}
        ${projectUiButton('Exporter le projet complet')}
        ${fileExportToggleButton('uploaded', 'Exporter les fichiers envoyés')}
        ${fileExportToggleButton('downloaded', 'Exporter les fichiers téléchargés')}
        ${rangeButton('full', 'Exporter le chat complet')}
        ${rangeButton('start', 'Exporter depuis le début')}
        ${rangeButton('end', 'Exporter depuis la fin')}
        ${currentProjectId() ? projectSourcesUiButton('Exporter toutes les sources de ce projet') : ''}
      </div>`;
  }

  function messageNumberBlock(label = 'Nombre de messages à exporter') {
    return `
      <div class="cgx-number-block">
        <div class="cgx-label full">${esc(label)}</div>
        <div class="cgx-number-controls">
          <button class="cgx-step" data-step="messages" data-delta="-1">−</button>
          <input class="cgx-input small" type="number" data-number="messages" value="${esc(state.messages)}">
          <button class="cgx-step" data-step="messages" data-delta="1">+</button>
        </div>
      </div>`;
  }

  function chatsPerZipBlock() {
    return `
      <div class="cgx-number-block">
        <div class="cgx-label full">Nombre de chats à exporter par ZIP</div>
        <div class="cgx-number-controls">
          <button class="cgx-step" data-step="chatsPerZip" data-delta="-1">−</button>
          <input class="cgx-input small" type="number" data-number="chatsPerZip" value="${esc(state.chatsPerZip)}">
          <button class="cgx-step" data-step="chatsPerZip" data-delta="1">+</button>
        </div>
      </div>`;
  }

  function timeoutBlock() {
    return `
      <div class="cgx-number-block">
        <div class="cgx-label full">Délai développeur en secondes</div>
        <div class="cgx-number-controls">
          <button class="cgx-step" data-step="timeout" data-delta="-10">−</button>
          <input class="cgx-input timeout" type="number" data-number="timeout" value="${esc(state.timeout)}">
          <span class="cgx-unit">s</span>
          <button class="cgx-step" data-step="timeout" data-delta="10">+</button>
        </div>
      </div>`;
  }

  function yesNoRow(label, key) {
    return `
      <div class="cgx-row yesno">
        <span class="cgx-label">${esc(label)}</span>
        <button class="cgx-choice ${!state[key] ? 'selected no' : ''}" data-bool="${key}" data-value="false">Non</button>
        <button class="cgx-choice ${state[key] ? 'selected yes' : ''}" data-bool="${key}" data-value="true">Oui</button>
      </div>`;
  }

  function locationRow() {
    return `${yesNoRow('Choisir l’emplacement de sauvegarde', 'askSave')}`;
  }

  function statusLine() {
    return `<div class="cgx-status-line"><span>Statut :</span><strong>${esc(runtime.status)}</strong></div>`;
  }

  function devPanel() {
    if (!state.dev) return '';
    const folder = runtime.downloadTarget || (runtime.folderHandle ? runtime.folderHandle.name : 'non défini');
    return `
      <div class="cgx-dev-box">
        <div class="cgx-dev-title">MODE DÉVELOPPEUR</div>
        ${timeoutBlock()}
        <div class="cgx-row target">
          <span class="cgx-label">Dossier cible</span>
          <span class="cgx-folder">${esc(folder)}</span>
          <button class="cgx-small" data-action="pick-folder">Choisir</button>
          <button class="cgx-small" data-action="clear-folder">Effacer</button>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:3px;flex:0 0 auto">
          <button class="cgx-small" data-action="export-log" title="Exporter le journal développeur" style="min-height:18px;padding:1px 6px;font-size:8px">LOG</button>
        </div>
        <pre class="cgx-logs">${esc([
          `mode=${state.mode}`,
          `exportMode=${state.exportMode}`,
          `projectFullUi=${state.projectFullUi}`,
          `allFullUi=${state.allFullUi}`,
          `projectSourcesUi=${state.projectSourcesUi}`,
          `exportUploadedFiles=${state.exportUploadedFiles}`,
          `exportDownloadedFiles=${state.exportDownloadedFiles}`,
          `visible=${state.visible}`,
          `exporting=${runtime.exporting}`,
          `setOwnLocation=${state.askSave}`,
          `chatsPerZip=${state.chatsPerZip}`,
          `timeout=${state.timeout}s`,
          `folder=${folder}`,
          '',
          'INDEX D’EXPORT',
          `index.startedAt=${runtime.metrics.exportStartedAt}`,
          `index.exportMode=${runtime.metrics.exportMode}`,
          `index.scrollElement=${runtime.metrics.scrollElement}`,
          `index.crawlScrollElement=${runtime.metrics.crawlScrollElement}`,
          `index.topLoadIterations=${runtime.metrics.topLoadIterations}`,
          `index.crawlSteps=${runtime.metrics.crawlSteps}`,
          `index.expandPasses=${runtime.metrics.expandPasses}`,
          `index.showMoreRounds=${runtime.metrics.showMoreRounds}`,
          `index.showMoreClicked=${runtime.metrics.showMoreClicked}`,
          `index.expandErrors=${runtime.metrics.expandErrors}`,
          `index.collectErrors=${runtime.metrics.collectErrors}`,
          `index.domArticleTurns=${runtime.metrics.domArticleTurns}`,
          `index.domRoleNodes=${runtime.metrics.domRoleNodes}`,
          `index.domGenericMessageNodes=${runtime.metrics.domGenericMessageNodes}`,
          `index.containersSeen=${runtime.metrics.containersSeen}`,
          `index.messagesCollected=${runtime.metrics.messagesCollected}`,
          `index.messagesAfterRange=${runtime.metrics.messagesAfterRange}`,
          `index.markdownChars=${runtime.metrics.markdownChars}`,
          `index.loopBreakReason=${runtime.metrics.loopBreakReason}`,
          `index.filename=${runtime.metrics.filename}`,
          `project.name=${runtime.metrics.projectName}`,
          `project.chatsDiscovered=${runtime.metrics.projectChatsDiscovered}`,
          `project.chatsCompleted=${runtime.metrics.projectChatsCompleted}`,
          `project.chatsFailed=${runtime.metrics.projectChatsFailed}`,
          `project.totalMessages=${runtime.metrics.projectTotalMessages}`,
          `project.userMessages=${runtime.metrics.projectUserMessages}`,
          `project.agentMessages=${runtime.metrics.projectAgentMessages}`,
          `project.attachmentsFound=${runtime.metrics.projectAttachmentsFound}`,
          `project.attachmentsDownloaded=${runtime.metrics.projectAttachmentsDownloaded}`,
          `project.attachmentsFailed=${runtime.metrics.projectAttachmentsFailed}`,
          `project.downloadsFound=${runtime.metrics.projectDownloadsFound}`,
          `project.downloadsDownloaded=${runtime.metrics.projectDownloadsDownloaded}`,
          `project.downloadsFailed=${runtime.metrics.projectDownloadsFailed}`,
          `project.zipBytes=${runtime.metrics.projectZipBytes}`,
          `project.zipFilename=${runtime.metrics.projectZipFilename}`,
          '',
          ...runtime.logs.slice(-35)
        ].join('\n'))}</pre>
      </div>`;
  }

  function resizeHandles() {
    return `
      <span class="cgx-resize-handle cgx-resize-n" data-resize="n" title="Redimensionner"></span>
      <span class="cgx-resize-handle cgx-resize-e" data-resize="e" title="Redimensionner"></span>
      <span class="cgx-resize-handle cgx-resize-s" data-resize="s" title="Redimensionner"></span>
      <span class="cgx-resize-handle cgx-resize-w" data-resize="w" title="Redimensionner"></span>
      <span class="cgx-resize-handle cgx-resize-ne" data-resize="ne" title="Redimensionner"></span>
      <span class="cgx-resize-handle cgx-resize-nw" data-resize="nw" title="Redimensionner"></span>
      <span class="cgx-resize-handle cgx-resize-se" data-resize="se" title="Redimensionner"></span>
      <span class="cgx-resize-handle cgx-resize-sw" data-resize="sw" title="Redimensionner"></span>`;
  }

  function renderMaxi() {
    return `
      ${header()}
      ${statusLine()}
      ${rangeBlock()}
      ${messageNumberBlock()}
      ${chatsPerZipBlock()}
      ${locationRow()}
      <div class="cgx-actions">
        <button class="cgx-export" data-action="export">Démarrer l’export</button>
        <button class="cgx-stop" data-action="stop" ${runtime.exporting ? '' : 'disabled'}>Arrêter l’export</button>
      </div>
      ${devPanel()}
      ${resizeHandles()}`;
  }

  function renderMini() {
    return `
      <div class="cgx-mini-wrap" data-drag="true">
        <div class="cgx-mini-top">
          <span class="cgx-mini-title">Export</span>
          <button class="cgx-head-btn mini-up" data-action="mode-up" title="Maxi">‹</button>
          <button class="cgx-head-btn dot mini-dot" data-action="mode-down" title="Mode bouton">•</button>
        </div>
        <button class="cgx-mini-main" data-action="export">${runtime.exporting ? 'Arrêter l’export' : 'Démarrer l’export'}</button>
        <div class="cgx-mini-range">
          ${allFullUiButton('TOUS', true)}
          ${rangeButton('full', 'COMPLET')}
          ${rangeButton('start', 'DÉBUT')}
          ${rangeButton('end', 'FIN')}
        </div>
        ${projectUiButton('PROJET', true)}
        ${fileExportToggleButton('uploaded', 'FICHIERS ENVOYÉS', true)}
        ${fileExportToggleButton('downloaded', 'FICHIERS TÉLÉCH.', true)}
        <div class="cgx-mini-msg-row">
          <span class="cgx-mini-label">#MSG</span>
          <button class="cgx-step" data-step="messages" data-delta="-1">−</button>
          <input class="cgx-input mini-input" type="number" data-number="messages" value="${esc(state.messages)}">
          <button class="cgx-step" data-step="messages" data-delta="1">+</button>
        </div>
        <div class="cgx-mini-msg-row">
          <span class="cgx-mini-label">#inZip</span>
          <button class="cgx-step" data-step="chatsPerZip" data-delta="-1">−</button>
          <input class="cgx-input mini-input" type="number" data-number="chatsPerZip" value="${esc(state.chatsPerZip)}">
          <button class="cgx-step" data-step="chatsPerZip" data-delta="1">+</button>
        </div>
        <div class="cgx-mini-loc-row">
          <span class="cgx-mini-label">LOC</span>
          <button class="cgx-choice ${!state.askSave ? 'selected no' : ''}" data-bool="askSave" data-value="false">Non</button>
          <button class="cgx-choice ${state.askSave ? 'selected yes' : ''}" data-bool="askSave" data-value="true">Oui</button>
        </div>
        <div class="cgx-status mini">${esc(runtime.status)}</div>
        <div class="cgx-footer-mini">@NoXoZ.be<br>${state.dev ? `v${VERSION} ${PATCH}` : `v${VERSION}`}</div>
      </div>`;
  }

  function renderButton() {
    return `
      <div class="cgx-button-shell" data-drag="true">
        <button class="cgx-button-exp ${runtime.exporting ? 'running' : ''}" data-action="button-export" title="Clic : exporter/arrêter. Double-clic : mode Mini.">EXP</button>
      </div>`;
  }

  function render() {
    if (!widget) return;
    widget.className = `cgx-mode-${state.mode} ${state.dev ? 'cgx-dev' : ''} ${runtime.exporting ? 'cgx-exporting' : ''}`;
    widget.dataset.cgxBatchExport = (!runtime.exporting && (state.projectFullUi || state.allFullUi)) ? '1' : '0';
    widget.dataset.cgxExporting = runtime.exporting ? '1' : '0';
    widget.dataset.cgxAutosave = 'p24';
    widget.style.display = state.visible ? '' : 'none';
    if (!state.visible) return;
    applyModeSize();
    if (state.mode === 'button') widget.innerHTML = renderButton();
    else if (state.mode === 'maxi') widget.innerHTML = renderMaxi();
    else widget.innerHTML = renderMini();
    bindEvents();
  }

  function bindEvents() {
    widget.querySelectorAll('button, input').forEach((el) => {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });

    widget.querySelectorAll('[data-mode]').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      await setMode(el.dataset.mode);
    }));

    widget.querySelectorAll('[data-action]').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const action = el.dataset.action;
      if (action === 'button-export') return buttonSingleClick();
      if (action === 'toggle-dev') { state.dev = !state.dev; await saveState(); render(); }
      if (action === 'mode-down') await modeDown();
      if (action === 'mode-up') await modeUp();
      if (action === 'export') {
        await exportOrStop(false);
      }
      if (action === 'stop') requestStop();
      if (action === 'reload') reloadExt();
      if (action === 'pick-folder') await pickFolder();
      if (action === 'clear-folder') { runtime.folderHandle = null; await clearBatchFolderHandle(); setStatus('Cible effacée'); render(); }
      if (action === 'export-log') exportDevLog();
    }));

    const exp = widget.querySelector('.cgx-button-exp');
    if (exp) exp.addEventListener('dblclick', async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (buttonClickTimer) clearTimeout(buttonClickTimer);
      buttonClickTimer = null;
      await setMode('mini');
    });

    widget.querySelectorAll('[data-all-ui]').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      state.allFullUi = !state.allFullUi;
      if (state.allFullUi) { state.projectFullUi = false; state.projectSourcesUi = false; }
      await saveState(); render();
    }));

    widget.querySelectorAll('[data-project-ui]').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      state.projectFullUi = !state.projectFullUi;
      if (state.projectFullUi) { state.allFullUi = false; state.projectSourcesUi = false; }
      await saveState(); render();
    }));

    widget.querySelectorAll('[data-project-sources-ui]').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      state.projectSourcesUi = !state.projectSourcesUi;
      if (state.projectSourcesUi) {
        state.projectFullUi = false;
        state.allFullUi = false;
      }
      await saveState(); render();
    }));

    widget.querySelectorAll('[data-file-export-toggle]').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const kind = el.dataset.fileExportToggle;
      if (kind === 'uploaded') state.exportUploadedFiles = !state.exportUploadedFiles;
      if (kind === 'downloaded') state.exportDownloadedFiles = !state.exportDownloadedFiles;
      await saveState(); render();
    }));

    widget.querySelectorAll('[data-range]').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      state.projectFullUi = false;
      state.allFullUi = false;
      state.projectSourcesUi = false;
      state.exportMode = el.dataset.range;
      await saveState(); render();
    }));

    widget.querySelectorAll('[data-bool]').forEach((el) => el.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      state[el.dataset.bool] = el.dataset.value === 'true';
      await saveState(); render();
    }));

    widget.querySelectorAll('[data-number]').forEach((el) => el.addEventListener('change', async () => {
      commitNumber(el.dataset.number, el.value);
      await saveState(); render();
    }));

    widget.querySelectorAll('[data-step]').forEach((el) => {
      const run = async () => { stepNumber(el.dataset.step, Number(el.dataset.delta) || 0); await saveState(); render(); };
      el.addEventListener('click', run);
      el.addEventListener('pointerdown', () => {
        clearRepeat();
        repeatTimer = setTimeout(() => { repeatInterval = setInterval(run, 80); }, 350);
      });
    });
  }

  function buttonSingleClick() {
    if (buttonClickTimer) clearTimeout(buttonClickTimer);
    buttonClickTimer = setTimeout(() => {
      buttonClickTimer = null;
      exportOrStop(true, true, true);
    }, 220);
  }

  async function exportOrStop(forceFull = false, forceAskSave = false, forceChat = false) {
    if (runtime.exporting) {
      requestStop();
      return;
    }
    // p18 : Projet/TOUS démarrent immédiatement ; chrome.downloads choisit l’enregistrement automatique ou Enregistrer sous selon state.askSave.
    const canStart = await prepareBatchFolderFromStartGesture(forceAskSave, forceChat);
    if (!canStart) return;
    await startExport(forceFull, forceAskSave, forceChat);
  }

  function clearRepeat() {
    if (repeatTimer) clearTimeout(repeatTimer);
    if (repeatInterval) clearInterval(repeatInterval);
    repeatTimer = null; repeatInterval = null;
  }
  document.addEventListener('pointerup', clearRepeat, true);
  document.addEventListener('pointercancel', clearRepeat, true);

  function commitNumber(key, value) {
    if (key === 'messages') state.messages = clamp(value, 1, 9999, 25);
    if (key === 'chatsPerZip') state.chatsPerZip = clamp(value, 1, 9999, 50);
    if (key === 'timeout') state.timeout = clamp(value, 1, 9999, 600);
  }
  function stepNumber(key, delta) { commitNumber(key, Number(state[key]) + delta); }

  async function setMode(mode) {
    if (!['button', 'mini', 'maxi'].includes(mode)) return;
    saveCurrentPosition();
    saveCurrentSize();
    const previousMode = state.mode;
    state.mode = mode;
    state.visible = true;
    if (mode === 'maxi' && previousMode !== 'maxi') {
      state.dev = false;
    }
    await saveState();
    render();
    applyStoredOrDefaultPosition();
    await saveState();
  }
  async function modeDown() {
    if (state.mode === 'maxi') return setMode('mini');
    if (state.mode === 'mini') return setMode('button');
  }
  async function modeUp() {
    if (state.mode === 'button') return setMode('mini');
    if (state.mode === 'mini') return setMode('maxi');
  }

  function saveCurrentPosition() {
    if (!widget || !state.visible) return;
    const r = widget.getBoundingClientRect();
    state.positions[state.mode] = { left: Math.round(r.left), top: Math.round(r.top) };
  }

  function defaultPosition(mode) {
    const w = widget?.offsetWidth || 240;
    const h = widget?.offsetHeight || 140;
    const safe = 8;
    const bottomOffset = mode === 'button' ? 72 : mode === 'mini' ? 82 : 96;
    const xRatio = mode === 'button' ? 0.80 : mode === 'mini' ? 0.78 : 0.70;
    const left = Math.round(window.innerWidth * xRatio);
    const top = Math.round(window.innerHeight - h - bottomOffset);
    return {
      left: Math.min(Math.max(safe, left), Math.max(safe, window.innerWidth - w - safe)),
      top: Math.min(Math.max(safe, top), Math.max(safe, window.innerHeight - h - safe))
    };
  }

  function applyPosition(pos) {
    if (!widget || !pos) return;
    const w = widget.offsetWidth || 240;
    const h = widget.offsetHeight || 140;
    const left = Math.max(8, Math.min(Number(pos.left) || 8, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(Number(pos.top) || 8, window.innerHeight - h - 8));
    widget.style.left = `${left}px`;
    widget.style.top = `${top}px`;
    widget.style.right = 'auto';
    widget.style.bottom = 'auto';
    state.positions[state.mode] = { left: Math.round(left), top: Math.round(top) };
  }

  function applyStoredOrDefaultPosition() { applyPosition(state.positions[state.mode] || defaultPosition(state.mode)); }

  function clampWidgetSize(size) {
    const userMinWidth = 248;
    const devMinWidth = 300;
    const minWidth = state.dev ? devMinWidth : userMinWidth;
    const minHeight = 260;
    const defaultWidth = state.dev ? 314 : 274;
    const maxWidth = Math.max(minWidth, window.innerWidth - 16);
    const maxHeight = Math.max(minHeight, window.innerHeight - 16);
    return {
      width: clamp(size?.width, minWidth, maxWidth, defaultWidth),
      height: clamp(size?.height, minHeight, maxHeight, 420)
    };
  }

  function applyModeSize() {
    if (!widget) return;
    if (state.mode !== 'maxi') {
      widget.style.width = '';
      widget.style.height = '';
      return;
    }
    const size = state.sizes?.maxi ? clampWidgetSize(state.sizes.maxi) : null;
    if (size) {
      widget.style.width = `${size.width}px`;
      widget.style.height = `${size.height}px`;
    } else {
      widget.style.width = '';
      widget.style.height = '';
    }
  }

  function saveCurrentSize() {
    if (!widget || state.mode !== 'maxi' || !state.visible) return;
    const r = widget.getBoundingClientRect();
    const size = clampWidgetSize({ width: r.width, height: r.height });
    state.sizes.maxi = { width: size.width, height: size.height };
  }

  function applyResizeBox(left, top, width, height) {
    if (!widget) return;
    const safe = 8;
    const size = clampWidgetSize({ width, height });
    width = size.width;
    height = size.height;
    left = Math.max(safe, Math.min(Math.round(left), window.innerWidth - width - safe));
    top = Math.max(safe, Math.min(Math.round(top), window.innerHeight - height - safe));
    widget.style.left = `${left}px`;
    widget.style.top = `${top}px`;
    widget.style.right = 'auto';
    widget.style.bottom = 'auto';
    widget.style.width = `${width}px`;
    widget.style.height = `${height}px`;
    state.positions.maxi = { left: Math.round(left), top: Math.round(top) };
    state.sizes.maxi = { width: Math.round(width), height: Math.round(height) };
  }

  function requestStop() {
    if (!runtime.exporting) return;
    runtime.stop = true;
    try { chrome.runtime.sendMessage({ type: 'CGX_CANCEL_LIVE_PROJECT_EXPORT' }); } catch { /* ignoré */ }
    setStatus('Arrêt…');
  }

  function guard(started) {
    if (runtime.stop) throw new Error('STOPPED_BY_USER');
    if (Date.now() - started > state.timeout * 1000) throw new Error('TIMEOUT');
  }

  async function startExport(forceFull = false, forceAskSave = false, forceChat = false) {
    if (runtime.exporting) return;
    if (state.projectSourcesUi && !forceChat) {
      await exportAllProjectSources();
      return;
    }
    if (state.allFullUi && !forceChat) {
      await startAllChatExport(true);
      return;
    }
    if (state.projectFullUi && !forceChat) {
      await startProjectExport(true);
      return;
    }
    runtime.exporting = true;
    runtime.stop = false;
    const effectiveExportMode = forceFull ? 'full' : state.exportMode;
    const effectiveAskSave = forceAskSave ? true : state.askSave;
    resetMetrics(effectiveExportMode);
    runtime.clickedExpandKeys = new Set();
    log(`index start exportMode=${effectiveExportMode}${forceAskSave ? ' savePicker=forced' : ''}`);
    await saveState();
    setStatus('Préparation…');
    const started = Date.now();
    let saveHandle = null;
    try {
      const identity = getExportIdentity();
      const title = identity.displayTitle;
      const markdownFilename = makeFilename(identity);
      const fullChatZipFilename = markdownFilenameToZipFilename(markdownFilename);
      const outputFilename = effectiveExportMode === 'full' ? fullChatZipFilename : markdownFilename;
      runtime.metrics.filename = outputFilename;
      log(`identity project=${identity.projectName || 'n/a'} chat=${identity.chatTitle || 'n/a'} inProject=${identity.inProject ? 'yes' : 'no'}`);

      if (!runtime.folderHandle && effectiveAskSave) {
        if (typeof window.showSaveFilePicker === 'function') {
          setStatus('Choisissez l’emplacement d’enregistrement…');
          if (effectiveExportMode === 'full') {
            saveHandle = await window.showSaveFilePicker({
              suggestedName: fullChatZipFilename,
              types: [{ description: 'Archive ZIP', accept: { 'application/zip': ['.zip'] } }]
            });
          } else {
            saveHandle = await window.showSaveFilePicker({
              suggestedName: markdownFilename,
              types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }]
            });
          }
        } else {
          log('save picker unsupported; fallback to browser download');
          setStatus('Sélecteur d’enregistrement non pris en charge ; utilisation de Téléchargements…');
          await sleep(350);
        }
      }

      setStatus('Export en cours…');
      let messages = await collectConversationForExport(started, effectiveExportMode);
      if (effectiveExportMode === 'start') messages = messages.slice(0, state.messages);
      if (effectiveExportMode === 'end') messages = messages.slice(Math.max(0, messages.length - state.messages));
      runtime.metrics.messagesAfterRange = messages.length;
      if (!messages.length) throw new Error('NO_MESSAGES');
      if (state.exportUploadedFiles) await mergeConversationApiUploadsIntoMessages(messages);
      if (state.exportDownloadedFiles) await mergeConversationApiDownloadsIntoMessages(messages);
      const markdown = buildMarkdown(title, messages);
      runtime.metrics.markdownChars = markdown.length;
      log(indexLogLine());
      log(`exported messages=${messages.length} chars=${markdown.length}`);
      guard(started);

      if (effectiveExportMode === 'full') {
        setStatus('Création du ZIP du chat…');
        const chatZip = await buildFullChatZip(markdownFilename, markdown, messages, started);
        runtime.metrics.filename = chatZip.zipFilename;
        await saveZip(chatZip.zipFilename, chatZip.zipBytes, saveHandle);
        setStatus(`Enregistré : ${chatZip.zipFilename}`);
        log(`saved ${chatZip.zipFilename}`);
      } else {
        await saveMarkdown(markdownFilename, markdown, saveHandle);
        setStatus(`Enregistré : ${markdownFilename}`);
        log(`saved ${markdownFilename}`);
      }
    } catch (error) {
      if (String(error.message) === 'STOPPED_BY_USER') setStatus('Arrêté');
      else if (String(error.message) === 'TIMEOUT') setStatus('Délai dépassé');
      else if (String(error.name) === 'AbortError') setStatus('Enregistrement annulé');
      else setStatus(`Erreur : ${error.message || error}`);
      log(`error ${error.message || error}`);
    } finally {
      runtime.exporting = false;
      runtime.stop = false;
      render();
    }
  }


  function projectChatMatchesBase(path, basePath) {
    const p = String(path || '').replace(/\/+$/, '');
    const base = String(basePath || '').replace(/\/+$/, '');
    return Boolean(base && p.startsWith(`${base}/`) && /\/c\/[a-z0-9-]{10,}/i.test(p));
  }

  function sameProjectName(a, b) {
    const clean = (value) => norm(value)
      .replace(/^open\s+/i, '')
      .replace(/\s+project$/i, '')
      .replace(/^project\s*[-:]*\s*/i, '')
      .toLowerCase();
    const aa = clean(a);
    const bb = clean(b);
    return Boolean(aa && bb && aa === bb);
  }

  function projectScopedRoots(basePath, projectName) {
    const candidates = [];
    const projectElements = new Set();

    document.querySelectorAll('a[href], button, [role="button"], [data-testid], [aria-label], [title]').forEach((el) => {
      try {
        if (!el || el.closest?.(`#${WIDGET_ID}`)) return;
        const href = rawHref(el);
        const path = sameOriginPath(href);
        const text = candidateText(
          el.getAttribute?.('aria-label')
          || el.getAttribute?.('title')
          || el.getAttribute?.('data-title')
          || el.innerText
          || el.textContent
          || ''
        );
        const byPath = Boolean(basePath && path === basePath);
        const byName = Boolean(projectName && sameProjectName(text, projectName));
        if (byPath || byName) projectElements.add(el);
      } catch { /* ignoré */ }
    });

    for (const el of projectElements) {
      let node = el;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        try {
          if (node.closest?.(`#${WIDGET_ID}`)) continue;
          const chatLinks = Array.from(node.querySelectorAll?.('a[href*="/c/"]') || []);
          if (!chatLinks.length) continue;

          const projectLinks = Array.from(node.querySelectorAll?.('a[href*="/g/g-p-"], a[href*="/project/"], a[href*="/projects/"]') || [])
            .filter((a) => looksLikeProjectPath(sameOriginPath(rawHref(a))));

          // Préfère le plus petit groupe local contenant les chats et le projet courant,
          // plutôt que toute la barre latérale qui contient de nombreux projets différents.
          const foreignProjects = projectLinks.filter((a) => {
            const p = sameOriginPath(rawHref(a));
            return basePath && p && p !== basePath;
          }).length;

          candidates.push({
            node,
            chatCount: chatLinks.length,
            foreignProjects,
            depth,
            score: (foreignProjects * 1000) + (chatLinks.length * 10) + depth
          });
        } catch { /* ignoré */ }
      }
    }

    candidates.sort((a, b) => a.score - b.score);
    const roots = [];
    for (const item of candidates) {
      if (!roots.some((r) => r === item.node || r.contains?.(item.node) || item.node.contains?.(r))) {
        roots.push(item.node);
      }
      if (roots.length >= 4) break;
    }
    return roots;
  }

  function projectLinkBelongsToCurrentProject(a, path, basePath, projectName, scopedRoots) {
    if (projectChatMatchesBase(path, basePath)) return { ok: true, reason: 'project-path' };

    const rawLabel = norm([
      a.getAttribute?.('aria-label') || '',
      a.getAttribute?.('title') || '',
      a.getAttribute?.('data-title') || '',
      a.innerText || '',
      a.textContent || ''
    ].filter(Boolean).join(' '));
    const parsed = parseChatProjectLabel(rawLabel);
    if (parsed.project && sameProjectName(parsed.project, projectName)) {
      return { ok: true, reason: 'project-label', parsed };
    }

    if (scopedRoots.some((root) => root === a || root.contains?.(a))) {
      return { ok: true, reason: 'project-scope', parsed };
    }

    return { ok: false, reason: 'outside-project', parsed };
  }

  function normalizedProjectChatUrl(href, path, basePath, cid) {
    try {
      if (projectChatMatchesBase(path, basePath)) {
        return new URL(href, location.href).href.split('#')[0];
      }
      // ChatGPT peut exposer dans la barre latérale les liens des chats de projet sous la forme /c/<id>.
      // Conserve explicitement le contexte du projet lors de leur navigation.
      if (basePath && cid) {
        return new URL(`${basePath}/c/${cid}`, location.origin).href;
      }
      return new URL(href, location.href).href.split('#')[0];
    } catch {
      return `${location.origin}${basePath}/c/${cid}`;
    }
  }

  function collectProjectChatLinks(basePath, projectName, out) {
    const target = out || new Map();
    const scopedRoots = projectScopedRoots(basePath, projectName);
    let anchorsSeen = 0;
    let accepted = 0;

    document.querySelectorAll('a[href*="/c/"]').forEach((a) => {
      try {
        anchorsSeen += 1;
        const href = rawHref(a);
        const path = sameOriginPath(href);
        const cid = conversationIdFromPath(path);
        if (!cid || target.has(cid)) return;

        const belongs = projectLinkBelongsToCurrentProject(
          a, path, basePath, projectName, scopedRoots
        );
        if (!belongs.ok) return;

        const rawLabel = norm([
          a.getAttribute?.('aria-label') || '',
          a.getAttribute?.('title') || '',
          a.getAttribute?.('data-title') || '',
          a.innerText || '',
          a.textContent || ''
        ].filter(Boolean).join(' '));
        const parsed = belongs.parsed || parseChatProjectLabel(rawLabel);
        const title = candidateText(parsed.chat || titleCandidateFromElement(a) || '');
        const url = normalizedProjectChatUrl(href, path, basePath, cid);
        target.set(cid, { id: cid, url, titleHint: title });
        accepted += 1;
      } catch { /* ignoré */ }
    });

    const curPath = currentPath();
    const curId = conversationIdFromPath(curPath);
    if (curId && projectChatMatchesBase(curPath, basePath) && !target.has(curId)) {
      const identity = getExportIdentity();
      target.set(curId, {
        id: curId,
        url: location.href.split('#')[0],
        titleHint: identity.chatTitle || ''
      });
      accepted += 1;
    }

    log(`project discovery scan anchors=${anchorsSeen} scopedRoots=${scopedRoots.length} acceptedNow=${accepted} total=${target.size}`);
    return target;
  }

  function projectNavigationRoots(basePath, projectName) {
    const roots = new Set(projectScopedRoots(basePath, projectName));
    const selectors = ['nav', 'aside', '[data-testid*="sidebar" i]', '[class*="sidebar" i]'];
    selectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el) => {
          if (el.closest?.(`#${WIDGET_ID}`)) return;
          const hasProject = Array.from(el.querySelectorAll?.('a[href]') || []).some((a) => {
            const path = sameOriginPath(rawHref(a));
            return path === basePath || projectChatMatchesBase(path, basePath);
          });
          if (hasProject && roots.size === 0) roots.add(el);
        });
      } catch { /* ignoré */ }
    });
    return Array.from(roots);
  }

  function sidebarScrollableNodes(roots) {
    const nodes = new Set();
    for (const root of roots) {
      [root, ...Array.from(root.querySelectorAll?.('*') || [])].forEach((el) => {
        try {
          if (!el || el.closest?.(`#${WIDGET_ID}`)) return;
          if ((el.scrollHeight || 0) <= (el.clientHeight || 0) + 40) return;
          const oy = getComputedStyle(el).overflowY || '';
          if (/auto|scroll|overlay/i.test(oy)) nodes.add(el);
        } catch { /* ignoré */ }
      });
    }
    return Array.from(nodes).slice(0, 12);
  }

  async function clickProjectShowMore(roots) {
    let clicks = 0;
    const re = /^(show more|view more|load more|afficher plus|voir plus|plus de discussions|plus de chats)$/i;
    for (const root of roots) {
      const controls = Array.from(root.querySelectorAll?.('button, a[role="button"], [role="button"]') || []);
      for (const el of controls) {
        try {
          if (!isVisibleElement(el)) continue;
          const text = norm(el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '');
          if (!re.test(text)) continue;
          el.click();
          clicks += 1;
          await sleep(180);
        } catch { /* ignoré */ }
      }
    }
    return clicks;
  }

  async function discoverProjectChats(started, basePath, projectName) {
    const found = new Map();
    const roots = projectNavigationRoots(basePath, projectName);
    const scrollables = sidebarScrollableNodes(roots);
    const savedScroll = scrollables.map((el) => ({ el, top: el.scrollTop || 0 }));
    let stable = 0;
    let previous = -1;
    try {
      for (let pass = 0; pass < 32 && stable < 4; pass += 1) {
        if (runtime.stop) throw new Error('STOPPED_BY_USER');
        collectProjectChatLinks(basePath, projectName, found);
        await clickProjectShowMore(roots);
        for (const el of scrollables) {
          try { el.scrollTop = el.scrollHeight; } catch { /* ignoré */ }
        }
        await sleep(240);
        collectProjectChatLinks(basePath, projectName, found);
        stable = found.size === previous ? stable + 1 : 0;
        previous = found.size;
        setStatus(`Recherche du projet… ${found.size} chats`);
      }
    } finally {
      savedScroll.forEach(({ el, top }) => { try { el.scrollTop = top; } catch { /* ignoré */ } });
    }
    const list = Array.from(found.values());
    log(`project discovered chats=${list.length} base=${basePath} name=${projectName}`);
    list.forEach((chat, idx) => log(`project discovered ${idx + 1}/${list.length} ${chat.titleHint || 'untitled'} ${chat.url}`));
    return list;
  }

  function humanLocalDateTime(value = new Date()) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return [
      d.getFullYear(),
      pad(d.getMonth() + 1),
      pad(d.getDate())
    ].join('-') + ' ' + [
      pad(d.getHours()),
      pad(d.getMinutes()),
      pad(d.getSeconds())
    ].join(':');
  }

  function projectStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`;
  }

  function batchChatFilenameToken(chats = []) {
    const names = (Array.isArray(chats) ? chats : [])
      .map((c) => underscoreToken(c?.chatTitle || c?.titleHint || c?.title || '', ''))
      .filter(Boolean);
    if (!names.length) return 'Chat';
    const trim = (v) => String(v).slice(0, 60).replace(/_+$/g, '') || 'Chat';
    if (names.length === 1) return `Chat_${trim(names[0])}`;
    return `Chats_${trim(names[0])}__to__${trim(names[names.length - 1])}`;
  }

  function makeProjectZipFilename(projectName, stamp = projectStamp(), batchIndex = 1, totalBatches = 1, browserName = '', accountName = '', chats = []) {
    const browserPart = underscoreToken(browserName || 'Browser', 'Browser');
    const accountPart = underscoreToken(accountName || 'ChatGPT Account', 'ChatGPT_Account');
    const chatPart = batchChatFilenameToken(chats);
    const prefix = `Full_Project_${underscoreToken(projectName, 'Project')}__${chatPart}__${browserPart}__${accountPart}__export_${stamp}`;
    if (totalBatches > 1) return `${prefix}__part_${String(batchIndex).padStart(3, '0')}_of_${String(totalBatches).padStart(3, '0')}.zip`;
    return `${prefix}.zip`;
  }

  function buildProjectIndex(projectName, results, failures, exportedAt) {
    const total = results.reduce((n, r) => n + Number(r.totalMessages || 0), 0);
    const user = results.reduce((n, r) => n + Number(r.userMessages || 0), 0);
    const agent = results.reduce((n, r) => n + Number(r.agentMessages || 0), 0);
    const lines = [
      `# Projet complet - ${projectName}`,
      '',
      `Projet : ${projectName}`,
      `Date/heure d’export : ${exportedAt}`,
      `Nombre total de chats : ${results.length}`,
      `Nombre total de messages : ${total}`,
      `Messages utilisateur : ${user}`,
      `Messages assistant : ${agent}`,
      '',
      '---',
      '',
      '## Chats',
      ''
    ];
    results.forEach((r, idx) => {
      lines.push(`${idx + 1}. **${r.chatTitle || r.filename}**`);
      lines.push(`   - Fichier : \`${r.filename}\``);
      lines.push(`   - Nombre total de messages : ${r.totalMessages || 0}`);
      lines.push(`   - Messages utilisateur : ${r.userMessages || 0}`);
      lines.push(`   - Messages assistant : ${r.agentMessages || 0}`);
      const uploadedFiles = Array.isArray(r.attachments) ? r.attachments : [];
      lines.push(`   - Fichiers envoyés : ${uploadedFiles.length}`);
      uploadedFiles.forEach((attachment) => {
        const uploadedName = cleanUploadedFilename(attachment?.name || '');
        if (uploadedName) lines.push(`      - ${uploadedName}`);
      });

      const filesToDownload = Array.isArray(r.downloads) ? r.downloads : [];
      lines.push(`   - Fichiers à télécharger : ${filesToDownload.length}`);
      filesToDownload.forEach((entry) => {
        const downloadName = cleanUploadedFilename(entry?.name || '');
        if (downloadName) lines.push(`      - ${downloadName}`);
      });
      lines.push('');
    });
    if (failures.length) {
      lines.push('---', '', '## Erreurs d’export', '');
      failures.forEach((f, idx) => lines.push(`${idx + 1}. ${f.titleHint || f.url || 'Chat inconnu'} — ${f.error || 'EXPORT_FAILED'}`));
      lines.push('');
    }
    return lines.join('\n').trim() + '\n';
  }

  function crc32(bytes) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < bytes.length; i += 1) {
      crc ^= bytes[i];
      for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (crc ^ (-1)) >>> 0;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31);
    const dosDate = (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
    return { dosTime, dosDate };
  }

  function writeU16(view, offset, value) { view.setUint16(offset, value & 0xffff, true); }
  function writeU32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  function makeStoredZip(files) {
    const enc = new TextEncoder();
    const entries = [];
    let localOffset = 0;
    const nowDate = new Date();
    const { dosTime, dosDate } = dosDateTime(nowDate);
    for (const file of files) {
      const nameBytes = enc.encode(file.name);
      const data = typeof file.content === 'string' ? enc.encode(file.content) : file.content;
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length + data.length);
      const v = new DataView(local.buffer);
      writeU32(v, 0, 0x04034b50);
      writeU16(v, 4, 20);
      writeU16(v, 6, 0x0800);
      writeU16(v, 8, 0);
      writeU16(v, 10, dosTime);
      writeU16(v, 12, dosDate);
      writeU32(v, 14, crc);
      writeU32(v, 18, data.length);
      writeU32(v, 22, data.length);
      writeU16(v, 26, nameBytes.length);
      writeU16(v, 28, 0);
      local.set(nameBytes, 30);
      local.set(data, 30 + nameBytes.length);
      entries.push({ nameBytes, dataLength: data.length, crc, localOffset, local });
      localOffset += local.length;
    }
    const centralParts = [];
    let centralSize = 0;
    for (const e of entries) {
      const c = new Uint8Array(46 + e.nameBytes.length);
      const v = new DataView(c.buffer);
      writeU32(v, 0, 0x02014b50);
      writeU16(v, 4, 20);
      writeU16(v, 6, 20);
      writeU16(v, 8, 0x0800);
      writeU16(v, 10, 0);
      writeU16(v, 12, dosTime);
      writeU16(v, 14, dosDate);
      writeU32(v, 16, e.crc);
      writeU32(v, 20, e.dataLength);
      writeU32(v, 24, e.dataLength);
      writeU16(v, 28, e.nameBytes.length);
      writeU16(v, 30, 0);
      writeU16(v, 32, 0);
      writeU16(v, 34, 0);
      writeU16(v, 36, 0);
      writeU32(v, 38, 0);
      writeU32(v, 42, e.localOffset);
      c.set(e.nameBytes, 46);
      centralParts.push(c);
      centralSize += c.length;
    }
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    writeU32(ev, 0, 0x06054b50);
    writeU16(ev, 4, 0);
    writeU16(ev, 6, 0);
    writeU16(ev, 8, entries.length);
    writeU16(ev, 10, entries.length);
    writeU32(ev, 12, centralSize);
    writeU32(ev, 16, localOffset);
    writeU16(ev, 20, 0);
    const total = localOffset + centralSize + end.length;
    const out = new Uint8Array(total);
    let off = 0;
    entries.forEach((e) => { out.set(e.local, off); off += e.local.length; });
    centralParts.forEach((c) => { out.set(c, off); off += c.length; });
    out.set(end, off);
    return out;
  }

  async function saveZip(filename, bytes, saveHandle) {
    const blob = new Blob([bytes], { type: 'application/zip' });
    if (saveHandle) {
      const writable = await saveHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }
    if (runtime.folderHandle) {
      const file = await runtime.folderHandle.getFileHandle(filename, { create: true });
      const writable = await file.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.documentElement.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 30000);
  }

  function uniqueZipNames(results) {
    const used = new Map();
    return results.map((r) => {
      let name = r.filename;
      const key = name.toLowerCase();
      const seen = used.get(key) || 0;
      used.set(key, seen + 1);
      if (seen > 0) {
        const m = name.match(/^(.*?)(\.md)$/i);
        name = m ? `${m[1]} (${seen + 1})${m[2]}` : `${name} (${seen + 1})`;
      }
      return Object.assign({}, r, { filename: name });
    });
  }

  function attachmentRootFromMarkdownFilename(markdownFilename) {
    return String(markdownFilename || 'chat.md').replace(/\.md$/i, '');
  }

  function safeZipAttachmentName(value) {
    const raw = cleanUploadedFilename(value) || 'uploaded-file';
    return raw
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/[\u0000-\u001f\u007f]+/g, '')
      .replace(/\.+$/g, '')
      .slice(0, 180)
      .trim() || 'uploaded-file';
  }

  function uniqueZipAttachmentPath(basePath, usedPaths) {
    const normalized = String(basePath || '').replace(/^\/+/, '');
    const lower = normalized.toLowerCase();
    const seen = usedPaths.get(lower) || 0;
    usedPaths.set(lower, seen + 1);
    if (!seen) return normalized;
    const slash = normalized.lastIndexOf('/');
    const dir = slash >= 0 ? normalized.slice(0, slash + 1) : '';
    const file = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    const dot = file.lastIndexOf('.');
    if (dot > 0) return `${dir}${file.slice(0, dot)} (${seen + 1})${file.slice(dot)}`;
    return `${dir}${file} (${seen + 1})`;
  }

  function base64ToBytes(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function fetchAttachmentBytes(url) {
    const response = await runtimeMessage({ type: 'CGX_FETCH_ATTACHMENT_DATA', url });
    if (!response?.ok || !response.base64) throw new Error(response?.error || 'ATTACHMENT_FETCH_FAILED');
    return {
      bytes: base64ToBytes(response.base64),
      contentType: String(response.contentType || ''),
      finalUrl: String(response.finalUrl || url),
      size: Number(response.size || 0)
    };
  }

  const authState = { token: '', accountId: '', accountName: '', loadedAt: 0 };

  function currentProjectId() {
    const path = currentPath();
    const m = path.match(/^\/g\/([^/]+)\/c\/[a-z0-9-]{10,}/i);
    return m ? m[1] : '';
  }

  function projectIdFromPathOrUrl(value = '') {
    try {
      const path = value ? new URL(String(value), location.href).pathname : currentPath();
      const m = path.match(/^\/g\/([^/]+)(?:\/|$)/i);
      return m ? m[1] : '';
    } catch {
      const m = String(value || '').match(/\/g\/([^/]+)(?:\/|$)/i);
      return m ? m[1] : '';
    }
  }

  async function ensureAuthState() {
    const now = Date.now();
    if (authState.loadedAt && now - authState.loadedAt < 60000 && authState.token) return authState;

    try {
      const m = document.cookie.match(/(?:^|;\s*)_account=([^;]+)/);
      if (m) authState.accountId = decodeURIComponent(m[1] || '').trim();
    } catch { /* cookie access can be unavailable */ }

    try {
      const response = await fetch('/api/auth/session', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store'
      });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        const token = String(data?.accessToken || data?.access_token || '').trim();
        if (token) authState.token = token.replace(/^Bearer\s+/i, '').trim();
        const user = data?.user || data?.account || {};
        authState.accountName = candidateText(
          user?.name || user?.displayName || user?.full_name || user?.email ||
          data?.name || data?.displayName || data?.email || ''
        );
        if (!authState.accountId) {
          authState.accountId = String(
            data?.account?.id || data?.accountId || user?.account_id || user?.accountId || ''
          ).trim();
        }
        if (!authState.accountId && authState.token) {
          try {
            const payload = JSON.parse(atob(authState.token.split('.')[1] || ''));
            const claim = payload?.['https://api.openai.com/auth'] || {};
            authState.accountId = String(claim?.chatgpt_account_id || claim?.account_id || '').trim();
          } catch { /* JWT fallback unavailable */ }
        }
      }
    } catch { /* keep cookie-only auth fallback */ }

    authState.loadedAt = now;
    return authState;
  }

  async function chatGptApiHeaders(projectId = '') {
    const auth = await ensureAuthState();
    const headers = new Headers();
    if (auth.token) headers.set('authorization', `Bearer ${auth.token}`);
    if (auth.accountId) headers.set('chatgpt-account-id', auth.accountId);
    const pid = String(projectId || currentProjectId() || '').trim();
    if (pid) headers.set('chatgpt-project-id', pid);
    return headers;
  }

  function isSameOriginBackendApiUrl(value) {
    try {
      const u = new URL(String(value || ''), location.href);
      return u.origin === location.origin && /\/backend-api\//i.test(u.pathname);
    } catch {
      return false;
    }
  }

  function bytesToUtf8(bytes, maxBytes = 524288) {
    try {
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      return new TextDecoder('utf-8', { fatal: false }).decode(view.slice(0, maxBytes));
    } catch {
      return '';
    }
  }

  function metaDownloadUrlFromBytes(bytes, contentType = '') {
    const ct = String(contentType || '').toLowerCase();
    const text = bytesToUtf8(bytes, 1048576).trim();
    if (!text) return '';
    if (!ct.includes('json') && !/^\s*[\[{]/.test(text)) return '';
    try {
      const data = JSON.parse(text);
      return String(data?.download_url || data?.url || data?.downloadUrl || data?.file_url || '').trim();
    } catch {
      return '';
    }
  }

  async function fetchBackendApiBytes(url, projectId = '') {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: await chatGptApiHeaders(projectId)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`DOWNLOAD_BACKEND_HTTP_${response.status}${text ? `_${text.slice(0, 80).replace(/\s+/g, '_')}` : ''}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = String(response.headers.get('content-type') || '');
    const metaUrl = metaDownloadUrlFromBytes(bytes, contentType);

    if (metaUrl) {
      let resolvedMetaUrl = metaUrl;
      try { resolvedMetaUrl = new URL(metaUrl, location.origin).href; } catch { /* keep original */ }
      const finalResult = await fetchAttachmentBytes(resolvedMetaUrl);
      return {
        bytes: finalResult.bytes,
        contentType: finalResult.contentType,
        finalUrl: finalResult.finalUrl || resolvedMetaUrl,
        size: finalResult.bytes.length
      };
    }

    return {
      bytes,
      contentType,
      finalUrl: response.url || url,
      size: bytes.length
    };
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) { reject(new Error(err.message || 'RUNTIME_MESSAGE_FAILED')); return; }
          resolve(response || {});
        });
      } catch (error) { reject(error); }
    });
  }

  function deepStringByKeys(value, wantedKeys, depth = 0) {
    if (depth > 7 || value == null) return '';
    if (typeof value !== 'object') return '';
    for (const [key, child] of Object.entries(value)) {
      if (wantedKeys.has(String(key).toLowerCase()) && typeof child === 'string' && child.trim()) {
        return child.trim();
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') {
        const found = deepStringByKeys(child, wantedKeys, depth + 1);
        if (found) return found;
      }
    }
    return '';
  }

  function normalizeProjectSourceFile(file) {
    if (!file || typeof file !== 'object') return null;
    const deepFileId = deepStringByKeys(file, new Set(['file_id', 'fileid', 'asset_id']));
    const rawId = typeof file.id === 'string' ? file.id : '';
    const id = String(file.file_id || file.fileId || file.asset_id || deepFileId || (/^file(?:_|-)/i.test(rawId) ? rawId : '')).trim();
    if (!id) return null;
    const libraryFileId = String(
      file.library_file_id || file.libraryFileId || file.library_download_id || file.libraryDownloadId ||
      deepStringByKeys(file, new Set(['library_file_id', 'libraryfileid', 'library_download_id', 'librarydownloadid'])) ||
      (/^libfile(?:_|-)/i.test(rawId) ? rawId : '')
    ).trim();
    const sourceProjectId = String(
      file.gizmo_id || file.gizmoId || file.project_id || file.projectId ||
      deepStringByKeys(file, new Set(['gizmo_id', 'gizmoid', 'project_id', 'projectid'])) || ''
    ).trim();
    const name = candidateText(file.name || file.file_name || file.filename || file.display_name || file.title || id) || id;
    return {
      id,
      libraryFileId,
      sourceProjectId,
      isProject: file.is_project === true || file.isProject === true,
      source: String(file.source || file.file_source || '').trim(),
      name,
      type: String(file.type || file.mime_type || file.content_type || '').trim(),
      size: Number(file.size ?? file.file_size ?? file.file_size_bytes ?? 0) || 0,
      url: String(file.download_url || file.downloadUrl || file.file_url || file.fileUrl || file.url || '').trim(),
      pointer: String(file.asset_pointer || file.pointer || '').trim(),
      raw: file
    };
  }

  function collectProjectSourceMetadataValues(file) {
    const out = [];
    const seen = new Set();
    const add = (value, key = '') => {
      if (typeof value !== 'string') return;
      const text = value.trim();
      if (!text || seen.has(text)) return;
      const k = String(key || '').toLowerCase();
      const useful = /(?:url|uri|href|download|pointer|asset|path|source|file)/i.test(k) ||
        /^(?:https?:\/\/|\/backend-api\/|file-service:\/\/|sandbox:\/)/i.test(text);
      if (!useful) return;
      seen.add(text);
      out.push(text);
    };
    const walk = (value, depth = 0, key = '') => {
      if (depth > 6 || value == null) return;
      if (typeof value === 'string') { add(value, key); return; }
      if (Array.isArray(value)) {
        value.forEach((item) => walk(item, depth + 1, key));
        return;
      }
      if (typeof value !== 'object') return;
      for (const [childKey, childValue] of Object.entries(value)) {
        walk(childValue, depth + 1, childKey);
      }
    };
    walk(file?.raw || file, 0, 'file');
    add(file?.url, 'url');
    add(file?.pointer, 'pointer');
    return out;
  }

  function projectSourceFilesFromPayload(data, projectId = '') {
    const candidates = [];
    const push = (value) => {
      if (!Array.isArray(value)) return;
      value.forEach((file) => {
        const normalized = normalizeProjectSourceFile(file);
        if (normalized) candidates.push(normalized);
      });
    };
    push(data?.files);
    push(data?.knowledge_files);
    push(data?.knowledgeFiles);
    push(data?.attachments);
    push(data?.gizmo?.files);
    push(data?.gizmo?.knowledge_files);
    push(data?.gizmo?.knowledgeFiles);
    push(data?.gizmo?.gizmo?.files);
    push(data?.gizmo?.gizmo?.knowledge_files);
    push(data?.project?.files);
    push(data?.project?.knowledge_files);
    push(data?.project?.knowledgeFiles);
    push(data?.project?.gizmo?.files);

    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const wrapper = item?.gizmo || item || {};
      const gizmo = wrapper?.gizmo || wrapper;
      const id = String(gizmo?.id || wrapper?.id || '').trim();
      if (projectId && id && id !== projectId) continue;
      push(wrapper?.files);
      push(gizmo?.files);
    }

    const byId = new Map();
    for (const file of candidates) if (!byId.has(file.id)) byId.set(file.id, file);
    return Array.from(byId.values());
  }

  async function fetchProjectSourcesMetadata(projectId) {
    const pid = String(projectId || '').trim();
    if (!pid) throw new Error('PROJECT_ID_NOT_FOUND');
    const errors = [];
    let files = [];
    let detail = null;

    try {
      const response = await fetch(`${location.origin}/backend-api/gizmos/${encodeURIComponent(pid)}`, {
        method: 'GET', credentials: 'include', cache: 'no-store', headers: await chatGptApiHeaders(pid)
      });
      if (!response.ok) throw new Error(`PROJECT_DETAIL_HTTP_${response.status}`);
      detail = await response.json();
      files = projectSourceFilesFromPayload(detail, pid);
      log(`project sources detail project=${pid} files=${files.length}`);
    } catch (error) {
      errors.push(`detail:${error?.message || error}`);
      log(`project sources detail failed project=${pid} ${error?.message || error}`);
    }

    if (!files.length) {
      for (const ownedOnly of [true, false]) {
        try {
          const url = `${location.origin}/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0&owned_only=${ownedOnly ? 'true' : 'false'}`;
          const response = await fetch(url, {
            method: 'GET', credentials: 'include', cache: 'no-store', headers: await chatGptApiHeaders(pid)
          });
          if (!response.ok) throw new Error(`PROJECT_SIDEBAR_HTTP_${response.status}`);
          const data = await response.json();
          const sidebarFiles = projectSourceFilesFromPayload(data, pid);
          if (sidebarFiles.length) {
            files = sidebarFiles;
            log(`project sources sidebar project=${pid} files=${files.length} ownedOnly=${ownedOnly}`);
            break;
          }
        } catch (error) {
          errors.push(`sidebar:${error?.message || error}`);
          log(`project sources sidebar failed project=${pid} ${error?.message || error}`);
        }
      }
    }

    if (!files.length && errors.length) throw new Error(errors.join(' | '));
    return { files, detail };
  }

  async function projectFileApiHeaders() {
    const auth = await ensureAuthState();
    const headers = new Headers();
    if (auth.token) headers.set('authorization', `Bearer ${auth.token}`);
    if (auth.accountId) headers.set('chatgpt-account-id', auth.accountId);
    headers.set('accept', 'application/json, application/octet-stream, */*');
    return headers;
  }

  async function fetchProjectFileApiBytes(url) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: await projectFileApiHeaders()
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`PROJECT_FILE_HTTP_${response.status}${text ? `_${text.slice(0, 100).replace(/\s+/g, '_')}` : ''}`);
    }

    const contentType = String(response.headers.get('content-type') || '');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const metaUrl = metaDownloadUrlFromBytes(bytes, contentType);
    if (metaUrl) {
      let resolved = metaUrl;
      try { resolved = new URL(metaUrl, location.origin).href; } catch { /* keep raw URL */ }
      const downloaded = await fetchAttachmentBytes(resolved);
      if (!downloaded?.bytes?.length) throw new Error('PROJECT_FILE_EMPTY_SIGNED_DOWNLOAD');
      return downloaded;
    }
    if (!bytes.length) throw new Error('PROJECT_FILE_EMPTY_RESPONSE');
    return { bytes, contentType, finalUrl: response.url || url, size: bytes.length };
  }

  function validateProjectSourcePayload(result) {
    const bytes = result?.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result?.bytes || []);
    if (!bytes.length) throw new Error('PROJECT_SOURCE_EMPTY_FILE');
    const contentType = String(result?.contentType || '').toLowerCase();
    if (contentType.includes('text/html')) throw new Error('PROJECT_SOURCE_HTML_INSTEAD_OF_FILE');
    return result;
  }

  function projectSourceResponseUrl(data) {
    if (!data || typeof data !== 'object') return '';
    return String(data.download_url || data.downloadUrl || data.url || data.file_url || '').trim();
  }

  function projectSourceLibraryId(data) {
    if (!data || typeof data !== 'object') return '';
    return String(
      data.library_file_id || data.libraryFileId || data.library_download_id || data.libraryDownloadId ||
      deepStringByKeys(data, new Set(['library_file_id', 'libraryfileid', 'library_download_id', 'librarydownloadid'])) || ''
    ).trim();
  }

  function projectSourceGizmoId(data) {
    if (!data || typeof data !== 'object') return '';
    return String(
      data.gizmo_id || data.gizmoId || data.project_id || data.projectId ||
      deepStringByKeys(data, new Set(['gizmo_id', 'gizmoid', 'project_id', 'projectid'])) || ''
    ).trim();
  }

  async function fetchProjectSourceJson(url) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'error',
      cache: 'no-store',
      headers: await projectFileApiHeaders()
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`PROJECT_SOURCE_JSON_HTTP_${response.status}${text ? `_${text.slice(0, 120).replace(/\s+/g, '_')}` : ''}`);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('json')) {
      const text = await response.text().catch(() => '');
      throw new Error(`PROJECT_SOURCE_JSON_BAD_TYPE_${contentType || 'unknown'}_${text.slice(0, 80).replace(/\s+/g, '_')}`);
    }
    return response.json();
  }

  function describeProjectContentRoute(url) {
    try {
      const u = new URL(String(url || ''), location.origin);
      if (u.origin === location.origin && /^\/api\/library\/files\/[^/]+\/project-content$/i.test(u.pathname)) return 'project-content';
      if (u.origin === location.origin && /\/backend-api\/estuary\/content$/i.test(u.pathname)) return 'estuary-content';
      if (u.hostname.toLowerCase().endsWith('.oaiusercontent.com')) return 'oaiusercontent';
      if (u.hostname.toLowerCase().endsWith('.blob.core.windows.net')) return 'blob-storage';
      return `${u.origin}${u.pathname}`;
    } catch {
      return 'unparsed';
    }
  }

  async function fetchAuthorizedProjectSourceContent(downloadUrl, expectedLibraryId = '', expectedFileId = '') {
    let resolved;
    try { resolved = new URL(String(downloadUrl || ''), location.origin); }
    catch { throw new Error('PROJECT_SOURCE_BAD_DOWNLOAD_URL'); }

    if (resolved.origin === location.origin) {
      const path = resolved.pathname;
      const projectContent = /^\/api\/library\/files\/([^/]+)\/project-content$/i.exec(path);
      if (projectContent) {
        const routeLibraryId = decodeURIComponent(projectContent[1] || '');
        const routeFileIds = resolved.searchParams.getAll('file_id');
        if (expectedLibraryId && routeLibraryId !== expectedLibraryId) throw new Error('PROJECT_SOURCE_LIBRARY_ID_MISMATCH');
        if (expectedFileId && (!routeFileIds.length || !routeFileIds.includes(expectedFileId))) throw new Error('PROJECT_SOURCE_FILE_ID_MISMATCH');
      } else if (!/\/backend-api\/estuary\/content$/i.test(path)) {
        throw new Error('PROJECT_SOURCE_UNEXPECTED_SAME_ORIGIN_ROUTE');
      }

      try {
        const response = await fetch(resolved.href, {
          method: 'GET',
          credentials: 'include',
          redirect: 'follow',
          cache: 'no-store'
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`PROJECT_SOURCE_CONTENT_HTTP_${response.status}${text ? `_${text.slice(0, 100).replace(/\s+/g, '_')}` : ''}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const result = {
          bytes,
          contentType: String(response.headers.get('content-type') || ''),
          finalUrl: response.url || resolved.href,
          size: bytes.length
        };
        validateProjectSourcePayload(result);
        return result;
      } catch (error) {
        // p24 : repli via le service worker de l’extension pour exactement la même
        // URL autorisée par le serveur. Aucun endpoint ni périmètre deviné n’est introduit.
        try {
          const viaBackground = await fetchAttachmentBytes(resolved.href);
          validateProjectSourcePayload(viaBackground);
          return viaBackground;
        } catch (backgroundError) {
          throw new Error(`${error?.message || error} | BACKGROUND_${backgroundError?.message || backgroundError}`);
        }
      }
    }

    const result = await fetchAttachmentBytes(resolved.href);
    validateProjectSourcePayload(result);
    return result;
  }

  async function fetchProjectSourceBytes(file, projectId) {
    const fileId = String(file?.id || '').trim();
    const fileName = safeZipAttachmentName(file?.name || fileId || 'source');
    const pid = String(projectId || currentProjectId() || '').trim();
    if (!fileId) throw new Error('PROJECT_SOURCE_FILE_ID_MISSING');
    if (!pid) throw new Error('PROJECT_SOURCE_PROJECT_ID_MISSING');

    // p24 : utilise le flux réel de fichiers de projet de ChatGPT.
    // 1) métadonnées de projet faisant autorité : /files/{file_id}/simple?gizmo_id=...
    // 2) autorisation de téléchargement : /files/download/{file_id}?gizmo_id=...&download_intent=true
    // 3) récupère l’URL de contenu exacte renvoyée par le serveur (souvent project-content ou estuary).
    // Ceci n’utilise volontairement PAS le chat courant comme périmètre source.
    const encodedFileId = encodeURIComponent(fileId);
    const metadataUrl = `${location.origin}/backend-api/files/${encodedFileId}/simple?gizmo_id=${encodeURIComponent(pid)}`;
    log(`project source metadata request ${fileName} fileId=${fileId} gizmo=${pid}`);
    const metadata = await fetchProjectSourceJson(metadataUrl);

    const metadataFileId = String(metadata?.file_id || metadata?.fileId || fileId).trim();
    if (metadataFileId && metadataFileId !== fileId) throw new Error('PROJECT_SOURCE_METADATA_FILE_ID_MISMATCH');

    const sourceLibraryId = String(file?.libraryFileId || '').trim();
    const metadataLibraryId = projectSourceLibraryId(metadata);
    if (sourceLibraryId && metadataLibraryId && sourceLibraryId !== metadataLibraryId) {
      throw new Error('PROJECT_SOURCE_METADATA_LIBRARY_ID_MISMATCH');
    }
    const effectiveLibraryId = metadataLibraryId || sourceLibraryId;

    const metadataProjectId = projectSourceGizmoId(metadata);
    if (metadataProjectId && metadataProjectId !== pid) throw new Error('PROJECT_SOURCE_METADATA_PROJECT_ID_MISMATCH');
    if (metadata?.is_project === false || metadata?.isProject === false) throw new Error('PROJECT_SOURCE_METADATA_NOT_PROJECT_FILE');

    log(`project source metadata ok ${fileName} library=${effectiveLibraryId || 'n/a'} gizmo=${metadataProjectId || pid}`);

    const authorizeUrl = `${location.origin}/backend-api/files/download/${encodedFileId}?gizmo_id=${encodeURIComponent(metadataProjectId || pid)}&download_intent=true`;
    const authorization = await fetchProjectSourceJson(authorizeUrl);
    const status = String(authorization?.status || '').toLowerCase();
    if (status && !['success', 'ok', 'complete', 'completed'].includes(status)) {
      throw new Error(`PROJECT_SOURCE_AUTH_STATUS_${status}`);
    }
    const downloadUrl = projectSourceResponseUrl(authorization);
    if (!downloadUrl) throw new Error('PROJECT_SOURCE_AUTH_NO_DOWNLOAD_URL');

    log(`project source authorization ok ${fileName} route=${describeProjectContentRoute(downloadUrl)}`);
    const result = await fetchAuthorizedProjectSourceContent(downloadUrl, effectiveLibraryId, fileId);
    validateUploadedFilePayload(fileName, result);
    log(`project source candidate ok ${fileName} official-project-flow bytes=${result.bytes.length} route=${describeProjectContentRoute(result.finalUrl || downloadUrl)}`);
    return result;
  }

  async function exportAllProjectSources() {
    if (runtime.exporting) {
      setStatus('Un export est déjà en cours');
      return;
    }
    const projectId = currentProjectId();
    const identity = getExportIdentity();
    if (!projectId || !identity.inProject) {
      setStatus('Ce chat n’appartient pas à un projet');
      log('project sources export refused NOT_IN_PROJECT');
      return;
    }

    runtime.exporting = true;
    runtime.stop = false;
    resetMetrics('project-sources');
    const stamp = projectStamp();
    const projectName = identity.projectName || 'Project';
    runtime.metrics.projectName = projectName;
    try {
      setStatus('Recherche des sources du projet…');
      const auth = await ensureAuthState();
      const accountName = auth.accountName || auth.accountId || 'ChatGPT Account';
      const browserName = await detectBrowserName();
      const { files: sourceFiles } = await fetchProjectSourcesMetadata(projectId);
      runtime.metrics.projectAttachmentsFound = sourceFiles.length;
      log(`project sources export start project=${projectName} id=${projectId} files=${sourceFiles.length}`);
      if (!sourceFiles.length) throw new Error('NO_PROJECT_SOURCES_FOUND');

      const zipFiles = [];
      const manifest = [];
      const usedPaths = new Map();
      const started = Date.now();
      for (let i = 0; i < sourceFiles.length; i += 1) {
        guard(started);
        const file = sourceFiles[i];
        const safeName = safeZipAttachmentName(file.name || file.id);
        const zipPath = uniqueZipAttachmentPath(`Sources/${safeName}`, usedPaths);
        setStatus(`Source du projet ${i + 1}/${sourceFiles.length} : ${safeName}`);
        try {
          const result = await fetchProjectSourceBytes(file, projectId);
          zipFiles.push({ name: zipPath, content: result.bytes });
          manifest.push({ id: file.id, name: file.name, zipPath, type: file.type || '', size: result.bytes.length, status: 'downloaded' });
          runtime.metrics.projectAttachmentsDownloaded += 1;
          log(`project source added ${zipPath} bytes=${result.bytes.length}`);
        } catch (error) {
          runtime.metrics.projectAttachmentsFailed += 1;
          manifest.push({ id: file.id, name: file.name, type: file.type || '', size: file.size || 0, status: 'failed', error: String(error?.message || error) });
          log(`project source error ${safeName} ${error?.message || error}`);
        }
      }

      if (sourceFiles.length && runtime.metrics.projectAttachmentsDownloaded === 0) {
        const firstErrors = manifest.filter((item) => item.status === 'failed').slice(0, 3)
          .map((item) => `${item.name}: ${item.error || 'download failed'}`)
          .join(' || ');
        throw new Error(`NO_PROJECT_SOURCE_FILES_DOWNLOADED${firstErrors ? ` :: ${firstErrors}` : ''}`);
      }

      const indexLines = [
        `# Sources du projet - ${projectName}`,
        '',
        `Projet : ${projectName}`,
        `ID du projet : ${projectId}`,
        `Date/heure d’export : ${humanLocalDateTime()}`,
        `Sources détectées : ${sourceFiles.length}`,
        `Sources téléchargées : ${runtime.metrics.projectAttachmentsDownloaded}`,
        `Sources en échec : ${runtime.metrics.projectAttachmentsFailed}`,
        '',
        '## Sources',
        ''
      ];
      manifest.forEach((item, idx) => {
        const statusFr = item.status === 'downloaded' ? 'téléchargée' : item.status === 'failed' ? 'échec' : item.status;
        indexLines.push(`${idx + 1}. ${item.name} — ${statusFr}${item.zipPath ? ` — ${item.zipPath}` : ''}`);
      });
      zipFiles.unshift({ name: 'SOURCES_INDEX.md', content: indexLines.join('\n') + '\n' });
      zipFiles.unshift({ name: 'sources_manifest.json', content: JSON.stringify({ projectName, projectId, exportedAt: new Date().toISOString(), files: manifest }, null, 2) });

      const zipBytes = makeStoredZip(zipFiles);
      runtime.metrics.projectZipBytes = zipBytes.length;
      const filename = `Project_Sources_${underscoreToken(projectName, 'Project')}__${underscoreToken(browserName || 'Browser', 'Browser')}__${underscoreToken(accountName || 'ChatGPT Account', 'ChatGPT_Account')}__export_${stamp}.zip`;
      runtime.metrics.projectZipFilename = filename;
      runtime.metrics.filename = filename;
      await saveBatchZipToDownloads(filename, zipBytes, 'project', projectName, accountName, browserName);
      setStatus(`Enregistré : ${filename}`);
      log(`project sources saved ${filename} files=${runtime.metrics.projectAttachmentsDownloaded}/${sourceFiles.length} bytes=${zipBytes.length}`);
    } catch (error) {
      if (String(error?.message || error) === 'STOPPED_BY_USER') setStatus('Arrêté');
      else setStatus(`Erreur : ${error?.message || error}`);
      log(`project sources export error ${error?.message || error}`);
    } finally {
      runtime.exporting = false;
      runtime.stop = false;
      render();
    }
  }

  async function discoverAllAccountChats(started) {
    const found = new Map();
    const limit = 100;
    let offset = 0;
    let total = null;
    let safety = 0;
    while (safety++ < 1000) {
      guard(started);
      setStatus(`Recherche de tous les chats… ${found.size}`);
      const url = `${location.origin}/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`;
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: await chatGptApiHeaders('')
      });
      if (!response.ok) throw new Error(`CONVERSATIONS_HTTP_${response.status}`);
      const data = await response.json();
      const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
      if (Number.isFinite(Number(data?.total))) total = Number(data.total);
      if (!items.length) break;
      for (const item of items) {
        const id = String(item?.id || item?.conversation_id || '').trim();
        if (!id || found.has(id)) continue;
        const title = candidateText(item?.title || item?.name || 'Chat sans titre') || 'Chat sans titre';
        found.set(id, {
          id,
          url: `${location.origin}/c/${encodeURIComponent(id)}`,
          titleHint: title
        });
      }
      offset += items.length;
      if (items.length < limit) break;
      if (total !== null && found.size >= total) break;
      await sleep(120);
    }
    const list = Array.from(found.values());
    log(`all-chat discovery total=${list.length}${total !== null ? ` apiTotal=${total}` : ''}`);
    list.forEach((chat, idx) => log(`all-chat discovered ${idx + 1}/${list.length} ${chat.titleHint} ${chat.url}`));
    return list;
  }

  function makeAllChatZipFilename(stamp = projectStamp(), batchIndex = 1, totalBatches = 1, accountName = '', browserName = '', chats = []) {
    const browserPart = underscoreToken(browserName || 'Browser', 'Browser');
    const accountPart = underscoreToken(accountName || 'ChatGPT Account', 'ChatGPT_Account');
    const chatPart = batchChatFilenameToken(chats);
    const prefix = `Export_ALL_Full_Chat__${chatPart}__${browserPart}__${accountPart}__export_${stamp}`;
    if (totalBatches > 1) return `${prefix}__part_${String(batchIndex).padStart(3, '0')}_of_${String(totalBatches).padStart(3, '0')}.zip`;
    return `${prefix}.zip`;
  }

  async function startAllChatExport(effectiveAskSave) {
    if (runtime.exporting) return;
    runtime.exporting = true;
    runtime.stop = false;
    resetMetrics('all-full-chat');
    runtime.clickedExpandKeys = new Set();
    const stamp = projectStamp();
    let handedOff = false;
    try {
      runtime.folderHandle = null;
      await clearBatchFolderHandle();
      await chooseBatchFolder(stamp, 'all-chat', false);
      log(`all-chat save mode=${state.askSave ? 'save-as' : 'autosave'} setOwnLocation=${state.askSave ? 'yes' : 'no'} chatsPerZip=${state.chatsPerZip}`);
      await saveState();
      setStatus('Préparation de l’export de tous les chats…');
      const auth = await ensureAuthState();
      const accountName = auth.accountName || auth.accountId || 'ChatGPT Account';
      const browserName = await detectBrowserName();
      runtime.downloadTarget = `Downloads/${batchDownloadFolder('all-chat', '', accountName, browserName)}/`;
      const zipFilename = makeAllChatZipFilename(stamp, 1, 1, accountName, browserName);
      runtime.metrics.projectName = 'ALL Chats';
      runtime.metrics.projectZipFilename = zipFilename;
      runtime.metrics.filename = zipFilename;
      const chats = await discoverAllAccountChats(Date.now());
      runtime.metrics.projectChatsDiscovered = chats.length;
      if (!chats.length) throw new Error('NO_ACCOUNT_CHATS_FOUND');
      log(`all-chat live export autosave target=${runtime.downloadTarget} browser=${browserName} account=${accountName}`);
      const response = await runtimeMessage({
        type: 'CGX_START_LIVE_ALL_CHAT_EXPORT',
        chats,
        timeoutSeconds: state.timeout,
        chatsPerZip: state.chatsPerZip,
        returnUrl: location.href,
        stamp,
        zipFilename,
        accountName,
        browserName
      });
      if (!response?.ok) throw new Error(response?.error || 'ALL_CHAT_EXPORT_START_FAILED');
      handedOff = true;
      setStatus(`TOUS ${chats.length} : ouverture des chats…`);
      log(`all-chat live worker accepted chats=${chats.length}`);
    } catch (error) {
      runtime.exporting = false;
      runtime.stop = false;
      setStatus(`Erreur : ${error.message || error}`);
      log(`all-chat error ${error.message || error}`);
      render();
    } finally {
      if (!handedOff) { runtime.exporting = false; runtime.stop = false; }
    }
  }

  async function startProjectExport(effectiveAskSave) {
    if (runtime.exporting) return;
    runtime.exporting = true;
    runtime.stop = false;
    resetMetrics('project-full');
    runtime.clickedExpandKeys = new Set();
    const stamp = projectStamp();
    let handedOff = false;
    try {
      runtime.folderHandle = null;
      await clearBatchFolderHandle();
      await chooseBatchFolder(stamp, 'project', false);
      log(`project save mode=${state.askSave ? 'save-as' : 'autosave'} setOwnLocation=${state.askSave ? 'yes' : 'no'} chatsPerZip=${state.chatsPerZip}`);
      await saveState();
      setStatus('Préparation du projet…');
      const identity = getExportIdentity();
      const basePath = projectBasePath() || findProjectBaseFromActiveLinks();
      if (!identity.inProject || !identity.projectName || !basePath) throw new Error('NOT_IN_PROJECT');
      const projectName = identity.projectName;
      const auth = await ensureAuthState();
      const accountName = auth.accountName || auth.accountId || 'ChatGPT Account';
      const browserName = await detectBrowserName();
      runtime.metrics.projectName = projectName;
      const zipFilename = makeProjectZipFilename(projectName, stamp, 1, 1, browserName, accountName);
      runtime.metrics.projectZipFilename = zipFilename;
      runtime.metrics.filename = zipFilename;
      log(`project live export start name=${projectName} base=${basePath}`);

      runtime.downloadTarget = `Downloads/${batchDownloadFolder('project', projectName, accountName, browserName)}/`;
      log(`project live export autosave target=${runtime.downloadTarget} browser=${browserName} account=${accountName}`);

      const chats = await discoverProjectChats(Date.now(), basePath, projectName);
      runtime.metrics.projectChatsDiscovered = chats.length;
      if (!chats.length) throw new Error('NO_PROJECT_CHATS_FOUND');

      const response = await runtimeMessage({
        type: 'CGX_START_LIVE_PROJECT_EXPORT',
        chats,
        projectName,
        basePath,
        timeoutSeconds: state.timeout,
        chatsPerZip: state.chatsPerZip,
        returnUrl: location.href,
        stamp,
        zipFilename,
        accountName,
        browserName
      });
      if (!response?.ok) throw new Error(response?.error || 'PROJECT_LIVE_START_FAILED');
      handedOff = true;
      setStatus(`Projet 1/${chats.length} : ouverture du chat…`);
      log(`project live worker accepted chats=${chats.length}`);
      // Le worker d’arrière-plan navigue maintenant dans CET onglet à travers chaque chat. Cette page
      // sera remplacée ; la création finale du ZIP a lieu après le retour du worker ici.
    } catch (error) {
      runtime.exporting = false;
      runtime.stop = false;
      if (String(error.message) === 'STOPPED_BY_USER') setStatus('Arrêté');
      else setStatus(`Erreur : ${error.message || error}`);
      log(`project error ${error.message || error}`);
      render();
    } finally {
      if (!handedOff) {
        runtime.exporting = false;
        runtime.stop = false;
      }
    }
  }

  function applyLiveProjectProgress(message = {}) {
    runtime.exporting = true;
    runtime.stop = false;
    runtime.metrics.projectName = message.projectName || runtime.metrics.projectName;
    runtime.metrics.projectChatsDiscovered = Number(message.total || runtime.metrics.projectChatsDiscovered || 0);
    runtime.metrics.projectChatsCompleted = Number(message.completed || 0);
    runtime.metrics.projectChatsFailed = Number(message.failed || 0);
    runtime.metrics.projectTotalMessages = Number(message.totalMessages || 0);
    runtime.metrics.projectUserMessages = Number(message.userMessages || 0);
    runtime.metrics.projectAgentMessages = Number(message.agentMessages || 0);
    const idx = Number(message.index || 0);
    const total = Number(message.total || 0);
    const title = message.titleHint || message.chatTitle || 'chat';
    if (message.phase === 'done') setStatus(`Projet ${idx}/${total} : ${title} exporté`);
    else setStatus(`Projet ${idx}/${total} : export de ${title}…`);
    log(`project live ${message.phase || 'progress'} ${idx}/${total} ${message.url || ''}`);
    render();
    return { ok: true, version: VERSION };
  }

  async function finalizeLiveProjectExport(message = {}) {
    runtime.exporting = true;
    runtime.stop = false;
    resetMetrics('project-full');
    const batchIndex = Math.max(1, Number(message.batchIndex || 1));
    const totalBatches = Math.max(1, Number(message.totalBatches || 1));
    let batchSaved = false;
    let continueExport = false;
    const projectName = String(message.projectName || 'Project');
    const rawResults = Array.isArray(message.results) ? message.results : [];
    const failures = Array.isArray(message.failures) ? message.failures : [];
    const results = uniqueZipNames(rawResults);
    runtime.metrics.projectName = projectName;
    runtime.metrics.projectChatsDiscovered = Number(message.total || (rawResults.length + failures.length));
    runtime.metrics.projectChatsCompleted = results.length;
    runtime.metrics.projectChatsFailed = failures.length;
    runtime.metrics.projectTotalMessages = results.reduce((n, r) => n + Number(r.totalMessages || 0), 0);
    runtime.metrics.projectUserMessages = results.reduce((n, r) => n + Number(r.userMessages || 0), 0);
    runtime.metrics.projectAgentMessages = results.reduce((n, r) => n + Number(r.agentMessages || 0), 0);
    const zipFilename = message.zipFilename || makeProjectZipFilename(projectName, message.stamp || projectStamp(), batchIndex, totalBatches, message.browserName || '', message.accountName || '');
    runtime.metrics.projectZipFilename = zipFilename;
    runtime.metrics.filename = zipFilename;
    (Array.isArray(message.logLines) ? message.logLines : []).forEach((line) => log(`worker ${line}`));

    try {
      if (message.cancelled) throw new Error('STOPPED_BY_USER');
      if (message.error && !results.length) throw new Error(message.error);
      if (!results.length) throw new Error('NO_PROJECT_CHATS_EXPORTED');
      setStatus('Création du ZIP du projet…');
      const exportedAt = message.exportedAt || new Date().toISOString();
      const index = buildProjectIndex(projectName, results, failures, exportedAt);
      const files = [{ name: 'INDEX.md', content: index }];
      results.forEach((r) => {
        const chatRoot = attachmentRootFromMarkdownFilename(r.filename);
        files.push({ name: `${chatRoot}/${r.filename}`, content: r.markdown });
      });

      const attachmentRefs = [];
      results.forEach((result) => {
        (Array.isArray(result.attachments) ? result.attachments : []).forEach((attachment) => {
          if (!attachment?.name) return;
          attachmentRefs.push({
            chatTitle: result.chatTitle || 'chat',
            markdownFilename: result.filename || '',
            name: attachment.name,
            url: attachment.url || '',
            fileId: String(attachment.fileId || ''),
            conversationId: String(attachment.conversationId || ''),
            projectId: String(attachment.projectId || ''),
            messageId: String(attachment.messageId || ''),
            messageIndex: Number(attachment.messageIndex || 0)
          });
        });
      });

      const downloadRefs = [];
      results.forEach((result) => {
        (Array.isArray(result.downloads) ? result.downloads : []).forEach((entry) => {
          if (!entry?.name) return;
          downloadRefs.push({
            chatTitle: result.chatTitle || 'chat',
            markdownFilename: result.filename || '',
            name: entry.name,
            url: String(entry.url || ''),
            sandboxPath: String(entry.sandboxPath || ''),
            fileId: String(entry.fileId || ''),
            conversationId: String(entry.conversationId || ''),
            projectId: String(entry.projectId || ''),
            messageId: String(entry.messageId || ''),
            messageIndex: Number(entry.messageIndex || 0)
          });
        });
      });

      runtime.metrics.projectAttachmentsFound = attachmentRefs.length;
      runtime.metrics.projectDownloadsFound = downloadRefs.length;
      const usedAttachmentPaths = new Map();
      const usedDownloadPaths = new Map();

      log(`project file export options uploaded=${state.exportUploadedFiles} downloaded=${state.exportDownloadedFiles} uploadsFound=${attachmentRefs.length} downloadsFound=${downloadRefs.length}`);
      if (!state.exportUploadedFiles && attachmentRefs.length) log('project uploaded-file copy disabled by user');
      if (!state.exportDownloadedFiles && downloadRefs.length) log('project downloaded-file copy disabled by user');

      // Crée une paire déterministe de dossiers Upload/Download par chat exporté,
      // basée sur le nom exact du fichier Markdown.
      results.forEach((result) => {
        const root = attachmentRootFromMarkdownFilename(result.filename || `${result.chatTitle || 'chat'}.md`);
        files.push({ name: `${root}/Upload/`, content: new Uint8Array(0) });
        files.push({ name: `${root}/Download/`, content: new Uint8Array(0) });
      });

      for (let i = 0; state.exportUploadedFiles && i < attachmentRefs.length; i += 1) {
        const attachment = attachmentRefs[i];
        const attachmentRoot = attachmentRootFromMarkdownFilename(
          attachment.markdownFilename || `${attachment.chatTitle || 'chat'}.md`
        );
        const fileName = safeZipAttachmentName(attachment.name);
        const zipPath = uniqueZipAttachmentPath(`${attachmentRoot}/Upload/${fileName}`, usedAttachmentPaths);

        if (!attachment.url && !attachment.fileId) {
          runtime.metrics.projectAttachmentsFailed += 1;
          log(`attachment skip ${i + 1}/${attachmentRefs.length} no-download-reference ${attachment.name}`);
          continue;
        }

        try {
          setStatus(`Pièce jointe ${i + 1}/${attachmentRefs.length} : ${attachment.name}`);
          log(`attachment fetch ${i + 1}/${attachmentRefs.length} ${attachment.name} ${attachment.url}`);
          const downloaded = await fetchUploadedFileBytes(attachment.url, attachment);
          files.push({ name: zipPath, content: downloaded.bytes });
          runtime.metrics.projectAttachmentsDownloaded += 1;
          log(`attachment added ${zipPath} bytes=${downloaded.bytes.length}`);
        } catch (error) {
          runtime.metrics.projectAttachmentsFailed += 1;
          log(`attachment error ${attachment.name} ${error?.message || error}`);
        }
      }

      for (let i = 0; state.exportDownloadedFiles && i < downloadRefs.length; i += 1) {
        const entry = downloadRefs[i];
        const root = attachmentRootFromMarkdownFilename(
          entry.markdownFilename || `${entry.chatTitle || 'chat'}.md`
        );
        const fileName = safeZipAttachmentName(entry.name);
        const zipPath = uniqueZipAttachmentPath(`${root}/Download/${fileName}`, usedDownloadPaths);

        if (!entry.url) {
          runtime.metrics.projectDownloadsFailed += 1;
          log(`project download skip ${i + 1}/${downloadRefs.length} no-download-url ${entry.name}`);
          continue;
        }

        try {
          setStatus(`Téléchargement ${i + 1}/${downloadRefs.length} : ${entry.name}`);
          log(`project download fetch ${i + 1}/${downloadRefs.length} ${entry.name} ${entry.url}`);
          const result = validateDownloadedFilePayload(
            entry.name,
            await fetchDownloadFileBytes(entry.url, entry)
          );
          files.push({ name: zipPath, content: result.bytes });
          runtime.metrics.projectDownloadsDownloaded += 1;
          log(`project download added ${zipPath} bytes=${result.bytes.length}`);
        } catch (error) {
          runtime.metrics.projectDownloadsFailed += 1;
          log(`project download error ${entry.name} ${error?.message || error}`);
        }
      }

      const zipBytes = makeStoredZip(files);
      runtime.metrics.projectZipBytes = zipBytes.length;
      log(`project zip files=${files.length} uploads=${runtime.metrics.projectAttachmentsDownloaded}/${runtime.metrics.projectAttachmentsFound} uploadFailed=${runtime.metrics.projectAttachmentsFailed} downloads=${runtime.metrics.projectDownloadsDownloaded}/${runtime.metrics.projectDownloadsFound} downloadFailed=${runtime.metrics.projectDownloadsFailed} bytes=${zipBytes.length} failedChats=${failures.length}`);
      await saveBatchZipToDownloads(zipFilename, zipBytes, 'project', message.projectName || runtime.metrics.projectName || 'Project', message.accountName || '', message.browserName || '');
      log(`project saved ${zipFilename} target=${runtime.downloadTarget || 'Downloads/ChatGPT-Export/'}`);

      // Confirme chaque partie enregistrée. Le worker MV3 d’arrière-plan persiste le
      // curseur du projet et ne reprend le lot suivant qu’après cet ACK ; une longue
      // phase ZIP/fichiers ne peut donc pas faire disparaître les parties restantes.
      const ack = await runtimeMessage({
        type: 'CGX_PROJECT_BATCH_SAVED',
        batchIndex,
        totalBatches,
        zipFilename
      });
      if (!ack?.ok) throw new Error(ack?.error || 'PROJECT_BATCH_ACK_FAILED');
      batchSaved = true;
      continueExport = !ack.done;
      if (continueExport) {
        const next = Number(ack.nextBatchIndex || (batchIndex + 1));
        setStatus(`Partie ${batchIndex}/${totalBatches} enregistrée ; poursuite avec la partie ${next}/${totalBatches}…`);
        log(`project batch continue ${batchIndex}/${totalBatches} next=${next}`);
      } else {
        setStatus(failures.length ? `Enregistré : ${zipFilename} (${failures.length} erreur)` : `Enregistré : ${zipFilename}`);
        log(`project all batches saved ${totalBatches}/${totalBatches}`);
        await clearBatchFolderHandle(message.stamp || '');
      }
      return { ok: true, filename: zipFilename, batchIndex, totalBatches, continueExport, version: VERSION };
    } catch (error) {
      if (String(error.message) === 'STOPPED_BY_USER') setStatus('Arrêté');
      else setStatus(`Erreur : ${error.message || error}`);
      log(`project final error ${error.message || error}`);
      await clearBatchFolderHandle(message.stamp || '');
      try { await runtimeMessage({ type: 'CGX_CANCEL_LIVE_PROJECT_EXPORT' }); } catch { /* au mieux */ }
      return { ok: false, error: String(error.message || error), version: VERSION };
    } finally {
      runtime.exporting = Boolean(batchSaved && continueExport);
      runtime.stop = false;
      render();
    }
  }

  function applyLiveAllChatProgress(message = {}) {
    runtime.exporting = true;
    runtime.stop = false;
    runtime.metrics.projectName = 'ALL Chats';
    runtime.metrics.projectChatsDiscovered = Number(message.total || runtime.metrics.projectChatsDiscovered || 0);
    runtime.metrics.projectChatsCompleted = Number(message.completed || 0);
    runtime.metrics.projectChatsFailed = Number(message.failed || 0);
    runtime.metrics.projectTotalMessages = Number(message.totalMessages || 0);
    runtime.metrics.projectUserMessages = Number(message.userMessages || 0);
    runtime.metrics.projectAgentMessages = Number(message.agentMessages || 0);
    const idx = Number(message.index || 0), total = Number(message.total || 0);
    const title = message.titleHint || message.chatTitle || 'chat';
    if (message.phase === 'done') setStatus(`TOUS ${idx}/${total} : ${title} exporté`);
    else setStatus(`TOUS ${idx}/${total} : export de ${title}…`);
    log(`all-chat live ${message.phase || 'progress'} ${idx}/${total} ${message.url || ''}`);
    render();
    return { ok: true, version: VERSION };
  }

  async function finalizeLiveAllChatExport(message = {}) {
    runtime.exporting = true;
    runtime.stop = false;
    resetMetrics('all-full-chat');
    let batchSaved = false;
    let continueExport = false;
    const rawResults = Array.isArray(message.results) ? message.results : [];
    const failures = Array.isArray(message.failures) ? message.failures : [];
    const results = uniqueZipNames(rawResults);
    runtime.metrics.projectName = 'ALL Chats';
    runtime.metrics.projectChatsDiscovered = Number(message.total || (rawResults.length + failures.length));
    runtime.metrics.projectChatsCompleted = results.length;
    runtime.metrics.projectChatsFailed = failures.length;
    runtime.metrics.projectTotalMessages = results.reduce((n, r) => n + Number(r.totalMessages || 0), 0);
    runtime.metrics.projectUserMessages = results.reduce((n, r) => n + Number(r.userMessages || 0), 0);
    runtime.metrics.projectAgentMessages = results.reduce((n, r) => n + Number(r.agentMessages || 0), 0);
    const zipFilename = message.zipFilename || makeAllChatZipFilename(message.stamp || projectStamp(), Number(message.batchIndex || 1), Number(message.totalBatches || 1), message.accountName || authState.accountName || authState.accountId || 'ChatGPT Account', message.browserName || '');
    runtime.metrics.projectZipFilename = zipFilename;
    runtime.metrics.filename = zipFilename;
    (Array.isArray(message.logLines) ? message.logLines : []).forEach((line) => log(`worker ${line}`));
    try {
      if (message.cancelled) throw new Error('STOPPED_BY_USER');
      if (message.error && !results.length) throw new Error(message.error);
      if (!results.length) throw new Error('NO_ACCOUNT_CHATS_EXPORTED');
      setStatus('Création du ZIP de tous les chats…');
      const exportedAt = message.exportedAt || new Date().toISOString();
      const index = buildProjectIndex('ALL Chats', results, failures, exportedAt).replace(/^# Projet complet - ALL Chats/m, '# Export complet de tous les chats');
      const files = [{ name: 'INDEX.md', content: index }];
      results.forEach((r) => {
        const root = attachmentRootFromMarkdownFilename(r.filename);
        files.push({ name: `${root}/${r.filename}`, content: r.markdown });
        files.push({ name: `${root}/Upload/`, content: new Uint8Array(0) });
        files.push({ name: `${root}/Download/`, content: new Uint8Array(0) });
      });
      const attachmentRefs = [];
      results.forEach((result) => (Array.isArray(result.attachments) ? result.attachments : []).forEach((a) => {
        if (a?.name) attachmentRefs.push({
          markdownFilename: result.filename || '',
          name: a.name,
          url: a.url || '',
          fileId: String(a.fileId || ''),
          conversationId: String(a.conversationId || ''),
          projectId: String(a.projectId || ''),
          messageId: String(a.messageId || '')
        });
      }));
      const downloadRefs = [];
      results.forEach((result) => (Array.isArray(result.downloads) ? result.downloads : []).forEach((e) => {
        if (e?.name) downloadRefs.push({ markdownFilename: result.filename || '', name: e.name, url: String(e.url || ''), sandboxPath: String(e.sandboxPath || ''), fileId: String(e.fileId || ''), conversationId: String(e.conversationId || ''), projectId: String(e.projectId || ''), messageId: String(e.messageId || '') });
      }));
      runtime.metrics.projectAttachmentsFound = attachmentRefs.length;
      runtime.metrics.projectDownloadsFound = downloadRefs.length;
      const usedAttachmentPaths = new Map(), usedDownloadPaths = new Map();
      for (let i = 0; state.exportUploadedFiles && i < attachmentRefs.length; i++) {
        const a = attachmentRefs[i], root = attachmentRootFromMarkdownFilename(a.markdownFilename), fileName = safeZipAttachmentName(a.name);
        const zipPath = uniqueZipAttachmentPath(`${root}/Upload/${fileName}`, usedAttachmentPaths);
        if (!a.url && !a.fileId) { runtime.metrics.projectAttachmentsFailed++; log(`all-chat upload skip ${a.name} no-download-reference`); continue; }
        try { setStatus(`Envoi ${i + 1}/${attachmentRefs.length} : ${a.name}`); const d = await fetchUploadedFileBytes(a.url, a); files.push({name:zipPath,content:d.bytes}); runtime.metrics.projectAttachmentsDownloaded++; }
        catch (e) { runtime.metrics.projectAttachmentsFailed++; log(`all-chat upload error ${a.name} ${e?.message || e}`); }
      }
      for (let i = 0; state.exportDownloadedFiles && i < downloadRefs.length; i++) {
        const e = downloadRefs[i], root = attachmentRootFromMarkdownFilename(e.markdownFilename), fileName = safeZipAttachmentName(e.name);
        const zipPath = uniqueZipAttachmentPath(`${root}/Download/${fileName}`, usedDownloadPaths);
        if (!e.url) { runtime.metrics.projectDownloadsFailed++; continue; }
        try { setStatus(`Téléchargement ${i + 1}/${downloadRefs.length} : ${e.name}`); const d = validateDownloadedFilePayload(e.name, await fetchDownloadFileBytes(e.url, e)); files.push({name:zipPath,content:d.bytes}); runtime.metrics.projectDownloadsDownloaded++; }
        catch (err) { runtime.metrics.projectDownloadsFailed++; log(`all-chat download error ${e.name} ${err?.message || err}`); }
      }
      const zipBytes = makeStoredZip(files);
      runtime.metrics.projectZipBytes = zipBytes.length;
      await saveBatchZipToDownloads(zipFilename, zipBytes, 'all-chat', '', message.accountName || '', message.browserName || '');
      log(`all-chat saved ${zipFilename} target=${runtime.downloadTarget || 'Downloads/ChatGPT-Export/'}`);

      // p18 : comportement d’enregistrement/lots identique à Projet complet. Le lot suivant démarre
      // uniquement lorsque chrome.downloads signale cette partie comme physiquement terminée.
      const batchIndex = Number(message.batchIndex || 1);
      const totalBatches = Number(message.totalBatches || 1);
      const ack = await runtimeMessage({
        type: 'CGX_ALL_CHAT_BATCH_SAVED',
        batchIndex,
        totalBatches,
        zipFilename
      });
      if (!ack?.ok) throw new Error(ack?.error || 'ALL_CHAT_BATCH_ACK_FAILED');
      batchSaved = true;
      continueExport = !ack.done;
      if (continueExport) {
        const next = Number(ack.nextBatchIndex || (batchIndex + 1));
        setStatus(`Partie ${batchIndex}/${totalBatches} enregistrée ; poursuite avec la partie ${next}/${totalBatches}…`);
        log(`all-chat batch continue ${batchIndex}/${totalBatches} next=${next}`);
      } else {
        setStatus(failures.length ? `Enregistré : ${zipFilename} (${failures.length} erreur)` : `Enregistré : ${zipFilename}`);
        log(`all-chat all batches saved ${totalBatches}/${totalBatches}`);
        await clearBatchFolderHandle(message.stamp || '');
      }
      return { ok: true, filename: zipFilename, batchIndex, totalBatches, continueExport, version: VERSION };
    } catch (error) {
      setStatus(String(error.message) === 'STOPPED_BY_USER' ? 'Arrêté' : `Erreur : ${error.message || error}`);
      log(`all-chat final error ${error.message || error}`);
      await clearBatchFolderHandle(message.stamp || '');
      try { await runtimeMessage({ type: 'CGX_CANCEL_LIVE_PROJECT_EXPORT' }); } catch { /* au mieux */ }
      return { ok: false, error: String(error.message || error), version: VERSION };
    } finally {
      runtime.exporting = Boolean(batchSaved && continueExport);
      runtime.stop = false;
      render();
    }
  }

  async function exportChatDataForProject(message = {}) {
    runtime.stop = false;
    runtime.clickedExpandKeys = new Set();
    resetMetrics('project-chat');
    const started = Date.now();
    const deadline = Date.now() + Math.max(4000, Math.min(30000, Number(message.readyTimeoutMs) || 15000));
    while (Date.now() < deadline) {
      if (getContainers().length > 0) break;
      await sleep(250);
    }
    let identity = getExportIdentity();

    const requestedProjectName = candidateText(message.projectName || identity.projectName || '');
    const discoveredTitleHint = stripProjectPrefixFromChatTitle(
      candidateText(message.titleHint || ''),
      requestedProjectName
    );

    if (requestedProjectName || discoveredTitleHint) {
      const finalProjectName = requestedProjectName || identity.projectName || '';
      const finalChatTitle = discoveredTitleHint
        || stripProjectPrefixFromChatTitle(identity.chatTitle, finalProjectName)
        || identity.chatTitle;

      identity = Object.assign({}, identity, {
        inProject: Boolean(finalProjectName || identity.inProject),
        projectName: finalProjectName,
        chatTitle: finalChatTitle,
        displayTitle: finalProjectName
          ? `Project - ${finalProjectName} - ${finalChatTitle}`
          : finalChatTitle
      });
    }
    const messages = await collectConversationForExport(started, 'full');
    if (!messages.length) throw new Error('NO_MESSAGES');
    if (state.exportUploadedFiles) await mergeConversationApiUploadsIntoMessages(messages);
    if (state.exportDownloadedFiles) await mergeConversationApiDownloadsIntoMessages(messages);
    const stats = countExportMessages(messages);
    const markdown = buildMarkdown(identity.displayTitle, messages);
    const attachmentMap = new Map();
    messages.forEach((m, messageIndex) => {
      (Array.isArray(m.uploads) ? m.uploads : []).forEach((entry) => {
        const name = cleanUploadedFilename(entry?.name || '');
        if (!name) return;
        const url = normalizeAttachmentUrl(entry?.url || '');
        const fileId = String(entry?.fileId || pointerToFileId(entry?.url || entry?.pointer || '') || '').trim();
        const conversationId = String(entry?.conversationId || currentConversationId() || '').trim();
        const projectId = String(entry?.projectId || currentProjectId() || '').trim();
        const messageId = String(entry?.messageId || '').trim();
        const key = `${name.toLowerCase()}|${url}|${fileId}|${conversationId}`;
        if (!attachmentMap.has(key)) {
          attachmentMap.set(key, {
            name,
            url,
            fileId,
            conversationId,
            projectId,
            messageId,
            messageIndex: messageIndex + 1
          });
        }
      });
    });
    const attachments = Array.from(attachmentMap.values());
    const downloads = downloadRefsFromMessages(messages);
    if (attachments.length) log(`project chat attachments=${attachments.length} downloadable=${attachments.filter((a) => a.url).length}`);
    if (downloads.length) log(`project chat files-to-download=${downloads.length} ${downloads.map((entry) => entry.name).join(' | ')}`);
    return {
      ok: true,
      chatTitle: identity.chatTitle,
      projectName: identity.projectName || message.projectName || '',
      filename: makeFilename(identity),
      markdown,
      totalMessages: messages.length,
      userMessages: stats.user,
      agentMessages: stats.agent,
      attachments,
      downloads,
      source: location.href
    };
  }

  async function saveMarkdown(filename, markdown, saveHandle) {
    if (saveHandle) {
      const writable = await saveHandle.createWritable();
      await writable.write(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
      await writable.close();
      return;
    }
    if (runtime.folderHandle) {
      const file = await runtime.folderHandle.getFileHandle(filename, { create: true });
      const writable = await file.createWritable();
      await writable.write(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
      await writable.close();
      return;
    }
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.documentElement.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 30000);
  }

  function buildDevLogSnapshot() {
    const folder = runtime.folderHandle ? runtime.folderHandle.name : 'non défini';
    return [
      `ChatGPT Export @NoXoZ.be - v${VERSION} ${PATCH}`,
      'EXPORT DU JOURNAL DÉVELOPPEUR',
      `exportedAt=${new Date().toISOString()}`,
      `url=${location.href}`,
      `documentTitle=${document.title || 'n/a'}`,
      '',
      `mode=${state.mode}`,
      `exportMode=${state.exportMode}`,
      `projectFullUi=${state.projectFullUi}`,
      `allFullUi=${state.allFullUi}`,
      `projectSourcesUi=${state.projectSourcesUi}`,
      `exportUploadedFiles=${state.exportUploadedFiles}`,
      `exportDownloadedFiles=${state.exportDownloadedFiles}`,
      `visible=${state.visible}`,
      `exporting=${runtime.exporting}`,
      `setOwnLocation=${state.askSave}`,
      `timeout=${state.timeout}s`,
      `folder=${folder}`,
      '',
      'INDEX D’EXPORT',
      `index.startedAt=${runtime.metrics.exportStartedAt}`,
      `index.exportMode=${runtime.metrics.exportMode}`,
      `index.scrollElement=${runtime.metrics.scrollElement}`,
      `index.crawlScrollElement=${runtime.metrics.crawlScrollElement}`,
      `index.topLoadIterations=${runtime.metrics.topLoadIterations}`,
      `index.crawlSteps=${runtime.metrics.crawlSteps}`,
      `index.expandPasses=${runtime.metrics.expandPasses}`,
      `index.showMoreRounds=${runtime.metrics.showMoreRounds}`,
      `index.showMoreClicked=${runtime.metrics.showMoreClicked}`,
      `index.expandErrors=${runtime.metrics.expandErrors}`,
      `index.collectErrors=${runtime.metrics.collectErrors}`,
      `index.domArticleTurns=${runtime.metrics.domArticleTurns}`,
      `index.domRoleNodes=${runtime.metrics.domRoleNodes}`,
      `index.domGenericMessageNodes=${runtime.metrics.domGenericMessageNodes}`,
      `index.containersSeen=${runtime.metrics.containersSeen}`,
      `index.messagesCollected=${runtime.metrics.messagesCollected}`,
      `index.messagesAfterRange=${runtime.metrics.messagesAfterRange}`,
      `index.markdownChars=${runtime.metrics.markdownChars}`,
      `index.loopBreakReason=${runtime.metrics.loopBreakReason}`,
      `index.filename=${runtime.metrics.filename}`,
      `project.name=${runtime.metrics.projectName}`,
      `project.chatsDiscovered=${runtime.metrics.projectChatsDiscovered}`,
      `project.chatsCompleted=${runtime.metrics.projectChatsCompleted}`,
      `project.chatsFailed=${runtime.metrics.projectChatsFailed}`,
      `project.totalMessages=${runtime.metrics.projectTotalMessages}`,
      `project.userMessages=${runtime.metrics.projectUserMessages}`,
      `project.agentMessages=${runtime.metrics.projectAgentMessages}`,
      `project.attachmentsFound=${runtime.metrics.projectAttachmentsFound}`,
      `project.attachmentsDownloaded=${runtime.metrics.projectAttachmentsDownloaded}`,
      `project.attachmentsFailed=${runtime.metrics.projectAttachmentsFailed}`,
      `project.downloadsFound=${runtime.metrics.projectDownloadsFound}`,
      `project.downloadsDownloaded=${runtime.metrics.projectDownloadsDownloaded}`,
      `project.downloadsFailed=${runtime.metrics.projectDownloadsFailed}`,
      `project.zipBytes=${runtime.metrics.projectZipBytes}`,
      `project.zipFilename=${runtime.metrics.projectZipFilename}`,
      '',
      'JOURNAL D’EXÉCUTION',
      ...runtime.logs
    ].join('\n');
  }

  function exportDevLog() {
    try {
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\.\d+Z$/, '');
      const filename = `ChatGPT-Export_v${VERSION}_DEV_LOG__${stamp}.log`;
      const blob = new Blob([buildDevLogSnapshot()], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.documentElement.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 30000);
      log(`developer log exported ${filename}`);
      setStatus(`Journal enregistré : ${filename}`);
    } catch (error) {
      log(`developer log export error ${error?.message || error}`);
      setStatus(`Erreur d’export du journal : ${error?.message || error}`);
    }
  }

  async function pickFolder() {
    if (typeof window.showDirectoryPicker !== 'function') { setStatus('Sélecteur de dossier non pris en charge'); return; }
    try {
      runtime.folderHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await clearBatchFolderHandle();
      setStatus(`Cible : ${runtime.folderHandle.name}`);
      render();
    } catch (error) {
      if (error.name !== 'AbortError') setStatus(`Erreur de dossier : ${error.message}`);
    }
  }

  function isDocumentScroller(el) {
    return !el || el === document.scrollingElement || el === document.documentElement || el === document.body;
  }

  function scrollMetrics(el) {
    if (isDocumentScroller(el)) {
      const root = document.scrollingElement || document.documentElement;
      return {
        top: Math.round(window.scrollY || root.scrollTop || document.documentElement.scrollTop || document.body.scrollTop || 0),
        clientHeight: Math.round(window.innerHeight || root.clientHeight || 0),
        scrollHeight: Math.round(Math.max(root.scrollHeight || 0, document.documentElement.scrollHeight || 0, document.body.scrollHeight || 0))
      };
    }
    return {
      top: Math.round(el.scrollTop || 0),
      clientHeight: Math.round(el.clientHeight || 0),
      scrollHeight: Math.round(el.scrollHeight || 0)
    };
  }

  function scrollToPosition(el, top) {
    const value = Math.max(0, Math.round(Number(top) || 0));
    if (isDocumentScroller(el)) {
      const root = document.scrollingElement || document.documentElement;
      try { root.scrollTop = value; } catch { /* ignoré */ }
      try { document.documentElement.scrollTop = value; } catch { /* ignoré */ }
      try { document.body.scrollTop = value; } catch { /* ignoré */ }
      try { window.scrollTo(0, value); } catch { /* ignoré */ }
      return;
    }
    try { el.scrollTop = value; } catch { /* ignoré */ }
    try { el.scrollTo({ top: value, behavior: 'auto' }); } catch { /* ignoré */ }
  }

  function visibleRect(el) {
    try { return el.getBoundingClientRect(); } catch { return { width: 0, height: 0, top: 0, bottom: 0 }; }
  }

  function isVisibleElement(el) {
    if (!el || el.closest?.(`#${WIDGET_ID}`)) return false;
    const r = visibleRect(el);
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom < -100 || r.top > window.innerHeight + 100) return false;
    return true;
  }

  function countContainersInside(el, containers) {
    if (!containers.length) return 0;
    if (isDocumentScroller(el)) return containers.length;
    let count = 0;
    for (const c of containers) {
      try { if (el.contains(c)) count += 1; } catch { /* ignoré */ }
    }
    return count;
  }

  function describeScrollElement(el) {
    if (isDocumentScroller(el)) return 'document';
    const id = el.id ? `#${el.id}` : '';
    const cls = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 4).join('.');
    return `${el.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ''}`;
  }

  function findChatScrollElement() {
    const containers = getContainers();
    const candidates = new Set();
    const root = document.scrollingElement || document.documentElement;
    candidates.add(root);
    candidates.add(document.documentElement);
    candidates.add(document.body);

    const sample = [containers[0], containers[Math.floor(containers.length / 2)], containers[containers.length - 1]].filter(Boolean);
    for (const node of sample) {
      let el = node?.parentElement;
      while (el && el !== document.documentElement) {
        if (!widget || (el !== widget && !widget.contains(el))) candidates.add(el);
        el = el.parentElement;
      }
    }

    document.querySelectorAll('main, [role="main"], div[class*="overflow"], div[class*="scroll"], section').forEach((el) => {
      if (!widget || (el !== widget && !widget.contains(el))) candidates.add(el);
    });

    let best = root;
    let bestScore = -1;
    for (const el of candidates) {
      if (!el || (widget && (el === widget || widget.contains(el)))) continue;
      const m = scrollMetrics(el);
      const overflow = Math.max(0, m.scrollHeight - m.clientHeight);
      if (overflow < 80) continue;
      const inside = countContainersInside(el, containers);
      if (containers.length && inside <= 0) continue;
      let overflowBoost = 0;
      try {
        const oy = getComputedStyle(el).overflowY || '';
        if (/auto|scroll|overlay/i.test(oy)) overflowBoost = 50000;
      } catch { /* ignoré */ }
      const tagBoost = el.tagName === 'MAIN' ? 20000 : 0;
      const score = inside * 1000000 + overflowBoost + tagBoost + overflow;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  async function loadFromTop(started) {
    const scrollEl = findChatScrollElement();
    runtime.metrics.scrollElement = describeScrollElement(scrollEl);
    log(`scroll-element=${runtime.metrics.scrollElement}`);
    let stable = 0, lastHeight = -1, lastCount = -1, lastTop = -1;
    for (let i = 0; i < 90 && stable < 6; i += 1) {
      guard(started);
      scrollToPosition(scrollEl, 0);
      await sleep(360);
      await expandVisible(started);
      const m = scrollMetrics(scrollEl);
      const c = getContainers().length;
      stable = (m.top <= 2 && m.scrollHeight === lastHeight && c === lastCount && m.top === lastTop) ? stable + 1 : 0;
      lastHeight = m.scrollHeight; lastCount = c; lastTop = m.top;
      runtime.metrics.topLoadIterations = i + 1;
      runtime.metrics.containersSeen = Math.max(runtime.metrics.containersSeen, c);
      setStatus(`Chargement du début… ${c}`);
    }
    scrollToPosition(scrollEl, 0);
    await sleep(300);
    await expandVisible(started);
  }

  async function collectConversationForExport(started, exportMode = state.exportMode) {
    const all = new Map();
    if (exportMode === 'full' || exportMode === 'start') await loadFromTop(started);
    await expandVisible(started);
    collectVisibleMessages(all);

    if (exportMode === 'full' || exportMode === 'end') {
      await crawlDownAndCollect(started, all);
    }

    const messages = Array.from(all.values()).sort((a, b) => a.order - b.order);
    runtime.metrics.messagesCollected = messages.length;
    runtime.metrics.containersSeen = Math.max(runtime.metrics.containersSeen, getContainers().length);
    log(`index messagesCollected=${messages.length} containersSeen=${runtime.metrics.containersSeen}`);
    setStatus(`${messages.length} messages collectés`);
    return messages;
  }

  async function crawlDownAndCollect(started, all) {
    const scrollEl = findChatScrollElement();
    runtime.metrics.crawlScrollElement = describeScrollElement(scrollEl);
    log(`crawl-scroll-element=${runtime.metrics.crawlScrollElement}`);
    let metrics = scrollMetrics(scrollEl);
    const step = Math.max(420, Math.floor((metrics.clientHeight || window.innerHeight || 720) * 0.62));
    let lastTop = metrics.top;
    let lastHeight = metrics.scrollHeight;
    let lastSize = all.size;
    let noProgress = 0;
    let repeatedState = 0;
    let previousSignature = '';

    for (let i = 0; i < 420; i += 1) {
      guard(started);
      await expandVisible(started);
      collectVisibleMessages(all);
      metrics = scrollMetrics(scrollEl);
      runtime.metrics.crawlSteps = i + 1;
      runtime.metrics.messagesCollected = Math.max(runtime.metrics.messagesCollected, all.size);
      setStatus(`Collecte… ${all.size} @${metrics.top}`);

      const maxTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
      const atBottom = maxTop > 0 && metrics.top >= maxTop - 8;
      if (atBottom) {
        runtime.metrics.loopBreakReason = 'bottom';
        break;
      }

      const signature = `${metrics.top}:${metrics.scrollHeight}:${all.size}`;
      repeatedState = signature === previousSignature ? repeatedState + 1 : 0;
      previousSignature = signature;
      if (repeatedState >= 8) {
        runtime.metrics.loopBreakReason = 'repeated-scroll-state';
        log(`crawl loop-guard repeated-state top=${metrics.top} height=${metrics.scrollHeight} size=${all.size}`);
        break;
      }

      const beforeTop = metrics.top;
      const beforeSize = all.size;
      const beforeHeight = metrics.scrollHeight;
      const nextTop = Math.min(beforeTop + step, maxTop || beforeTop + step);
      scrollToPosition(scrollEl, nextTop);
      await sleep(320);

      const after = scrollMetrics(scrollEl);
      const advanced = after.top > beforeTop + 4;
      const gotNewMessages = all.size > beforeSize;
      const heightChanged = Math.abs(after.scrollHeight - beforeHeight) > 8;
      if (!advanced && !gotNewMessages && !heightChanged) noProgress += 1;
      else noProgress = 0;

      lastTop = after.top;
      lastHeight = after.scrollHeight;
      lastSize = all.size;

      if (noProgress >= 10) {
        runtime.metrics.loopBreakReason = 'no-scroll-progress';
        log(`crawl loop-guard no-progress top=${after.top} size=${all.size}`);
        break;
      }
    }

    if (runtime.metrics.loopBreakReason === 'n/a') {
      runtime.metrics.loopBreakReason = 'max-steps';
      log(`crawl stopped max-steps size=${all.size}`);
    }

    await expandVisible(started);
    collectVisibleMessages(all);
  }

  function messageContainerFor(node) {
    if (!node || node.closest?.(`#${WIDGET_ID}`)) return null;
    const selector = [
      'article[data-testid^="conversation-turn-"]',
      'article[data-testid*="conversation"]',
      'article[data-testid*="message"]',
      '[data-testid^="conversation-turn-"]',
      '[data-message-author-role]',
      '[data-author-role]',
      '[data-testid*="user-message"]',
      '[data-testid*="assistant-message"]',
      '[data-testid*="message"]'
    ].join(',');
    const container = node.closest?.(selector) || null;
    if (container && (!widget || (container !== widget && !widget.contains(container)))) return container;
    return null;
  }

  function expandButtonKey(button) {
    try {
      const container = messageContainerFor(button);
      const containerId = container
        ? (container.getAttribute?.('data-testid') || container.id || `order-${containerOrder(container, 0)}`)
        : 'global';
      const raw = [
        button?.innerText,
        button?.textContent,
        button?.getAttribute?.('aria-label'),
        button?.getAttribute?.('title'),
        button?.getAttribute?.('data-testid')
      ].filter(Boolean).join(' ');
      const rect = button?.getBoundingClientRect?.();
      const pos = rect ? `${Math.round(rect.left)}x${Math.round(rect.top)}` : 'nopos';
      return `${containerId}:${pos}:${norm(raw).slice(0, 120)}`;
    } catch (error) {
      runtime.metrics.expandErrors += 1;
      log(`expand key error ${error?.message || error}`);
      return `expand-error:${Date.now()}:${Math.random()}`;
    }
  }

  function isExpandableButton(button) {
    try {
      if (!button || button.closest?.(`#${WIDGET_ID}`) || !isVisibleElement(button)) return false;
      const container = messageContainerFor(button);
      if (!container) return false;
      const raw = [
        button.innerText,
        button.textContent,
        button.getAttribute?.('aria-label'),
        button.getAttribute?.('title'),
        button.getAttribute?.('data-testid')
      ].filter(Boolean).join(' ');
      const t = norm(raw);
      if (!t) return false;
      if (/show\s*more|read\s*more|expand|show\s*full|voir\s*plus|afficher\s*plus|afficher\s*la\s*suite|développer|click\s*to\s*expand/i.test(t)) return true;
      if (/^(…|\.\.\.|more)$/i.test(t)) return true;
      return false;
    } catch (error) {
      runtime.metrics.expandErrors += 1;
      log(`expand filter error ${error?.message || error}`);
      return false;
    }
  }

  async function expandVisible(started) {
    for (let round = 0; round < 4; round += 1) {
      let buttons = [];
      try {
        buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isExpandableButton);
      } catch (error) {
        runtime.metrics.expandErrors += 1;
        log(`expand scan error ${error?.message || error}`);
        break;
      }
      let clicked = 0;
      for (const b of buttons) {
        guard(started);
        try {
          const key = expandButtonKey(b);
          if (runtime.clickedExpandKeys?.has(key)) continue;
          b.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' });
          await sleep(40);
          b.click?.();
          runtime.clickedExpandKeys?.add(key);
          clicked += 1;
          await sleep(140);
        } catch (error) {
          runtime.metrics.expandErrors += 1;
          log(`expand click error ${error?.message || error}`);
        }
        if (clicked > 80) break;
      }
      runtime.metrics.expandPasses += 1;
      if (!clicked) break;
      runtime.metrics.showMoreRounds += 1;
      runtime.metrics.showMoreClicked += clicked;
      log(`showMore clicked=${clicked} total=${runtime.metrics.showMoreClicked}`);
      await sleep(180);
    }
  }

  function containerOrder(container, fallback) {
    if (!container) return fallback + 100000;
    const testid = container.getAttribute?.('data-testid') || '';
    const m = testid.match(/conversation-turn-(\d+)/i);
    if (m) return Number(m[1]);
    const id = container.id || '';
    const im = id.match(/(\d+)/);
    if (im) return Number(im[1]);
    return fallback + 100000;
  }

  function messageKey(container, role, text, order) {
    const testid = container?.getAttribute?.('data-testid');
    if (testid) return testid;
    return `${order}:${role}:${text.slice(0, 160)}`;
  }

  function dedupeElements(nodes) {
    const out = [];
    const seen = new Set();
    for (const n of nodes || []) {
      if (!n || seen.has(n)) continue;
      if (widget && (n === widget || widget.contains(n))) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }

  function updateDomMetrics() {
    try { runtime.metrics.domArticleTurns = document.querySelectorAll('article[data-testid^="conversation-turn-"], [data-testid^="conversation-turn-"]').length; } catch { runtime.metrics.domArticleTurns = -1; }
    try { runtime.metrics.domRoleNodes = document.querySelectorAll('[data-message-author-role], [data-author-role]').length; } catch { runtime.metrics.domRoleNodes = -1; }
    try { runtime.metrics.domGenericMessageNodes = document.querySelectorAll('[data-testid*="message"], [data-testid*="conversation"]').length; } catch { runtime.metrics.domGenericMessageNodes = -1; }
  }

  const ATTACHMENT_EXPLICIT_SELECTOR = [
    '[data-filename]',
    '[data-file-name]',
    '[data-testid*="attachment" i]',
    '[data-testid*="file-upload" i]',
    '[data-testid*="uploaded-file" i]',
    '[data-testid*="file-preview" i]',
    '[aria-label*="attachment" i]',
    '[aria-label*="attached file" i]',
    '[aria-label*="uploaded file" i]',
    'a[download]',
    'a[href*="files.oaiusercontent.com" i]',
    'a[href*="/backend-api/files/" i]',
    'a[href*="/files/" i]',
    'a[href*="/file/" i]'
  ].join(',');

  function cleanUploadedFilename(value) {
    let s = String(value || '').replace(/\u00a0/g, ' ').trim();
    if (!s) return '';

    // Supprime les verbes/libellés courants de l’interface sans toucher au vrai nom de fichier.
    s = s.replace(/^(?:file\s+uploaded|uploaded\s+file|attached\s+file|attachment|file|download|open|remove|delete|preview|télécharger|ouvrir|supprimer|fichier\s+téléversé|fichier\s+joint|pièce\s+jointe)\s*[:\-–—]*\s*/i, '');
    s = s.replace(/\s+(?:download|open|remove|delete|preview|télécharger|ouvrir|supprimer)\s*$/i, '');
    s = s.replace(/\s+\d+(?:[.,]\d+)?\s*(?:bytes?|b|kb|mb|gb|kib|mib|gib)\s*$/i, '');
    s = s.replace(/\s+/g, ' ').trim();

    if (!s || s.length > 255) return '';
    if (/^(?:https?:|blob:|data:|javascript:)/i.test(s)) return '';
    return s;
  }

  const SUPPORTED_FILE_EXTENSIONS_PATTERN = '(?:zip|pdf|md|markdown|txt|csv|json|xml|ya?ml|docx?|xlsx?|pptx?|odt|ods|odp|png|jpe?g|gif|webp|svg|bmp|tiff?|mp3|wav|flac|ogg|m4a|mp4|mov|avi|mkv|webm|tar|gz|tgz|bz2|xz|7z|rar|sql|sqlite|db|py|js|mjs|cjs|ts|tsx|jsx|css|scss|sh|bash|zsh|ps1|bat|cmd|log|kdbx|pem|crt|cer|key)';
  const SUPPORTED_FILE_EXTENSIONS_RE = new RegExp(`\.${SUPPORTED_FILE_EXTENSIONS_PATTERN}$`, 'i');

  function canonicalDownloadFilename(value) {
    let s = cleanUploadedFilename(value);
    if (!s) return '';

    const fileExt = SUPPORTED_FILE_EXTENSIONS_PATTERN;
    const suffix = '(?:(?:Document|File|Artifact)?(?:Open|Download|Preview|View|Télécharger|Telecharger|Ouvrir))+';
    const re = new RegExp(`^(.+\.${fileExt})${suffix}$`, 'i');
    const m = s.match(re);
    if (m) s = m[1];

    return cleanUploadedFilename(s);
  }

  function looksLikeUploadedFilename(value) {
    const s = cleanUploadedFilename(value);
    if (!s || s.includes('\n')) return false;
    // N’accepte pas les classes utilitaires CSS ni les fragments décimaux comme « px-2.5 »
    // comme noms de fichiers. Les artefacts générés/téléchargeables doivent se terminer par une extension
    // de fichier connue, tandis que les noms explicites inhabituels restent acceptés via les attributs
    // data-filename/download avant canonicalisation.
    return SUPPORTED_FILE_EXTENSIONS_RE.test(s);
  }

  function filenameCandidatesFromText(value) {
    const raw = String(value || '').replace(/\r/g, '\n');
    const out = [];
    const seen = new Set();

    const add = (candidate, explicit = false) => {
      const cleaned = cleanUploadedFilename(candidate);
      if (!cleaned) return;
      if (!explicit && !looksLikeUploadedFilename(cleaned)) return;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(cleaned);
    };

    for (const lineRaw of raw.split(/\n+/)) {
      let line = lineRaw.trim();
      if (!line) continue;

      // Une carte de fichier affiche souvent « nom.ext  123 KB » sur une seule ligne visuelle.
      line = line.replace(/\s+\d+(?:[.,]\d+)?\s*(?:bytes?|b|kb|mb|gb|kib|mib|gib)\s*$/i, '').trim();

      if (looksLikeUploadedFilename(line)) {
        const wordCount = line.split(/\s+/).filter(Boolean).length;
        const sentenceLike = wordCount > 9 || /^(?:tu\s+peux|peux[- ]?tu|pouvez[- ]?vous|je\s+veux|fais(?:-moi)?|faites|cr[ée]e?|create|make|g[eé]n[eè]re|nomm[ée]|appelle)/i.test(line);
        if (!sentenceLike) add(line);
        continue;
      }

      // Extrait une portion ressemblant à un nom de fichier depuis des libellés tels que
      // « Télécharger report final.pdf ».
      const m = line.match(/(?:^|\s)([^<>"|?*\n]{1,240}\.[a-z0-9][a-z0-9._+-]{0,15})(?=\s|$)/i);
      if (m) add(m[1]);
    }
    return out;
  }

  function uploadedFilenameFromHref(href) {
    try {
      const u = new URL(String(href || ''), location.href);

      for (const key of ['filename', 'file_name', 'name', 'download']) {
        const value = decodeURIComponent(String(u.searchParams.get(key) || '').trim());
        if (looksLikeUploadedFilename(value)) return cleanUploadedFilename(value);
      }

      const last = decodeURIComponent((u.pathname.split('/').pop() || '').trim());
      return looksLikeUploadedFilename(last) ? cleanUploadedFilename(last) : '';
    } catch {
      return '';
    }
  }

  function normalizeAttachmentUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || /^(?:blob:|data:|javascript:|mailto:)/i.test(raw)) return '';
    try {
      const u = new URL(raw, location.href);
      if (!/^https?:$/i.test(u.protocol)) return '';
      return u.href;
    } catch {
      return '';
    }
  }

  function attachmentUrlFromElement(el) {
    if (!el) return '';

    const preferredAttrs = [
      'href',
      'data-url',
      'data-download-url',
      'data-file-url',
      'data-attachment-url',
      'data-src',
      'src'
    ];

    for (const attr of preferredAttrs) {
      const normalized = normalizeAttachmentUrl(el.getAttribute?.(attr));
      if (normalized && isLikelyAttachmentUrl(normalized)) return normalized;
    }

    // ChatGPT modifie régulièrement le balisage des cartes de pièces jointes. Inspecte chaque attribut
    // à la recherche d’une vraie URL de pièce jointe, y compris les attributs data-* inconnus.
    try {
      for (const attr of Array.from(el.attributes || [])) {
        const normalized = normalizeAttachmentUrl(attr?.value);
        if (normalized && isLikelyAttachmentUrl(normalized)) return normalized;
      }
    } catch { /* ignoré */ }

    try {
      const links = Array.from(el.querySelectorAll?.('a[href]') || []);
      for (const a of links) {
        const normalized = normalizeAttachmentUrl(a.getAttribute?.('href') || a.href);
        if (normalized && isLikelyAttachmentUrl(normalized)) return normalized;
      }
    } catch { /* ignoré */ }

    return '';
  }

  function isLikelyAttachmentUrl(value) {
    const url = normalizeAttachmentUrl(value);
    if (!url) return false;
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();
      return host.endsWith('.oaiusercontent.com')
        || host === 'chatgpt.com'
        || host === 'chat.openai.com'
        || host.endsWith('.openai.com')
        || /(?:\/backend-api\/files\/|\/files\/|\/file\/|\/download(?:\/|$)|\/attachment(?:s)?\/)/i.test(path);
    } catch {
      return false;
    }
  }

  function elementLooksLikeAttachmentCard(el) {
    if (!el || el.closest?.(`#${WIDGET_ID}`)) return false;

    const signal = [
      el.getAttribute?.('data-testid') || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('title') || '',
      el.getAttribute?.('role') || '',
      el.className || ''
    ].join(' ').toLowerCase();

    if (/(attach|attachment|upload|uploaded|file|download|document)/i.test(signal)) return true;

    try {
      if (el.querySelector?.(
        '[data-filename], [data-file-name], a[download], ' +
        'a[href*="oaiusercontent" i], a[href*="/backend-api/files/" i], ' +
        'a[href*="/backend-api/estuary/" i]'
      )) return true;
    } catch { /* ignoré */ }

    return false;
  }

  function filenameTextOutsideMessageBody(container, contentBody) {
    const candidates = [];
    const seen = new Set();

    const add = (value) => {
      for (const name of filenameCandidatesFromText(value)) {
        const key = name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(name);
        }
      }
    };

    try {
      for (const el of Array.from(container.querySelectorAll?.('*') || [])) {
        if (!el || el.closest?.(`#${WIDGET_ID}`)) continue;

        // Du texte ou du code ordinaire peut contenir des noms de fichiers simplement saisis par
        // l’utilisateur. Ne les traite pas comme des envois sauf si l’élément présente les signaux d’une carte de fichier.
        const insideBody = Boolean(contentBody && (el === contentBody || contentBody.contains?.(el)));
        const structural = elementLooksLikeAttachmentCard(el);
        if (insideBody && !structural) continue;

        const text = String(el.innerText || el.textContent || '').trim();
        if (text && text.length <= 320) add(text);

        for (const attrName of ['aria-label', 'title', 'data-filename', 'data-file-name', 'download']) {
          const value = el.getAttribute?.(attrName);
          if (value) add(value);
        }
      }
    } catch { /* ignoré */ }

    return candidates;
  }

  function downloadFilenameFromHref(href) {
    const raw = String(href || '').trim();
    if (!raw) return '';

    try {
      if (/^sandbox:/i.test(raw)) {
        const path = raw.replace(/^sandbox:/i, '').split(/[?#]/, 1)[0];
        const last = decodeURIComponent((path.split('/').pop() || '').trim());
        const canonical = canonicalDownloadFilename(last);
        return looksLikeUploadedFilename(canonical) ? canonical : '';
      }

      const u = new URL(raw, location.href);
      for (const key of ['filename', 'file_name', 'name', 'download']) {
        const value = decodeURIComponent(String(u.searchParams.get(key) || '').trim());
        const canonical = canonicalDownloadFilename(value);
        if (looksLikeUploadedFilename(canonical)) return canonical;
      }

      const last = decodeURIComponent((u.pathname.split('/').pop() || '').trim());
      const canonical = canonicalDownloadFilename(last);
      return looksLikeUploadedFilename(canonical) ? canonical : '';
    } catch {
      return '';
    }
  }

  function isStrongDownloadHref(href) {
    const raw = String(href || '').trim();
    if (!raw) return false;
    if (/^sandbox:\/{0,2}mnt\/data\//i.test(raw)) return true;
    if (/^\/mnt\/data\//i.test(raw)) return true;

    try {
      const u = new URL(raw, location.href);
      const host = u.hostname.toLowerCase();
      const lowerPath = u.pathname.toLowerCase();

      if (host.endsWith('.oaiusercontent.com')) return true;

      if (
        host === 'chatgpt.com'
        || host === 'chat.openai.com'
        || host.endsWith('.openai.com')
      ) {
        // « Strong » signifie uniquement un vrai endpoint backend/fichier/téléchargement. Une route normale
        // de conversation ChatGPT comme /g/.../c/name.pdf est une visionneuse HTML
        // et ne doit pas être traitée comme des octets de fichier.
        if (/(?:\/backend-api\/conversation\/[^/]+\/interpreter\/download|\/backend-api\/files\/download\/|\/backend-api\/files\/[^/]+\/download|\/backend-api\/files\/|\/backend-api\/estuary\/|\/download(?:\/|$)|\/attachment(?:s)?\/)/i.test(lowerPath)) {
          return true;
        }
        return false;
      }

      return false;
    } catch {
      return false;
    }
  }

  function isRealDownloadUrlCandidate(value) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (/^(?:javascript:|mailto:)/i.test(raw)) return false;
    if (/^sandbox:\/{0,2}mnt\/data\//i.test(raw)) return true;
    if (/^\/mnt\/data\//i.test(raw)) return true;
    if (/^(?:https?:|blob:|data:)/i.test(raw)) return true;
    if (/^\/backend-api\//i.test(raw)) return true;
    if (/^(?:\.\/|\.\.\/)?(?:download|downloads|file|files|attachment|attachments)\//i.test(raw)) return true;

    // Les valeurs relatives contenant seulement un nom de fichier sont des noms, pas des URL. Des attributs de classe tels que
    // « cursor-pointer ... px-1.5 » ne doivent jamais devenir de fausses URL ChatGPT.
    if (/\s/.test(raw)) return false;
    if (/^[A-Za-z0-9_. -]+$/i.test(raw) && looksLikeUploadedFilename(raw)) return false;
    return /[/?#]/.test(raw);
  }

  function downloadUrlCandidatesFromElement(el) {
    const found = [];
    const seen = new Set();

    const add = (value) => {
      const raw = String(value || '').trim();
      if (!isRealDownloadUrlCandidate(raw)) return;

      let candidate = raw;
      try {
        if (/^\/mnt\/data\//i.test(raw)) candidate = `sandbox:${raw}`;
        else if (!/^(?:sandbox:|blob:|data:)/i.test(raw)) candidate = new URL(raw, location.href).href;
      } catch { return; }

      if (seen.has(candidate)) return;
      seen.add(candidate);
      found.push(candidate);
    };

    const inspectOne = (node) => {
      if (!node) return;

      for (const attrName of [
        'href',
        'data-url',
        'data-download-url',
        'data-file-url',
        'data-attachment-url',
        'data-src',
        'src'
      ]) {
        add(node.getAttribute?.(attrName));
      }

      // La propriété DOM peut exposer une URL résolue même lorsque getAttribute() est relatif.
      try { add(node.href); } catch { /* ignoré */ }
      try { add(node.src); } catch { /* ignoré */ }

      // Les attributs inconnus ne sont inspectés que s’ils ressemblent à de vraies URL.
      // Les simples classes/titres/libellés aria ne doivent pas être convertis en faux chemins.
      try {
        for (const attr of Array.from(node.attributes || [])) add(attr?.value);
      } catch { /* ignoré */ }

      try {
        node.querySelectorAll?.('a[href], [data-download-url], [data-file-url], [data-url]').forEach((child) => {
          add(child.getAttribute?.('href'));
          add(child.href);
          add(child.getAttribute?.('data-download-url'));
          add(child.getAttribute?.('data-file-url'));
          add(child.getAttribute?.('data-url'));
        });
      } catch { /* ignoré */ }
    };

    inspectOne(el);

    // ChatGPT encapsule fréquemment le bouton visible du nom de fichier dans une carte de fichier plus grande.
    let parent = el?.parentElement || null;
    for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
      inspectOne(parent);
      if (elementLooksLikeAttachmentCard(parent)) break;
    }

    return found;
  }

  function bestDownloadUrlFromElement(el) {
    const candidates = downloadUrlCandidatesFromElement(el);

    // Préfère les URL déjà acceptées par la passerelle de récupération en arrière-plan.
    const strongHttps = candidates.find((url) => /^https:/i.test(url) && isStrongDownloadHref(url));
    if (strongHttps) return strongHttps;

    // Ne se replie jamais sur une page HTTPS arbitraire : une URL normale de conversation/visionneuse
    // ChatGPT est du HTML, pas le fichier généré.

    // Conserve les schémas spéciaux pour les journaux/tentatives de repli. Ils peuvent être utiles
    // lorsque ChatGPT change son rendu, même si la récupération en arrière-plan ne peut pas
    // toujours les lire.
    return candidates.find((url) => /^(?:blob:|data:|sandbox:)/i.test(url)) || '';
  }

  function bytesLookLikeHtml(bytes) {
    try {
      const head = bytes instanceof Uint8Array
        ? bytes.slice(0, 1024)
        : new Uint8Array(bytes || []).slice(0, 1024);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(head).trim().toLowerCase();
      return text.startsWith('<!doctype html')
        || text.startsWith('<html')
        || /<html[\s>]/i.test(text.slice(0, 300));
    } catch {
      return false;
    }
  }

  function currentConversationId() {
    return conversationIdFromPath(currentPath()) || currentConversationIdFromActiveLinks();
  }

  function normalizeSandboxPath(value, fallbackName = '') {
    const rawInput = String(value || '').trim();
    const fallback = cleanUploadedFilename(fallbackName || '');
    let raw = rawInput;

    if (/^sandbox:\/\//i.test(raw)) raw = raw.replace(/^sandbox:\/\//i, '/');
    else if (/^sandbox:\//i.test(raw)) raw = raw.replace(/^sandbox:\//i, '/');
    else if (/^sandbox:/i.test(raw)) raw = raw.replace(/^sandbox:/i, '');

    try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }

    const marker = raw.match(/\/mnt\/data\/[^\n\r"'<>`\]]+/i);
    if (marker) raw = marker[0];
    else if (!raw && fallback) raw = `/mnt/data/${fallback}`;
    else if (fallback && looksLikeUploadedFilename(raw)) raw = `/mnt/data/${raw}`;

    raw = raw.replace(/\\+/g, '/').replace(/[?#].*$/g, '').trim();
    raw = raw.replace(/[),.;:]+$/g, '');
    if (!raw.startsWith('/mnt/data/')) return '';
    if (raw.includes('\0') || raw.includes('..')) return '';
    return raw;
  }

  function sandboxPathsFromText(value, fallbackName = '') {
    const raw = String(value || '');
    const out = [];
    const seen = new Set();
    const add = (candidate) => {
      const path = normalizeSandboxPath(candidate, fallbackName);
      if (!path || seen.has(path)) return;
      seen.add(path);
      out.push(path);
    };

    (raw.match(/sandbox:\/{0,2}mnt\/data\/[^\n\r"'<>`\]]+/ig) || []).forEach(add);
    (raw.match(/\/mnt\/data\/[^\n\r"'<>`\]]+/ig) || []).forEach(add);
    // Ne synthétise jamais /mnt/data/<filename> à partir du seul texte. Cela associait auparavant
    // des ID de message/fichier sans rapport à un nom visible et pouvait
    // enregistrer silencieusement le mauvais contenu sous le nom demandé.
    return out;
  }

  function messageIdFromElement(el) {
    if (!el) return '';
    const attrs = [
      'data-message-id',
      'data-messageid',
      'data-testid',
      'id',
      'aria-describedby'
    ];

    let node = el;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      for (const attrName of attrs) {
        const value = String(node.getAttribute?.(attrName) || '');
        const explicit = value.match(/(?:msg|message)[-_]([a-z0-9-]{10,})/i);
        if (explicit) return explicit[1];
        const uuid = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (uuid) return uuid[0];
      }
    }

    try {
      const child = el.querySelector?.('[data-message-id], [data-messageid], [id*="message" i], [data-testid*="message" i]');
      if (child) return messageIdFromElement(child);
    } catch { /* ignoré */ }

    return '';
  }

  function fileIdsFromText(value) {
    const raw = String(value || '');
    const ids = raw.match(/file[-_][A-Za-z0-9_-]{20,}/gi) || [];
    return Array.from(new Set(ids));
  }

  function downloadUrlsFromText(value) {
    const raw = String(value || '');
    const urls = raw.match(/https:\/\/[^\s"'<>`\\]+/g) || [];
    return Array.from(new Set(urls)).filter(isStrongDownloadHref);
  }

  function collectStringsDeep(value, maxDepth = 6, out = []) {
    if (out.length > 4000 || maxDepth < 0 || value == null) return out;
    if (typeof value === 'string') {
      if (value) out.push(value);
      return out;
    }
    if (typeof value !== 'object') return out;
    if (Array.isArray(value)) {
      value.forEach((item) => collectStringsDeep(item, maxDepth - 1, out));
      return out;
    }
    Object.keys(value).forEach((key) => {
      if (typeof key === 'string') out.push(key);
      collectStringsDeep(value[key], maxDepth - 1, out);
    });
    return out;
  }

  function localMessageIdFromObject(obj, current = '') {
    if (!obj || typeof obj !== 'object') return current;
    const role = String(obj?.author?.role || obj?.message?.author?.role || obj?.role || '').toLowerCase();
    const id = String(obj?.message?.id || obj?.id || obj?.message_id || obj?.messageId || '').trim();
    if (id && (role === 'assistant' || /^msg[_-]/i.test(id) || /[0-9a-f-]{20,}/i.test(id))) return id;
    return current;
  }

  async function fetchConversationJson(conversationId, projectId = '') {
    const cid = String(conversationId || '').trim();
    const pid = String(projectId || currentProjectId() || '').trim();
    if (!cid) throw new Error('DOWNLOAD_CONVERSATION_ID_MISSING');
    const cacheKey = `${cid}|${pid}`;
    if (conversationDataCache.has(cacheKey)) return conversationDataCache.get(cacheKey);

    const headers = await chatGptApiHeaders(pid);
    const urls = [
      `${location.origin}/backend-api/conversations/${encodeURIComponent(cid)}?include_has_versions=true&num_turns=100`,
      `${location.origin}/backend-api/conversation/${encodeURIComponent(cid)}`
    ];
    let lastError = null;

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`CONVERSATION_HTTP_${response.status}${text ? `_${text.slice(0, 80).replace(/\s+/g, '_')}` : ''}`);
        }

        const data = await response.json();
        // Depuis août 2026, ChatGPT sert /conversations/{id} avec un tableau
        // messages[] plat au lieu de l’ancien arbre mapping. Les collecteurs de fichiers
        // ci-dessous conservent volontairement leur parcours basé sur mapping ;
        // on crée donc un mapping de compatibilité sans modifier leur logique.
        if (!data?.mapping && Array.isArray(data?.messages)) {
          const mapping = {};
          data.messages.forEach((message, index) => {
            const id = String(message?.id || `cgx-message-${index + 1}`);
            mapping[id] = { id, message };
          });
          data.mapping = mapping;
        }

        conversationDataCache.set(cacheKey, data);
        return data;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('CONVERSATION_FETCH_FAILED');
  }

  function conversationDownloadEndpointCandidates(conversationId, messageId, sandboxPath) {
    const cid = String(conversationId || '').trim();
    const mid = String(messageId || '').trim();
    const path = normalizeSandboxPath(sandboxPath || '');
    if (!cid || !path) return [];

    const base = `${location.origin}/backend-api/conversation/${encodeURIComponent(cid)}/interpreter/download`;
    const out = [];
    const add = (messageIdValue) => {
      const params = new URLSearchParams();
      if (messageIdValue) params.set('message_id', messageIdValue);
      params.set('sandbox_path', path);
      out.push(`${base}?${params.toString()}`);
    };

    // Le flux actuel de téléchargement sandbox de ChatGPT exige message_id.
    // N’utilise pas le repli sans message : il renvoie systématiquement 422
    // et donne l’impression que les gros exports de projet sont bloqués pendant des tentatives inutiles.
    if (mid) add(mid);
    return out;
  }

  function fileDownloadEndpointCandidates(fileId, conversationId = '') {
    const fid = String(fileId || '').trim();
    if (!/^file[-_][A-Za-z0-9_-]{20,}$/i.test(fid)) return [];
    const out = [];
    const cid = String(conversationId || '').trim();
    const encoded = encodeURIComponent(fid);
    const add = (value) => { if (value) out.push(value); };

    // Endpoint de fichier ChatGPT actuel. Certains éléments historiques refusent ou renvoient 404 lorsque
    // conversation_id est fourni alors que le même ID de fichier reste valide ;
    // essaie donc toujours les formes avec et sans périmètre.
    if (cid) {
      add(`${location.origin}/backend-api/files/download/${encoded}?conversation_id=${encodeURIComponent(cid)}&inline=false`);
      add(`${location.origin}/backend-api/files/download/${encoded}?conversation_id=${encodeURIComponent(cid)}&post_id=&inline=false`);
    }
    add(`${location.origin}/backend-api/files/download/${encoded}?inline=false`);
    add(`${location.origin}/backend-api/files/download/${encoded}?post_id=&inline=false`);

    // Les variantes anciennes/actuelles peuvent renvoyer des métadonnées JSON contenant download_url.
    add(`${location.origin}/backend-api/files/${encoded}/download`);
    add(`${location.origin}/backend-api/files/${encoded}`);

    // Estuary est la route de contenu finale pour de nombreux éléments du service de fichiers. Un ID
    // authentifié seul fonctionne pour certains éléments historiques ; le conserve en dernier.
    add(`${location.origin}/backend-api/estuary/content?id=${encoded}`);
    return Array.from(new Set(out));
  }


  function findConversationDownloadCandidates(data, fileName, conversationId) {
    const target = canonicalDownloadFilename(fileName || '');
    const targetLow = target.toLowerCase();
    if (!targetLow) return [];

    const out = [];
    const seen = new Set();
    const basenameMatches = (value) => {
      const candidate = canonicalDownloadFilename(downloadFilenameFromHref(value || '') || String(value || '').split('/').pop() || '');
      return Boolean(candidate && candidate.toLowerCase() === targetLow);
    };
    const add = (candidate) => {
      const item = Object.assign({ conversationId }, candidate || {});
      const key = [item.url || '', item.sandboxPath || '', item.fileId || '', item.messageId || ''].join('|');
      if (!key.replace(/\|/g, '') || seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };

    const walk = (node, ctx = {}, depth = 0) => {
      if (!node || depth > 32) return;
      if (typeof node === 'string') {
        if (!node.toLowerCase().includes(targetLow)) return;
        downloadUrlsFromText(node)
          .filter(basenameMatches)
          .forEach((url) => add({ url, messageId: ctx.messageId || '' }));
        sandboxPathsFromText(node, target)
          .filter(basenameMatches)
          .forEach((sandboxPath) => add({ sandboxPath, messageId: ctx.messageId || '' }));
        // Ne récupère pas d’ID de fichier arbitraires depuis un objet plus large simplement parce que
        // le nom de fichier cible apparaît ailleurs dans cet objet. L’extraction structurée des
        // métadonnées associe déjà les vrais ID de fichiers à leurs noms.
        return;
      }
      if (typeof node !== 'object') return;

      const nextCtx = Object.assign({}, ctx, { messageId: localMessageIdFromObject(node, ctx.messageId || '') });
      if (Array.isArray(node)) node.forEach((item) => walk(item, nextCtx, depth + 1));
      else Object.keys(node).forEach((key) => walk(node[key], nextCtx, depth + 1));
    };

    walk(data, {}, 0);
    return out;
  }

  function pointerToFileId(value) {
    const raw = String(value || '').trim();
    const m = raw.match(/file[-_][A-Za-z0-9_-]{8,}/i);
    return m ? m[0] : '';
  }

  function filenameFromMetaObject(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const values = [
      obj.name,
      obj.file_name,
      obj.filename,
      obj.title,
      obj.display_name,
      obj?.metadata?.name,
      obj?.metadata?.file_name,
      obj?.metadata?.filename
    ];
    for (const value of values) {
      const cleaned = canonicalDownloadFilename(value || '');
      if (cleaned && looksLikeUploadedFilename(cleaned)) return cleaned;
    }
    return '';
  }

  function addApiDownloadCandidate(out, seen, candidate) {
    const name = canonicalDownloadFilename(candidate?.name || downloadFilenameFromHref(candidate?.pointer || candidate?.url || candidate?.sandboxPath || ''));
    const sandboxPath = normalizeSandboxPath(candidate?.sandboxPath || candidate?.pointer || '', name);
    const fileId = pointerToFileId(candidate?.fileId || candidate?.file_id || candidate?.pointer || candidate?.url || '');
    const url = String(candidate?.url || (sandboxPath ? `sandbox:${sandboxPath}` : '') || '').trim();
    if (!name || !looksLikeUploadedFilename(name)) return;
    const key = [name.toLowerCase(), sandboxPath, fileId, candidate?.messageId || '', candidate?.conversationId || ''].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name,
      url: url || (fileId ? `${location.origin}/backend-api/files/download/${encodeURIComponent(fileId)}?conversation_id=${encodeURIComponent(String(candidate?.conversationId || ''))}&inline=false` : ''),
      sandboxPath,
      fileId,
      conversationId: String(candidate?.conversationId || ''),
      projectId: String(candidate?.projectId || ''),
      messageId: String(candidate?.messageId || '')
    });
  }

  function filenameFromUploadMetaObject(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const values = [
      obj.name,
      obj.file_name,
      obj.filename,
      obj.title,
      obj.display_name,
      obj?.metadata?.name,
      obj?.metadata?.file_name,
      obj?.metadata?.filename,
      obj?.metadata?.title
    ];
    for (const value of values) {
      const cleaned = cleanUploadedFilename(value || '');
      if (cleaned && looksLikeUploadedFilename(cleaned)) return cleaned;
    }
    return '';
  }

  function addApiUploadCandidate(out, seen, candidate) {
    const name = cleanUploadedFilename(
      candidate?.name
      || filenameFromUploadMetaObject(candidate?.raw)
      || uploadedFilenameFromHref(candidate?.url || candidate?.pointer || '')
      || downloadFilenameFromHref(candidate?.url || candidate?.pointer || '')
      || ''
    );
    const fileId = pointerToFileId(candidate?.fileId || candidate?.file_id || candidate?.pointer || candidate?.url || '');
    let url = String(candidate?.url || '').trim();

    if (!url && fileId) {
      url = `${location.origin}/backend-api/files/download/${encodeURIComponent(fileId)}?conversation_id=${encodeURIComponent(String(candidate?.conversationId || ''))}&inline=false`;
    }

    if (!name || !looksLikeUploadedFilename(name)) return;
    if (!url || !/^https:/i.test(url)) return;

    const key = [name.toLowerCase(), url, fileId, candidate?.messageId || '', candidate?.conversationId || ''].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name,
      url,
      fileId,
      conversationId: String(candidate?.conversationId || ''),
      projectId: String(candidate?.projectId || ''),
      messageId: String(candidate?.messageId || '')
    });
  }

  function collectConversationApiUploadEntries(data, conversationId = '', projectId = '') {
    const mapping = data?.mapping || {};
    const out = [];
    const seen = new Set();
    const cid = String(conversationId || data?.conversation_id || '').trim();
    const pid = String(projectId || data?.gizmo_id || data?.conversation_template_id || '').trim();

    const inspectUploadRef = (ref, ctx = {}) => {
      if (!ref || typeof ref !== 'object') return;
      const refName = filenameFromUploadMetaObject(ref);
      const refFileId = String(
        ref.file_id
        || ref.fileId
        || ref.id
        || pointerToFileId(ref.asset_pointer || ref.pointer || ref.url || ref.download_url || '')
        || ''
      ).trim();
      const refUrl = String(ref.url || ref.download_url || ref.downloadUrl || ref.file_url || ref.fileUrl || '').trim();
      const refPointer = String(ref.asset_pointer || ref.pointer || '').trim();

      addApiUploadCandidate(out, seen, {
        name: refName,
        url: isRealDownloadUrlCandidate(refUrl) && /^https:/i.test(refUrl) ? refUrl : '',
        pointer: refPointer,
        fileId: refFileId,
        raw: ref,
        conversationId: cid,
        projectId: String(ctx.projectId || pid || ''),
        messageId: String(ctx.messageId || '')
      });

      // Certaines références d’envoi sont imbriquées un niveau sous les métadonnées visibles.
      for (const key of [
        'file',
        'attachment',
        'asset',
        'metadata',
        'uploaded_file',
        'uploadedFile',
        'source',
        'source_file',
        'sourceFile'
      ]) {
        const child = ref[key];
        if (child && typeof child === 'object' && child !== ref) inspectUploadRef(child, ctx);
      }
    };

    Object.keys(mapping).forEach((key) => {
      const node = mapping[key];
      const msg = node?.message || node;
      if (!msg || typeof msg !== 'object') return;

      const role = String(msg?.author?.role || msg?.role || '').toLowerCase();
      if (role !== 'user') return;

      const messageId = String(msg?.id || key || '').trim();
      const msgProjectId = String(pid || msg?.metadata?.gizmo_id || msg?.metadata?.conversation_template_id || '').trim();
      const ctx = { messageId, projectId: msgProjectId };
      const meta = msg.metadata || {};

      (Array.isArray(meta.attachments) ? meta.attachments : []).forEach((ref) => inspectUploadRef(ref, ctx));
      (Array.isArray(meta.files) ? meta.files : []).forEach((ref) => inspectUploadRef(ref, ctx));
      (Array.isArray(meta.uploaded_files) ? meta.uploaded_files : []).forEach((ref) => inspectUploadRef(ref, ctx));
      (Array.isArray(meta.uploadedFiles) ? meta.uploadedFiles : []).forEach((ref) => inspectUploadRef(ref, ctx));

      const refsByFile = meta.content_references_by_file || meta.content_references || {};
      if (Array.isArray(refsByFile)) refsByFile.forEach((ref) => inspectUploadRef(ref, ctx));
      else Object.values(refsByFile).flat().forEach((ref) => inspectUploadRef(ref, ctx));

      const parts = Array.isArray(msg?.content?.parts) ? msg.content.parts : [];
      parts.forEach((part) => {
        if (part && typeof part === 'object') inspectUploadRef(part, ctx);
      });
    });

    return out;
  }

  async function mergeConversationApiUploadsIntoMessages(messages) {
    const cid = currentConversationId();
    if (!cid || !Array.isArray(messages) || !messages.length) return messages;
    const pid = currentProjectId();

    try {
      const data = await fetchConversationJson(cid, pid);
      const apiEntries = collectConversationApiUploadEntries(data, cid, pid);
      if (!apiEntries.length) {
        log(`upload api entries conversation=${cid} count=0`);
        return messages;
      }

      const target = [...messages].reverse().find((m) => String(m?.role || '').toLowerCase() === 'user') || messages[0];
      const merged = new Map();
      (Array.isArray(target.uploads) ? target.uploads : []).forEach((entry) => {
        const key = `${String(entry?.name || '').toLowerCase()}|${String(entry?.url || '')}|${String(entry?.fileId || '')}`;
        if (entry?.name && !merged.has(key)) merged.set(key, entry);
      });
      apiEntries.forEach((entry) => {
        const key = `${String(entry?.name || '').toLowerCase()}|${String(entry?.url || '')}|${String(entry?.fileId || '')}`;
        if (entry?.name && !merged.has(key)) merged.set(key, entry);
      });
      target.uploads = Array.from(merged.values());
      log(`upload api entries conversation=${cid} count=${apiEntries.length} ${apiEntries.map((entry) => entry.name).join(' | ')}`);
    } catch (error) {
      log(`upload api entries failed conversation=${cid} ${error?.message || error}`);
    }

    return messages;
  }

  function collectConversationApiDownloadEntries(data, conversationId = '', projectId = '') {
    const mapping = data?.mapping || {};
    const out = [];
    const seen = new Set();
    const cid = String(conversationId || data?.conversation_id || '').trim();
    const pid = String(projectId || data?.gizmo_id || data?.conversation_template_id || '').trim();

    Object.keys(mapping).forEach((key) => {
      const node = mapping[key];
      const msg = node?.message || node;
      if (!msg || typeof msg !== 'object') return;

      const role = String(msg?.author?.role || msg?.role || '').toLowerCase();
      if (role === 'user') return;

      const messageId = String(msg?.id || key || '').trim();
      const msgProjectId = String(pid || msg?.metadata?.gizmo_id || msg?.metadata?.conversation_template_id || '').trim();
      // Ne parcourt pas ici tout le texte du message de l’assistant. Les blocs de code et
      // commandes de terminal contiennent souvent des chemins /mnt/data qui ne sont pas proposés
      // au téléchargement. Seules les références API structurées sont acceptées ci-dessous.

      const inspectRef = (ref) => {
        if (!ref || typeof ref !== 'object') return;
        const refName = filenameFromMetaObject(ref);
        const refFileId = String(ref.file_id || ref.fileId || pointerToFileId(ref.id || ref.asset_pointer || ref.pointer || '') || '').trim();
        const refPointer = String(ref.asset_pointer || ref.pointer || ref.url || ref.download_url || ref.downloadUrl || ref.file_url || '').trim();
        const refSandbox = normalizeSandboxPath(ref.sandbox_path || ref.sandboxPath || refPointer, refName);
        const fileSignal = Boolean(
          refName
          || refFileId
          || refPointer
          || refSandbox
          || ref.file_id
          || ref.fileId
          || ref.sandbox_path
          || ref.sandboxPath
          || ref.asset_pointer
          || ref.pointer
          || ref.download_url
          || ref.downloadUrl
          || ref.file_url
          || ref.fileUrl
          || ref.audio_asset_pointer
          || ref.image_asset_pointer
        );

        if (!fileSignal) return;

        if (refSandbox || refFileId || refPointer) {
          addApiDownloadCandidate(out, seen, {
            name: refName || downloadFilenameFromHref(refPointer || refSandbox || refFileId),
            url: isRealDownloadUrlCandidate(refPointer) ? refPointer : '',
            sandboxPath: refSandbox,
            fileId: refFileId,
            conversationId: cid,
            projectId: msgProjectId,
            messageId
          });
        }

        const refStrings = collectStringsDeep(ref, 5, []);
        refStrings.forEach((value) => {
          sandboxPathsFromText(value, refName).forEach((sandboxPath) => {
            const pathName = canonicalDownloadFilename(downloadFilenameFromHref(`sandbox:${sandboxPath}`));
            if (refName && pathName && pathName.toLowerCase() !== canonicalDownloadFilename(refName).toLowerCase()) return;
            addApiDownloadCandidate(out, seen, {
              name: refName || pathName,
              sandboxPath,
              conversationId: cid,
              projectId: msgProjectId,
              messageId
            });
          });
          // Les ID de fichiers ne sont considérés fiables que s’ils proviennent des champs structurés
          // ci-dessus. Extraire chaque jeton file_* d’un texte imbriqué provoquait la réutilisation d’un
          // contenu valide sous plusieurs noms de fichiers sans rapport.
        });
      };

      const meta = msg.metadata || {};
      (Array.isArray(meta.attachments) ? meta.attachments : []).forEach(inspectRef);

      const refsByFile = meta.content_references_by_file || meta.content_references || {};
      if (Array.isArray(refsByFile)) refsByFile.forEach(inspectRef);
      else Object.values(refsByFile).flat().forEach(inspectRef);

      const n7 = meta.n7jupd_crefs_by_file || meta.n7jupd_crefs || {};
      if (Array.isArray(n7)) n7.forEach(inspectRef);
      else Object.values(n7).flat().forEach(inspectRef);

      const parts = Array.isArray(msg?.content?.parts) ? msg.content.parts : [];
      parts.forEach((part) => {
        if (!part || typeof part !== 'object') return;
        inspectRef(part);
        inspectRef(part.audio_asset_pointer);
        inspectRef(part.image_asset_pointer);
      });
    });

    return out;
  }

  async function mergeConversationApiDownloadsIntoMessages(messages) {
    const cid = currentConversationId();
    if (!cid || !Array.isArray(messages) || !messages.length) return messages;
    const pid = currentProjectId();

    try {
      const data = await fetchConversationJson(cid, pid);
      const apiEntries = collectConversationApiDownloadEntries(data, cid, pid);
      if (!apiEntries.length) {
        log(`download api entries conversation=${cid} count=0`);
        return messages;
      }

      const target = [...messages].reverse().find((m) => String(m?.role || '').toLowerCase() === 'assistant') || messages[messages.length - 1];
      const merged = new Map();
      (Array.isArray(target.downloads) ? target.downloads : []).forEach((entry) => {
        const key = `${String(entry?.name || '').toLowerCase()}|${String(entry?.url || '')}|${String(entry?.sandboxPath || '')}|${String(entry?.fileId || '')}`;
        if (entry?.name && !merged.has(key)) merged.set(key, entry);
      });
      apiEntries.forEach((entry) => {
        const key = `${String(entry?.name || '').toLowerCase()}|${String(entry?.url || '')}|${String(entry?.sandboxPath || '')}|${String(entry?.fileId || '')}`;
        if (entry?.name && !merged.has(key)) merged.set(key, entry);
      });
      target.downloads = Array.from(merged.values());
      log(`download api entries conversation=${cid} count=${apiEntries.length} ${apiEntries.map((entry) => entry.name).join(' | ')}`);
    } catch (error) {
      log(`download api entries failed conversation=${cid} ${error?.message || error}`);
    }

    return messages;
  }

  function bytesStartWith(bytes, signature) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!view.length || view.length < signature.length) return false;
    return signature.every((value, index) => view[index] === value);
  }

  function bytesLookLikeJsonError(bytes, contentType = '') {
    const ct = String(contentType || '').toLowerCase();
    const text = bytesToUtf8(bytes, 4096).trim();
    if (!text) return false;
    if (!ct.includes('json') && !/^[{[]/.test(text)) return false;
    try {
      const data = JSON.parse(text);
      const lower = text.toLowerCase();
      return Boolean(
        data?.error
        || data?.detail
        || data?.message
        || data?.code
        || lower.includes('not found')
        || lower.includes('expired')
        || lower.includes('missing')
        || lower.includes('unauthorized')
        || lower.includes('forbidden')
      );
    } catch {
      return false;
    }
  }

  function expectedBinarySignatureOk(fileName, result) {
    const name = String(fileName || '').toLowerCase();
    const bytes = result?.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result?.bytes || []);
    if (!bytes.length) return false;

    if (/\.pdf$/i.test(name)) return bytesStartWith(bytes, [0x25, 0x50, 0x44, 0x46]);
    if (/\.png$/i.test(name)) return bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (/\.jpe?g$/i.test(name)) return bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
    if (/\.gif$/i.test(name)) return bytesStartWith(bytes, [0x47, 0x49, 0x46, 0x38]);
    if (/\.(?:zip|docx|xlsx|pptx|odt|ods|odp|jar)$/i.test(name)) return bytesStartWith(bytes, [0x50, 0x4b]);
    if (/\.webp$/i.test(name)) return bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytesToUtf8(bytes.slice(8, 12), 4) === 'WEBP';
    return true;
  }

  function validateFilePayload(fileName, result, label = 'DOWNLOAD') {
    const name = canonicalDownloadFilename(fileName);
    const contentType = String(result?.contentType || '').toLowerCase();
    const expectsHtml = /\.(?:html?|xhtml)$/i.test(name);
    const expectsJson = /\.(?:json|geojson|ipynb)$/i.test(name);
    const isHtml = contentType.includes('text/html') || bytesLookLikeHtml(result?.bytes);

    if (isHtml && !expectsHtml) {
      throw new Error(`${label}_REJECTED_HTML_VIEWER`);
    }

    if (!expectsJson && bytesLookLikeJsonError(result?.bytes, contentType)) {
      throw new Error(`${label}_REJECTED_JSON_ERROR`);
    }

    if (!expectedBinarySignatureOk(name, result)) {
      throw new Error(`${label}_REJECTED_BAD_SIGNATURE`);
    }

    const bytes = result?.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result?.bytes || []);
    const isPdf = bytesStartWith(bytes, [0x25, 0x50, 0x44, 0x46]);
    const isZip = bytesStartWith(bytes, [0x50, 0x4b]);
    const isPng = bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const isJpeg = bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
    const expectsText = /\.(?:txt|md|markdown|csv|xml|ya?ml|json|js|mjs|cjs|ts|tsx|jsx|css|scss|sh|bash|zsh|ps1|bat|cmd|log|sql|py)$/i.test(name);
    if (expectsText && (isPdf || isZip || isPng || isJpeg)) {
      throw new Error(`${label}_REJECTED_TYPE_MISMATCH`);
    }

    return result;
  }

  function validateDownloadedFilePayload(fileName, result) {
    return validateFilePayload(fileName, result, 'DOWNLOAD');
  }

  function validateUploadedFilePayload(fileName, result) {
    return validateFilePayload(fileName, result, 'UPLOAD');
  }

  async function fetchUploadedFileBytes(url, entry = {}) {
    const raw = String(url || '').trim();
    const fileName = canonicalDownloadFilename(entry?.name || '') || cleanUploadedFilename(entry?.name || '');
    const projectId = String(entry?.projectId || currentProjectId() || '').trim();
    const conversationId = String(entry?.conversationId || currentConversationId() || '').trim();
    const fileId = String(entry?.fileId || pointerToFileId(raw) || '').trim();
    const errors = [];
    const tried = new Set();

    const attempt = async (candidate, label = 'upload') => {
      const href = String(candidate || '').trim();
      if (!href || tried.has(href)) return null;
      tried.add(href);
      try {
        let result;
        if (/^https:/i.test(href)) {
          result = isSameOriginBackendApiUrl(href)
            ? await fetchBackendApiBytes(href, projectId)
            : await fetchAttachmentBytes(href);
        } else {
          throw new Error('UPLOAD_URL_NOT_FETCHABLE');
        }

        validateUploadedFilePayload(fileName || href, result);
        log(`upload candidate ok ${label} ${href} bytes=${result.bytes.length}`);
        return result;
      } catch (error) {
        errors.push(`${label}:${error?.message || error}`);
        log(`upload candidate failed ${label} ${href} ${error?.message || error}`);
        return null;
      }
    };

    if (/^https:/i.test(raw)) {
      const direct = await attempt(raw, 'direct');
      if (direct) return direct;
    }

    for (const endpoint of fileDownloadEndpointCandidates(fileId, conversationId)) {
      const byFileId = await attempt(endpoint, 'file-id');
      if (byFileId) return byFileId;
    }

    // Les exports Projet/TOUS se terminent sur une autre page de chat. Résout à nouveau l’envoi
    // par rapport à la conversation source afin que des URL DOM obsolètes ou des métadonnées supprimées
    // ne fassent pas disparaître le fichier de Upload/.
    if (conversationId && fileName) {
      try {
        const conversationData = await fetchConversationJson(conversationId, projectId);
        const apiUploads = collectConversationApiUploadEntries(conversationData, conversationId, projectId)
          .filter((candidate) => String(candidate?.name || '').toLowerCase() === fileName.toLowerCase());
        log(`upload api candidates ${fileName} count=${apiUploads.length}`);

        for (const candidate of apiUploads) {
          const candidateProjectId = String(candidate?.projectId || projectId || '').trim();
          if (candidate?.url) {
            const byUrl = await attempt(candidate.url, 'api-url');
            if (byUrl) return byUrl;
          }
          const candidateFileId = String(candidate?.fileId || '').trim();
          for (const endpoint of fileDownloadEndpointCandidates(candidateFileId, conversationId)) {
            const href = String(endpoint || '').trim();
            if (!href || tried.has(href)) continue;
            tried.add(href);
            try {
              const result = await fetchBackendApiBytes(href, candidateProjectId);
              validateUploadedFilePayload(fileName || href, result);
              log(`upload candidate ok api-file-id ${href} bytes=${result.bytes.length}`);
              return result;
            } catch (error) {
              errors.push(`api-file-id:${error?.message || error}`);
              log(`upload candidate failed api-file-id ${href} ${error?.message || error}`);
            }
          }
        }
      } catch (error) {
        errors.push(`conversation-api:${error?.message || error}`);
        log(`upload api resolution failed ${fileName} ${error?.message || error}`);
      }
    }

    throw new Error(errors.length ? errors.join(' | ') : 'UPLOAD_FETCH_FAILED');
  }

  async function fetchDownloadFileBytes(url, entry = {}) {
    const raw = String(url || '').trim();
    const fileName = canonicalDownloadFilename(entry?.name || '');
    const conversationId = String(entry?.conversationId || currentConversationId() || '').trim();
    const messageId = String(entry?.messageId || '').trim();
    const projectId = String(entry?.projectId || currentProjectId() || '').trim();
    const fileId = String(entry?.fileId || '').trim();
    const sandboxPath = normalizeSandboxPath(entry?.sandboxPath || raw, fileName)
      || (fileName ? `/mnt/data/${fileName}` : '');
    const errors = [];
    const tried = new Set();

    const attempt = async (candidate, label = 'download') => {
      const href = String(candidate || '').trim();
      if (!href || tried.has(href)) return null;
      tried.add(href);
      try {
        let result;
        if (/^https:/i.test(href)) {
          result = isSameOriginBackendApiUrl(href)
            ? await fetchBackendApiBytes(href, projectId)
            : await fetchAttachmentBytes(href);
        } else if (/^(?:data:|blob:)/i.test(href)) {
          const response = await fetch(href);
          if (!response.ok) throw new Error(`DOWNLOAD_HTTP_${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          result = {
            bytes,
            contentType: String(response.headers.get('content-type') || ''),
            finalUrl: href,
            size: bytes.length
          };
        } else {
          throw new Error(/^sandbox:/i.test(href) ? 'DOWNLOAD_SANDBOX_NEEDS_RESOLVE' : 'DOWNLOAD_URL_NOT_FETCHABLE');
        }

        const metaUrl = metaDownloadUrlFromBytes(result.bytes, result.contentType);
        if (metaUrl) {
          const finalResult = await fetchAttachmentBytes(metaUrl);
          validateDownloadedFilePayload(fileName || href, finalResult);
          log(`download candidate ok ${label}-meta ${href} -> ${metaUrl} bytes=${finalResult.bytes.length}`);
          return finalResult;
        }

        validateDownloadedFilePayload(fileName || href, result);
        log(`download candidate ok ${label} ${href} bytes=${result.bytes.length}`);
        return result;
      } catch (error) {
        errors.push(`${label}:${error?.message || error}`);
        log(`download candidate failed ${label} ${href} ${error?.message || error}`);
        return null;
      }
    };

    if (/^(?:https:|blob:|data:)/i.test(raw)) {
      const direct = await attempt(raw, 'direct');
      if (direct) return direct;
    }

    for (const endpoint of fileDownloadEndpointCandidates(fileId, conversationId)) {
      const byFileId = await attempt(endpoint, 'entry-file-id');
      if (byFileId) return byFileId;
    }

    for (const candidate of conversationDownloadEndpointCandidates(conversationId, messageId, sandboxPath)) {
      const resolved = await attempt(candidate, 'sandbox');
      if (resolved) return resolved;
    }

    if (conversationId && fileName) {
      try {
        const conversationData = await fetchConversationJson(conversationId, projectId);
        const fullApiCandidates = collectConversationApiDownloadEntries(conversationData, conversationId, projectId)
          .filter((candidate) => String(candidate?.name || '').toLowerCase() === fileName.toLowerCase());
        // Le parcours récursif de compatibilité peut exploser sur des libellés génériques comme
        // « Copier », car le mot apparaît partout dans une conversation. N’utilise ce repli
        // que pour des noms ayant réellement la forme d’un nom de fichier et le limite pour éviter
        // des centaines de tentatives réseau par fichier.
        const fallbackApiCandidates = /\.[A-Za-z0-9]{1,12}$/i.test(fileName)
          ? findConversationDownloadCandidates(conversationData, fileName, conversationId).slice(0, 24)
          : [];
        log(`download api candidates ${fileName} structured=${fullApiCandidates.length} fallback=${fallbackApiCandidates.length}`);

        for (const candidate of [...fullApiCandidates, ...fallbackApiCandidates]) {
          if (candidate.url && !/^sandbox:/i.test(candidate.url)) {
            const byUrl = await attempt(candidate.url, 'api-url');
            if (byUrl) return byUrl;
          }
          for (const endpoint of fileDownloadEndpointCandidates(candidate.fileId, conversationId)) {
            const byFileId = await attempt(endpoint, 'file-id');
            if (byFileId) return byFileId;
          }
          const candidateSandbox = normalizeSandboxPath(candidate.sandboxPath || candidate.url, fileName) || sandboxPath;
          for (const endpoint of conversationDownloadEndpointCandidates(conversationId, candidate.messageId || messageId, candidateSandbox)) {
            const bySandbox = await attempt(endpoint, 'api-sandbox');
            if (bySandbox) return bySandbox;
          }
        }
      } catch (error) {
        errors.push(`conversation-api:${error?.message || error}`);
        log(`download conversation api failed ${fileName} ${error?.message || error}`);
      }
    }

    if (!raw && !sandboxPath && !fileId) throw new Error('DOWNLOAD_URL_MISSING');
    throw new Error(errors.length ? errors.join(' | ') : 'DOWNLOAD_FETCH_FAILED');
  }

  function extractDownloadFileEntries(container, role) {
    if (!container || String(role || '').toLowerCase() !== 'assistant') return [];

    const found = new Map();
    const conversationId = currentConversationId();
    const projectId = currentProjectId();
    const containerMessageId = messageIdFromElement(container);

    const add = (name, href = '', extra = {}) => {
      const cleaned = canonicalDownloadFilename(name);
      if (!cleaned || !looksLikeUploadedFilename(cleaned)) return;

      const realHref = isRealDownloadUrlCandidate(href) ? String(href || '') : '';
      const sandboxPath = normalizeSandboxPath(extra.sandboxPath || realHref, cleaned);
      const fileId = String(extra.fileId || pointerToFileId(realHref) || '').trim();

      // N’invente jamais sandbox:/mnt/data/<filename> à partir d’un simple libellé.
      // La fusion via l’API de conversation fournit de vrais chemins sandbox/ID de fichiers pour les
      // fichiers générés par l’assistant. Les seuls libellés DOM produisaient des contenus JSON/erreur
      // de 106 octets et de fausses entrées dans Download/.
      if (!realHref && !sandboxPath && !fileId) return;

      const url = realHref || (sandboxPath ? `sandbox:${sandboxPath}` : '');
      const messageId = String(extra.messageId || containerMessageId || '').trim();
      const key = `${cleaned.toLowerCase()}|${url}|${messageId}|${conversationId}|${fileId}`;

      if (!found.has(key)) {
        found.set(key, {
          name: cleaned,
          url,
          sandboxPath,
          fileId,
          conversationId,
          projectId,
          messageId
        });
      }
    };

    const extractNamesFromClickableText = (value) => {
      const raw = String(value || '').replace(/\r/g, '\n').trim();
      if (!raw) return [];

      const names = [];
      const seen = new Set();

      const push = (candidate) => {
        const cleaned = canonicalDownloadFilename(candidate);
        if (!cleaned || !looksLikeUploadedFilename(cleaned)) return;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        names.push(cleaned);
      };

      // Utilise d’abord la détection existante de noms de fichiers orientée ligne.
      filenameCandidatesFromText(raw).forEach(push);

      // Supprime ensuite explicitement les verbes courants de téléchargement et vérifie à nouveau.
      raw.split(/\n+/).forEach((line) => {
        const cleanedLine = line
          .replace(/^(?:download|télécharger|telecharger|download file|download the file|fichier à télécharger|fichier a telecharger)\s*[:\-–—]*\s*/i, '')
          .trim();
        if (looksLikeUploadedFilename(cleanedLine)) push(cleanedLine);

        // Catch a filename embedded inside a clickable label such as:
        // "Télécharger brave-extension-ChatGPT-Export_runtime_v5.0.16.zip"
        const matches = cleanedLine.match(/[^<>"|?*\n]{1,240}\.[a-z0-9][a-z0-9._+-]{0,15}/ig) || [];
        matches.forEach((m) => {
          const candidate = m
            .replace(/^(?:download|télécharger|telecharger)\s+/i, '')
            .trim();
          push(candidate);
        });
      });

      return names;
    };

    const inspect = (el) => {
      if (!el || el.closest?.(`#${WIDGET_ID}`)) return;

      const href = bestDownloadUrlFromElement(el);
      const messageId = messageIdFromElement(el) || containerMessageId;

      const explicitDownload = el.hasAttribute?.('download')
        || Boolean(el.getAttribute?.('data-filename'))
        || Boolean(el.getAttribute?.('data-file-name'));

      const signal = [
        el.getAttribute?.('data-testid') || '',
        el.getAttribute?.('aria-label') || '',
        el.getAttribute?.('title') || '',
        el.className || ''
      ].join(' ').toLowerCase();

      const visible = String(el.innerText || el.textContent || '').trim();
      const visibleNames = extractNamesFromClickableText(visible);
      const labelNames = [
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('title')
      ].filter(Boolean).flatMap(extractNamesFromClickableText);

      const downloadVerb = /\b(download|télécharger|telecharger)\b/i.test(
        `${visible} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''}`
      );

      const structural = /(download|file|attachment|artifact)/i.test(signal)
        || elementLooksLikeAttachmentCard(el);

      const strongHref = isStrongDownloadHref(href);
      const clickableFilename = visibleNames.length > 0 || labelNames.length > 0;

      // Ignore les boutons ChatGPT génériques sauf s’ils portent un vrai signal de nom de fichier/téléchargement.
      // Cela élimine les faux positifs provenant de classes CSS dans l’index du projet.
      if (!explicitDownload && !structural && !strongHref && !downloadVerb && !clickableFilename) return;
      if (!clickableFilename && !explicitDownload && !strongHref) return;

      const attrNames = [
        el.getAttribute?.('download'),
        el.getAttribute?.('data-filename'),
        el.getAttribute?.('data-file-name'),
        downloadFilenameFromHref(href)
      ].filter(Boolean);

      attrNames.forEach((name) => add(name, href, { messageId, sandboxPath: normalizeSandboxPath(href, name) }));
      visibleNames.forEach((name) => add(name, href, { messageId, sandboxPath: normalizeSandboxPath(href, name) }));
      labelNames.forEach((name) => add(name, href, { messageId, sandboxPath: normalizeSandboxPath(href, name) }));
    };

    try {
      container.querySelectorAll?.(
        'a[href], a[download], button, [role="link"], [role="button"], ' +
        '[data-filename], [data-file-name], [data-download-url], [data-file-url], [data-url]'
      ).forEach(inspect);
    } catch { /* ignoré */ }

    const result = Array.from(found.values());
    if (result.length) {
      log(`files to download detected=${result.length} ${result.map((entry) => `${entry.name}${entry.url ? '' : ' (no-url)'}`).join(' | ')}`);
    }
    return result;
  }

  function extractUploadedFileEntries(container, role) {
    if (!container || String(role || '').toLowerCase() !== 'user') return [];

    const entries = new Map();
    const contentBody = contentNode(container);
    const urlPool = [];

    const addUrlPool = (url) => {
      const normalized = normalizeAttachmentUrl(url);
      if (!normalized || !isLikelyAttachmentUrl(normalized)) return;
      if (!urlPool.includes(normalized)) urlPool.push(normalized);
    };

    const add = (name, url = '', explicit = false) => {
      const cleaned = cleanUploadedFilename(name);
      if (!cleaned) return;
      if (!explicit && !looksLikeUploadedFilename(cleaned)) return;

      const normalizedUrl = normalizeAttachmentUrl(url);
      const key = cleaned.toLowerCase();
      const existing = entries.get(key);

      if (!existing) entries.set(key, { name: cleaned, url: normalizedUrl || '' });
      else if (!existing.url && normalizedUrl) existing.url = normalizedUrl;

      if (normalizedUrl) addUrlPool(normalizedUrl);
    };

    const inspect = (el, explicitSignal = false) => {
      if (!el || el.closest?.(`#${WIDGET_ID}`)) return;

      const ownUrl = attachmentUrlFromElement(el);
      if (ownUrl) addUrlPool(ownUrl);

      [
        el.getAttribute?.('data-filename'),
        el.getAttribute?.('data-file-name'),
        el.getAttribute?.('download')
      ].filter(Boolean).forEach((name) => add(name, ownUrl, true));

      [
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('title')
      ].filter(Boolean).forEach((label) => {
        filenameCandidatesFromText(label).forEach((name) => add(name, ownUrl));
      });

      if (el.tagName?.toLowerCase() === 'a') {
        const href = el.getAttribute?.('href') || el.href || '';
        const normalizedHref = normalizeAttachmentUrl(href);
        if (normalizedHref && isLikelyAttachmentUrl(normalizedHref)) addUrlPool(normalizedHref);

        const fromHref = uploadedFilenameFromHref(href);
        if (fromHref) add(fromHref, href);
      }

      const visible = String(el.innerText || el.textContent || '').trim();
      if (visible && (explicitSignal || elementLooksLikeAttachmentCard(el))) {
        filenameCandidatesFromText(visible).forEach((name) => add(name, ownUrl));
      }

      if (explicitSignal || elementLooksLikeAttachmentCard(el)) {
        let parent = el.parentElement;
        for (let depth = 0; parent && parent !== container && depth < 4; depth += 1, parent = parent.parentElement) {
          const parentUrl = attachmentUrlFromElement(parent) || ownUrl;
          if (parentUrl) addUrlPool(parentUrl);

          const txt = String(parent.innerText || parent.textContent || '').trim();
          if (txt && txt.length <= 500) {
            filenameCandidatesFromText(txt).forEach((name) => add(name, parentUrl));
          }
        }
      }
    };

    // Sélecteurs forts existants.
    try {
      if (container.matches?.(ATTACHMENT_EXPLICIT_SELECTOR)) inspect(container, true);
      container.querySelectorAll?.(ATTACHMENT_EXPLICIT_SELECTOR).forEach((el) => inspect(el, true));
    } catch { /* ignoré */ }

    // Tous les contrôles cliquables. Une vraie URL de pièce jointe est acceptée même lorsque le
    // lien se trouve dans le corps du message.
    try {
      container.querySelectorAll?.('a[href], button, [role="link"], [role="button"]').forEach((el) => {
        const explicit = Boolean(el.matches?.(ATTACHMENT_EXPLICIT_SELECTOR));
        const structural = elementLooksLikeAttachmentCard(el);
        const ownUrl = attachmentUrlFromElement(el);
        const realFileUrl = Boolean(ownUrl && isLikelyAttachmentUrl(ownUrl));
        const insidePlainBody = Boolean(contentBody && contentBody !== el && contentBody.contains?.(el));

        if (insidePlainBody && !explicit && !structural && !realFileUrl) return;
        inspect(el, explicit || structural || realFileUrl);
      });
    } catch { /* ignoré */ }

    // Parcourt chaque descendant hors du texte ordinaire à la recherche d’un texte ressemblant à un nom de fichier.
    // Cela détecte les puces de fichiers ChatGPT actuelles dont le div externe n’a pas de
    // data-testid ni d’attribut download stable.
    try {
      const outsideNames = filenameTextOutsideMessageBody(container, contentBody);
      outsideNames.forEach((name) => add(name, '', true));
    } catch { /* ignoré */ }

    // Collecte les URL de pièces jointes depuis tout descendant/attribut data-* inconnu.
    try {
      for (const el of Array.from(container.querySelectorAll?.('*') || [])) {
        const url = attachmentUrlFromElement(el);
        if (url) addUrlPool(url);
      }
    } catch { /* ignoré */ }

    // Associe les noms et les URL.
    const unresolved = Array.from(entries.values()).filter((entry) => !entry.url);

    for (const entry of unresolved) {
      const exact = urlPool.find((url) => {
        const fromUrl = uploadedFilenameFromHref(url);
        return fromUrl && fromUrl.toLowerCase() === entry.name.toLowerCase();
      });
      if (exact) entry.url = exact;
    }

    const stillUnresolved = Array.from(entries.values()).filter((entry) => !entry.url);

    // Une carte de fichier unique avec un nom et une URL de fichier est sans ambiguïté.
    if (stillUnresolved.length === 1 && urlPool.length === 1) {
      stillUnresolved[0].url = urlPool[0];
    }

    const result = Array.from(entries.values());
    if (result.length) {
      log(
        `attachment detector names=${result.length} urls=${urlPool.length} ` +
        `paired=${result.filter((entry) => entry.url).length} ` +
        result.map((entry) => `${entry.name}${entry.url ? '[url]' : '[no-url]'}`).join(' | ')
      );
    }

    return result;
  }

  function extractUploadedFileNames(container, role) {
    return extractUploadedFileEntries(container, role).map((entry) => entry.name);
  }

  function uploadedFilesMarkdown(names) {
    const files = Array.from(new Set((names || []).filter(Boolean)));
    if (!files.length) return '';
    const safeInline = (name) => String(name).replace(/`/g, '\\`');
    if (files.length === 1) return `**Fichier envoyé :** \`${safeInline(files[0])}\``;
    return `**Fichiers envoyés :**\n${files.map((name) => `- \`${safeInline(name)}\``).join('\n')}`;
  }

  function messageTextWithUploads(container, role, uploadEntries = null) {
    const base = nodeToMarkdown(contentNode(container)).replace(/\n{4,}/g, '\n\n\n').trim();
    const entries = Array.isArray(uploadEntries) ? uploadEntries : extractUploadedFileEntries(container, role);
    const uploads = entries.map((entry) => entry.name);
    const uploadBlock = uploadedFilesMarkdown(uploads);
    if (!uploadBlock) return base;
    if (uploads.length) {
      const downloadable = entries.filter((entry) => entry.url).length;
      log(`uploaded files detected=${uploads.length} downloadable=${downloadable} ${uploads.join(' | ')}`);
    }
    return [base, uploadBlock].filter(Boolean).join('\n\n').trim();
  }

  function collectVisibleMessages(all) {
    const containers = getContainers();
    runtime.metrics.containersSeen = Math.max(runtime.metrics.containersSeen, containers.length);
    containers.forEach((container, i) => {
      try {
        const role = roleOf(container);
        const uploads = extractUploadedFileEntries(container, role);
        const downloads = extractDownloadFileEntries(container, role);
        const text = messageTextWithUploads(container, role, uploads);
        if (!text) return;
        const order = containerOrder(container, i);
        const key = messageKey(container, role, text, order);
        const previous = all.get(key);
        const mergedUploads = new Map();
        [...(previous?.uploads || []), ...uploads].forEach((entry) => {
          const k = `${String(entry?.name || '').toLowerCase()}|${String(entry?.url || '')}`;
          if (entry?.name && !mergedUploads.has(k)) mergedUploads.set(k, entry);
        });
        const mergedDownloads = new Map();
        [...(previous?.downloads || []), ...downloads].forEach((entry) => {
          const k = `${String(entry?.name || '').toLowerCase()}|${String(entry?.url || '')}`;
          if (entry?.name && !mergedDownloads.has(k)) mergedDownloads.set(k, entry);
        });
        all.set(key, {
          role,
          text,
          index: i + 1,
          order,
          uploads: Array.from(mergedUploads.values()),
          downloads: Array.from(mergedDownloads.values())
        });
      } catch (error) {
        runtime.metrics.collectErrors += 1;
        log(`collect error ${error?.message || error}`);
      }
    });
  }

  function getContainers() {
    updateDomMetrics();
    const roleNodes = Array.from(document.querySelectorAll('[data-message-author-role], [data-author-role]'));
    const roleContainers = roleNodes.map((n) => messageContainerFor(n) || n.closest?.('article') || n);
    const turnNodes = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn-"], [data-testid^="conversation-turn-"]'));
    const articleNodes = Array.from(document.querySelectorAll('article[data-testid*="conversation"], article[data-testid*="message"]'));
    const genericNodes = Array.from(document.querySelectorAll('[data-testid*="user-message"], [data-testid*="assistant-message"], [data-testid*="message"]'))
      .map((n) => messageContainerFor(n) || n.closest?.('article') || n);
    const primary = dedupeElements([...turnNodes, ...roleContainers, ...articleNodes, ...genericNodes]);
    if (primary.length) return primary;

    // Repli de dernier recours en cas de futur changement du DOM ChatGPT : collecte les enfants directs visibles sous main qui ressemblent à du vrai contenu de chat.
    const main = document.querySelector('main, [role="main"]') || document.body;
    const fallback = Array.from(main.querySelectorAll(':scope > div, :scope article, :scope section'))
      .filter((n) => !widget?.contains(n) && norm(n.innerText || n.textContent).length > 20);
    return dedupeElements(fallback);
  }

  function roleOf(container) {
    const n = container?.matches?.('[data-message-author-role], [data-author-role]') ? container : container?.querySelector?.('[data-message-author-role], [data-author-role]');
    const role = (n?.getAttribute?.('data-message-author-role') || n?.getAttribute?.('data-author-role') || container?.getAttribute?.('data-message-author-role') || container?.getAttribute?.('data-author-role') || '').toLowerCase();
    if (role === 'user') return 'Utilisateur';
    if (role === 'assistant') return 'Assistant';
    if (role === 'tool') return 'Outil';
    const tid = String(container?.getAttribute?.('data-testid') || '').toLowerCase();
    if (tid.includes('user')) return 'User';
    if (tid.includes('assistant')) return 'Assistant';
    return 'Message';
  }

  function contentNode(container) {
    const n = container?.matches?.('[data-message-author-role], [data-author-role]') ? container : container?.querySelector?.('[data-message-author-role], [data-author-role]');
    return n?.querySelector?.('.markdown, .prose, [class*="markdown"], [class*="prose"], [data-testid*="message-content"], [class*="whitespace-pre-wrap"]') || n || container;
  }

  function collectMessages() {
    return getContainers().map((container, i) => {
      try {
        const role = roleOf(container);
        const uploads = extractUploadedFileEntries(container, role);
        const downloads = extractDownloadFileEntries(container, role);
        const text = messageTextWithUploads(container, role, uploads);
        return text ? { role, text, index: i + 1, uploads, downloads } : null;
      } catch (error) {
        runtime.metrics.collectErrors += 1;
        log(`collectMessages error ${error?.message || error}`);
        return null;
      }
    }).filter(Boolean);
  }

  function extractCodeText(pre) {
    const code = pre.querySelector?.('code') || pre;
    const lineNodes = Array.from(code.querySelectorAll?.('[data-line], .line, .hljs-ln-line') || []);
    if (lineNodes.length > 1) {
      return lineNodes.map((n) => (n.innerText || n.textContent || '').replace(/\n+$/g, '')).join('\n');
    }
    let text = code.innerText || code.textContent || '';
    text = text.replace(/^(copy code|copier le code)\s*/i, '');
    text = text.replace(/^([A-Za-z0-9_#+.-]{1,24})\n(?=\S)/, '');
    return text.replace(/\n+$/g, '');
  }

  function nodeToMarkdown(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'svg', 'button'].includes(tag)) return '';
    if (tag === 'br') return '\n';
    if (tag === 'pre') return `\n\n\`\`\`\n${extractCodeText(node)}\n\`\`\`\n\n`;
    if (tag === 'code') return `\`${node.textContent.replace(/`/g, '\\`')}\``;
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${children(node).trim()}\n\n`;
    if (tag === 'p') return `\n\n${children(node).trim()}\n\n`;
    if (tag === 'strong' || tag === 'b') return `**${children(node).trim()}**`;
    if (tag === 'em' || tag === 'i') return `*${children(node).trim()}*`;
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      const label = children(node).trim() || href;
      return href && !href.startsWith('javascript:') ? `[${label}](${href})` : label;
    }
    if (tag === 'li') return `- ${children(node).trim().replace(/\n/g, '\n  ')}\n`;
    if (tag === 'ul' || tag === 'ol') return `\n${children(node)}\n`;
    if (tag === 'blockquote') return children(node).trim().split('\n').map((l) => `> ${l}`).join('\n');
    return children(node);
  }

  function children(node) { return Array.from(node.childNodes || []).map(nodeToMarkdown).join(''); }

  function cleanTitleText(value) {
    let t = norm(value);
    if (!t) return '';
    t = t.replace(/[\u0000-\u001f\u007f]+/g, ' ');
    t = t.replace(/\s*[-–—|]\s*ChatGPT\s*$/i, '');
    t = t.replace(/^ChatGPT\s*[-–—|]\s*/i, '');
    t = t.replace(/^open\s+conversation\s*[-:]*\s*/i, '');
    t = t.replace(/^open\s+(.+?)\s+project$/i, '$1');
    t = t.replace(/^open\s+project\s*[-:]*\s*/i, '');
    t = t.replace(/^ouvrir\s+(?:le\s+)?projet\s*[-:]*\s*/i, '');
    t = t.replace(/^conversation\s*[-:]*\s*/i, '');
    t = t.replace(/^discussion\s*[-:]*\s*/i, '');
    t = t.replace(/^project\s*[-:]*\s*/i, '');
    t = t.replace(/^projet\s*[-:]*\s*/i, '');
    t = t.replace(/\bcopy link\b|\brename\b|\bdelete\b|\bshare\b|\barchive\b/gi, '');
    t = t.replace(/\bcopier le lien\b|\brenommer\b|\bsupprimer\b|\bpartager\b|\barchiver\b/gi, '');
    t = t.replace(/\bproject settings\b|\bparamètres du projet\b/gi, '');
    t = t.replace(/\s*,?\s*(?:chat|conversation|discussion)\s+(?:in|dans)\s+(?:the\s+|le\s+|la\s+)?(?:project|projet)\s+.+$/i, '');
    t = t.replace(/\s*,?\s*(?:chat|conversation|discussion)\s+(?:du|de la|de l'|de)\s+(?:project|projet)\s+.+$/i, '');
    return norm(t.replace(/\n+/g, ' '));
  }

  function isBadTitleCandidate(value) {
    const t = norm(value);
    if (!t) return true;
    const low = t.toLowerCase();
    if (t.length < 2 || t.length > 180) return true;

    // Garde de sécurité finale uniquement. Le chemin normal ci-dessous s’appuie sur le contexte structurel du DOM :
    // liens de la conversation courante, liens du projet actif, en-têtes/fil d’Ariane du projet.
    const badExact = [
      'chatgpt', 'openai', 'project', 'projects', 'projet', 'projets',
      'new project', 'nouveau projet', 'new chat', 'nouveau chat',
      'skip to content', 'passer au contenu', 'content', 'main content',
      'menu', 'more', 'plus', 'library', 'history', 'settings',
      'upgrade', 'log in', 'sign up', 'search', 'search chats',
      'rechercher', 'rechercher des chats'
    ];
    if (badExact.includes(low)) return true;
    if (/^(skip|passer)\s+(to|au)\s+content$/i.test(t)) return true;
    return false;
  }

  function candidateText(value) {
    const t = cleanTitleText(value);
    return isBadTitleCandidate(t) ? '' : t;
  }

  function stripProjectPrefixFromChatTitle(chatTitle, projectName) {
    const chat = candidateText(chatTitle);
    const project = candidateText(projectName);
    if (!chat || !project) return chat;

    const esc = project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixed = new RegExp(`^${esc}\\s*[-–—|:]\\s*(.+)$`, 'i');
    const match = chat.match(prefixed);
    if (match) {
      const stripped = candidateText(match[1]);
      if (stripped) return stripped;
    }

    return chat;
  }

  function parseChatProjectLabel(value) {
    const raw = norm(value);
    if (!raw) return { chat: '', project: '' };
    const patterns = [
      /^(.*?)\s*,?\s*(?:chat|conversation|discussion)\s+(?:in|dans)\s+(?:the\s+|le\s+|la\s+)?(?:project|projet)\s+(.+)$/i,
      /^(.*?)\s*,?\s*(?:chat|conversation|discussion)\s+(?:du|de la|de l'|de)\s+(?:project|projet)\s+(.+)$/i
    ];
    for (const re of patterns) {
      const m = raw.match(re);
      if (!m) continue;
      const chat = candidateText(m[1]);
      const project = candidateText(String(m[2] || '').replace(/\s+folder$/i, ''));
      if (chat || project) return { chat, project };
    }
    return { chat: '', project: '' };
  }

  function rawHref(el) {
    try { return String(el?.getAttribute?.('href') || el?.href || ''); } catch { return ''; }
  }

  function sameOriginPath(href) {
    try {
      const u = new URL(href, location.href);
      if (u.origin !== location.origin) return '';
      return u.pathname.replace(/\/+$/, '') || '/';
    } catch { return ''; }
  }

  function currentPath() {
    return (location.pathname || '/').replace(/\/+$/, '') || '/';
  }

  function conversationIdFromPath(path = location.pathname) {
    const m = String(path || '').match(/\/c\/([a-z0-9-]{10,})/i);
    return m ? m[1] : '';
  }

  function isHashOnlyLink(href) {
    const raw = String(href || '').trim();
    if (!raw) return false;
    if (raw.startsWith('#')) return true;
    try {
      const u = new URL(raw, location.href);
      const current = new URL(location.href);
      return Boolean(u.hash)
        && u.origin === current.origin
        && u.pathname === current.pathname
        && u.search === current.search
        && !/\/c\//i.test(raw);
    } catch { return false; }
  }

  function looksLikeConversationPath(path) {
    return /\/c\/[a-z0-9-]{10,}/i.test(String(path || ''));
  }

  function looksLikeProjectPath(path) {
    return /(?:\/g\/g-p-|\/project\/|\/projects\/)/i.test(String(path || '')) && !looksLikeConversationPath(path);
  }

  function isActionOrAccessibilityLink(el, text = '', href = '') {
    const t = norm(text).toLowerCase();
    const raw = String(href || rawHref(el)).trim().toLowerCase();
    if (!el) return true;
    if (el.closest?.(`#${WIDGET_ID}`)) return true;
    if (isHashOnlyLink(raw)) return true;
    if (/^(skip|passer)\s+(to|au)\s+content$/i.test(t)) return true;
    if (/^(new|create|add)\s+project$/i.test(t)) return true;
    if (/^(nouveau|créer|creer|ajouter)\s+projet$/i.test(t)) return true;
    if (/\/projects?\/(new|create)(?:$|[/?#])/i.test(raw)) return true;
    if (/\/g\/(new|create)(?:$|[/?#])/i.test(raw)) return true;
    return false;
  }

  function activeScore(el) {
    if (!el) return 0;
    let score = 0;
    const attrs = [
      el.getAttribute?.('aria-current'),
      el.getAttribute?.('data-active'),
      el.getAttribute?.('data-selected'),
      el.getAttribute?.('aria-selected')
    ].filter(Boolean).join(' ');
    if (/page|true|location/i.test(attrs)) score += 80;
    const nodes = [el, el.parentElement, el.parentElement?.parentElement].filter(Boolean);
    const joinedClass = nodes.map((n) => String(n.className || '')).join(' ');
    if (/\b(active|selected|current)\b/i.test(joinedClass)) score += 35;
    if (/bg-token-sidebar-surface-secondary|sidebar-surface-secondary|bg-token-main-surface-secondary/i.test(joinedClass)) score += 30;
    if (el.closest?.('[aria-current="page"],[data-active="true"],[data-selected="true"],[aria-selected="true"]')) score += 25;
    return score;
  }

  function structuralContextScore(el) {
    if (!el) return 0;
    let score = 0;
    if (el.closest?.('nav, aside, [data-testid*="sidebar"], [class*="sidebar"]')) score += 14;
    if (el.closest?.('header, [role="banner"], [data-testid*="header"]')) score += 8;
    if (el.closest?.('[aria-label*="breadcrumb" i], [data-testid*="breadcrumb" i]')) score += 12;
    return score;
  }

  function visibleText(el) {
    if (!el || !isVisibleElement(el)) return '';
    const text = norm(el.innerText || el.textContent || '');
    return text.length <= 240 ? text : '';
  }

  function elementTextLines(el) {
    const out = [];
    try {
      const raw = String(el?.innerText || el?.textContent || '');
      raw.split(/\n+/).forEach((line) => {
        const text = candidateText(line);
        if (text) out.push(text);
      });
    } catch { /* ignoré */ }
    return out;
  }

  function titleCandidateFromElement(el) {
    if (!el) return '';
    const values = [];
    try {
      values.push(el.getAttribute?.('data-title'));
      values.push(el.getAttribute?.('title'));
      values.push(el.getAttribute?.('aria-label'));
      el.querySelectorAll?.('[data-title], [title]')?.forEach((child) => {
        if (child.closest?.('button, [role="button"]')) return;
        values.push(child.getAttribute?.('data-title'));
        values.push(child.getAttribute?.('title'));
      });
    } catch { /* ignoré */ }
    values.push(...elementTextLines(el));
    values.push(visibleText(el));

    const candidates = [];
    values.forEach((value, idx) => {
      const text = candidateText(value);
      if (!text) return;
      let score = 0;
      if (idx <= 2) score += 14;
      if (/^[-0-9]{2,}\.|ExtBr|Export|NoXoZ|NoXoZ\.be/i.test(text)) score += 10;
      score += Math.min(20, text.length / 6);
      candidates.push({ text, score });
    });
    candidates.sort((a, b) => (b.score - a.score) || (b.text.length - a.text.length));
    return candidates[0]?.text || '';
  }

  function titleCandidateScore(el, text, path, cur, cid) {
    let score = 0;
    if (path === cur) score += 110;
    if (cid && path.includes(`/c/${cid}`)) score += 120;
    if (looksLikeConversationPath(path)) score += 35;
    score += activeScore(el);
    score += structuralContextScore(el);
    if (/^[-0-9]{2,}\.|ExtBr|Export|NoXoZ/i.test(text)) score += 10;
    score += Math.min(12, Math.floor(text.length / 12));
    return score;
  }

  function currentConversationIdFromActiveLinks() {
    const candidates = [];
    document.querySelectorAll('a[href*="/c/"]').forEach((a) => {
      const href = rawHref(a);
      if (isHashOnlyLink(href)) return;
      const path = sameOriginPath(href);
      if (!looksLikeConversationPath(path)) return;
      const score = activeScore(a) + structuralContextScore(a);
      if (score <= 0) return;
      const cid = conversationIdFromPath(path);
      if (cid) candidates.push({ cid, score });
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.cid || '';
  }

  function findChatTitleFromLinks() {
    const cur = currentPath();
    const cid = conversationIdFromPath(cur) || currentConversationIdFromActiveLinks();
    const candidates = [];
    document.querySelectorAll('a[href*="/c/"]').forEach((a) => {
      const href = rawHref(a);
      if (isHashOnlyLink(href)) return;
      const path = sameOriginPath(href);
      if (!looksLikeConversationPath(path)) return;
      if (cid && !path.includes(`/c/${cid}`)) return;
      if (!cid && path !== cur && activeScore(a) <= 0) return;
      const text = titleCandidateFromElement(a);
      if (!text || isActionOrAccessibilityLink(a, text, href)) return;
      candidates.push({ text, score: titleCandidateScore(a, text, path, cur, cid) });
    });
    candidates.sort((a, b) => (b.score - a.score) || (b.text.length - a.text.length));
    return candidates[0]?.text || '';
  }

  function findChatTitleFromDocument() {
    const selectors = [
      '[data-testid="conversation-title"]',
      '[data-testid*="conversation-title" i]',
      '[data-testid*="chat-title" i]',
      'main h1',
      '[role="main"] h1'
    ];
    for (const selector of selectors) {
      try {
        for (const el of document.querySelectorAll(selector)) {
          const t = titleCandidateFromElement(el);
          if (t && !isActionOrAccessibilityLink(el, t, '')) return t;
        }
      } catch { /* ignoré */ }
    }
    const metaTitle = document.querySelector('meta[property="og:title"]')?.content;
    const metaText = candidateText(metaTitle);
    if (metaText) return metaText;
    const docTitle = candidateText(document.title);
    return docTitle || '';
  }

  function projectBasePath() {
    const path = currentPath();
    const patterns = [
      /^(\/g\/g-p-[^/]+)(?:\/|$)/i,
      /^(\/project\/[^/]+)(?:\/|$)/i,
      /^(\/projects\/[^/]+)(?:\/|$)/i
    ];
    for (const re of patterns) {
      const m = path.match(re);
      if (m) return m[1].replace(/\/+$/, '');
    }
    return '';
  }

  function findProjectBaseFromActiveLinks() {
    const candidates = [];
    document.querySelectorAll('a[href*="/g/g-p-"], a[href*="/project/"], a[href*="/projects/"]').forEach((a) => {
      const href = rawHref(a);
      if (isHashOnlyLink(href)) return;
      const path = sameOriginPath(href);
      if (!looksLikeProjectPath(path)) return;
      const text = titleCandidateFromElement(a);
      if (isActionOrAccessibilityLink(a, text, href)) return;
      const score = activeScore(a) + structuralContextScore(a);
      if (score < 20) return;
      candidates.push({ path, score });
    });
    candidates.sort((a, b) => (b.score - a.score) || (a.path.length - b.path.length));
    return candidates[0]?.path || '';
  }

  function findProjectNameFromLinks(basePath) {
    const candidates = [];
    document.querySelectorAll('a[href*="/g/g-p-"], a[href*="/project/"], a[href*="/projects/"]').forEach((el) => {
      const href = rawHref(el);
      if (isHashOnlyLink(href)) return;
      const path = sameOriginPath(href);
      if (!looksLikeProjectPath(path)) return;
      const text = titleCandidateFromElement(el);
      if (!text || isActionOrAccessibilityLink(el, text, href)) return;

      let pathMatch = false;
      if (basePath) pathMatch = path === basePath || path.startsWith(`${basePath}/`);
      else pathMatch = activeScore(el) > 0;
      if (!pathMatch) return;

      let score = path === basePath ? 120 : 70;
      score += activeScore(el);
      score += structuralContextScore(el);
      if (/extension/i.test(text)) score += 4;
      candidates.push({ text, score });
    });
    candidates.sort((a, b) => (b.score - a.score) || (b.text.length - a.text.length));
    return candidates[0]?.text || '';
  }

  function findProjectNameFromHeader() {
    const selectors = [
      '[data-testid="project-name"]',
      '[data-testid*="project-name" i]',
      '[data-testid*="project-title" i]',
      '[data-testid*="project-header" i]',
      '[data-testid*="project-sidebar-header" i]',
      '[data-testid*="breadcrumb" i] a',
      '[aria-label*="breadcrumb" i] a',
      'header [data-testid*="project" i]',
      '[role="banner"] [data-testid*="project" i]'
    ];
    const candidates = [];
    for (const selector of selectors) {
      try {
        for (const el of document.querySelectorAll(selector)) {
          const href = rawHref(el);
          const text = titleCandidateFromElement(el);
          if (!text || isActionOrAccessibilityLink(el, text, href)) continue;
          let score = activeScore(el) + structuralContextScore(el);
          if (el.matches?.('[data-testid="project-name"], [data-testid*="project-name" i], [data-testid*="project-title" i]')) score += 80;
          if (el.closest?.('[data-testid*="breadcrumb" i], [aria-label*="breadcrumb" i]')) score += 30;
          if (/extension/i.test(text)) score += 4;
          candidates.push({ text, score });
        }
      } catch { /* ignoré */ }
    }
    candidates.sort((a, b) => (b.score - a.score) || (b.text.length - a.text.length));
    return candidates[0]?.text || '';
  }

  function projectNameFromDocumentTitle(chatTitle) {
    const raw = cleanTitleText(document.title || '');
    if (!raw) return '';
    const parts = raw.split(/\s+[-–—|]\s+/).map(candidateText).filter(Boolean);
    if (parts.length < 2) return '';
    const chatLow = norm(chatTitle).toLowerCase();
    const candidates = parts.filter((p) => p.toLowerCase() !== chatLow && !/^chatgpt$/i.test(p));
    if (!candidates.length) return '';
    return candidates.find((p) => /project|extension/i.test(p)) || candidates[0] || '';
  }

  function getExportIdentity() {
    const projectBaseFromUrl = projectBasePath();
    const projectBaseFromActive = findProjectBaseFromActiveLinks();
    const projectBase = projectBaseFromUrl || projectBaseFromActive;

    const linkChatTitle = findChatTitleFromLinks();
    const documentChatTitle = findChatTitleFromDocument();
    const parsedLinkIdentity = parseChatProjectLabel(linkChatTitle);
    const parsedDocumentIdentity = parseChatProjectLabel(documentChatTitle);
    const parsedIdentity = (parsedLinkIdentity.chat || parsedLinkIdentity.project)
      ? parsedLinkIdentity
      : parsedDocumentIdentity;

    let chatTitle = candidateText(parsedIdentity.chat || linkChatTitle || documentChatTitle) || 'ChatGPT Export';

    const linkProjectName = findProjectNameFromLinks(projectBase);
    const headerProjectName = findProjectNameFromHeader();
    const docProjectName = projectNameFromDocumentTitle(chatTitle);
    let projectName = candidateText(parsedIdentity.project || linkProjectName || headerProjectName || docProjectName);

    // ChatGPT peut exposer document.title sous la forme « <project> - <chat> » alors que le
    // vrai titre de la conversation est seulement « <chat> ». Ne duplique jamais le nom du projet
    // dans le titre du chat exporté.
    chatTitle = stripProjectPrefixFromChatTitle(chatTitle, projectName);

    const inProject = Boolean(projectName || projectBase);
    const displayTitle = inProject && projectName
      ? `Project - ${projectName} - ${chatTitle}`
      : chatTitle;

    log(`identity candidates projectBaseUrl=${projectBaseFromUrl || 'n/a'} projectBaseActive=${projectBaseFromActive || 'n/a'} parsedProject=${parsedIdentity.project || 'n/a'} parsedChat=${parsedIdentity.chat || 'n/a'} projectLink=${linkProjectName || 'n/a'} projectHeader=${headerProjectName || 'n/a'} projectDoc=${docProjectName || 'n/a'} chatLink=${linkChatTitle || 'n/a'} chatDoc=${documentChatTitle || 'n/a'}`);
    return { inProject, projectName, chatTitle, displayTitle };
  }

  function getTitle() {
    return getExportIdentity().displayTitle;
  }

  function safeFilenameBase(value) {
    return norm(value)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/[\u0000-\u001f\u007f]+/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\.+$/g, '')
      .slice(0, 170)
      .trim() || 'ChatGPT Export';
  }

  function makeFilename(identityOrTitle) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\.\d+Z$/, '');
    const identity = typeof identityOrTitle === 'object' && identityOrTitle
      ? identityOrTitle
      : { displayTitle: String(identityOrTitle || 'ChatGPT Export') };
    const safe = safeFilenameBase(identity.displayTitle || identity.chatTitle || 'ChatGPT Export');
    return `${safe}__export_${stamp}.md`;
  }

  function buildMarkdown(title, messages) {
    const stats = countExportMessages(messages);
    const headerLines = [
      `# ${title}`,
      '',
      `Date d’export : ${humanLocalDateTime()}`,
      `Source : ${location.href}`,
      '',
      `Nombre total de messages : ${messages.length}`,
      `Messages utilisateur : ${stats.user}`,
      `Messages assistant : ${stats.agent}`
    ];
    if (stats.tool > 0) headerLines.push(`Messages outil : ${stats.tool}`);
    if (stats.other > 0) headerLines.push(`Autres messages : ${stats.other}`);

    const filesToDownload = downloadRefsFromMessages(messages);
    headerLines.push(`Fichiers à télécharger : ${filesToDownload.length}`);
    filesToDownload.forEach((entry) => {
      const name = cleanUploadedFilename(entry?.name || '');
      if (name) headerLines.push(`   - ${name}`);
    });

    return [...headerLines, '', '---', '', ...messages.flatMap((m, i) => [`## ${i + 1}. ${m.role}`, '', m.text, '', '---', ''])].join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
  }

  function downloadRefsFromMessages(messages) {
    const map = new Map();
    (Array.isArray(messages) ? messages : []).forEach((m, messageIndex) => {
      (Array.isArray(m?.downloads) ? m.downloads : []).forEach((entry) => {
        const name = cleanUploadedFilename(entry?.name || '');
        if (!name) return;
        const key = `${name.toLowerCase()}|${String(entry?.url || '')}`;
        if (!map.has(key)) {
          map.set(key, {
            name,
            url: String(entry?.url || ''),
            sandboxPath: String(entry?.sandboxPath || ''),
            fileId: String(entry?.fileId || ''),
            conversationId: String(entry?.conversationId || ''),
            projectId: String(entry?.projectId || ''),
            messageId: String(entry?.messageId || ''),
            messageIndex: messageIndex + 1
          });
        }
      });
    });
    return Array.from(map.values());
  }

  function attachmentRefsFromMessages(messages) {
    const map = new Map();
    (Array.isArray(messages) ? messages : []).forEach((m, messageIndex) => {
      (Array.isArray(m?.uploads) ? m.uploads : []).forEach((entry) => {
        const name = cleanUploadedFilename(entry?.name || '');
        if (!name) return;
        const url = normalizeAttachmentUrl(entry?.url || '');
        const key = `${name.toLowerCase()}|${url}`;
        if (!map.has(key)) {
          map.set(key, {
            name,
            url,
            messageIndex: messageIndex + 1
          });
        }
      });
    });
    return Array.from(map.values());
  }

  function markdownFilenameToZipFilename(markdownFilename) {
    const name = String(markdownFilename || 'chat.md');
    return /\.md$/i.test(name) ? name.replace(/\.md$/i, '.zip') : `${name}.zip`;
  }

  async function buildFullChatZip(markdownFilename, markdown, messages, started) {
    const attachmentRoot = attachmentRootFromMarkdownFilename(markdownFilename);
    const files = [
      { name: `${attachmentRoot}/${markdownFilename}`, content: markdown },
      { name: `${attachmentRoot}/Upload/`, content: new Uint8Array(0) },
      { name: `${attachmentRoot}/Download/`, content: new Uint8Array(0) }
    ];
    const attachments = attachmentRefsFromMessages(messages);
    const downloadRefs = downloadRefsFromMessages(messages);
    const usedPaths = new Map();
    const usedDownloadPaths = new Map();
    let downloaded = 0;
    let failed = 0;
    let offeredDownloaded = 0;
    let offeredFailed = 0;

    log(`full chat attachments found=${attachments.length} filesToDownload=${downloadRefs.length} exportUploadedFiles=${state.exportUploadedFiles} exportDownloadedFiles=${state.exportDownloadedFiles}`);
    if (!state.exportUploadedFiles && attachments.length) log('full chat uploaded-file copy disabled by user');
    if (!state.exportDownloadedFiles && downloadRefs.length) log('full chat downloaded-file copy disabled by user');

    for (let i = 0; state.exportUploadedFiles && i < attachments.length; i += 1) {
      guard(started);
      const attachment = attachments[i];
      const fileName = safeZipAttachmentName(attachment.name);
      const zipPath = uniqueZipAttachmentPath(`${attachmentRoot}/Upload/${fileName}`, usedPaths);

      if (!attachment.url) {
        failed += 1;
        log(`full chat attachment skip ${i + 1}/${attachments.length} no-download-url ${attachment.name}`);
        continue;
      }

      try {
        setStatus(`Pièce jointe ${i + 1}/${attachments.length} : ${attachment.name}`);
        log(`full chat attachment fetch ${i + 1}/${attachments.length} ${attachment.name} ${attachment.url}`);
        const result = await fetchUploadedFileBytes(attachment.url, attachment);
        files.push({ name: zipPath, content: result.bytes });
        downloaded += 1;
        log(`full chat attachment added ${zipPath} bytes=${result.bytes.length}`);
      } catch (error) {
        failed += 1;
        log(`full chat attachment error ${attachment.name} ${error?.message || error}`);
      }
    }

    for (let i = 0; state.exportDownloadedFiles && i < downloadRefs.length; i += 1) {
      guard(started);
      const entry = downloadRefs[i];
      const fileName = safeZipAttachmentName(entry.name);
      const zipPath = uniqueZipAttachmentPath(`${attachmentRoot}/Download/${fileName}`, usedDownloadPaths);

      if (!entry.url) {
        offeredFailed += 1;
        log(`full chat download skip ${i + 1}/${downloadRefs.length} no-download-url ${entry.name}`);
        continue;
      }

      try {
        setStatus(`Téléchargement ${i + 1}/${downloadRefs.length} : ${entry.name}`);
        log(`full chat download fetch ${i + 1}/${downloadRefs.length} ${entry.name} ${entry.url}`);
        const result = validateDownloadedFilePayload(
          entry.name,
          await fetchDownloadFileBytes(entry.url, entry)
        );
        files.push({ name: zipPath, content: result.bytes });
        offeredDownloaded += 1;
        log(`full chat download added ${zipPath} bytes=${result.bytes.length}`);
      } catch (error) {
        offeredFailed += 1;
        log(`full chat download error ${entry.name} ${error?.message || error}`);
      }
    }

    const zipBytes = makeStoredZip(files);
    const zipFilename = markdownFilenameToZipFilename(markdownFilename);
    log(`full chat zip files=${files.length} uploads=${downloaded}/${attachments.length} uploadFailed=${failed} downloads=${offeredDownloaded}/${downloadRefs.length} downloadFailed=${offeredFailed} bytes=${zipBytes.length}`);

    return {
      zipFilename,
      zipBytes,
      attachmentsFound: attachments.length,
      attachmentsDownloaded: downloaded,
      attachmentsFailed: failed,
      downloadsFound: downloadRefs.length,
      downloadsDownloaded: offeredDownloaded,
      downloadsFailed: offeredFailed
    };
  }

  function countExportMessages(messages) {
    return (messages || []).reduce((acc, m) => {
      const role = String(m?.role || '').toLowerCase();
      if (role === 'user') acc.user += 1;
      else if (role === 'assistant' || role === 'agent') acc.agent += 1;
      else if (role === 'tool') acc.tool += 1;
      else acc.other += 1;
      return acc;
    }, { user: 0, agent: 0, tool: 0, other: 0 });
  }

  function reloadExt() {
    try {
      chrome.storage.local.set({ 'cgx.refreshAfterReload': true }, () => chrome.runtime.sendMessage({ type: 'CGX_RELOAD_EXTENSION' }));
      setStatus('Rechargement…');
    } catch (error) { setStatus(`Échec du rechargement : ${error.message}`); }
  }


  function installResize() {
    document.addEventListener('pointerdown', (e) => {
      if (!widget || state.mode !== 'maxi' || !widget.contains(e.target) || e.button !== 0) return;
      const handle = e.target.closest('[data-resize]');
      if (!handle) return;
      e.preventDefault();
      e.stopPropagation();
      const r = widget.getBoundingClientRect();
      resizeDrag = {
        dir: handle.dataset.resize || 'se',
        x: e.clientX,
        y: e.clientY,
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        moved: false
      };
      try { widget.setPointerCapture(e.pointerId); } catch { /* ignoré */ }
    }, true);

    document.addEventListener('pointermove', (e) => {
      if (!resizeDrag || !widget) return;
      e.preventDefault();
      e.stopPropagation();
      const dx = e.clientX - resizeDrag.x;
      const dy = e.clientY - resizeDrag.y;
      const dir = resizeDrag.dir;
      if (Math.abs(dx) + Math.abs(dy) > 2) resizeDrag.moved = true;
      if (!resizeDrag.moved) return;

      let left = resizeDrag.left;
      let top = resizeDrag.top;
      let width = resizeDrag.width;
      let height = resizeDrag.height;

      if (dir.includes('e')) width = resizeDrag.width + dx;
      if (dir.includes('s')) height = resizeDrag.height + dy;
      if (dir.includes('w')) width = resizeDrag.width - dx;
      if (dir.includes('n')) height = resizeDrag.height - dy;

      const clamped = clampWidgetSize({ width, height });
      width = clamped.width;
      height = clamped.height;
      if (dir.includes('w')) left = resizeDrag.left + resizeDrag.width - width;
      if (dir.includes('n')) top = resizeDrag.top + resizeDrag.height - height;

      applyResizeBox(left, top, width, height);
    }, true);

    document.addEventListener('pointerup', async () => {
      if (!resizeDrag) return;
      const moved = resizeDrag.moved;
      resizeDrag = null;
      if (moved) { suppressClickUntil = now() + 180; saveCurrentPosition(); saveCurrentSize(); await saveState(); }
    }, true);

    document.addEventListener('pointercancel', async () => {
      if (!resizeDrag) return;
      resizeDrag = null;
      saveCurrentSize();
      await saveState();
    }, true);
  }

  function installDrag() {
    document.addEventListener('pointerdown', (e) => {
      if (!widget || !widget.contains(e.target) || e.button !== 0 || resizeDrag) return;
      if (e.target.closest('[data-resize]')) return;
      if (e.target.closest('button, input, textarea, select, a')) return;
      if (!e.target.closest('[data-drag="true"], .cgx-title, .cgx-status, .cgx-button-shell')) return;
      const r = widget.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
      try { widget.setPointerCapture(e.pointerId); } catch { /* ignoré */ }
    }, true);
    document.addEventListener('pointermove', (e) => {
      if (!drag || !widget) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      applyPosition({ left: drag.left + dx, top: drag.top + dy });
    }, true);
    document.addEventListener('pointerup', async () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) { suppressClickUntil = now() + 180; saveCurrentPosition(); await saveState(); }
    }, true);
  }

  async function iconToggle() {
    if (state.visible) {
      saveCurrentPosition();
      saveCurrentSize();
      state.visible = false;
      await saveState();
      render();
      return;
    }
    state.visible = true;
    if (!['button', 'mini', 'maxi'].includes(state.mode)) state.mode = 'mini';
    render();
    applyStoredOrDefaultPosition();
    await saveState();
  }

  async function showWidget() {
    state.visible = true;
    if (!['button', 'mini', 'maxi'].includes(state.mode)) state.mode = 'mini';
    render();
    applyStoredOrDefaultPosition();
    await saveState();
  }

  function afterInit(task, sendResponse) {
    const ready = initPromise || Promise.resolve();
    ready
      .then(task)
      .then((payload) => sendResponse(payload))
      .catch((error) => {
        console.error('[ChatGPT Export] icon action failed:', error);
        sendResponse({ ok: false, error: String(error?.message || error), version: VERSION });
      });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message !== 'object') return false;
      if (message.type === 'CGX_ICON_TOGGLE') {
        afterInit(async () => {
          await iconToggle();
          return { ok: true, visible: state.visible, mode: state.mode, version: VERSION };
        }, sendResponse);
        return true;
      }
      if (message.type === 'CGX_ICON_SHOW') {
        afterInit(async () => {
          await showWidget();
          return { ok: true, visible: true, mode: state.mode, version: VERSION };
        }, sendResponse);
        return true;
      }
      if (message.type === 'CGX_ALL_CHAT_EXPORT_PROGRESS') {
        afterInit(async () => applyLiveAllChatProgress(message), sendResponse);
        return true;
      }
      if (message.type === 'CGX_ALL_CHAT_EXPORT_COMPLETE') {
        afterInit(async () => finalizeLiveAllChatExport(message), sendResponse);
        return true;
      }
      if (message.type === 'CGX_PROJECT_EXPORT_PROGRESS') {
        afterInit(async () => applyLiveProjectProgress(message), sendResponse);
        return true;
      }
      if (message.type === 'CGX_PROJECT_EXPORT_COMPLETE') {
        afterInit(async () => finalizeLiveProjectExport(message), sendResponse);
        return true;
      }
      if (message.type === 'CGX_EXPORT_CHAT_DATA_FOR_PROJECT') {
        afterInit(async () => exportChatDataForProject(message), sendResponse);
        return true;
      }
      return false;
    });
  }

  async function init() {
    await loadState();
    const old = document.getElementById(WIDGET_ID);
    if (old) old.remove();
    widget = document.createElement('div');
    widget.id = WIDGET_ID;
    document.documentElement.appendChild(widget);
    if (!['button', 'mini', 'maxi'].includes(state.mode)) state.mode = 'mini';
    if (typeof state.visible !== 'boolean') state.visible = true;
    render();
    applyStoredOrDefaultPosition();
    installResize();
    installDrag();
    await saveState();
  }

  initPromise = init();
  initPromise.catch((error) => console.error('[ChatGPT Export] init failed:', error));
}());
