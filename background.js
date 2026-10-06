/*
 * ChatGPT Export - background.js
 * Version: v7.0.0
 * Patch: p24
 * Développeur : @NoXoZ.be
 */
'use strict';

const VERSION = '7.0.0';

function safeFilenameBase(value) {
  return String(value || 'ChatGPT Account')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120) || 'ChatGPT Account';
}

function underscoreToken(value, fallback = 'Export') {
  return safeFilenameBase(value || fallback)
    .trim()
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_')
    .replace(/_+/g, '_');
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

const SUPPORTED = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;
const liveProjectJobs = new Map();
const liveAllChatJobs = new Map();
const PROJECT_JOB_STORAGE_PREFIX = 'cgx.liveProjectJob.';
const ALL_CHAT_JOB_STORAGE_PREFIX = 'cgx.liveAllChatJob.';


const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creatingOffscreenDocument = null;

function safeDownloadSegment(value, fallback = 'Export') {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 160) || fallback;
}

function sanitizeRelativeDownloadPath(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => safeDownloadSegment(part, 'Export'));
  if (!parts.length) throw new Error('INVALID_DOWNLOAD_PATH');
  return parts.join('/');
}

async function ensureOffscreenDownloadDocument() {
  if (!chrome.offscreen?.createDocument) throw new Error('OFFSCREEN_API_UNAVAILABLE');
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length) return;
  }
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }
  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['BLOBS'],
    justification: 'Créer des URL Blob temporaires pour les grosses parties ZIP avant leur enregistrement avec chrome.downloads.'
  });
  try {
    await creatingOffscreenDocument;
  } catch (error) {
    const message = String(error?.message || error);
    // Si un autre contexte de l’extension l’a créé simultanément, il est sûr de continuer.
    if (!/single offscreen|already exists|Only a single offscreen/i.test(message)) throw error;
  } finally {
    creatingOffscreenDocument = null;
  }
}

function waitForDownloadTerminal(downloadId, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer = null;

    const cleanup = () => {
      if (finished) return false;
      finished = true;
      try { chrome.downloads.onChanged.removeListener(listener); } catch { /* ignoré */ }
      if (timer) clearTimeout(timer);
      return true;
    };

    const finishFromItem = (item) => {
      if (!item) return false;
      if (item.state === 'complete') {
        if (cleanup()) resolve(item);
        return true;
      }
      if (item.state === 'interrupted') {
        if (cleanup()) reject(new Error(`DOWNLOAD_INTERRUPTED_${item.error || 'UNKNOWN'}`));
        return true;
      }
      return false;
    };

    const inspect = async () => {
      try {
        const items = await chrome.downloads.search({ id: downloadId });
        finishFromItem(Array.isArray(items) ? items[0] : null);
      } catch { /* onChanged remains authoritative */ }
    };

    const listener = (delta) => {
      if (finished || !delta || delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        inspect();
        return;
      }
      if (delta.state?.current === 'interrupted') {
        if (cleanup()) reject(new Error(`DOWNLOAD_INTERRUPTED_${delta.error?.current || 'UNKNOWN'}`));
      }
    };

    chrome.downloads.onChanged.addListener(listener);
    timer = setTimeout(() => {
      if (cleanup()) reject(new Error('DOWNLOAD_TIMEOUT'));
    }, timeoutMs);
    inspect();
  });
}

async function releaseOffscreenTransfer(transferId) {
  if (!transferId) return;
  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'CGX_OFFSCREEN_ZIP_RELEASE',
      transferId
    });
  } catch { /* au mieux */ }
}

async function downloadBatchZip(url, relativePath, transferId = '', saveAs = false) {
  const sourceUrl = String(url || '').trim();
  const expectedPrefix = `blob:chrome-extension://${chrome.runtime.id}/`;
  if (!sourceUrl.startsWith(expectedPrefix)) throw new Error('INVALID_BATCH_BLOB_URL');
  const filename = sanitizeRelativeDownloadPath(relativePath);
  let downloadId = 0;
  try {
    downloadId = await chrome.downloads.download({
      url: sourceUrl,
      filename,
      saveAs: Boolean(saveAs),
      conflictAction: 'uniquify'
    });
    if (!Number.isInteger(downloadId)) throw new Error('DOWNLOAD_NOT_STARTED');
    const item = await waitForDownloadTerminal(downloadId);
    return { downloadId, filename: item?.filename || filename };
  } finally {
    await releaseOffscreenTransfer(transferId);
  }
}

function projectJobStorageKey(tabId) {
  return `${PROJECT_JOB_STORAGE_PREFIX}${tabId}`;
}

function projectJobStorageArea() {
  return chrome.storage?.session || chrome.storage?.local;
}

