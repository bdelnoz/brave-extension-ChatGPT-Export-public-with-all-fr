/*
 * ChatGPT Export - offscreen.js
 * Version: v7.0.0
 * Patch: p12
 * Développeur : @NoXoZ.be
 * Tampon de transfert pour les gros ZIP / propriétaire des URL Blob pour Manifest V3.
 */
'use strict';

const transfers = new Map();

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function releaseTransfer(id) {
  const record = transfers.get(id);
  if (!record) return;
  if (record.url) {
    try { URL.revokeObjectURL(record.url); } catch { /* ignoré */ }
  }
  transfers.delete(id);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;
  const id = String(message.transferId || '');
  if (!id) {
    sendResponse({ ok: false, error: 'OFFSCREEN_TRANSFER_ID_MISSING' });
    return false;
  }

  try {
    if (message.type === 'CGX_OFFSCREEN_ZIP_BEGIN') {
      releaseTransfer(id);
      transfers.set(id, {
        totalBytes: Math.max(0, Number(message.totalBytes || 0)),
        totalChunks: Math.max(1, Number(message.totalChunks || 1)),
        chunks: new Map(),
        receivedBytes: 0,
        url: ''
      });
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'CGX_OFFSCREEN_ZIP_CHUNK') {
      const record = transfers.get(id);
      if (!record) throw new Error('OFFSCREEN_TRANSFER_NOT_FOUND');
      const index = Number(message.index);
      if (!Number.isInteger(index) || index < 0 || index >= record.totalChunks) throw new Error('OFFSCREEN_CHUNK_INDEX_INVALID');
      if (!record.chunks.has(index)) {
        const bytes = base64ToBytes(message.base64);
        record.chunks.set(index, bytes);
        record.receivedBytes += bytes.length;
      }
      sendResponse({ ok: true, receivedBytes: record.receivedBytes });
      return false;
    }

    if (message.type === 'CGX_OFFSCREEN_ZIP_COMMIT') {
      const record = transfers.get(id);
      if (!record) throw new Error('OFFSCREEN_TRANSFER_NOT_FOUND');
      if (record.chunks.size !== record.totalChunks) throw new Error(`OFFSCREEN_CHUNKS_MISSING_${record.chunks.size}_OF_${record.totalChunks}`);
      if (record.totalBytes && record.receivedBytes !== record.totalBytes) throw new Error(`OFFSCREEN_SIZE_MISMATCH_${record.receivedBytes}_OF_${record.totalBytes}`);
      const parts = [];
      for (let i = 0; i < record.totalChunks; i += 1) parts.push(record.chunks.get(i));
      const blob = new Blob(parts, { type: 'application/zip' });
      record.url = URL.createObjectURL(blob);
      // Libère les références aux blocs après création du Blob afin de réduire la mémoire conservée.
      record.chunks.clear();
      sendResponse({ ok: true, url: record.url, size: blob.size });
      return false;
    }

    if (message.type === 'CGX_OFFSCREEN_ZIP_RELEASE' || message.type === 'CGX_OFFSCREEN_ZIP_ABORT') {
      releaseTransfer(id);
      sendResponse({ ok: true });
      return false;
    }

    sendResponse({ ok: false, error: 'OFFSCREEN_UNKNOWN_MESSAGE' });
  } catch (error) {
    sendResponse({ ok: false, error: String(error?.message || error) });
  }
  return false;
});
