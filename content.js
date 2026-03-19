(() => {
  'use strict';

  const STORAGE_KEY = 'bosunShowSilenced';
  const HIDDEN_CLASS = 'bosun-silence-hidden';
  const TOGGLE_ID = 'bosun-silence-toggle';

  const OLD_NO_NOTE_CLASS = 'bosun-old-no-note';
  const OLD_NO_NOTE_ICON_CLASS = 'bosun-old-no-note-icon';
  const DATA_REFRESH_MS = 60000;
  const OLD_NO_NOTE_MINUTES = 5;

  // ===== НАСТРОЙКИ КНОПКИ =====
  const TOGGLE_TOP = '12px';
  const TOGGLE_RIGHT = '16px';
  // ===========================

  let showSilenced = false;
  let refreshTimer = null;
  let observerStarted = false;
  let hiddenCount = 0;
  let dataRefreshInFlight = false;
  let dataRefreshTimer = null;

  const childProblemById = new Map();
  const childProblemBySubject = new Map();
  const groupProblemBySubject = new Map();

  function injectStyles() {
    if (document.getElementById('bosun-silence-style')) return;

    const style = document.createElement('style');
    style.id = 'bosun-silence-style';
    style.textContent = `
      .${HIDDEN_CLASS} {
        display: none !important;
      }

      .${OLD_NO_NOTE_ICON_CLASS} {
        color: #ff9800 !important;
        margin-right: 6px;
        font-size: 14px;
        vertical-align: middle;
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
    return panel.querySelector(':scope > .panel-heading') || panel.querySelector('.panel-heading');
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

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);

    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      ensureToggleExists();
      applyVisibility();
      applyNeedsAckMarkersFromData();
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

    ['pointerdown', 'mousedown', 'touchstart'].forEach((evt) => {
      btn.addEventListener(evt, swallowPointerStart, true);
    });

    btn.addEventListener('click', handleToggleClick, true);

    document.body.appendChild(btn);
    updateToggleText();
  }

  function getNeedsAckRoot() {
    return document.querySelector('[ts-ack-group="schedule.Groups.NeedAck"]');
  }

  function uniquePanels(nodes) {
    const seen = new Set();
    const result = [];

    for (const node of nodes) {
      if (!node || seen.has(node)) continue;
      seen.add(node);
      result.push(node);
    }

    return result;
  }

  function getGroupPanels() {
    const root = getNeedsAckRoot();
    if (!root) return [];

    return Array.from(root.querySelectorAll(':scope .panel-group > .panel')).filter((panel) => {
      const heading = getPanelHeading(panel);
      const title = heading?.querySelector('.panel-title');
      const hasGroupCount = !!title?.querySelector('.pull-right.ng-binding');
      const hasChildAge = !!heading?.querySelector('[ts-since="child.Ago"]');
      return hasGroupCount && !hasChildAge;
    });
  }

  function getChildAlertPanels() {
    const root = getNeedsAckRoot();
    if (!root) return [];

    const byHeading = Array.from(
      root.querySelectorAll('.panel-heading[ng-click="toggle()"]')
    )
      .filter((heading) => {
        return !!(
          heading.querySelector('[ts-since="child.Ago"]') ||
          heading.querySelector('[ng-bind="child.Subject || child.AlertKey"]')
        );
      })
      .map((heading) => heading.closest('.panel'));

    const byExplicitRepeat = Array.from(
      root.querySelectorAll('[ng-repeat="child in group.Children"]')
    ).map((node) => node.closest('.panel') || node);

    return uniquePanels([...byHeading, ...byExplicitRepeat]).filter(Boolean);
  }

  function getChildHeading(panel) {
    return panel.querySelector(':scope > .panel-heading') || panel.querySelector('.panel-heading');
  }

  function getPanelIdFromHeading(heading) {
    const idNode = heading?.querySelector('span[ng-show="state.Id"]');
    if (!idNode) return null;

    const match = idNode.textContent.match(/#(\d+)/);
    return match ? match[1] : null;
  }

  function getPanelSubjectFromHeading(heading) {
    const subjectNode = heading?.querySelector('[ng-bind="child.Subject || child.AlertKey"]');
    if (subjectNode?.textContent?.trim()) return subjectNode.textContent.trim();

    const idNode = heading?.querySelector('span[ng-show="state.Id"]');
    let cloneText = heading?.querySelector('.panel-title')?.textContent || heading?.textContent || '';
    if (idNode?.textContent) cloneText = cloneText.replace(idNode.textContent, '');

    const ageNode = heading?.querySelector('[ts-since="child.Ago"], .pull-right[ts-since]');
    if (ageNode?.textContent) cloneText = cloneText.replace(ageNode.textContent, '');

    return cloneText.replace(/\s+/g, ' ').trim() || null;
  }

  function getGroupSubjectFromPanel(groupPanel) {
    const title = getPanelHeading(groupPanel)?.querySelector('.panel-title');
    if (!title) return null;

    const clone = title.cloneNode(true);
    clone.querySelectorAll('.pull-right').forEach((n) => n.remove());
    clone.querySelectorAll('.fa').forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim() || null;
  }

  function hasNoteFromActions(actions) {
    if (!Array.isArray(actions)) return false;

    return actions.some((action) => {
      return action &&
        action.Type === 'Note' &&
        typeof action.Message === 'string' &&
        action.Message.trim().length > 0 &&
        action.Cancelled !== true;
    });
  }

  function isOlderThanThreshold(agoValue) {
    if (!agoValue) return false;
    const ts = Date.parse(agoValue);
    if (!Number.isFinite(ts)) return false;
    return (Date.now() - ts) >= OLD_NO_NOTE_MINUTES * 60 * 1000;
  }

  function rebuildAlertDataIndex(payload) {
    childProblemById.clear();
    childProblemBySubject.clear();
    groupProblemBySubject.clear();

    const groups = payload?.Groups?.NeedAck;
    if (!Array.isArray(groups)) return;

    for (const group of groups) {
      const groupSubject = typeof group?.Subject === 'string' ? group.Subject.trim() : '';
      let groupHasProblem = false;

      const children = Array.isArray(group?.Children) ? group.Children : [];
      for (const child of children) {
        const childId = child?.State?.Id != null ? String(child.State.Id) : null;
        const childSubject = typeof child?.Subject === 'string' && child.Subject.trim()
          ? child.Subject.trim()
          : (typeof child?.AlertKey === 'string' ? child.AlertKey.trim() : null);

        const oldEnough = isOlderThanThreshold(child?.Ago);
        const hasNote = hasNoteFromActions(child?.State?.Actions);
        const isProblem = oldEnough && !hasNote;

        if (childId) childProblemById.set(childId, isProblem);
        if (childSubject) childProblemBySubject.set(childSubject, isProblem);
        if (isProblem) groupHasProblem = true;
      }

      if (groupSubject) {
        groupProblemBySubject.set(groupSubject, groupHasProblem);
      }
    }
  }

  function ensureChildProblemIcon(panel, shouldShow) {
    const heading = getChildHeading(panel);
    const title = heading?.querySelector('.panel-title');
    if (!heading || !title) return;

    let icon = title.querySelector(`.${OLD_NO_NOTE_ICON_CLASS}:not(.bosun-parent-marker)`);

    if (!shouldShow) {
      panel.classList.remove(OLD_NO_NOTE_CLASS);
      if (icon) icon.remove();
      return;
    }

    panel.classList.add(OLD_NO_NOTE_CLASS);

    if (!icon) {
      icon = document.createElement('span');
      icon.className = `fa fa-exclamation-triangle ${OLD_NO_NOTE_ICON_CLASS}`;
      icon.title = `Older than ${OLD_NO_NOTE_MINUTES} minutes and has no Note`;
      title.insertBefore(icon, title.firstChild);
    }
  }

  function ensureParentProblemIcon(groupPanel, shouldShow) {
    const groupHeading = getPanelHeading(groupPanel);
    const groupTitle = groupHeading?.querySelector('.panel-title');
    if (!groupHeading || !groupTitle) return;

    let icon = groupTitle.querySelector(`.${OLD_NO_NOTE_ICON_CLASS}.bosun-parent-marker`);

    if (!shouldShow) {
      groupPanel.classList.remove(OLD_NO_NOTE_CLASS);
      if (icon) icon.remove();
      return;
    }

    groupPanel.classList.add(OLD_NO_NOTE_CLASS);

    if (!icon) {
      icon = document.createElement('span');
      icon.className = `fa fa-exclamation-triangle ${OLD_NO_NOTE_ICON_CLASS} bosun-parent-marker`;
      icon.title = `Contains alerts older than ${OLD_NO_NOTE_MINUTES} minutes without Note`;
      groupTitle.insertBefore(icon, groupTitle.firstChild);
    }
  }

  function resolveChildProblem(panel) {
    const heading = getChildHeading(panel);
    if (!heading) return false;

    const panelId = getPanelIdFromHeading(heading);
    if (panelId && childProblemById.has(panelId)) {
      return childProblemById.get(panelId) === true;
    }

    const subject = getPanelSubjectFromHeading(heading);
    if (subject && childProblemBySubject.has(subject)) {
      return childProblemBySubject.get(subject) === true;
    }

    return false;
  }

  function resolveGroupProblem(groupPanel) {
    const subject = getGroupSubjectFromPanel(groupPanel);
    if (subject && groupProblemBySubject.has(subject)) {
      return groupProblemBySubject.get(subject) === true;
    }
    return false;
  }

  function applyNeedsAckMarkersFromData() {
    const groupPanels = getGroupPanels();
    for (const groupPanel of groupPanels) {
      ensureParentProblemIcon(groupPanel, resolveGroupProblem(groupPanel));
    }

    const childPanels = getChildAlertPanels();
    for (const childPanel of childPanels) {
      ensureChildProblemIcon(childPanel, resolveChildProblem(childPanel));
    }
  }

  async function refreshAlertsData() {
    if (dataRefreshInFlight) return;
    dataRefreshInFlight = true;

    try {
      const resp = await fetch('/api/alerts?filter=', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          'Accept': 'application/json'
        },
        cache: 'no-store'
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const payload = await resp.json();
      rebuildAlertDataIndex(payload);
      applyNeedsAckMarkersFromData();
    } catch (err) {
      console.warn('[Bosun plugin] Failed to refresh alerts data:', err);
    } finally {
      dataRefreshInFlight = false;
    }
  }

  function startDataRefreshLoop() {
    if (dataRefreshTimer) return;

    refreshAlertsData();
    dataRefreshTimer = setInterval(() => {
      refreshAlertsData();
    }, DATA_REFRESH_MS);
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

      if (shouldRefresh) scheduleRefresh();
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
      applyNeedsAckMarkersFromData();
      startObserver();
      startDataRefreshLoop();

      setTimeout(() => {
        ensureToggleExists();
        applyVisibility();
        applyNeedsAckMarkersFromData();
      }, 1000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();