async function persistProjectJob(job) {
  const area = projectJobStorageArea();
  if (!area || !job?.tabId) return;
  const key = projectJobStorageKey(job.tabId);
  const snapshot = {
    tabId: job.tabId,
    chats: Array.isArray(job.chats) ? job.chats : [],
    projectName: String(job.projectName || 'Project'),
    returnUrl: String(job.returnUrl || ''),
    timeoutSeconds: Number(job.timeoutSeconds || 600),
    chatsPerZip: Math.max(1, Number(job.chatsPerZip || 50)),
    stamp: String(job.stamp || ''),
    zipFilename: String(job.zipFilename || ''),
    batchStart: Math.max(0, Number(job.batchStart || 0)),
    currentBatchIndex: Math.max(0, Number(job.currentBatchIndex || 0)),
    awaitingAck: Boolean(job.awaitingAck),
    cancelled: Boolean(job.cancelled),
    logLines: Array.isArray(job.logLines) ? job.logLines.slice(-240) : []
  };
  await area.set({ [key]: snapshot });
}

async function loadPersistedProjectJob(tabId) {
  const area = projectJobStorageArea();
  if (!area || !tabId) return null;
  const key = projectJobStorageKey(tabId);
  const data = await area.get(key);
  const saved = data?.[key];
  if (!saved || !Array.isArray(saved.chats) || !saved.chats.length) return null;
  return {
    ...saved,
    tabId,
    results: [],
    failures: [],
    logLines: Array.isArray(saved.logLines) ? saved.logLines : []
  };
}

async function clearPersistedProjectJob(tabId) {
  const area = projectJobStorageArea();
  if (!area || !tabId) return;
  await area.remove(projectJobStorageKey(tabId));
}

function allChatJobStorageKey(tabId) {
  return `${ALL_CHAT_JOB_STORAGE_PREFIX}${tabId}`;
}

async function persistAllChatJob(job) {
  const area = projectJobStorageArea();
  if (!area || !job?.tabId) return;
  const key = allChatJobStorageKey(job.tabId);
  const snapshot = {
    tabId: job.tabId,
    chats: Array.isArray(job.chats) ? job.chats : [],
    returnUrl: String(job.returnUrl || ''),
    timeoutSeconds: Number(job.timeoutSeconds || 600),
    chatsPerZip: Math.max(1, Number(job.chatsPerZip || 50)),
    stamp: String(job.stamp || ''),
    zipFilename: String(job.zipFilename || ''),
    accountName: String(job.accountName || ''),
    batchStart: Math.max(0, Number(job.batchStart || 0)),
    currentBatchIndex: Math.max(0, Number(job.currentBatchIndex || 0)),
    awaitingAck: Boolean(job.awaitingAck),
    cancelled: Boolean(job.cancelled),
    logLines: Array.isArray(job.logLines) ? job.logLines.slice(-240) : []
  };
  await area.set({ [key]: snapshot });
}

async function loadPersistedAllChatJob(tabId) {
  const area = projectJobStorageArea();
  if (!area || !tabId) return null;
  const key = allChatJobStorageKey(tabId);
  const data = await area.get(key);
  const saved = data?.[key];
  if (!saved || !Array.isArray(saved.chats) || !saved.chats.length) return null;
  return {
    ...saved,
    tabId,
    results: [],
    failures: [],
    logLines: Array.isArray(saved.logLines) ? saved.logLines : []
  };
}

async function clearPersistedAllChatJob(tabId) {
  const area = projectJobStorageArea();
  if (!area || !tabId) return;
  await area.remove(allChatJobStorageKey(tabId));
}

function isSupported(url) {
  return typeof url === 'string' && SUPPORTED.test(url);
}

function isAllowedAttachmentUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (url.origin === 'https://chatgpt.com' || url.origin === 'https://chat.openai.com') {
      if (path.startsWith('/backend-api/')) return true;
      // p24 : URL de contenu de même origine renvoyées exactement par le flux d’autorisation
      // des fichiers de projet ChatGPT. Ce sont des routes de contenu binaire, pas des API devinées.
      if (/^\/api\/library\/files\/[^/]+\/project-content$/i.test(path)) return true;
      return false;
    }
    if (host.endsWith('.oaiusercontent.com')) return true;
    if (host.endsWith('.openai.com')) return true;
    if (host.endsWith('.blob.core.windows.net')) return true;
    return false;
  } catch {
    return false;
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    const chunk = view.subarray(offset, Math.min(offset + chunkSize, view.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function inject(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['export-style.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-export.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['donate-mini.js'] });
}

async function send(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function sendWithRetry(tabId, message, attempts = 80, delayMs = 250) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await send(tabId, message);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError || new Error('CONTENT_SCRIPT_NOT_READY');
}

async function toggle(tab) {
  if (!tab || !tab.id || !isSupported(tab.url || '')) return;
  try {
    await send(tab.id, { type: 'CGX_ICON_TOGGLE', version: VERSION });
  } catch (error) {
    try {
      await inject(tab.id);
      await sendWithRetry(tab.id, { type: 'CGX_ICON_SHOW', version: VERSION });
    } catch (innerError) {
      console.error('[ChatGPT Export] toggle failed:', innerError);
    }
  }
}

async function refreshChatGPTTabsAfterReload() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
  } catch (error) {
    console.error('[ChatGPT Export] tabs query failed:', error);
    return;
  }
  for (const tab of tabs) {
    if (!tab || !tab.id) continue;
    try { await chrome.tabs.reload(tab.id); } catch (error) { console.error('[ChatGPT Export] reload tab failed:', error); }
  }
}

function waitForTabComplete(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error('TAB_LOAD_TIMEOUT')), timeoutMs);
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error); else resolve();
    }
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === 'complete') finish();
    }).catch((error) => finish(error));
  });
}

