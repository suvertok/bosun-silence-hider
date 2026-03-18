(() => {
    'use strict';
  
    const STORAGE_KEY = 'bosunShowSilenced';
    const HIDDEN_CLASS = 'bosun-silence-hidden';
    const TOGGLE_ID = 'bosun-silence-toggle';
  
    let showSilenced = false;
    let refreshTimer = null;
    let observerStarted = false;
  
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
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          background: #1f2937;
          color: #fff;
          border: 0;
          border-radius: 10px;
          padding: 10px 14px;
          font: 13px/1.2 Arial, sans-serif;
          cursor: pointer;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
        }
  
        #${TOGGLE_ID}:hover {
          opacity: 0.95;
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
  
      for (const panel of panels) {
        const silenced = isSilencedPanel(panel);
  
        if (silenced && !showSilenced) {
          panel.classList.add(HIDDEN_CLASS);
        } else {
          panel.classList.remove(HIDDEN_CLASS);
        }
      }
  
      updateToggleText();
    }
  
    function scheduleApplyVisibility() {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
  
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        applyVisibility();
        ensureToggleExists();
      }, 120);
    }
  
    function updateToggleText() {
      const btn = document.getElementById(TOGGLE_ID);
      if (!btn) return;
  
      btn.textContent = showSilenced
        ? 'Скрыть silenced alerts'
        : 'Показать silenced alerts';
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
        if (chrome.runtime?.lastError) {
          callback();
          return;
        }
  
        if (typeof result[STORAGE_KEY] === 'boolean') {
          showSilenced = result[STORAGE_KEY];
        }
  
        callback();
      });
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
  
      btn.addEventListener('click', () => {
        showSilenced = !showSilenced;
        saveState();
        applyVisibility();
      });
  
      document.body.appendChild(btn);
      updateToggleText();
    }
  
    function startObserver() {
      if (observerStarted || !document.body) return;
      observerStarted = true;
  
      const observer = new MutationObserver(() => {
        scheduleApplyVisibility();
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