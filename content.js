(() => {
  'use strict';

  const STORAGE_KEY = 'bosunShowSilenced';
  const HIDDEN_CLASS = 'bosun-silence-hidden';
  const TOGGLE_ID = 'bosun-silence-toggle';

  const OLD_NO_NOTE_ICON_CLASS = 'bosun-old-no-note-icon';
  const DATA_REFRESH_MS = 60000;
  const DATA_REFRESH_DEBOUNCE_MS = 1200;
  const FORCE_REFRESH_MIN_INTERVAL_MS = 1500;

  // Оставил как в твоей текущей версии
  const OLD_NO_NOTE_MINUTES = 2;

  const TOGGLE_TOP = '12px';
  const TOGGLE_RIGHT = '16px';

  let showSilenced = false;
  let refreshTimer = null;
  let observerStarted = false;
  let hiddenCount = 0;

  let dataRefreshInFlight = false;
  let dataRefreshTimer = null;
  let dataRefreshDebounceTimer = null;
  let lastForcedRefreshAt = 0;

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
    return panel?.querySelector(':scope > .panel-heading') || panel?.querySelector('.panel-heading') || null;
  }

  function isSilencedPanel(panel) {
    const heading = getPanelHeading(panel);
    return !!heading?.querySelector('.fa-volume-off');
  }

  function getAlertPanels() {
    return Array.from(document.querySelectorAll('.panel'));
  }

  function applyVisibility() {
    const panels = getAlertPanels();
    let nextHiddenCount = 0;

    for (const panel of panels) {
      if (isSilencedPanel(panel) && !showSilenced) {
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

  function uniqueNodes(nodes) {
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

    const byHeading = Array.from(root.querySelectorAll('.panel-heading[ng-click="toggle()"]'))
      .filter((heading) => {
        return !!(
          heading.querySelector('[ts-since="child.Ago"]') ||
          heading.querySelector('[ng-bind="child.Subject || child.AlertKey"]')
        );
      })
      .map((heading) => heading.closest('.panel'));

    const byRepeat = Array.from(root.querySelectorAll('[ng-repeat="child in group.Children"]'))
      .map((node) => node.closest('.panel') || node);

    return uniqueNodes([...byHeading, ...byRepeat]).filter(Boolean);
  }

  function getVisibleChildPanelsForGroup(groupPanel) {
    if (!groupPanel) return [];

    return Array.from(groupPanel.querySelectorAll(':scope > .panel-body .panel')).filter((panel) => {
      const heading = getChildHeading(panel);
      return !!(
        heading &&
        (
          heading.querySelector('[ts-since="child.Ago"]') ||
          heading.querySelector('[ng-bind="child.Subject || child.AlertKey"]')
        )
      );
    });
  }

  function getChildHeading(panel) {
    return panel?.querySelector(':scope > .panel-heading') || panel?.querySelector('.panel-heading') || null;
  }

  function getChildBody(panel) {
    return panel?.querySelector(':scope > .panel-body') || panel?.querySelector('.panel-body') || null;
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
    let text = heading?.querySelector('.panel-title')?.textContent || heading?.textContent || '';

    if (idNode?.textContent) text = text.replace(idNode.textContent, '');

    const ageNode = heading?.querySelector('[ts-since="child.Ago"], .pull-right[ts-since]');
    if (ageNode?.textContent) text = text.replace(ageNode.textContent, '');

    return text.replace(/\s+/g, ' ').trim() || null;
  }

  function getGroupSubjectFromPanel(groupPanel) {
    const title = getPanelHeading(groupPanel)?.querySelector('.panel-title');
    if (!title) return null;

    const clone = title.cloneNode(true);
    clone.querySelectorAll('.pull-right').forEach((n) => n.remove());
    clone.querySelectorAll('.fa').forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim() || null;
  }

  function getLastActionRow(panel) {
    const body = getChildBody(panel);
    if (!body) return null;

    const rows = Array.from(body.querySelectorAll('.row'));
    return rows.find((row) => {
      const strong = row.querySelector('strong');
      return strong && strong.textContent.trim() === 'Last Action:';
    }) || null;
  }

  function hasVisibleNoteInDom(panel) {
    const row = getLastActionRow(panel);
    if (!row) return null;

    const explicit = row.querySelector('span[ng-show="state.LastAction.Message"]:not(.ng-hide)');
    if (explicit && explicit.textContent.trim().replace(/^:\s*/, '')) {
      return true;
    }

    const all = row.querySelectorAll('span[ng-show="state.LastAction.Message"]');
    for (const node of all) {
      const text = node.textContent.trim().replace(/^:\s*/, '');
      if (text) return true;
    }

    return false;
  }

  function scheduleAlertsDataRefresh(delay = DATA_REFRESH_DEBOUNCE_MS) {
    if (dataRefreshDebounceTimer) clearTimeout(dataRefreshDebounceTimer);

    dataRefreshDebounceTimer = setTimeout(() => {
      dataRefreshDebounceTimer = null;
      refreshAlertsData();
    }, delay);
  }

  function forceAlertsDataRefreshSoon(minIntervalMs = FORCE_REFRESH_MIN_INTERVAL_MS) {
    const now = Date.now();
    if (now - lastForcedRefreshAt < minIntervalMs) return;

    lastForcedRefreshAt = now;
    scheduleAlertsDataRefresh(150);
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
        const childSubject =
          typeof child?.Subject === 'string' && child.Subject.trim()
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
      if (icon) icon.remove();
      return;
    }

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
      if (icon) icon.remove();
      return;
    }

    if (!icon) {
      icon = document.createElement('span');
      icon.className = `fa fa-exclamation-triangle ${OLD_NO_NOTE_ICON_CLASS} bosun-parent-marker`;
      icon.title = `Contains alerts older than ${OLD_NO_NOTE_MINUTES} minutes without Note`;
      groupTitle.insertBefore(icon, groupTitle.firstChild);
    }
  }

  function findOwningGroupPanel(childPanel) {
    const root = getNeedsAckRoot();
    let current = childPanel?.parentElement || null;

    while (current && current !== root) {
      if (
        current.classList?.contains('panel') &&
        current.querySelector(':scope > .panel-heading .panel-title .pull-right.ng-binding') &&
        !current.querySelector(':scope > .panel-heading [ts-since="child.Ago"]')
      ) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }

  function syncCachesFromVisibleGroup(groupPanel) {
    const groupSubject = getGroupSubjectFromPanel(groupPanel);
    if (!groupSubject) return;

    const visibleChildPanels = getVisibleChildPanelsForGroup(groupPanel);
    if (visibleChildPanels.length === 0) return;

    let hasAnyKnown = false;
    let hasAnyProblem = false;

    for (const childPanel of visibleChildPanels) {
      const heading = getChildHeading(childPanel);
      if (!heading) continue;

      const panelId = getPanelIdFromHeading(heading);
      const childSubject = getPanelSubjectFromHeading(heading);
      const domNote = hasVisibleNoteInDom(childPanel);

      if (domNote === true) {
        hasAnyKnown = true;
        if (panelId) childProblemById.set(panelId, false);
        if (childSubject) childProblemBySubject.set(childSubject, false);
        continue;
      }

      let known = false;
      let isProblem = false;

      if (panelId && childProblemById.has(panelId)) {
        known = true;
        isProblem = childProblemById.get(panelId) === true;
      } else if (childSubject && childProblemBySubject.has(childSubject)) {
        known = true;
        isProblem = childProblemBySubject.get(childSubject) === true;
      }

      if (known) {
        hasAnyKnown = true;
        if (isProblem) hasAnyProblem = true;
      }
    }

    if (hasAnyKnown && !hasAnyProblem) {
      groupProblemBySubject.set(groupSubject, false);
      return;
    }

    if (hasAnyProblem) {
      groupProblemBySubject.set(groupSubject, true);
    }
  }

  function resolveChildProblem(panel) {
    const domNote = hasVisibleNoteInDom(panel);

    if (domNote === true) {
      const heading = getChildHeading(panel);
      const panelId = getPanelIdFromHeading(heading);
      const subject = getPanelSubjectFromHeading(heading);

      if (panelId) childProblemById.set(panelId, false);
      if (subject) childProblemBySubject.set(subject, false);

      const groupPanel = findOwningGroupPanel(panel);
      if (groupPanel) {
        syncCachesFromVisibleGroup(groupPanel);
      }

      forceAlertsDataRefreshSoon();
      return false;
    }

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
    const cachedGroupProblem =
      subject && groupProblemBySubject.has(subject)
        ? groupProblemBySubject.get(subject) === true
        : false;

    const visibleChildPanels = getVisibleChildPanelsForGroup(groupPanel);

    if (visibleChildPanels.length === 0) {
      return cachedGroupProblem;
    }

    let hasUnknownChildren = false;
    let hasProblemChildren = false;
    let hasAnyChildrenState = false;

    for (const childPanel of visibleChildPanels) {
      const domNote = hasVisibleNoteInDom(childPanel);

      if (domNote === true) {
        hasAnyChildrenState = true;
        continue;
      }

      const heading = getChildHeading(childPanel);
      if (!heading) {
        hasUnknownChildren = true;
        continue;
      }

      const panelId = getPanelIdFromHeading(heading);
      const childSubject = getPanelSubjectFromHeading(heading);

      if (panelId && childProblemById.has(panelId)) {
        hasAnyChildrenState = true;
        if (childProblemById.get(panelId) === true) {
          hasProblemChildren = true;
        }
        continue;
      }

      if (childSubject && childProblemBySubject.has(childSubject)) {
        hasAnyChildrenState = true;
        if (childProblemBySubject.get(childSubject) === true) {
          hasProblemChildren = true;
        }
        continue;
      }

      hasUnknownChildren = true;
    }

    if (hasProblemChildren) {
      if (subject) groupProblemBySubject.set(subject, true);
      return true;
    }

    if (hasAnyChildrenState && !hasUnknownChildren) {
      if (subject) groupProblemBySubject.set(subject, false);
      return false;
    }

    return cachedGroupProblem;
  }

  function applyNeedsAckMarkersFromData() {
    const childPanels = getChildAlertPanels();

    for (const childPanel of childPanels) {
      ensureChildProblemIcon(childPanel, resolveChildProblem(childPanel));
    }

    const groupPanels = getGroupPanels();
    for (const groupPanel of groupPanels) {
      syncCachesFromVisibleGroup(groupPanel);
      ensureParentProblemIcon(groupPanel, resolveGroupProblem(groupPanel));
    }
  }

  async function fetchAlertsDataViaFetch() {
    const resp = await fetch('/api/alerts?filter=', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    return resp.json();
  }

  function fetchAlertsDataViaXHR() {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/alerts?filter=', true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Accept', 'application/json');

      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`HTTP ${xhr.status}`));
          return;
        }

        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (err) {
          reject(err);
        }
      };

      xhr.onerror = function () {
        reject(new Error('XMLHttpRequest network error'));
      };

      xhr.send();
    });
  }

  async function refreshAlertsData() {
    if (dataRefreshInFlight) return;
    dataRefreshInFlight = true;

    try {
      let payload;
      try {
        payload = await fetchAlertsDataViaFetch();
      } catch (_) {
        payload = await fetchAlertsDataViaXHR();
      }

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
      let shouldRefreshUi = false;
      let shouldRefreshData = false;
      const needsAckRoot = getNeedsAckRoot();

      for (const mutation of mutations) {
        const target = mutation.target && mutation.target.nodeType === 1
          ? mutation.target
          : mutation.target?.parentElement;

        if (!target) continue;
        if (target.id === TOGGLE_ID || target.closest?.(`#${TOGGLE_ID}`)) continue;
        if (target.classList?.contains(OLD_NO_NOTE_ICON_CLASS) || target.closest?.(`.${OLD_NO_NOTE_ICON_CLASS}`)) continue;

        shouldRefreshUi = true;

        if (needsAckRoot && (needsAckRoot.contains(target) || target === needsAckRoot)) {
          shouldRefreshData = true;
        }
      }

      if (shouldRefreshUi) {
        scheduleRefresh();
      }

      if (shouldRefreshData) {
        scheduleAlertsDataRefresh();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
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