async function navigateTab(tabId, url, timeoutSeconds) {
  const timeoutMs = Math.max(20000, Math.min(120000, Number(timeoutSeconds || 600) * 1000));
  const tab = await chrome.tabs.update(tabId, { url, active: true });
  if (!tab) throw new Error('TAB_NAVIGATION_FAILED');
  await waitForTabComplete(tabId, timeoutMs);
}

function statsFromResults(results) {
  return results.reduce((acc, r) => {
    acc.totalMessages += Number(r?.totalMessages || 0);
    acc.userMessages += Number(r?.userMessages || 0);
    acc.agentMessages += Number(r?.agentMessages || 0);
    return acc;
  }, { totalMessages: 0, userMessages: 0, agentMessages: 0 });
}

async function sendProgress(job, extra = {}) {
  const stats = statsFromResults(job.results);
  const payload = Object.assign({
    type: 'CGX_PROJECT_EXPORT_PROGRESS',
    projectName: job.projectName,
    total: job.chats.length,
    completed: job.results.length,
    failed: job.failures.length,
    totalMessages: stats.totalMessages,
    userMessages: stats.userMessages,
    agentMessages: stats.agentMessages
  }, extra);
  try { await sendWithRetry(job.tabId, payload, 40, 250); } catch { /* progression au mieux */ }
}

async function returnAndFinalize(job, finalError = '') {
  let returnError = finalError;
  try {
    await navigateTab(job.tabId, job.returnUrl, job.timeoutSeconds);
  } catch (error) {
    returnError = returnError || String(error?.message || error);
  }

  const payload = {
    type: 'CGX_PROJECT_EXPORT_COMPLETE',
    projectName: job.projectName,
    total: job.chats.length,
    results: job.results,
    failures: job.failures,
    cancelled: Boolean(job.cancelled),
    error: returnError,
    stamp: job.stamp,
    zipFilename: job.zipFilename,
    exportedAt: new Date().toISOString(),
    logLines: job.logLines.slice(-80)
  };

  if (!returnError || isSupported(job.returnUrl)) {
    try { await sendWithRetry(job.tabId, payload, 80, 250); } catch (error) {
      console.error('[ChatGPT Export] final project delivery failed:', error);
    }
  }
}

