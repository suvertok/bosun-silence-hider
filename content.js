(() => {
  'use strict';

  const STORAGE_KEY = 'bosunShowSilenced';
  const HIDDEN_CLASS = 'bosun-silence-hidden';
  const COPY_BUTTON_CLASS = 'bosun-copy-alert-btn';
  const TOGGLE_ID = 'bosun-silence-toggle';

  const OLD_NO_NOTE_ICON_CLASS = 'bosun-old-no-note-icon';
  const HAS_NOTE_ICON_CLASS = 'bosun-has-note-icon';

  const DATA_REFRESH_MS = 6000;
  const DATA_REFRESH_DEBOUNCE_MS = 250;

  // Оставил в духе твоей текущей ветки
  const OLD_NO_NOTE_MINUTES = 0

  const TOGGLE_TOP = '12px';
  const TOGGLE_RIGHT = '16px';

  let showSilenced = false;
  let refreshTimer = null;
  let observerStarted = false;
  let hiddenCount = 0;

  let dataRefreshInFlight = false;
  let dataRefreshTimer = null;
  let dataRefreshQueued = false;
  let dataRefreshDebounceTimer = null;

  // child maps
  const childOldNoNoteById = new Map();
  const childOldNoNoteBySubject = new Map();
  const childHasNoteById = new Map();
  const childHasNoteBySubject = new Map();

  // group maps
  const groupHasOldNoNoteBySubject = new Map();
  const groupHasAnyNoteBySubject = new Map();
  const lastResolvedParentStateBySubject = new Map();

  function injectStyles() {
    if (document.getElementById('bosun-silence-hider-styles')) return;

    const style = document.createElement('style');
    style.id = 'bosun-silence-hider-styles';
    style.textContent = `
      .${HIDDEN_CLASS} {
        display: none !important;
      }

      .${COPY_BUTTON_CLASS} {
        margin-left: 8px;
        padding: 1px 6px;
        border: 1px solid rgba(255,255,255,0.25);
        border-radius: 3px;
        background: rgba(255,255,255,0.08);
        color: inherit;
        font-size: 11px;
        line-height: 1.4;
        cursor: pointer;
        vertical-align: middle;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
        user-select: none;
      }

      .${COPY_BUTTON_CLASS}:hover {
        background: rgba(255,255,255,0.16);
      }

      .${COPY_BUTTON_CLASS}::selection {
        background: transparent;
      }

      .${COPY_BUTTON_CLASS}::-moz-selection {
        background: transparent;
      }

      .${COPY_BUTTON_CLASS}[data-copied="true"] {
        opacity: 0.85;
      }

      .${OLD_NO_NOTE_ICON_CLASS} {
        color: #ff9800 !important;
        margin-right: 6px;
        font-size: 14px;
        vertical-align: middle;
      }

      .${HAS_NOTE_ICON_CLASS} {
        color: #9ea19d !important;
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

  function getGroupSubjectNode(groupPanel) {
    return getPanelHeading(groupPanel)?.querySelector('[ng-bind="group.Subject"]') || null;
  }

  function getChildSubjectNode(childPanel) {
    return getChildHeading(childPanel)?.querySelector('[ng-bind="child.Subject || child.AlertKey"]') || null;
  }

  function getAlertTextFromPanel(panel) {
    const groupNode = getGroupSubjectNode(panel);
    if (groupNode) {
      return groupNode.textContent?.replace(/\s+/g, ' ').trim() || '';
    }

    const childNode = getChildSubjectNode(panel);
    if (childNode) {
      return childNode.textContent?.replace(/\s+/g, ' ').trim() || '';
    }

    return '';
  }

  async function copyTextToClipboard(text) {
    if (!text) return false;

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Fallback для окружений без navigator.clipboard
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (_) {
        return false;
      }
    }
  }

  function flashCopyButtonState(button, ok) {
    const originalText = button.textContent;
    button.textContent = ok ? 'Copied' : 'error';
    button.dataset.copied = ok ? 'true' : 'false';
    setTimeout(() => {
      button.textContent = originalText;
      delete button.dataset.copied;
    }, 2000);
  }

  function ensureCopyButton(panel) {
    const subjectNode = getGroupSubjectNode(panel) || getChildSubjectNode(panel);
    if (!subjectNode) return;

    if (subjectNode.parentElement?.querySelector(`.${COPY_BUTTON_CLASS}`)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = COPY_BUTTON_CLASS;
    btn.textContent = 'Copy';
    btn.title = 'Скопировать текст алерта';
    btn.setAttribute('unselectable', 'on');

    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const text = getAlertTextFromPanel(panel);
      const ok = await copyTextToClipboard(text);
      flashCopyButtonState(btn, ok);
    });

    subjectNode.insertAdjacentElement('afterend', btn);
  }

  function ensureCopyButtons() {
    getAcknowledgedPanels().forEach((panel) => ensureCopyButton(panel));
    getGroupPanels().forEach((panel) => ensureCopyButton(panel));
    getChildAlertPanels().forEach((panel) => ensureCopyButton(panel));
  }

  function getPanelHeading(panel) {
    return panel?.querySelector(':scope > .panel-heading') || panel?.querySelector('.panel-heading') || null;
  }

  function isSilencedPanel(panel) {
    const heading = getPanelHeading(panel);
    return !!heading?.querySelector('.fa-volume-off');
  }

  function getAcknowledgedRoot() {
    return document.querySelector('[ts-ack-group="schedule.Groups.Acknowledged"]');
  }

  function getAcknowledgedPanels() {
    const root = getAcknowledgedRoot();
    if (!root) return [];

    return Array.from(root.querySelectorAll('.panel-group > .panel'));
  }

  function applyVisibility() {
    const panels = getAcknowledgedPanels();
    let nextHiddenCount = 0;

    for (const panel of panels) {
      if (isSilencedPanel(panel) && !showSilenced) {
        panel.classList.add(HIDDEN_CLASS);
        nextHiddenCount++;
      } else {
        panel.classList.remove(HIDDEN_CLASS);
      }
    }

    // На всякий случай гарантируем, что в Needs Acknowledgement ничего не скрыто
    const needsAckRoot = getNeedsAckRoot();
    needsAckRoot?.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((panel) => {
      panel.classList.remove(HIDDEN_CLASS);
    });

    hiddenCount = nextHiddenCount;
    updateToggleText();
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);

    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      ensureToggleExists();
      applyVisibility();
      ensureCopyButtons();

      // Быстрый локальный repaint по текущим index maps,
      // но без удаления значков, если DOM ещё не устаканился.
      repaintNeedsAckMarkersFast();
    }, 120);
  }

  function scheduleAlertsDataRefresh() {
    if (dataRefreshDebounceTimer) clearTimeout(dataRefreshDebounceTimer);

    dataRefreshDebounceTimer = setTimeout(() => {
      dataRefreshDebounceTimer = null;
      refreshAlertsData();
    }, DATA_REFRESH_DEBOUNCE_MS);
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

    return Array.from(root.querySelectorAll('.panel-group > .panel')).filter((panel) => {
      const heading = getPanelHeading(panel);
      return !!heading?.querySelector('[ng-bind="group.Subject"]');
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

  function getChildHeading(panel) {
    return panel?.querySelector(':scope > .panel-heading') || panel?.querySelector('.panel-heading') || null;
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
    const subjectNode = getPanelHeading(groupPanel)?.querySelector('[ng-bind="group.Subject"]');
    return subjectNode?.textContent?.replace(/\s+/g, ' ').trim() || null;
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
    childOldNoNoteById.clear();
    childOldNoNoteBySubject.clear();
    childHasNoteById.clear();
    childHasNoteBySubject.clear();
    groupHasOldNoNoteBySubject.clear();
    groupHasAnyNoteBySubject.clear();

    const groups = payload?.Groups?.NeedAck;
    if (!Array.isArray(groups)) return;

    for (const group of groups) {
      const groupSubject = typeof group?.Subject === 'string' ? group.Subject.trim() : '';
      let groupHasOldNoNote = false;
      let groupHasAnyNote = false;

      const children = Array.isArray(group?.Children) ? group.Children : [];
      for (const child of children) {
        const childId = child?.State?.Id != null ? String(child.State.Id) : null;
        const childSubject =
          typeof child?.Subject === 'string' && child.Subject.trim()
            ? child.Subject.trim()
            : (typeof child?.AlertKey === 'string' ? child.AlertKey.trim() : null);

        const oldEnough = isOlderThanThreshold(child?.Ago);
        const hasNote = hasNoteFromActions(child?.State?.Actions);
        const oldNoNote = oldEnough && !hasNote;

        if (childId) {
          childOldNoNoteById.set(childId, oldNoNote);
          childHasNoteById.set(childId, hasNote);
        }
        if (childSubject) {
          childOldNoNoteBySubject.set(childSubject, oldNoNote);
          childHasNoteBySubject.set(childSubject, hasNote);
        }

        if (oldNoNote) groupHasOldNoNote = true;
        if (hasNote) groupHasAnyNote = true;
      }

      if (groupSubject) {
        const prevOld = groupHasOldNoNoteBySubject.get(groupSubject) === true;
        const prevNote = groupHasAnyNoteBySubject.get(groupSubject) === true;

        groupHasOldNoNoteBySubject.set(
          groupSubject,
          prevOld || groupHasOldNoNote
        );
        groupHasAnyNoteBySubject.set(groupSubject, prevNote || groupHasAnyNote);
      }
    }
  }

  function ensureStateIcon(title, type) {
    if (!title) return;

    const warnSelector = `.${OLD_NO_NOTE_ICON_CLASS}:not(.bosun-parent-marker)`;
    const noteSelector = `.${HAS_NOTE_ICON_CLASS}:not(.bosun-parent-marker)`;

    const warnIcon = title.querySelector(warnSelector);
    const noteIcon = title.querySelector(noteSelector);

    if (type === 'warning') {
      if (noteIcon) noteIcon.remove();
      if (!warnIcon) {
        const icon = document.createElement('span');
        icon.className = `fa fa-exclamation-triangle ${OLD_NO_NOTE_ICON_CLASS}`;
        icon.title = `Older than ${OLD_NO_NOTE_MINUTES} minutes and has no Note`;
        title.insertBefore(icon, title.firstChild);
      }
      return;
    }

    if (type === 'note') {
      if (warnIcon) warnIcon.remove();
      if (!noteIcon) {
        const icon = document.createElement('span');
        icon.className = `fa fa-comment ${HAS_NOTE_ICON_CLASS}`;
        icon.title = 'Contains Note';
        title.insertBefore(icon, title.firstChild);
      }
      return;
    }

    if (warnIcon) warnIcon.remove();
    if (noteIcon) noteIcon.remove();
  }

  function getExistingParentMarkerState(groupPanel) {
    const heading = getPanelHeading(groupPanel);
    const title = heading?.querySelector('.panel-title');
    if (!title) return 'none';

    if (title.querySelector(`.${OLD_NO_NOTE_ICON_CLASS}.bosun-parent-marker`)) {
      return 'warning';
    }
    if (title.querySelector(`.${HAS_NOTE_ICON_CLASS}.bosun-parent-marker`)) {
      return 'note';
    }

    return 'none';
  }

  function ensureChildStateIcon(panel, state) {
    const heading = getChildHeading(panel);
    const title = heading?.querySelector('.panel-title');
    ensureStateIcon(title, state);
  }

  function ensureParentStateIcon(groupPanel, state) {
    const heading = getPanelHeading(groupPanel);
    const title = heading?.querySelector('.panel-title');
    if (!title) return;

    const warnSelector = `.${OLD_NO_NOTE_ICON_CLASS}.bosun-parent-marker`;
    const noteSelector = `.${HAS_NOTE_ICON_CLASS}.bosun-parent-marker`;

    const warnIcon = title.querySelector(warnSelector);
    const noteIcon = title.querySelector(noteSelector);

    if (state === 'warning') {
      if (noteIcon) noteIcon.remove();
      if (!warnIcon) {
        const icon = document.createElement('span');
        icon.className = `fa fa-exclamation-triangle ${OLD_NO_NOTE_ICON_CLASS} bosun-parent-marker`;
        icon.title = `Contains alerts older than ${OLD_NO_NOTE_MINUTES} minutes without Note`;
        title.insertBefore(icon, title.firstChild);
      }
      return;
    }

    if (state === 'note') {
      if (warnIcon) warnIcon.remove();
      if (!noteIcon) {
        const icon = document.createElement('span');
        icon.className = `fa fa-comment ${HAS_NOTE_ICON_CLASS} bosun-parent-marker`;
        icon.title = 'Contains alerts with Note';
        title.insertBefore(icon, title.firstChild);
      }
      return;
    }

    if (warnIcon) warnIcon.remove();
    if (noteIcon) noteIcon.remove();
  }

  function resolveChildState(panel) {
    const heading = getChildHeading(panel);
    if (!heading) return 'none';

    const panelId = getPanelIdFromHeading(heading);
    const subject = getPanelSubjectFromHeading(heading);

    let oldNoNote = false;
    let hasNote = false;

    if (panelId) {
      if (childOldNoNoteById.has(panelId)) oldNoNote = childOldNoNoteById.get(panelId) === true;
      if (childHasNoteById.has(panelId)) hasNote = childHasNoteById.get(panelId) === true;
    }

    if (!oldNoNote && !hasNote && subject) {
      if (childOldNoNoteBySubject.has(subject)) oldNoNote = childOldNoNoteBySubject.get(subject) === true;
      if (childHasNoteBySubject.has(subject)) hasNote = childHasNoteBySubject.get(subject) === true;
    }

    if (oldNoNote) return 'warning';
    if (hasNote) return 'note';
    return 'none';
  }

  function resolveGroupStateFromDom(groupPanel) {
    if (!groupPanel) return 'none';

    const childPanels = Array.from(
      groupPanel.querySelectorAll('[ng-repeat="child in group.Children"]')
    )
      .map((node) => node.closest('.panel') || node)
      .filter(Boolean);

    let hasWarning = false;
    let hasNote = false;

    for (const childPanel of childPanels) {
      const state = resolveChildState(childPanel);
      if (state === 'warning') hasWarning = true;
      else if (state === 'note') hasNote = true;
    }

    if (hasWarning) return 'warning';
    if (hasNote) return 'note';

    const domHasWarning = !!groupPanel.querySelector(`.${OLD_NO_NOTE_ICON_CLASS}:not(.bosun-parent-marker)`);
    const domHasNote = !!groupPanel.querySelector(`.${HAS_NOTE_ICON_CLASS}:not(.bosun-parent-marker)`);

    if (domHasWarning) return 'warning';
    if (domHasNote) return 'note';

    return 'none';
  }

  function resolveGroupState(groupPanel) {
    const subject = getGroupSubjectFromPanel(groupPanel);

    const domState = resolveGroupStateFromDom(groupPanel);
    if (domState !== 'none') {
      if (subject) lastResolvedParentStateBySubject.set(subject, domState);
      return domState;
    }

    if (subject) {
      const hasOldNoNote = groupHasOldNoNoteBySubject.get(subject) === true;
      const hasAnyNote = groupHasAnyNoteBySubject.get(subject) === true;

      if (hasOldNoNote) {
        lastResolvedParentStateBySubject.set(subject, 'warning');
        return 'warning';
      }
      if (hasAnyNote) {
        lastResolvedParentStateBySubject.set(subject, 'note');
        return 'note';
      }

      const stickyState = lastResolvedParentStateBySubject.get(subject);
      if (stickyState === 'warning' || stickyState === 'note') {
        return stickyState;
      }
    }

    const existingState = getExistingParentMarkerState(groupPanel);
    if (existingState !== 'none') return existingState;

    return 'none';
  }

  function applyNeedsAckMarkersFromData(options = {}) {
    const preserveExistingOnNone = options.preserveExistingOnNone === true;

    const childPanels = getChildAlertPanels();
    for (const childPanel of childPanels) {
      const state = resolveChildState(childPanel);
      if (state !== 'none') {
        ensureChildStateIcon(childPanel, state);
      } else if (!preserveExistingOnNone) {
        ensureChildStateIcon(childPanel, 'none');
      }
    }

    const groupPanels = getGroupPanels();
    for (const groupPanel of groupPanels) {
      const state = resolveGroupState(groupPanel);
      if (state !== 'none') {
        ensureParentStateIcon(groupPanel, state);
      } else if (!preserveExistingOnNone) {
        ensureParentStateIcon(groupPanel, 'none');
      }
    }
  }

  function repaintNeedsAckMarkersFast() {
    applyNeedsAckMarkersFromData({ preserveExistingOnNone: true });
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
    if (dataRefreshInFlight) {
      dataRefreshQueued = true;
      return;
    }

    if (dataRefreshDebounceTimer) {
      clearTimeout(dataRefreshDebounceTimer);
      dataRefreshDebounceTimer = null;
    }

    if (dataRefreshInFlight) {
      dataRefreshQueued = true;
      return;
    }

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
      ensureCopyButtons();
    } catch (err) {
      console.warn('[Bosun plugin] Failed to refresh alerts data:', err);
    } finally {
      dataRefreshInFlight = false;

      if (dataRefreshQueued) {
        dataRefreshQueued = false;
        setTimeout(() => {
          refreshAlertsData();
        }, 50);
      }
    }
  }

  function startDataRefreshLoop() {
    if (dataRefreshTimer) return;

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
        if (target.classList?.contains(HAS_NOTE_ICON_CLASS) || target.closest?.(`.${HAS_NOTE_ICON_CLASS}`)) continue;

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
      ensureCopyButtons();
      startObserver();
      refreshAlertsData();
      startDataRefreshLoop();

      setTimeout(() => {
        ensureToggleExists();
        applyVisibility();
        ensureCopyButtons();
        refreshAlertsData();
      }, 1000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();