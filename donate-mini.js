/*
 * ChatGPT Export - donate-mini.js
 * Version: v7.0.0
 * Développeur : @NoXoZ.be
 *
 * Bouton de soutien FINAL :
 * - Mini : placement en bas, option C rose pâle / rouge, bordure rouge marquée.
 * - Maxi / Maxi Dev : après la zone Démarrer/Arrêter l’export, pleine largeur,
 *   hauteur réduite, taille de texte adaptée, option C rose pâle / rouge, bordure rouge marquée.
 */
(function cgxDonateMiniInit() {
  'use strict';

  const WIDGET_ID = 'cgx-widget';
  const BUTTON_CLASS = 'cgx-donate-mini';
  const STYLE_ID = 'cgx-donate-mini-style';
  const DONATE_URL = 'https://donate.stripe.com/6oUdRbfsifpQ8DzbbWfQI00';

  const MINI_LABEL = '♡  Soutenir ce projet';
  const MAXI_LABEL = '♡  Cliquez pour soutenir ce projet  ♡';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${WIDGET_ID} .${BUTTON_CLASS} {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        max-width: 100%;
        margin: 6px 0 0 0;
        padding: 0 6px;
        border: 1px solid rgba(255,23,68,.98);
        border-radius: 7px;
        background: #ffe4ec;
        color: #3b0a18;
        font-family: inherit;
        font-weight: 900;
        text-align: center;
        text-decoration: none;
        white-space: nowrap;
        cursor: pointer;
        box-sizing: border-box;
        box-shadow:
          inset 0 0 0 1px rgba(255,255,255,.45),
          0 0 7px rgba(255,23,68,.24);
        animation: cgxDonatePulse 2.2s ease-in-out infinite;
      }

      #${WIDGET_ID} .${BUTTON_CLASS}:hover {
        background: #fff0f5;
        color: #2b0611;
        border-color: rgba(255,23,68,1);
        box-shadow:
          inset 0 0 0 1px rgba(255,255,255,.58),
          0 0 12px rgba(255,23,68,.40);
      }

      #${WIDGET_ID} .${BUTTON_CLASS}:focus-visible {
        outline: 2px solid rgba(255,23,68,.92);
        outline-offset: 1px;
      }

      #${WIDGET_ID}.cgx-mode-mini .${BUTTON_CLASS} {
        margin: 5px 0 0 0;
        height: 17px;
        min-height: 17px;
        line-height: 15px;
        font-size: 10px;
      }

      #${WIDGET_ID}.cgx-mode-maxi .${BUTTON_CLASS} {
        display: flex !important;
        width: 100% !important;
        max-width: 100% !important;
        align-self: stretch;
        flex: 0 0 auto;
        margin: 7px 0 0 0;
        height: 22px;
        min-height: 22px;
        line-height: 20px;
        font-size: 11px;
        border-radius: 8px;
        padding: 0 10px;
      }

      @keyframes cgxDonatePulse {
        0%, 100% {
          box-shadow:
            inset 0 0 0 1px rgba(255,255,255,.45),
            0 0 6px rgba(255,23,68,.18);
        }
        50% {
          box-shadow:
            inset 0 0 0 1px rgba(255,255,255,.58),
            0 0 12px rgba(255,23,68,.34);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        #${WIDGET_ID} .${BUTTON_CLASS} {
          animation: none;
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function createSupportButton() {
    const support = document.createElement('a');
    support.className = BUTTON_CLASS;
    support.href = DONATE_URL;
    support.target = '_blank';
    support.rel = 'noopener noreferrer';

    support.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    return support;
  }

  function cleanupOldDonateBits(widget) {
    widget.querySelectorAll('.cgx-donate-separator').forEach((node) => node.remove());
  }

  function textOf(node) {
    return (node && node.textContent ? node.textContent : '').trim().toLowerCase();
  }

  function closestDirectChild(widget, node) {
    let current = node;
    while (current && current.parentElement && current.parentElement !== widget) {
      current = current.parentElement;
    }
    return current && current.parentElement === widget ? current : node;
  }

  function findDeveloperModeBlock(widget) {
    const all = Array.from(widget.querySelectorAll('*'));
    const devTitle = all.find((node) => textOf(node) === 'mode développeur' || textOf(node).includes('mode développeur') || textOf(node) === 'developer mode' || textOf(node).includes('developer mode'));
    return devTitle ? closestDirectChild(widget, devTitle) : null;
  }

  function isMainExportButton(button) {
    const txt = textOf(button);
    const action = (button.getAttribute('data-action') || '').toLowerCase();

    if (button.classList.contains(BUTTON_CLASS)) return false;

    return (
      action === 'export' ||
      txt === 'démarrer l’export' ||
      txt === 'arrêter l’export' ||
      txt.includes('démarrer l’export') ||
      txt.includes('arrêter l’export') ||
      txt === 'start export' ||
      txt === 'stop export' ||
      txt.includes('start export') ||
      txt.includes('stop export')
    );
  }

  function findStartStopExportRow(widget) {
    const buttons = Array.from(widget.querySelectorAll('button')).filter(isMainExportButton);
    if (!buttons.length) return null;

    const first = buttons[0];

    let row = first.parentElement;
    while (row && row.parentElement && row.parentElement !== widget) {
      const rowText = textOf(row);
      const hasRangeOnly =
        ((rowText.includes('complet') && rowText.includes('début') && rowText.includes('fin')) ||
         (rowText.includes('full') && rowText.includes('start') && rowText.includes('end'))) &&
        !rowText.includes('démarrer l’export') &&
        !rowText.includes('arrêter l’export') &&
        !rowText.includes('start export') &&
        !rowText.includes('stop export');

      if (hasRangeOnly) break;

      const rowButtons = Array.from(row.querySelectorAll('button')).filter(isMainExportButton);
      if (rowButtons.length >= buttons.length) {
        const direct = closestDirectChild(widget, row);
        return direct || row;
      }

      row = row.parentElement;
    }

    return closestDirectChild(widget, first.parentElement || first);
  }

  function placeAtBottom(widget, support) {
    if (widget.lastElementChild !== support) {
      widget.appendChild(support);
    }
  }

  function ensureButton() {
    const widget = document.getElementById(WIDGET_ID);
    if (!widget) return;

    cleanupOldDonateBits(widget);

    const existingButton = widget.querySelector(`.${BUTTON_CLASS}`);
    const isMini = widget.classList.contains('cgx-mode-mini');
    const isMaxi = widget.classList.contains('cgx-mode-maxi');

    if (!isMini && !isMaxi) {
      if (existingButton) existingButton.remove();
      return;
    }

    const support = existingButton || createSupportButton();

    if (isMini) {
      support.textContent = MINI_LABEL;
      support.title = 'Soutenir ce projet via Stripe';
      placeAtBottom(widget, support);
      return;
    }

    support.textContent = MAXI_LABEL;
    support.title = 'Cliquez pour soutenir ce projet via Stripe';

    const devBlock = findDeveloperModeBlock(widget);
    if (devBlock && devBlock.parentElement) {
      if (devBlock.previousElementSibling !== support) {
        devBlock.insertAdjacentElement('beforebegin', support);
      }
      return;
    }

    const exportRow = findStartStopExportRow(widget);
    if (exportRow && exportRow.parentElement) {
      if (exportRow.nextElementSibling !== support) {
        exportRow.insertAdjacentElement('afterend', support);
      }
      return;
    }

    placeAtBottom(widget, support);
  }

  let scheduled = false;

  function scheduleEnsure() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensureStyle();
      ensureButton();
    });
  }

  const observer = new MutationObserver(scheduleEnsure);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });

  ensureStyle();
  ensureButton();
}());