async function runLiveProjectExport(job) {
  let fatalError = '';
  try {
    const batchSize = Math.max(1, Number(job.chatsPerZip || 50));
    const totalBatches = Math.ceil(job.chats.length / batchSize);
    const batchStart = Math.max(0, Number(job.batchStart || 0));

    if (batchStart >= job.chats.length) {
      await clearPersistedProjectJob(job.tabId);
      liveProjectJobs.delete(job.tabId);
      return;
    }

    if (job.cancelled) throw new Error('STOPPED_BY_USER');

    const batchIndex = Math.floor(batchStart / batchSize) + 1;
    const batchChats = job.chats.slice(batchStart, batchStart + batchSize);
    job.results = [];
    job.failures = [];
    job.currentBatchIndex = batchIndex;
    job.awaitingAck = false;
    job.logLines.push(`batch start ${batchIndex}/${totalBatches} chats=${batchStart + 1}-${batchStart + batchChats.length}`);
    await persistProjectJob(job);

    for (let j = 0; j < batchChats.length; j += 1) {
      if (job.cancelled) break;
      const i = batchStart + j;
      const chat = batchChats[j];
      const titleHint = String(chat?.titleHint || `chat ${i + 1}`);
      job.logLines.push(`chat start ${i + 1}/${job.chats.length} batch=${batchIndex}/${totalBatches} ${chat.url}`);
      try {
        await navigateTab(job.tabId, chat.url, job.timeoutSeconds);
        if (job.cancelled) break;
        await sendProgress(job, {
          phase: 'start', index: i + 1, total: job.chats.length,
          batchIndex, totalBatches, url: chat.url, titleHint
        });
        const result = await sendWithRetry(job.tabId, {
          type: 'CGX_EXPORT_CHAT_DATA_FOR_PROJECT',
          projectName: job.projectName,
          titleHint,
          readyTimeoutMs: 20000,
          liveProject: true,
          index: i + 1,
          total: job.chats.length,
          batchIndex,
          totalBatches
        }, 100, 250);
        if (job.cancelled) break;
        if (!result || result.ok === false) throw new Error(result?.error || 'CHAT_EXPORT_FAILED');
        job.results.push(result);
        job.logLines.push(`chat done ${i + 1}/${job.chats.length} ${result.chatTitle || titleHint} messages=${result.totalMessages || 0}`);
        await sendProgress(job, {
          phase: 'done', index: i + 1, total: job.chats.length,
          batchIndex, totalBatches, url: chat.url, titleHint,
          chatTitle: result.chatTitle || titleHint
        });
      } catch (error) {
        const failure = { url: chat.url, titleHint, error: String(error?.message || error) };
        job.failures.push(failure);
        job.logLines.push(`chat error ${i + 1}/${job.chats.length} ${failure.error}`);
        if (job.cancelled) break;
        try {
          await sendProgress(job, {
            phase: 'error', index: i + 1, total: job.chats.length,
            batchIndex, totalBatches, url: chat.url, titleHint
          });
        } catch { /* ignoré */ }
      }
      if (!job.cancelled) await sleep(350);
    }

    if (job.cancelled) throw new Error('STOPPED_BY_USER');

    let returnError = '';
    try { await navigateTab(job.tabId, job.returnUrl, job.timeoutSeconds); }
    catch (error) { returnError = String(error?.message || error); }

    const projectBrowser = underscoreToken(job.browserName || 'Browser', 'Browser');
    const projectAccount = underscoreToken(job.accountName || 'ChatGPT Account', 'ChatGPT_Account');
    const projectChats = batchChatFilenameToken(batchChats);
    const projectPrefix = `Full_Project_${underscoreToken(job.projectName, 'Project')}__${projectChats}__${projectBrowser}__${projectAccount}__export_${job.stamp}`;
    const projectFilename = totalBatches > 1
      ? `${projectPrefix}__part_${String(batchIndex).padStart(3, '0')}_of_${String(totalBatches).padStart(3, '0')}.zip`
      : `${projectPrefix}.zip`;

    const payload = {
      type: 'CGX_PROJECT_EXPORT_COMPLETE',
      projectName: job.projectName,
      accountName: job.accountName || '',
      browserName: job.browserName || '',
      total: job.chats.length,
      batchIndex,
      totalBatches,
      batchStart: batchStart + 1,
      batchEnd: batchStart + batchChats.length,
      results: job.results,
      failures: job.failures,
      cancelled: false,
      error: returnError,
      stamp: job.stamp,
      zipFilename: projectFilename,
      exportedAt: new Date().toISOString(),
      logLines: job.logLines.slice(-120)
    };

    // Persiste AVANT de remettre le lot au script de contenu. Construire un ZIP contenant
    // de nombreux fichiers peut prendre plusieurs minutes. MV3 peut suspendre ce service worker entre-temps.
    // Le script de contenu confirme la partie enregistrée avec CGX_PROJECT_BATCH_SAVED ;
    // cet événement nous réveille et démarre la partie suivante depuis l’état persistant.
    job.awaitingAck = true;
    job.currentBatchIndex = batchIndex;
    await persistProjectJob(job);

    try {
      const response = await sendWithRetry(job.tabId, payload, 100, 250);
      if (!response?.ok && response?.error) throw new Error(response.error);
      job.logLines.push(`batch ${batchIndex}/${totalBatches} delivered; waiting save acknowledgement`);
      await persistProjectJob(job);
    } catch (error) {
      fatalError = String(error?.message || error);
      job.logLines.push(`batch ${batchIndex} final delivery failed ${fatalError}`);
    }
  } catch (error) {
    fatalError = String(error?.message || error);
    job.logLines.push(`fatal ${fatalError}`);
  } finally {
    if (job.cancelled || fatalError) {
      try { await clearPersistedProjectJob(job.tabId); } catch { /* ignoré */ }
      liveProjectJobs.delete(job.tabId);
      try { await navigateTab(job.tabId, job.returnUrl, job.timeoutSeconds); } catch { /* ignoré */ }
      try {
        await sendWithRetry(job.tabId, {
          type: 'CGX_PROJECT_EXPORT_COMPLETE',
          projectName: job.projectName,
          total: job.chats.length,
          batchIndex: 0,
          totalBatches: Math.ceil(job.chats.length / Math.max(1, Number(job.chatsPerZip || 50))),
          results: [], failures: [], cancelled: Boolean(job.cancelled),
          error: job.cancelled ? '' : fatalError, stamp: job.stamp, zipFilename: '',
          exportedAt: new Date().toISOString(), logLines: job.logLines.slice(-120)
        }, 40, 250);
      } catch { /* au mieux */ }
    }
  }
}

