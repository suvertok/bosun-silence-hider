(() => {
  'use strict';

  const STORAGE_KEY = 'bosunShowSilenced';
  const HIDDEN_CLASS = 'bosun-silence-hidden';
  const TOGGLE_ID = 'bosun-silence-toggle';

  const OLD_NO_NOTE_CLASS = 'bosun-old-no-note';
  const OLD_NO_NOTE_ICON_CLASS = 'bosun-old-no-note-icon';
  const OLD_NO_NOTE_MINUTES = 8;

  const TOGGLE_TOP = '12px';
  const TOGGLE_RIGHT = '16px';

  let showSilenced = false;
  let refreshTimer = null;
  let observerStarted = false;
  let hiddenCount = 0;
  let warmupStarted = false;
  let warmupFinished = false;

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

      .${OLD_NO_NOTE_CLASS} > .panel-heading {
        box-shadow: inset 4px 0 0 #ff9800;
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      applyNeedsAckChildMarkers();
      applyNeedsAckParentMarkers();
      maybeStartWarmup();
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

  function getExpandedGroupPanels() {
    return getGroupPanels().filter((panel) => {
      return !!panel.querySelector(':scope > .panel-body.panel-group, :scope > .panel-body');
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

  function getChildBody(panel) {
    return panel.querySelector(':scope > .panel-body') || panel.querySelector('.panel-body');
  }

  function parseAgoToSeconds(text) {
    if (!text) return null;

    const normalized = text.replace(/\s+/g, '').trim().toLowerCase();

    let match = normalized.match(/^(\d+)s-?ago$/);
    if (match) return Number(match[1]);

    match = normalized.match(/^(\d+)m-?ago$/);
    if (match) return Number(match[1]) * 60;

    match = normalized.match(/^(\d+)h-?ago$/);
    if (match) return Number(match[1]) * 3600;

    match = normalized.match(/^(\d+)d-?ago$/);
    if (match) return Number(match[1]) * 86400;

    match = normalized.match(/^(\d+)h(\d+)m(\d+)s-?ago$/);
    if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);

    match = normalized.match(/^(\d+)m(\d+)s-?ago$/);
    if (match) return Number(match[1]) * 60 + Number(match[2]);

    match = normalized.match(/\((\d+)\s*s\s*ago\)/i);
    if (match) return Number(match[1]);

    match = normalized.match(/\((\d+)\s*m\s*ago\)/i);
    if (match) return Number(match[1]) * 60;

    match = normalized.match(/\((\d+)\s*h\s*ago\)/i);
    if (match) return Number(match[1]) * 3600;

    match = normalized.match(/\((\d+)\s*d\s*ago\)/i);
    if (match) return Number(match[1]) * 86400;

    match = normalized.match(/\((\d+)h(\d+)m(\d+)sago\)/i);
    if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);

    return null;
  }

  function getChildAgeSeconds(panel) {
    const heading = getChildHeading(panel);
    if (!heading) return null;

    const ageNode =
      heading.querySelector('[ts-since="child.Ago"]') ||
      heading.querySelector('[ts-since]') ||
      heading.querySelector('.pull-right[ts-since]');

    if (!ageNode) return null;

    return parseAgoToSeconds(ageNode.textContent);
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

  function getPanelKey(panel) {
    const heading = getChildHeading(panel);
    if (!heading) return null;

    const idNode = heading.querySelector('span[ng-show="state.Id"]');
    const subjectNode = heading.querySelector('[ng-bind="child.Subject || child.AlertKey"]');

    const idText = idNode?.textContent?.trim() || '';
    const subjectText = subjectNode?.textContent?.trim() || '';

    if (!idText && !subjectText) return null;
    return `${idText}__${subjectText}`;
  }

  function getCachedNoteState(panel) {
    const key = getPanelKey(panel);
    if (!key) return null;

    const attr = panel.dataset.bosunHasNote;
    if (attr === '1') return true;
    if (attr === '0') return false;
    return null;
  }

  function setCachedNoteState(panel, hasNote) {
    panel.dataset.bosunHasNote = hasNote ? '1' : '0';
  }

  function hasLastActionNote(panel) {
    const row = getLastActionRow(panel);
    if (!row) return getCachedNoteState(panel);

    const explicit = row.querySelector('span[ng-show="state.LastAction.Message"]:not(.ng-hide)');
    if (explicit && explicit.textContent.trim().replace(/^:\s*/, '')) {
      setCachedNoteState(panel, true);
      return true;
    }

    const allMessageNodes = row.querySelectorAll('span[ng-show="state.LastAction.Message"]');
    for (const node of allMessageNodes) {
      const text = node.textContent.trim().replace(/^:\s*/, '');
      if (text) {
        setCachedNoteState(panel, true);
        return true;
      }
    }

    setCachedNoteState(panel, false);
    return false;
  }

  function ensureOldNoNoteIcon(panel, shouldShow) {
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

  function applyNeedsAckChildMarkers() {
    const panels = getChildAlertPanels();

    panels.forEach((panel) => {
      const ageSeconds = getChildAgeSeconds(panel);
      const hasNote = hasLastActionNote(panel);

      const shouldShow =
        ageSeconds != null &&
        ageSeconds > OLD_NO_NOTE_MINUTES * 60 &&
        hasNote === false;

      ensureOldNoNoteIcon(panel, shouldShow);
    });
  }

  function findOwningGroupPanel(childPanel) {
    const root = getNeedsAckRoot();
    if (!root || !childPanel) return null;

    let current = childPanel.parentElement;
    let candidate = null;

    while (current && current !== root) {
      if (current.classList?.contains('panel')) {
        const hasGroupHeading =
          current.querySelector(':scope > .panel-heading .panel-title .pull-right.ng-binding') &&
          !current.querySelector(':scope > .panel-heading [ts-since="child.Ago"]');

        if (hasGroupHeading) {
          candidate = current;
        }
      }
      current = current.parentElement;
    }

    return candidate;
  }

  function getAllGroupPanels() {
    const childPanels = getChildAlertPanels();
    return uniquePanels([...getGroupPanels(), ...childPanels.map(findOwningGroupPanel)]).filter(Boolean);
  }

  function applyNeedsAckParentMarkers() {
    const groupPanels = getAllGroupPanels();

    groupPanels.forEach((groupPanel) => {
      const groupHeading =
        groupPanel.querySelector(':scope > .panel-heading') ||
        groupPanel.querySelector('.panel-heading');

      const groupTitle = groupHeading?.querySelector('.panel-title');
      if (!groupHeading || !groupTitle) return;

      const childPanels = getChildAlertPanels().filter((childPanel) => {
        return groupPanel.contains(childPanel) && childPanel !== groupPanel;
      });

      const hasProblemChild = childPanels.some((childPanel) => {
        const ageSeconds = getChildAgeSeconds(childPanel);
        const hasNote = hasLastActionNote(childPanel);

        return ageSeconds != null &&
               ageSeconds > OLD_NO_NOTE_MINUTES * 60 &&
               hasNote === false;
      });

      let icon = groupTitle.querySelector(`.${OLD_NO_NOTE_ICON_CLASS}.bosun-parent-marker`);

      if (!hasProblemChild) {
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
    });
  }

  async function warmupNeedsAckPanels() {
    if (warmupStarted || warmupFinished) return;
    warmupStarted = true;

    try {
      const groups = getGroupPanels();
      if (!groups.length) {
        warmupFinished = true;
        return;
      }

      const closedGroups = groups.filter((groupPanel) => {
        return !groupPanel.querySelector(':scope > .panel-body.panel-group, :scope > .panel-body');
      });

      if (!closedGroups.length) {
        warmupFinished = true;
        applyNeedsAckChildMarkers();
        applyNeedsAckParentMarkers();
        return;
      }

      const scrollX = window.scrollX;
      const scrollY = window.scrollY;

      for (const groupPanel of closedGroups) {
        const heading = getPanelHeading(groupPanel);
        if (!heading) continue;

        heading.click();
        await sleep(120);

        const childPanels = Array.from(
          groupPanel.querySelectorAll(':scope > .panel-body .panel')
        );

        for (const childPanel of childPanels) {
          const childHeading = getChildHeading(childPanel);
          if (!childHeading) continue;

          const cached = getCachedNoteState(childPanel);
          if (cached !== null) continue;

          childHeading.click();
          await sleep(80);

          hasLastActionNote(childPanel);

          childHeading.click();
          await sleep(30);
        }

        heading.click();
        await sleep(50);
      }

      window.scrollTo(scrollX, scrollY);

      warmupFinished = true;
      applyNeedsAckChildMarkers();
      applyNeedsAckParentMarkers();
    } catch (err) {
      console.warn('[Bosun plugin] warmup failed:', err);
    }
  }

  function maybeStartWarmup() {
    if (warmupStarted || warmupFinished) return;

    const root = getNeedsAckRoot();
    if (!root) return;

    const groups = getGroupPanels();
    if (!groups.length) return;

    warmupNeedsAckPanels();
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

      if (shouldRefresh) {
        scheduleRefresh();
      }
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
      applyNeedsAckChildMarkers();
      applyNeedsAckParentMarkers();
      startObserver();
      maybeStartWarmup();

      setTimeout(() => {
        ensureToggleExists();
        applyVisibility();
        applyNeedsAckChildMarkers();
        applyNeedsAckParentMarkers();
        maybeStartWarmup();
      }, 1000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();