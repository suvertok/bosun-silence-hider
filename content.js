(() => {
    'use strict';
  
    const STORAGE_KEY = 'bosunShowSilenced';
    const HIDDEN_CLASS = 'bosun-silence-hidden';
    const TOGGLE_ID = 'bosun-silence-toggle';
  
    // ===== НАСТРОЙКИ КНОПКИ =====
    const TOGGLE_TOP = '12px';    // <- высота от верхнего края
    const TOGGLE_RIGHT = '16px';  // <- отступ справа
    // ===========================
  
    let showSilenced = false;
    let refreshTimer = null;
    let observerStarted = false;
    let hiddenCount = 0;
  
    function injectStyles() {
      if (document.getElementById('bosun-silence-style')) return;
  
      const style = document.createElement('style');
      style.id = 'bosun-silence-style';
      style.textContent = `
        .${HIDDEN_CLASS} {
          display: none !important;
        }
  
        #${TOGGLE_ID} {
          position: fixed;
          top: ${TOGGLE_TOP};
          right: ${TOGGLE_RIGHT};
          z-index: 2147483647;
          background: #1f2937;
          color: #fff;
          border: 0;
          border-radius: 10px;
          padding: 10px 14px;
          font: 13px/1.2 Arial, sans-serif;
          cursor: pointer;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
          display: inline-flex;
          align-items: center;
          gap: 8px;
          user-select: none;
          -webkit-user-select: none;
          pointer-events: auto;
        }
  
        #${TOGGLE_ID}:hover {
          opacity: 0.95;
        }
  
        #${TOGGLE_ID}:focus {
          outline: 2px solid rgba(255,255,255,0.35);
          outline-offset: 2px;
        }
  
        #${TOGGLE_ID} .bosun-silence-label {
          display: inline-block;
          pointer-events: none;
        }
  
        #${TOGGLE_ID} .bosun-silence-badge {
          display: inline-block;
          min-width: 22px;
          padding: 2px 7px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.18);
          font-weight: bold;
          text-align: center;
          pointer-events: none;
        }
      `;
      document.head.appendChild(style);
    }
  
    function getPanelHeading(panel) {
      return panel.querySelector('.panel-heading');
    }
  
    function isSilencedPanel(panel) {
      const heading = getPanelHeading(panel);
      if (!heading) return false;
      return !!heading.querySelector('.fa-volume-off');
    }
  
    function getAlertPanels() {
      return Array.from(document.querySelectorAll('.panel'));
    }
  
    function applyVisibility() {
      const panels = getAlertPanels();
      let nextHiddenCount = 0;
  
      for (const panel of panels) {
        const silenced = isSilencedPanel(panel);
  
        if (silenced && !showSilenced) {
          panel.classList.add(HIDDEN_CLASS);
          nextHiddenCount++;
        } else {
          panel.classList.remove(HIDDEN_CLASS);
        }
      }
  
      hiddenCount = nextHiddenCount;
      updateToggleText();
    }
  
    function scheduleApplyVisibility() {
      if (refreshTimer) clearTimeout(refreshTimer);
  
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        ensureToggleExists();
        applyVisibility();
      }, 120);
    }
  
    function saveState() {
      if (!chrome?.storage?.local) return;
      chrome.storage.local.set({ [STORAGE_KEY]: showSilenced });
    }
  
    function loadState(callback) {
      if (!chrome?.storage?.local) {
        callback();
        return;
      }
  
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        if (!chrome.runtime?.lastError && typeof result[STORAGE_KEY] === 'boolean') {
          showSilenced = result[STORAGE_KEY];
        }
        callback();
      });
    }
  
    function updateToggleText() {
        const btn = document.getElementById(TOGGLE_ID);
        if (!btn) return;
      
        const labelNode = btn.querySelector('.bosun-silence-label');
        const badgeNode = btn.querySelector('.bosun-silence-badge');
        if (!labelNode || !badgeNode) return;
      
        if (showSilenced) {
          labelNode.textContent = 'Скрыть silenced alerts';
          badgeNode.style.display = 'none';
          badgeNode.textContent = '';
        } else {
          labelNode.textContent = 'Показать silenced alerts';
          badgeNode.style.display = 'inline-block';
          badgeNode.textContent = String(hiddenCount);
        }
      }
  
    function swallowPointerStart(e) {
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
    }
  
    function handleToggleClick(e) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
  
      showSilenced = !showSilenced;
      saveState();
      applyVisibility();
    }
  
    function ensureToggleExists() {
      let btn = document.getElementById(TOGGLE_ID);
      if (btn) {
        updateToggleText();
        return;
      }
  
      btn = document.createElement('button');
      btn.id = TOGGLE_ID;
      btn.type = 'button';
  
      const label = document.createElement('span');
      label.className = 'bosun-silence-label';
  
      const badge = document.createElement('span');
      badge.className = 'bosun-silence-badge';
  
      btn.appendChild(label);
      btn.appendChild(badge);
  
      // Гасим стартовые события, чтобы их не ловил Bosun
      ['pointerdown', 'mousedown', 'touchstart'].forEach((evt) => {
        btn.addEventListener(evt, swallowPointerStart, true);
      });
  
      // Сам переключатель — отдельным обработчиком
      btn.addEventListener('click', handleToggleClick, true);
  
      document.body.appendChild(btn);
      updateToggleText();
    }
  
    function startObserver() {
      if (observerStarted || !document.body) return;
      observerStarted = true;
  
      const observer = new MutationObserver((mutations) => {
        let shouldRefresh = false;
  
        for (const mutation of mutations) {
          const target = mutation.target && mutation.target.nodeType === 1
            ? mutation.target
            : mutation.target?.parentElement;
  
          if (!target) continue;
          if (target.id === TOGGLE_ID || target.closest?.(`#${TOGGLE_ID}`)) continue;
  
          shouldRefresh = true;
          break;
        }
  
        if (shouldRefresh) scheduleApplyVisibility();
      });
  
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  
    function init() {
      injectStyles();
  
      loadState(() => {
        ensureToggleExists();
        applyVisibility();
        startObserver();
  
        setTimeout(() => {
          ensureToggleExists();
          applyVisibility();
        }, 1000);
      });
    }
  
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  })();