async function sendAllChatProgress(job, extra = {}) {
  const stats = statsFromResults(job.results);
  const payload = Object.assign({
    type: 'CGX_ALL_CHAT_EXPORT_PROGRESS',
    total: job.chats.length,
    completed: job.results.length,
    failed: job.failures.length,
    totalMessages: stats.totalMessages,
    userMessages: stats.userMessages,
    agentMessages: stats.agentMessages
  }, extra);
  try { await sendWithRetry(job.tabId, payload, 40, 250); } catch { /* au mieux */ }
}

async function returnAndFinalizeAllChat(job, finalError = '') {
  let returnError = finalError;
  try { await navigateTab(job.tabId, job.returnUrl, job.timeoutSeconds); }
  catch (error) { returnError = returnError || String(error?.message || error); }
  const payload = {
    type: 'CGX_ALL_CHAT_EXPORT_COMPLETE',
    total: job.chats.length,
    results: job.results,
    failures: job.failures,
    cancelled: Boolean(job.cancelled),
    error: returnError,
    stamp: job.stamp,
    zipFilename: job.zipFilename,
    exportedAt: new Date().toISOString(),
    logLines: job.logLines.slice(-120)
  };
  try { await sendWithRetry(job.tabId, payload, 100, 250); } catch (error) { console.error('[ChatGPT Export] all-chat final delivery failed:', error); }
}

async function runLiveAllChatExport(job) {
  let fatalError = '';
  try {
    const batchSize = Math.max(1, Number(job.chatsPerZip || 50));
    const totalBatches = Math.ceil(job.chats.length / batchSize);
    const batchStart = Math.max(0, Number(job.batchStart || 0));

    if (batchStart >= job.chats.length) {
      await clearPersistedAllChatJob(job.tabId);
      liveAllChatJobs.delete(job.tabId);
      return;
    }

    if (job.cancelled) throw new Error('STOPPED_BY_USER');

    const batchIndex = Math.floor(batchStart / batchSize) + 1;
    const batchChats = job.chats.slice(batchStart, batchStart + batchSize);
    job.results = [];
    job.failures = [];
    job.currentBatchIndex = batchIndex;
    job.awaitingAck = false;
    job.logLines.push(`batch start ${batchIndex}/${totalBatches} chats=${batchStart + 1}-${batchStart + batchChats.length}`);
    await persistAllChatJob(job);

    for (let j = 0; j < batchChats.length; j += 1) {
      if (job.cancelled) break;
      const globalIndex = batchStart + j + 1;
      const chat = batchChats[j];
      const titleHint = String(chat?.titleHint || `chat ${globalIndex}`);
      try {
        await navigateTab(job.tabId, chat.url, job.timeoutSeconds);
        if (job.cancelled) break;
        await sendAllChatProgress(job, {
          phase: 'start', index: globalIndex, batchIndex, totalBatches,
          url: chat.url, titleHint
        });
        const result = await sendWithRetry(job.tabId, {
          type: 'CGX_EXPORT_CHAT_DATA_FOR_PROJECT',
          projectName: 'ALL Chats',
          titleHint,
          readyTimeoutMs: 20000,
          liveProject: true,
          index: globalIndex,
          total: job.chats.length,
          batchIndex,
          totalBatches
        }, 100, 250);
        if (job.cancelled) break;
        if (!result || result.ok === false) throw new Error(result?.error || 'CHAT_EXPORT_FAILED');
        job.results.push(result);
        job.logLines.push(`chat done ${globalIndex}/${job.chats.length} ${result.chatTitle || titleHint} messages=${result.totalMessages || 0}`);
        await sendAllChatProgress(job, {
          phase: 'done', index: globalIndex, batchIndex, totalBatches,
          url: chat.url, titleHint, chatTitle: result.chatTitle || titleHint
        });
      } catch (error) {
        const failure = { url: chat.url, titleHint, error: String(error?.message || error) };
        job.failures.push(failure);
        job.logLines.push(`chat error ${globalIndex}/${job.chats.length} ${failure.error}`);
        if (job.cancelled) break;
        try {
          await sendAllChatProgress(job, {
            phase: 'error', index: globalIndex, batchIndex, totalBatches,
            url: chat.url, titleHint
          });
        } catch { /* ignoré */ }
      }
      if (!job.cancelled) await sleep(350);
    }

    if (job.cancelled) throw new Error('STOPPED_BY_USER');

    let returnError = '';
    try { await navigateTab(job.tabId, job.returnUrl, job.timeoutSeconds); }
    catch (error) { returnError = String(error?.message || error); }

    const allBrowser = underscoreToken(job.browserName || 'Browser', 'Browser');
    const allAccount = underscoreToken(job.accountName || 'ChatGPT Account', 'ChatGPT_Account');
    const allChats = batchChatFilenameToken(batchChats);
    const allPrefix = `Export_ALL_Full_Chat__${allChats}__${allBrowser}__${allAccount}__export_${job.stamp}`;
    const zipFilename = totalBatches > 1
      ? `${allPrefix}__part_${String(batchIndex).padStart(3, '0')}_of_${String(totalBatches).padStart(3, '0')}.zip`
      : `${allPrefix}.zip`;

    const payload = {
      type: 'CGX_ALL_CHAT_EXPORT_COMPLETE',
      total: job.chats.length,
      batchIndex,
      totalBatches,
      batchStart: batchStart + 1,
      batchEnd: batchStart + batchChats.length,
      results: job.results,
      failures: job.failures,
      cancelled: false,
      error: returnError,
      stamp: job.stamp,
      accountName: job.accountName || '',
      browserName: job.browserName || '',
      zipFilename,
      exportedAt: new Date().toISOString(),
      logLines: job.logLines.slice(-120)
    };

    // p17 : l’export de tous les chats utilise le même cycle de lots et la même sémantique chatsPerZip que le projet complet.
    // Chaque partie ZIP est enregistrée automatiquement sous le dossier Téléchargements par défaut du navigateur,
    // puis confirmée avant le démarrage du lot suivant.
    job.awaitingAck = true;
    job.currentBatchIndex = batchIndex;
    await persistAllChatJob(job);

    try {
      const response = await sendWithRetry(job.tabId, payload, 100, 250);
      if (!response?.ok && response?.error) throw new Error(response.error);
      job.logLines.push(`batch ${batchIndex}/${totalBatches} delivered; waiting save acknowledgement`);
      await persistAllChatJob(job);
    } catch (error) {
      fatalError = String(error?.message || error);
      job.logLines.push(`batch ${batchIndex} final delivery failed ${fatalError}`);
    }
  } catch (error) {
    fatalError = String(error?.message || error);
    job.logLines.push(`fatal ${fatalError}`);
  } finally {
    if (job.cancelled || fatalError) {
      try { await clearPersistedAllChatJob(job.tabId); } catch { /* ignoré */ }
      liveAllChatJobs.delete(job.tabId);
      try { await navigateTab(job.tabId, job.returnUrl, job.timeoutSeconds); } catch { /* ignoré */ }
      try {
        await sendWithRetry(job.tabId, {
          type: 'CGX_ALL_CHAT_EXPORT_COMPLETE',
          total: job.chats.length,
          batchIndex: 0,
          totalBatches: Math.ceil(job.chats.length / Math.max(1, Number(job.chatsPerZip || 50))),
          results: [],
          failures: [],
          cancelled: Boolean(job.cancelled),
          error: job.cancelled ? '' : fatalError,
          stamp: job.stamp,
          accountName: job.accountName || '',
          zipFilename: '',
          exportedAt: new Date().toISOString(),
          logLines: job.logLines.slice(-120)
        }, 40, 250);
      } catch { /* au mieux */ }
    }
  }
}

async function fetchAttachmentData(url) {
  if (!isAllowedAttachmentUrl(url)) throw new Error('ATTACHMENT_URL_NOT_ALLOWED');
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`ATTACHMENT_HTTP_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    ok: true,
    base64: bytesToBase64(bytes),
    size: bytes.length,
    contentType: response.headers.get('content-type') || '',
    finalUrl: response.url || url,
    version: VERSION
  };
}

chrome.action.onClicked.addListener(toggle);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  // Les messages destinés au document hors écran sont volontairement ignorés ici
  // afin que son écouteur runtime soit le seul à répondre.
  if (message.target === 'offscreen') return false;

  if (message.type === 'CGX_PREPARE_OFFSCREEN_DOWNLOAD') {
    ensureOffscreenDownloadDocument()
      .then(() => sendResponse({ ok: true, version: VERSION }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error), version: VERSION }));
    return true;
  }

  if (message.type === 'CGX_DOWNLOAD_BATCH_ZIP') {
    (async () => {
      await ensureOffscreenDownloadDocument();
      const relativePath = sanitizeRelativeDownloadPath(message.relativePath || message.filename || 'ChatGPT-Export/export.zip');
      const result = await downloadBatchZip(message.url, relativePath, String(message.transferId || ''), Boolean(message.saveAs));
      sendResponse({ ok: true, ...result, version: VERSION });
    })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error), version: VERSION }));
    return true;
  }

  if (message.type === 'CGX_START_LIVE_ALL_CHAT_EXPORT') {
    const tabId = sender?.tab?.id;
    if (!tabId) { sendResponse({ ok:false, error:'NO_ACTIVE_TAB', version:VERSION }); return false; }
    if (liveAllChatJobs.has(tabId) || liveProjectJobs.has(tabId)) { sendResponse({ ok:false, error:'EXPORT_ALREADY_RUNNING', version:VERSION }); return false; }
    const chats = Array.isArray(message.chats) ? message.chats.filter((c) => c && isSupported(c.url)) : [];
    if (!chats.length) { sendResponse({ ok:false, error:'NO_ACCOUNT_CHATS_FOUND', version:VERSION }); return false; }
    const job = {
      tabId,
      chats,
      returnUrl: String(message.returnUrl || sender.tab.url || ''),
      timeoutSeconds: Number(message.timeoutSeconds || 600),
      chatsPerZip: Math.max(1, Number(message.chatsPerZip || 50)),
      stamp: String(message.stamp || ''),
      zipFilename: String(message.zipFilename || ''),
      accountName: String(message.accountName || ''),
      browserName: String(message.browserName || ''),
      batchStart: 0,
      currentBatchIndex: 0,
      awaitingAck: false,
      results: [],
      failures: [],
      logLines: [],
      cancelled: false
    };
    liveAllChatJobs.set(tabId, job);
    (async () => {
      await persistAllChatJob(job);
      sendResponse({ ok:true, total:chats.length, version:VERSION });
      setTimeout(() => runLiveAllChatExport(job), 150);
    })().catch((error) => {
      liveAllChatJobs.delete(tabId);
      sendResponse({ ok:false, error:String(error?.message || error), version:VERSION });
    });
    return true;
  }

  if (message.type === 'CGX_START_LIVE_PROJECT_EXPORT') {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB', version: VERSION });
      return false;
    }
    if (liveProjectJobs.has(tabId)) {
      sendResponse({ ok: false, error: 'PROJECT_EXPORT_ALREADY_RUNNING', version: VERSION });
      return false;
    }
    const chats = Array.isArray(message.chats) ? message.chats.filter((c) => c && isSupported(c.url)) : [];
    if (!chats.length) {
      sendResponse({ ok: false, error: 'NO_PROJECT_CHATS_FOUND', version: VERSION });
      return false;
    }
    const job = {
      tabId,
      chats,
      projectName: String(message.projectName || 'Project'),
      returnUrl: String(message.returnUrl || sender.tab.url || ''),
      timeoutSeconds: Number(message.timeoutSeconds || 600),
      chatsPerZip: Math.max(1, Number(message.chatsPerZip || 50)),
      stamp: String(message.stamp || ''),
      zipFilename: String(message.zipFilename || ''),
      accountName: String(message.accountName || ''),
      browserName: String(message.browserName || ''),
      batchStart: 0,
      currentBatchIndex: 0,
      awaitingAck: false,
      results: [],
      failures: [],
      logLines: [],
      cancelled: false
    };
    liveProjectJobs.set(tabId, job);
    (async () => {
      await persistProjectJob(job);
      sendResponse({ ok: true, total: chats.length, version: VERSION });
      setTimeout(() => runLiveProjectExport(job), 150);
    })().catch((error) => {
      liveProjectJobs.delete(tabId);
      sendResponse({ ok: false, error: String(error?.message || error), version: VERSION });
    });
    return true;
  }

  if (message.type === 'CGX_ALL_CHAT_BATCH_SAVED') {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB', version: VERSION });
      return false;
    }
    (async () => {
      let job = liveAllChatJobs.get(tabId) || await loadPersistedAllChatJob(tabId);
      if (!job) {
        sendResponse({ ok: false, error: 'ALL_CHAT_EXPORT_STATE_MISSING', version: VERSION });
        return;
      }
      liveAllChatJobs.set(tabId, job);
      const batchSize = Math.max(1, Number(job.chatsPerZip || 50));
      const totalBatches = Math.ceil(job.chats.length / batchSize);
      const ackBatch = Math.max(0, Number(message.batchIndex || 0));
      if (!job.awaitingAck || ackBatch !== Number(job.currentBatchIndex || 0)) {
        sendResponse({ ok: true, ignored: true, done: false, totalBatches, version: VERSION });
        return;
      }

      const nextBatchStart = Math.max(0, Number(job.batchStart || 0)) + batchSize;
      job.logLines.push(`batch ${ackBatch}/${totalBatches} saved acknowledgement received`);
      job.awaitingAck = false;
      job.results = [];
      job.failures = [];

      if (nextBatchStart >= job.chats.length) {
        job.logLines.push(`all-chat complete batches=${totalBatches}`);
        await clearPersistedAllChatJob(tabId);
        liveAllChatJobs.delete(tabId);
        sendResponse({ ok: true, done: true, batchIndex: ackBatch, totalBatches, version: VERSION });
        return;
      }

      job.batchStart = nextBatchStart;
      job.currentBatchIndex = 0;
      await persistAllChatJob(job);
      sendResponse({
        ok: true,
        done: false,
        batchIndex: ackBatch,
        nextBatchIndex: Math.floor(nextBatchStart / batchSize) + 1,
        totalBatches,
        version: VERSION
      });
      setTimeout(() => runLiveAllChatExport(job), 150);
    })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error), version: VERSION }));
    return true;
  }

  if (message.type === 'CGX_PROJECT_BATCH_SAVED') {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB', version: VERSION });
      return false;
    }
    (async () => {
      let job = liveProjectJobs.get(tabId) || await loadPersistedProjectJob(tabId);
      if (!job) {
        sendResponse({ ok: false, error: 'PROJECT_EXPORT_STATE_MISSING', version: VERSION });
        return;
      }
      liveProjectJobs.set(tabId, job);
      const batchSize = Math.max(1, Number(job.chatsPerZip || 50));
      const totalBatches = Math.ceil(job.chats.length / batchSize);
      const ackBatch = Math.max(0, Number(message.batchIndex || 0));
      if (!job.awaitingAck || ackBatch !== Number(job.currentBatchIndex || 0)) {
        sendResponse({ ok: true, ignored: true, done: false, totalBatches, version: VERSION });
        return;
      }

      const nextBatchStart = Math.max(0, Number(job.batchStart || 0)) + batchSize;
      job.logLines.push(`batch ${ackBatch}/${totalBatches} saved acknowledgement received`);
      job.awaitingAck = false;
      job.results = [];
      job.failures = [];

      if (nextBatchStart >= job.chats.length) {
        job.logLines.push(`project complete batches=${totalBatches}`);
        await clearPersistedProjectJob(tabId);
        liveProjectJobs.delete(tabId);
        sendResponse({ ok: true, done: true, batchIndex: ackBatch, totalBatches, version: VERSION });
        return;
      }

      job.batchStart = nextBatchStart;
      job.currentBatchIndex = 0;
      await persistProjectJob(job);
      sendResponse({
        ok: true,
        done: false,
        batchIndex: ackBatch,
        nextBatchIndex: Math.floor(nextBatchStart / batchSize) + 1,
        totalBatches,
        version: VERSION
      });
      setTimeout(() => runLiveProjectExport(job), 150);
    })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error), version: VERSION }));
    return true;
  }

  if (message.type === 'CGX_FETCH_ATTACHMENT_DATA') {
    fetchAttachmentData(message.url)
      .then((payload) => sendResponse(payload))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error), version: VERSION }));
    return true;
  }

  if (message.type === 'CGX_CANCEL_LIVE_PROJECT_EXPORT') {
    const tabId = sender?.tab?.id;
    (async () => {
      let job = tabId ? liveProjectJobs.get(tabId) : null;
      let kind = job ? 'project' : '';
      if (!job && tabId) {
        job = liveAllChatJobs.get(tabId);
        if (job) kind = 'all-chat';
      }
      if (!job && tabId) {
        job = await loadPersistedProjectJob(tabId);
        if (job) kind = 'project';
      }
      if (!job && tabId) {
        job = await loadPersistedAllChatJob(tabId);
        if (job) kind = 'all-chat';
      }
      if (job) {
        job.cancelled = true;
        job.logLines.push('cancel requested by user');
        if (kind === 'all-chat') {
          liveAllChatJobs.set(tabId, job);
          await persistAllChatJob(job);
        } else {
          liveProjectJobs.set(tabId, job);
          await persistProjectJob(job);
        }
      }
      sendResponse({ ok: true, cancelled: Boolean(job), version: VERSION });
    })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error), version: VERSION }));
    return true;
  }

  if (message.type === 'CGX_RELOAD_EXTENSION') {
    sendResponse({ ok: true, version: VERSION });
    setTimeout(() => chrome.runtime.reload(), 150);
    return false;
  }

  if (message.type === 'CGX_REFRESH_CHATGPT_TABS') {
    refreshChatGPTTabsAfterReload().then(() => sendResponse({ ok: true, version: VERSION }));
    return true;
  }

  return false;
});

setTimeout(() => {
  chrome.storage.local.get(['cgx.refreshAfterReload'], (data) => {
    if (!data || !data['cgx.refreshAfterReload']) return;
    chrome.storage.local.remove(['cgx.refreshAfterReload'], () => refreshChatGPTTabsAfterReload());
  });
}, 500);
