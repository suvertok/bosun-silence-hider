(() => {
  'use strict';

  const STORAGE_KEY = 'bosunShowSilenced';
  const AUTO_REFRESH_ENABLED_KEY = 'bosunAutoRefreshEnabled';
  const AUTO_REFRESH_IDLE_SECONDS_KEY = 'bosunAutoRefreshIdleSeconds';
  const HIDDEN_CLASS = 'bosun-silence-hidden';
  const TOP_BAR_ID = 'bosun-top-controls-bar';
  const TOGGLE_ID = 'bosun-silence-toggle';
  const TOGGLE_COUNTER_ID = 'bosun-silence-toggle-counter';
  const AUTO_REFRESH_TOGGLE_ID = 'bosun-auto-refresh-toggle';
  const AUTO_REFRESH_INPUT_ID = 'bosun-auto-refresh-idle-seconds';
  const AUTO_REFRESH_COUNTDOWN_ID = 'bosun-auto-refresh-countdown';
  const SOUND_ALERTS_ENABLED_KEY = 'bosunSoundAlertsEnabled';
  const SOUND_ALERTS_TOGGLE_ID = 'bosun-sound-alerts-toggle';
  const SOUND_TEST_BUTTON_ID = 'bosun-sound-test-button';
  const DIAGNOSTICS_ENABLED_KEY = 'bosunDiagnosticsEnabled';
  const DIAGNOSTICS_TOGGLE_ID = 'bosun-diagnostics-toggle';
  const DIAGNOSTICS_OPEN_BUTTON_ID = 'bosun-diagnostics-open-button';
  const DIAGNOSTICS_MODAL_ID = 'bosun-diagnostics-modal';
  const DIAGNOSTICS_LOG_LIST_ID = 'bosun-diagnostics-log-list';
  const DIAGNOSTICS_LOG_STORAGE_KEY = 'bosunDiagnosticsLogV1';
  const NEED_ACK_SOUND_BASELINE_SESSION_KEY = 'bosunNeedAckSoundBaselineV1';
  const SOUND_FILE_ALERT = 'bosun_notification_alert_chime.wav';
  const SOUND_FILE_SOFT = 'bosun_notification_soft_chime.wav';
  const COPY_BUTTON_CLASS = 'bosun-copy-alert-btn';
  const COPY_ALL_BUTTON_CLASS = 'bosun-copy-all-alerts-btn';
  const NO_SELECT_CLASS = 'bosun-no-select';
  const SILENCED_BADGE_CLASS = 'bosun-silenced-badge';

  /**
   * Показывать ли в тулбаре блок «Диагностика» (чекбокс, кнопки «Открыть лог» / модалка журнала).
   * Сейчас выключено: в обычной работе UI отладки не нужен.
   *
   * Как включить снова:
   * — поставьте значение true ниже;
   * — перезагрузите расширение в chrome://extensions (кнопка «Обновить» у пакета).
   *
   * Запись в chrome.storage и внутренний diagnosticsApi при этом остаются; при скрытом UI
   * переключатель недоступен, но флаг из storage всё ещё читается при старте.
   */
  const DIAGNOSTICS_TOOLBAR_UI_ENABLED = false;

  let bosunSelectionDragState = null;

  const OLD_NO_NOTE_ICON_CLASS = 'bosun-old-no-note-icon';
  const HAS_NOTE_ICON_CLASS = 'bosun-has-note-icon';

  const DATA_REFRESH_MS = 6000;
  const DATA_REFRESH_DEBOUNCE_MS = 250;
  const OLD_NO_NOTE_MINUTES = 0
  const AUTO_REFRESH_DEFAULT_IDLE_SECONDS = 60;
  const AUTO_REFRESH_MIN_IDLE_SECONDS = 10;
  const AUTO_REFRESH_MAX_IDLE_SECONDS = 3600;
  const AUTO_REFRESH_FORCE_REENABLE_MS = 10 * 60 * 1000;

  let showSilenced = false;
  let refreshTimer = null;
  let observerStarted = false;
  let hiddenCount = 0;

  let dataRefreshInFlight = false;
  let dataRefreshTimer = null;
  let dataRefreshQueued = false;
  let dataRefreshDebounceTimer = null;
  let autoRefreshEnabled = true;
  let autoRefreshIdleSeconds = AUTO_REFRESH_DEFAULT_IDLE_SECONDS;
  let autoRefreshTimer = null;
  let autoRefreshReEnableTimer = null;
  let lastUserActivityTs = Date.now();
  let lastKnownUrl = window.location.href;
  let topBarMountObserver = null;
  let soundAlertsEnabled = true;
  let diagnosticsEnabled = false;
  const DIAGNOSTICS_LOG_MAX_ENTRIES = 750;

  // child maps
  const childOldNoNoteById = new Map();
  const childOldNoNoteByKey = new Map();
  const childHasNoteById = new Map();
  const childHasNoteByKey = new Map();

  // group maps
  const groupHasOldNoNoteByKey = new Map();
  const groupHasAnyNoteByKey = new Map();
  const groupHasOldNoNoteBySubject = new Map();
  const groupHasAnyNoteBySubject = new Map();
  const lastResolvedParentStateByKey = new Map();
  const sharedUtils = globalThis.BosunSilenceHiderSharedUtils || null;
  const diagnosticsApi = globalThis.BosunSilenceHiderDiagnostics?.createDiagnostics?.({
    modalId: DIAGNOSTICS_MODAL_ID,
    logListId: DIAGNOSTICS_LOG_LIST_ID,
    logStorageKey: DIAGNOSTICS_LOG_STORAGE_KEY,
    maxEntries: DIAGNOSTICS_LOG_MAX_ENTRIES,
    getEnabled: () => diagnosticsEnabled
  }) || null;
  const soundApi = globalThis.BosunSilenceHiderSound?.createSound?.({
    alertFile: SOUND_FILE_ALERT,
    softFile: SOUND_FILE_SOFT,
    getEnabled: () => soundAlertsEnabled,
    reportDiagnostics: (eventName, details = '') => reportDiagnostics(eventName, details)
  }) || null;
  const alertsDataApi = globalThis.BosunSilenceHiderAlertsData?.createAlertsData?.({
    oldNoNoteMinutes: OLD_NO_NOTE_MINUTES
  }) || null;
  const needAckSeverityApi = globalThis.BosunSilenceHiderNeedAckSeverity?.createNeedAckSeverity?.({
    normalizeNeedAckChildren: (raw) => {
      if (sharedUtils?.normalizeNeedAckChildren) {
        return sharedUtils.normalizeNeedAckChildren(raw);
      }
      if (raw == null) return [];
      if (Array.isArray(raw)) return raw;
      return [raw];
    }
  }) || null;
  const needAckBaselineApi = globalThis.BosunSilenceHiderNeedAckBaseline?.createNeedAckBaseline?.({
    sessionKey: NEED_ACK_SOUND_BASELINE_SESSION_KEY,
    isSoundEnabled: () => soundAlertsEnabled,
    reportDiagnostics: (eventName, details = '') => reportDiagnostics(eventName, details),
    playNeedAckChime: (kind) => soundApi?.playNeedAckChime?.(kind),
    collectCurrentIdsAndSeverity: (payload) =>
      needAckSeverityApi?.collectCurrentIdsAndSeverity?.(payload) ?? {
        currentIds: new Set(),
        idToSeverity: new Map()
      }
  }) || null;

  if (!soundApi || !needAckBaselineApi || !needAckSeverityApi || !alertsDataApi) {
    console.warn(
      '[Bosun plugin] One or more extension modules failed to load; sound, NeedAck baseline, severity, or alerts index may be disabled.',
      {
        soundApi: Boolean(soundApi),
        needAckBaselineApi: Boolean(needAckBaselineApi),
        needAckSeverityApi: Boolean(needAckSeverityApi),
        alertsDataApi: Boolean(alertsDataApi)
      }
    );
  }

  function isActionPage() {
    return window.location.pathname === '/action';
  }

  /** Только дашборд: автоперезагрузка по простою не трогает /action и др. */
  function isDashboardHome() {
    return window.location.pathname === '/';
  }

  function uncheckActionNotificationCheckbox() {
    if (!isActionPage()) return;

    const notifyInputs = document.querySelectorAll(
      'input[type="checkbox"][ng-model], input[type="checkbox"][data-ng-model], input[type="checkbox"][x-ng-model]'
    );
    notifyInputs.forEach((input) => {
      const model =
        input.getAttribute('ng-model') ||
        input.getAttribute('data-ng-model') ||
        input.getAttribute('x-ng-model') ||
        '';

      if (!/notify/i.test(model) || !input.checked) return;

      // Для Angular-наблюдателей надежнее вызвать нативный click,
      // чтобы framework корректно обновил модель.
      input.click();

      // Fallback: если после click состояние не изменилось, принудительно снимаем чекбокс.
      if (!input.checked) return;

      input.checked = false;
      input.removeAttribute('checked');

      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function applyActionPageTweaks() {
    if (!isActionPage()) return;
    uncheckActionNotificationCheckbox();
  }

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
        border: 1px solid rgba(194, 180, 180, 0.85);
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        color: inherit;
        font-size: 11px;
        line-height: 1.4;
        cursor: pointer;
        vertical-align: middle;
        box-shadow: 0 0 0 1px rgba(155, 143, 143, 0.6) inset;
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

      .${COPY_ALL_BUTTON_CLASS} {
        margin-left: 8px;
        margin-right: 8px;
        padding: 1px 6px;
        border: 1px solid rgba(194, 180, 180, 0.85);
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        color: inherit;
        font-size: 11px;
        line-height: 1.4;
        cursor: pointer;
        vertical-align: middle;
        float: right;
        box-shadow: 0 0 0 1px rgba(155, 143, 143, 0.6) inset;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
        user-select: none;
      }

      .${COPY_ALL_BUTTON_CLASS}:hover {
        background: rgba(255,255,255,0.16);
      }

      .${COPY_ALL_BUTTON_CLASS}::selection {
        background: transparent;
      }

      .${COPY_ALL_BUTTON_CLASS}::-moz-selection {
        background: transparent;
      }

      .${COPY_ALL_BUTTON_CLASS}[data-copied="true"] {
        opacity: 0.85;
      }

      .${NO_SELECT_CLASS} {
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
        user-select: none;
      }

      .${NO_SELECT_CLASS}::selection {
        background: transparent;
      }

      .${NO_SELECT_CLASS}::-moz-selection {
        background: transparent;
      }

      .${SILENCED_BADGE_CLASS} {
        display: inline-block;
        margin-left: 6px;
        padding: 0 6px;
        border: 1px solid rgba(35, 95, 207, 0.55);
        border-radius: 999px;
        font-size: 10px;
        line-height: 1.5;
        vertical-align: middle;
        color:rgb(46, 113, 201);
        background: rgba(255, 193, 7, 0.10);
        box-shadow: 0 0 0 1px rgba(255, 193, 7, 0.12) inset;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
        user-select: none;
        pointer-events: none;
      }

      .${SILENCED_BADGE_CLASS}::selection {
        background: transparent;
      }

      .${SILENCED_BADGE_CLASS}::-moz-selection {
        background: transparent;
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

      /* Центр шапки: абсолютное позиционирование внутри #navbar-collapse */
      .navbar.navbar-default .navbar-collapse {
        position: relative;
      }

      /* Бренд слева должен быть выше тулбара по z-index — иначе мышь попадает в «дырку»
         pointer-events и зона клика не совпадает с текстом ссылки */
      .navbar.navbar-default .navbar-header {
        position: relative;
        z-index: 12;
      }

      .navbar.navbar-default .navbar-brand {
        position: relative;
        z-index: 13;
      }

      div#${TOP_BAR_ID}.bosun-toolbar-navbar-center {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 2;
        box-sizing: border-box;
        margin: 0;
        padding: 0;
        max-width: calc(100% - 32px);
        pointer-events: none;
      }

      /* Иначе широкий flex-блок перехватывает клики по бренду слева */
      div#${TOP_BAR_ID}.bosun-toolbar-navbar-center .bosun-top-controls-inner,
      div#${TOP_BAR_ID}.bosun-toolbar-navbar-center .bosun-top-controls-actions {
        pointer-events: none;
      }

      div#${TOP_BAR_ID}.bosun-toolbar-navbar-center label,
      div#${TOP_BAR_ID}.bosun-toolbar-navbar-center button,
      div#${TOP_BAR_ID}.bosun-toolbar-navbar-center input,
      div#${TOP_BAR_ID}.bosun-toolbar-navbar-center #${AUTO_REFRESH_COUNTDOWN_ID} {
        pointer-events: auto;
      }

      div#${TOP_BAR_ID}.bosun-toolbar-fallback {
        width: 95%;
        margin: 0 auto 14px auto;
        padding: 0;
        box-sizing: border-box;
        min-height: 60px;
      }

      #${TOP_BAR_ID} .bosun-top-controls-inner {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        box-sizing: border-box;
        font-family: Arial, sans-serif;
        font-size: 12px;
        line-height: 1.4;
      }

      div#${TOP_BAR_ID}.bosun-toolbar-navbar-center .bosun-top-controls-inner {
        padding: 0 8px;
        margin: 0;
        background: transparent;
        border: none;
        border-radius: 0;
        box-shadow: none;
        min-height: auto;
      }

      div#${TOP_BAR_ID}.bosun-toolbar-fallback .bosun-top-controls-inner {
        min-height: 42px;
        padding: 8px 12px;
        gap: 12px;
        justify-content: space-between;
        background: #f8f8f8;
        border: 1px solid #ddd;
        border-radius: 4px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.15);
      }

      div#${TOP_BAR_ID}.bosun-toolbar-fallback .bosun-top-controls-title {
        color: #555;
        font-size: 12px;
        line-height: 1.4;
        font-weight: 600;
        letter-spacing: 0.2px;
        text-transform: uppercase;
        white-space: nowrap;
      }

      #${TOP_BAR_ID} .bosun-top-controls-actions {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      #${TOP_BAR_ID} .bosun-diagnostics-group {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
        padding-left: 10px;
        border-left: 1px solid #d8d8d8;
      }

      #${TOP_BAR_ID} .bosun-auto-refresh-group {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-left: 4px;
        margin-right: 8px;
        padding-left: 12px;
        padding-right: 12px;
        border-left: 1px solid rgba(0, 0, 0, 0.12);
        border-right: 1px solid rgba(0, 0, 0, 0.18);
      }

      #${TOP_BAR_ID} .bosun-auto-refresh-label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 30px;
        margin: 0;
        color: #333;
        font-weight: 500;
      }

      #${AUTO_REFRESH_TOGGLE_ID} {
        width: 14px;
        height: 14px;
        margin: 0;
        vertical-align: middle;
      }

      #${SOUND_ALERTS_TOGGLE_ID} {
        width: 14px;
        height: 14px;
        margin: 0;
        vertical-align: middle;
      }

      #${SOUND_TEST_BUTTON_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 30px;
        padding: 4px 10px;
        border: 1px solid #ccc;
        border-radius: 4px;
        background: #fff;
        color: #333;
        font-size: 12px;
        line-height: 1.2;
        cursor: pointer;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.15);
      }

      #${SOUND_TEST_BUTTON_ID}:hover {
        background: #f5f5f5;
        border-color: #adadad;
      }

      #${DIAGNOSTICS_TOGGLE_ID} {
        width: 14px;
        height: 14px;
        margin: 0;
        vertical-align: middle;
      }

      #${DIAGNOSTICS_OPEN_BUTTON_ID} {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        padding: 4px 10px;
        border: 1px solid #ccc;
        border-radius: 4px;
        background: #fff;
        color: #333;
        font-size: 12px;
        line-height: 1.2;
        cursor: pointer;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.15);
      }

      #${DIAGNOSTICS_OPEN_BUTTON_ID}:hover {
        background: #f5f5f5;
        border-color: #adadad;
      }

      #${DIAGNOSTICS_MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.45);
      }

      #${DIAGNOSTICS_MODAL_ID}.is-open {
        display: flex;
      }

      #${DIAGNOSTICS_MODAL_ID} .bosun-diagnostics-modal-card {
        width: min(920px, calc(100vw - 32px));
        max-height: calc(100vh - 48px);
        display: flex;
        flex-direction: column;
        border-radius: 8px;
        border: 1px solid #d6d6d6;
        background: #fff;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
      }

      #${DIAGNOSTICS_MODAL_ID} .bosun-diagnostics-modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #ececec;
        font-size: 13px;
      }

      #${DIAGNOSTICS_MODAL_ID} .bosun-diagnostics-modal-actions {
        display: inline-flex;
        gap: 8px;
      }

      #${DIAGNOSTICS_MODAL_ID} .bosun-diagnostics-modal-actions button {
        border: 1px solid #ccc;
        border-radius: 4px;
        background: #fff;
        color: #333;
        font-size: 12px;
        padding: 3px 10px;
      }

      #${DIAGNOSTICS_MODAL_ID} .bosun-diagnostics-modal-actions button:hover {
        background: #f5f5f5;
        border-color: #adadad;
      }

      #${DIAGNOSTICS_MODAL_ID} .bosun-diagnostics-modal-body {
        padding: 0;
        overflow: auto;
      }

      #${DIAGNOSTICS_LOG_LIST_ID} {
        margin: 0;
        padding: 8px 10px;
        list-style: none;
        font-family: Consolas, "Courier New", monospace;
        font-size: 12px;
        line-height: 1.45;
      }

      #${DIAGNOSTICS_LOG_LIST_ID} li {
        padding: 4px 6px;
        border-radius: 4px;
        white-space: pre-wrap;
        word-break: break-word;
      }

      #${DIAGNOSTICS_LOG_LIST_ID} li:nth-child(odd) {
        background: #fafafa;
      }

      #${TOP_BAR_ID} .bosun-auto-refresh-seconds {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        color: #555;
      }

      #${AUTO_REFRESH_INPUT_ID} {
        width: 72px;
        height: 30px;
        padding: 4px 6px;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.4;
      }

      #${AUTO_REFRESH_COUNTDOWN_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 46px;
        height: 30px;
        padding: 0 10px;
        border: 1px solid #d0d0d0;
        border-radius: 999px;
        background: #fff;
        color: #666;
        font-weight: 600;
      }

      #${TOGGLE_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 170px;
        min-height: 30px;
        padding: 4px 12px;
        border: 1px solid #ccc;
        border-radius: 4px;
        background: #fff;
        color: #333;
        font-size: 12px;
        line-height: 1.4;
        font-weight: 400;
        cursor: pointer;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.15);
        user-select: none;
        -webkit-user-select: none;
      }

      #${TOGGLE_ID}:hover {
        background: #f5f5f5;
        border-color: #adadad;
      }

      #${TOGGLE_ID}:focus {
        outline: none;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.15), 0 0 0 2px rgba(102,175,233,.35);
      }

      #${TOGGLE_ID}.is-active {
        background: #e6e6e6;
        border-color: #adadad;
      }

      #${TOGGLE_COUNTER_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 28px;
        height: 30px;
        padding: 0 10px;
        border-radius: 15px;
        background: #337ab7;
        color: #fff;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.4;
        user-select: none;
        -webkit-user-select: none;
      }

      #${TOGGLE_ID} .bosun-silence-label {
        display: inline-block;
        width: 100%;
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

  function getPanelTitle(panel) {
    return getPanelHeading(panel)?.querySelector('.panel-title') || null;
  }

  function isGroupPanel(panel) {
    return !!getGroupSubjectNode(panel);
  }

  function getGroupCountNode(groupPanel) {
    return getPanelTitle(groupPanel)?.querySelector('.pull-right.ng-binding') || null;
  }

  function parseGroupAlertCount(groupPanel) {
    const countNode = getGroupCountNode(groupPanel);
    const text = countNode?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const match = text.match(/^(\d+)\s+alerts?$/i);
    return match ? Number(match[1]) : 0;
  }

  function getExpandedChildPanelsForGroup(groupPanel) {
    if (!groupPanel) return [];

    return Array.from(
      groupPanel.querySelectorAll('[ng-bind="child.Subject || child.AlertKey"]')
    );
  }

  function getChildAlertText(nodeOrPanel) {
    const node =
      nodeOrPanel?.getAttribute?.('ng-bind') === 'child.Subject || child.AlertKey'
        ? nodeOrPanel
        : getChildSubjectNode(nodeOrPanel);

    return node?.textContent?.replace(/\s+/g, ' ').trim() || '';
  }

  function getAllChildAlertTextsForGroup(groupPanel) {
    const childNodes = getExpandedChildPanelsForGroup(groupPanel);
    if (!childNodes.length) return [];

    return childNodes
      .map((node) => getChildAlertText(node))
      .filter(Boolean);
  }

  function markNoSelectElements() {
    document
      .querySelectorAll('.panel-title > a > span.pull-right.ng-binding')
      .forEach((el) => el.classList.add(NO_SELECT_CLASS));

    document
      .querySelectorAll('.panel-title > span.pull-right[ts-since="child.Ago"]')
      .forEach((el) => el.classList.add(NO_SELECT_CLASS));

    document
      .querySelectorAll('.panel-title > span[ng-show="state.Id"], .panel-title > span.ng-binding')
      .forEach((el) => {
        if (/^#\d+:$/.test((el.textContent || '').trim())) {
          el.classList.add(NO_SELECT_CLASS);
        }
      });
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

  function flashCopyButtonState(button, ok, errorText = 'error') {
    const originalText = button.textContent;
    button.textContent = ok ? 'copied' : errorText;
    button.dataset.copied = ok ? 'true' : 'false';
    setTimeout(() => {
      button.textContent = originalText;
      delete button.dataset.copied;
    }, ok ? 1200 : 2500);
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

  function ensureCopyAllButton(panel) {
    if (!isGroupPanel(panel)) return;

    const title = getPanelTitle(panel);
    const countNode = getGroupCountNode(panel);
    if (!title || !countNode) return;

    const totalCount = parseGroupAlertCount(panel);
    const shouldShow = totalCount >= 2;

    const existing = title.querySelector(`.${COPY_ALL_BUTTON_CLASS}`);
    if (!shouldShow) {
      existing?.remove();
      return;
    }

    if (existing) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = COPY_ALL_BUTTON_CLASS;
    btn.textContent = 'Copy all';
    btn.title = 'Скопировать все вложенные алерты';
    btn.setAttribute('unselectable', 'on');

    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const texts = getAllChildAlertTextsForGroup(panel);
      const payload = texts.join('\n');
      const ok = payload ? await copyTextToClipboard(payload) : false;
      flashCopyButtonState(btn, ok, 'Внимание! Сначала раскрой и проверь!');
    });

    countNode.insertAdjacentElement('afterend', btn);
  }

  function ensureCopyButtons() {
    getAcknowledgedPanels().forEach((panel) => {
      ensureCopyButton(panel);
      ensureCopyAllButton(panel);
    });

    getGroupPanels().forEach((panel) => {
      ensureCopyButton(panel);
      ensureCopyAllButton(panel);
    });

    getChildAlertPanels().forEach((panel) => ensureCopyButton(panel));
  }

  function getPanelHeading(panel) {
    return panel?.querySelector(':scope > .panel-heading') || panel?.querySelector('.panel-heading') || null;
  }

  function installSelectionGuard() {
    if (window.__bosunSelectionGuardInstalled) return;
    window.__bosunSelectionGuardInstalled = true;

    document.addEventListener(
      'mousedown',
      (event) => {
        const heading = event.target?.closest?.('.panel-heading');
        if (!heading) return;

        bosunSelectionDragState = {
          x: event.clientX,
          y: event.clientY,
          moved: false,
          heading,
        };
      },
      true
    );

    document.addEventListener(
      'mousemove',
      (event) => {
        if (!bosunSelectionDragState) return;

        const dx = Math.abs(event.clientX - bosunSelectionDragState.x);
        const dy = Math.abs(event.clientY - bosunSelectionDragState.y);
        if (dx > 4 || dy > 4) {
          bosunSelectionDragState.moved = true;
        }
      },
      true
    );

    document.addEventListener(
      'mouseup',
      () => {
        setTimeout(() => {
          bosunSelectionDragState = null;
        }, 0);
      },
      true
    );

    document.addEventListener(
      'click',
      (event) => {
        const heading = event.target?.closest?.('.panel-heading');
        if (!heading) return;

        const selectionText = window.getSelection?.()?.toString?.().trim?.() || '';
        const wasDragSelection =
          bosunSelectionDragState &&
          bosunSelectionDragState.heading === heading &&
          bosunSelectionDragState.moved &&
          selectionText.length > 0;

        if (!wasDragSelection) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      },
      true
    );
  }

  function isSilencedPanel(panel) {
    const heading = getPanelHeading(panel);
    return !!heading?.querySelector('.fa-volume-off');
  }

  function ensureSilencedBadge(panel) {
    const heading = getPanelHeading(panel);
    if (!heading) return;

    const muteIcon = heading.querySelector('.fa-volume-off');
    if (!muteIcon) return;

    let badge = muteIcon.parentElement?.querySelector(`.${SILENCED_BADGE_CLASS}`);
    if (badge) return;

    badge = document.createElement('span');
    badge.className = `${SILENCED_BADGE_CLASS} ${NO_SELECT_CLASS}`;
    badge.textContent = 'Silenced';

    muteIcon.insertAdjacentElement('afterend', badge);
  }

  function removeSilencedBadge(panel) {
    panel?.querySelector(`.${SILENCED_BADGE_CLASS}`)?.remove();
  }

  function refreshSilencedBadges() {
    document.querySelectorAll('.panel').forEach((panel) => {
      if (isSilencedPanel(panel)) {
        ensureSilencedBadge(panel);
      } else {
        removeSilencedBadge(panel);
      }
    });
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
      markNoSelectElements();
      refreshSilencedBadges();
      applyActionPageTweaks();

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

  function normalizeAutoRefreshIdleSeconds(value) {
    if (sharedUtils?.normalizeAutoRefreshIdleSeconds) {
      return sharedUtils.normalizeAutoRefreshIdleSeconds(value, {
        min: AUTO_REFRESH_MIN_IDLE_SECONDS,
        max: AUTO_REFRESH_MAX_IDLE_SECONDS,
        fallback: AUTO_REFRESH_DEFAULT_IDLE_SECONDS
      });
    }
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return AUTO_REFRESH_DEFAULT_IDLE_SECONDS;
    return Math.min(
      AUTO_REFRESH_MAX_IDLE_SECONDS,
      Math.max(AUTO_REFRESH_MIN_IDLE_SECONDS, Math.round(numericValue))
    );
  }

  function uniqueNodes(nodes) {
    if (sharedUtils?.uniqueNodes) {
      return sharedUtils.uniqueNodes(nodes);
    }
    const seen = new Set();
    const result = [];
    for (const node of nodes) {
      if (!node || seen.has(node)) continue;
      seen.add(node);
      result.push(node);
    }
    return result;
  }

  function saveAutoRefreshState() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.set({
      [AUTO_REFRESH_ENABLED_KEY]: autoRefreshEnabled,
      [AUTO_REFRESH_IDLE_SECONDS_KEY]: autoRefreshIdleSeconds
    });
  }

  function saveSoundAlertsState() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.set({ [SOUND_ALERTS_ENABLED_KEY]: soundAlertsEnabled });
  }

  function saveDiagnosticsState() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.set({ [DIAGNOSTICS_ENABLED_KEY]: diagnosticsEnabled });
  }

  function resetNeedAckSoundBaseline() {
    needAckBaselineApi?.reset?.();
  }

  function restoreNeedAckSoundBaselineFromSession() {
    needAckBaselineApi?.restoreFromSession?.();
  }

  function restoreDiagnosticsLogFromStorage() {
    diagnosticsApi?.restoreLogFromStorage?.();
  }

  function setDiagnosticsModalOpen(isOpen) {
    diagnosticsApi?.setModalOpen?.(isOpen);
  }

  function reportDiagnostics(eventName, details = '') {
    diagnosticsApi?.report?.(eventName, details);
  }

  function parseNeedAckStatusToBucket(raw) {
    return needAckSeverityApi?.parseNeedAckStatusToBucket?.(raw) ?? 'unknown';
  }

  /** В шаблоне Bosun у группы есть CurrentStatus; у ребёнка — State.* и Events[].Status */
  function getNeedAckSeverityBucket(child, group) {
    return needAckSeverityApi?.getNeedAckSeverityBucket?.(child, group) ?? 'unknown';
  }

  function getNeedAckSeverityFromGroupOnly(group) {
    return needAckSeverityApi?.getNeedAckSeverityFromGroupOnly?.(group) ?? 'unknown';
  }

  /** Стабильный ключ: Id -> AlertKey+Tags -> group+child+ago -> fallback */
  function needAckStableKey(child, group) {
    return needAckSeverityApi?.needAckStableKey?.(child, group) ?? null;
  }

  function loadState(callback) {
    if (!chrome?.storage?.local) {
      callback();
      return;
    }

    chrome.storage.local.get(
      [STORAGE_KEY, AUTO_REFRESH_ENABLED_KEY, AUTO_REFRESH_IDLE_SECONDS_KEY, SOUND_ALERTS_ENABLED_KEY, DIAGNOSTICS_ENABLED_KEY],
      (result) => {
      showSilenced = Boolean(result[STORAGE_KEY]);
      autoRefreshEnabled = typeof result[AUTO_REFRESH_ENABLED_KEY] === 'boolean'
        ? result[AUTO_REFRESH_ENABLED_KEY]
        : true;
      autoRefreshIdleSeconds = normalizeAutoRefreshIdleSeconds(result[AUTO_REFRESH_IDLE_SECONDS_KEY]);
      soundAlertsEnabled = typeof result[SOUND_ALERTS_ENABLED_KEY] === 'boolean'
        ? result[SOUND_ALERTS_ENABLED_KEY]
        : true;
      diagnosticsEnabled = typeof result[DIAGNOSTICS_ENABLED_KEY] === 'boolean'
        ? result[DIAGNOSTICS_ENABLED_KEY]
        : false;
      if (!autoRefreshEnabled) {
        scheduleAutoRefreshReEnable();
      }
      callback();
      }
    );
  }

  function updateToggleText() {
    const btn = document.getElementById(TOGGLE_ID);
    const counter = document.getElementById(TOGGLE_COUNTER_ID);
    if (!btn) return;

    const labelNode = btn.querySelector('.bosun-silence-label');
    if (!labelNode || !counter) return;

    if (showSilenced) {
      labelNode.textContent = 'Скрыть silenced alerts';
      btn.classList.add('is-active');
      counter.style.visibility = 'hidden';
      counter.textContent = '';
    } else {
      labelNode.textContent = 'Показать silenced alerts';
      btn.classList.remove('is-active');
      counter.style.visibility = 'visible';
      counter.textContent = String(hiddenCount);
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

  function markUserActivity() {
    lastUserActivityTs = Date.now();
    updateAutoRefreshCountdown();
  }

  function getAutoRefreshRemainingSeconds() {
    const elapsedSeconds = (Date.now() - lastUserActivityTs) / 1000;
    return Math.max(0, Math.ceil(autoRefreshIdleSeconds - elapsedSeconds));
  }

  function updateAutoRefreshCountdown() {
    const countdown = document.getElementById(AUTO_REFRESH_COUNTDOWN_ID);
    if (!countdown) return;

    if (!autoRefreshEnabled) {
      countdown.textContent = 'off';
      countdown.title = 'Отключить автообновление';
      return;
    }

    if (!isDashboardHome()) {
      countdown.textContent = '—';
      countdown.title = 'Автообновление страницы только на главной /';
      return;
    }

    countdown.title = 'Отключить автообновление';
    countdown.textContent = `${getAutoRefreshRemainingSeconds()}s`;
  }

  function updateAutoRefreshControls() {
    const toggle = document.getElementById(AUTO_REFRESH_TOGGLE_ID);
    const input = document.getElementById(AUTO_REFRESH_INPUT_ID);
    if (!toggle || !input) return;

    toggle.checked = autoRefreshEnabled;
    if (document.activeElement !== input) {
      input.value = String(autoRefreshIdleSeconds);
    }
    updateAutoRefreshCountdown();
  }

  function clearAutoRefreshReEnableTimer() {
    if (!autoRefreshReEnableTimer) return;
    clearTimeout(autoRefreshReEnableTimer);
    autoRefreshReEnableTimer = null;
  }

  function scheduleAutoRefreshReEnable() {
    clearAutoRefreshReEnableTimer();
    autoRefreshReEnableTimer = setTimeout(() => {
      autoRefreshReEnableTimer = null;
      if (autoRefreshEnabled) return;

      autoRefreshEnabled = true;
      markUserActivity();
      saveAutoRefreshState();
      updateAutoRefreshControls();
    }, AUTO_REFRESH_FORCE_REENABLE_MS);
  }

  function handleAutoRefreshToggleChange(e) {
    autoRefreshEnabled = Boolean(e.target.checked);
    if (autoRefreshEnabled) clearAutoRefreshReEnableTimer();
    else scheduleAutoRefreshReEnable();
    markUserActivity();
    saveAutoRefreshState();
    updateAutoRefreshControls();
  }

  function handleAutoRefreshIdleChange(e) {
    autoRefreshIdleSeconds = normalizeAutoRefreshIdleSeconds(e.target.value);
    markUserActivity();
    saveAutoRefreshState();
    updateAutoRefreshControls();
  }

  function handleAutoRefreshIdleInput(e) {
    const numericValue = Number(e.target.value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) return;

    // Во время ввода не clamping до min/max, чтобы не мешать набору.
    autoRefreshIdleSeconds = Math.round(numericValue);
    markUserActivity();
  }

  function handleAutoRefreshIdleKeydown(e) {
    if (e.key !== 'Enter') return;

    e.preventDefault();
    e.currentTarget.blur();
  }

  function handleAutoRefreshCountdownClick() {
    if (!autoRefreshEnabled) return;

    autoRefreshEnabled = false;
    scheduleAutoRefreshReEnable();
    markUserActivity();
    saveAutoRefreshState();
    updateAutoRefreshControls();
  }

  function updateSoundAlertsControl() {
    const cb = document.getElementById(SOUND_ALERTS_TOGGLE_ID);
    if (cb) cb.checked = soundAlertsEnabled;
  }

  function updateDiagnosticsControl() {
    const cb = document.getElementById(DIAGNOSTICS_TOGGLE_ID);
    if (cb) cb.checked = diagnosticsEnabled;
    const openBtn = document.getElementById(DIAGNOSTICS_OPEN_BUTTON_ID);
    if (openBtn) {
      const isOpen = diagnosticsApi?.isModalOpen?.() === true;
      openBtn.textContent = isOpen ? 'Закрыть лог' : 'Открыть лог';
    }
  }

  function handleSoundAlertsToggle(e) {
    soundAlertsEnabled = Boolean(e.target.checked);
    saveSoundAlertsState();
    resetNeedAckSoundBaseline();
    updateSoundAlertsControl();
  }

  function handleSoundTestClick(e) {
    e.preventDefault();
    e.stopPropagation();
    markUserActivity();
    reportDiagnostics('sound-test-click', `enabled=${soundAlertsEnabled ? 'on' : 'off'}`);
    soundApi?.playNeedAckChime?.('alert');
  }

  function handleDiagnosticsToggle(e) {
    diagnosticsEnabled = Boolean(e.target.checked);
    saveDiagnosticsState();
    updateDiagnosticsControl();
    reportDiagnostics('diag-toggled', diagnosticsEnabled ? 'on' : 'off');
  }

  function handleDiagnosticsOpenClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const isOpen = diagnosticsApi?.isModalOpen?.() === true;
    setDiagnosticsModalOpen(!isOpen);
    updateDiagnosticsControl();
  }

  function ensureDiagnosticsModal() {
    return diagnosticsApi?.ensureModal?.(updateDiagnosticsControl) || null;
  }

  function ensureSoundAlertsControls(actions) {
    let wrap = actions.querySelector('.bosun-sound-alerts-wrap');
    if (!wrap) {
      wrap = document.createElement('label');
      wrap.className = 'bosun-auto-refresh-label bosun-sound-alerts-wrap';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = SOUND_ALERTS_TOGGLE_ID;
      cb.addEventListener('change', handleSoundAlertsToggle);
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode('Звуковое оповещение'));
      actions.appendChild(wrap);
    }

    updateSoundAlertsControl();
  }

  /** Кнопка «Тест звука» при выключенном блоке диагностики — сразу после «Звуковое оповещение». */
  function ensureSoundTestButtonAfterSoundWrap(actions) {
    let testBtn = document.getElementById(SOUND_TEST_BUTTON_ID);
    if (!testBtn) {
      testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.id = SOUND_TEST_BUTTON_ID;
      testBtn.textContent = 'Тест';
      testBtn.title = 'Проиграть тестовый alert sound';
      testBtn.addEventListener('click', handleSoundTestClick);
    }
    const soundWrap = actions.querySelector('.bosun-sound-alerts-wrap');
    if (soundWrap) {
      if (soundWrap.nextElementSibling !== testBtn) {
        soundWrap.insertAdjacentElement('afterend', testBtn);
      }
    } else if (testBtn.parentElement !== actions) {
      actions.appendChild(testBtn);
    }
  }

  function ensureDiagnosticsControls(actions) {
    if (!DIAGNOSTICS_TOOLBAR_UI_ENABLED) {
      const deadGroup = actions.querySelector('.bosun-diagnostics-group');
      if (deadGroup) deadGroup.remove();
      const deadModal = document.getElementById(DIAGNOSTICS_MODAL_ID);
      if (deadModal) deadModal.remove();
      ensureSoundTestButtonAfterSoundWrap(actions);
      return;
    }

    let group = actions.querySelector('.bosun-diagnostics-group');
    if (!group) {
      group = document.createElement('div');
      group.className = 'bosun-diagnostics-group';
      actions.appendChild(group);
    }

    let wrap = group.querySelector('.bosun-diagnostics-wrap');
    if (!wrap) {
      wrap = document.createElement('label');
      wrap.className = 'bosun-auto-refresh-label bosun-diagnostics-wrap';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = DIAGNOSTICS_TOGGLE_ID;
      cb.addEventListener('change', handleDiagnosticsToggle);
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode('Диагностика'));
      group.appendChild(wrap);
    }
    let openBtn = group.querySelector(`#${DIAGNOSTICS_OPEN_BUTTON_ID}`);
    if (!openBtn) {
      openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.id = DIAGNOSTICS_OPEN_BUTTON_ID;
      openBtn.textContent = 'Открыть лог';
      openBtn.title = 'Открыть окно журнала диагностики';
      openBtn.addEventListener('click', handleDiagnosticsOpenClick);
      group.appendChild(openBtn);
    }
    let testBtn = document.getElementById(SOUND_TEST_BUTTON_ID);
    if (!testBtn) {
      testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.id = SOUND_TEST_BUTTON_ID;
      testBtn.textContent = 'Тест звука';
      testBtn.title = 'Проиграть тестовый alert sound';
      testBtn.addEventListener('click', handleSoundTestClick);
    }
    // Keep sound test button immediately to the right of "Открыть лог".
    if (openBtn.nextSibling !== testBtn || testBtn.parentElement !== group) {
      group.insertBefore(testBtn, openBtn.nextSibling);
    }
    ensureDiagnosticsModal();
    updateDiagnosticsControl();
  }

  function ensureAutoRefreshControls(actions) {
    let group = actions.querySelector('.bosun-auto-refresh-group');
    if (!group) {
      group = document.createElement('div');
      group.className = 'bosun-auto-refresh-group';

      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'bosun-auto-refresh-label';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.id = AUTO_REFRESH_TOGGLE_ID;
      toggle.addEventListener('change', handleAutoRefreshToggleChange);
      toggleLabel.appendChild(toggle);
      toggleLabel.appendChild(document.createTextNode('Автообновление,'));

      const secondsLabel = document.createElement('label');
      secondsLabel.className = 'bosun-auto-refresh-seconds';
      secondsLabel.setAttribute('for', AUTO_REFRESH_INPUT_ID);
      secondsLabel.appendChild(document.createTextNode('сек'));
      const input = document.createElement('input');
      input.id = AUTO_REFRESH_INPUT_ID;
      input.type = 'number';
      input.min = String(AUTO_REFRESH_MIN_IDLE_SECONDS);
      input.max = String(AUTO_REFRESH_MAX_IDLE_SECONDS);
      input.step = '1';
      input.addEventListener('input', handleAutoRefreshIdleInput);
      input.addEventListener('change', handleAutoRefreshIdleChange);
      input.addEventListener('keydown', handleAutoRefreshIdleKeydown);
      secondsLabel.appendChild(input);

      group.appendChild(toggleLabel);
      group.appendChild(secondsLabel);
      const countdown = document.createElement('span');
      countdown.id = AUTO_REFRESH_COUNTDOWN_ID;
      countdown.style.cursor = 'pointer';
      countdown.title = 'Отключить автообновление';
      countdown.addEventListener('click', handleAutoRefreshCountdownClick);
      group.appendChild(countdown);
      actions.appendChild(group);
    }

    updateAutoRefreshControls();
  }

  function maybeAutoRefreshPage() {
    if (!autoRefreshEnabled || !isDashboardHome()) return;
    if (Date.now() - lastUserActivityTs < autoRefreshIdleSeconds * 1000) return;

    window.location.reload();
  }

  function startAutoRefreshLoop() {
    if (autoRefreshTimer) return;

    autoRefreshTimer = setInterval(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastKnownUrl) {
        lastKnownUrl = currentUrl;
        markUserActivity();
        resetNeedAckSoundBaseline();
      }

      updateAutoRefreshCountdown();
      maybeAutoRefreshPage();
    }, 1000);
  }

  function installUserActivityTracking() {
    const activityEvents = ['keydown'];
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, markUserActivity, { passive: true, capture: true });
    });
  }

  function findMainContentAnchor() {
    return (
      document.querySelector('body > .container[style*="width: 95%"]') ||
      document.querySelector('body > .container') ||
      document.body?.querySelector('.container') ||
      null
    );
  }

  function disconnectTopBarMountObserver() {
    if (topBarMountObserver) {
      topBarMountObserver.disconnect();
      topBarMountObserver = null;
    }
  }

  function scheduleTopBarMount() {
    const tryMount = () => {
      ensureToggleExists();
      return !!document.getElementById(TOP_BAR_ID);
    };

    if (tryMount()) return;

    if (topBarMountObserver) return;

    topBarMountObserver = new MutationObserver(() => {
      if (tryMount()) {
        disconnectTopBarMountObserver();
      }
    });
    topBarMountObserver.observe(document.documentElement, { childList: true, subtree: true });
    requestAnimationFrame(tryMount);
  }

  function ensureTopBarExists() {
    let bar = document.getElementById(TOP_BAR_ID);
    if (bar) return bar;

    const collapse =
      document.getElementById('navbar-collapse') ||
      document.querySelector('.navbar.navbar-default .navbar-collapse');

    if (collapse) {
      const rightNav = collapse.querySelector('ul.nav.navbar-nav.navbar-right');
      if (rightNav) {
        bar = document.createElement('div');
        bar.id = TOP_BAR_ID;
        bar.className = 'bosun-toolbar-navbar-center';
        bar.innerHTML = `
          <div class="bosun-top-controls-inner">
            <div class="bosun-top-controls-actions"></div>
          </div>
        `;
        collapse.insertBefore(bar, rightNav);
        return bar;
      }
    }

    const navbar = document.querySelector('.navbar.navbar-default.navbar-static-top');
    const contentContainer = findMainContentAnchor();
    if (!contentContainer) return null;

    bar = document.createElement('div');
    bar.id = TOP_BAR_ID;
    bar.className = 'bosun-toolbar-fallback';
    bar.innerHTML = `
      <div class="bosun-top-controls-inner">
        <div class="bosun-top-controls-title">Bosun Silence Hider</div>
        <div class="bosun-top-controls-actions"></div>
      </div>
    `;

    if (navbar && navbar.nextSibling) {
      navbar.parentNode.insertBefore(bar, navbar.nextSibling);
    } else {
      contentContainer.parentNode.insertBefore(bar, contentContainer);
    }

    return bar;
  }

  function getTopBarActionsContainer() {
    const bar = ensureTopBarExists();
    return bar?.querySelector('.bosun-top-controls-actions') || null;
  }

  function ensureToggleExists() {
    const actions = getTopBarActionsContainer();
    if (!actions) return;
    ensureSoundAlertsControls(actions);
    ensureAutoRefreshControls(actions);

    let btn = document.getElementById(TOGGLE_ID);
    let counter = document.getElementById(TOGGLE_COUNTER_ID);

    if (!btn) {
      btn = document.createElement('button');
      btn.id = TOGGLE_ID;
      btn.type = 'button';

      const label = document.createElement('span');
      label.className = 'bosun-silence-label';
      btn.appendChild(label);
      btn.addEventListener('click', handleToggleClick, true);
    }

    if (!counter) {
      counter = document.createElement('span');
      counter.id = TOGGLE_COUNTER_ID;
    }

    if (btn.parentElement !== actions) {
      actions.appendChild(btn);
    }
    if (counter.parentElement !== actions) {
      actions.appendChild(counter);
    }
    ensureDiagnosticsControls(actions);
    updateToggleText();
  }

  function getNeedsAckRoot() {
    return document.querySelector('[ts-ack-group="schedule.Groups.NeedAck"]');
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

  function buildChildMarkerKey(id, groupSubject, childSubject, ago) {
    const normalizedId = id != null && String(id).trim() ? String(id).trim() : '';
    if (normalizedId) return `id:${normalizedId}`;

    const g = typeof groupSubject === 'string' ? groupSubject.trim() : '';
    const c = typeof childSubject === 'string' ? childSubject.trim() : '';
    const a = typeof ago === 'string' ? ago.trim() : '';

    if (g && c && a) return `g:${g}|c:${c}|ago:${a}`;
    if (g && c) return `g:${g}|c:${c}`;
    if (c && a) return `c:${c}|ago:${a}`;
    if (c) return `c:${c}`;
    if (g) return `g:${g}`;
    return null;
  }

  function getPanelAgoFromHeading(heading) {
    const ageNode = heading?.querySelector('[ts-since="child.Ago"], .pull-right[ts-since]');
    return ageNode?.textContent?.replace(/\s+/g, ' ').trim() || null;
  }

  function buildChildMarkerKeyFromData(child, group) {
    return buildChildMarkerKey(
      child?.State?.Id,
      typeof group?.Subject === 'string' ? group.Subject : '',
      (typeof child?.Subject === 'string' && child.Subject.trim())
        ? child.Subject
        : (typeof child?.AlertKey === 'string' ? child.AlertKey : ''),
      typeof child?.Ago === 'string' ? child.Ago : ''
    );
  }

  function buildChildMarkerKeyFromHeading(heading, groupPanel) {
    if (!heading) return null;
    const panelId = getPanelIdFromHeading(heading);
    const groupSubject = getGroupSubjectFromPanel(groupPanel);
    const subject = getPanelSubjectFromHeading(heading);
    const ago = getPanelAgoFromHeading(heading);
    return buildChildMarkerKey(panelId, groupSubject, subject, ago);
  }

  function getGroupChildPanels(groupPanel) {
    if (!groupPanel) return [];
    return Array.from(groupPanel.querySelectorAll('[ng-repeat="child in group.Children"]'))
      .map((node) => node.closest('.panel') || node)
      .filter(Boolean);
  }

  function buildGroupMarkerKey(groupSubject, childKeys) {
    const g = typeof groupSubject === 'string' ? groupSubject.trim() : '';
    const normalizedChildKeys = Array.isArray(childKeys)
      ? childKeys.filter((key) => typeof key === 'string' && key)
      : [];

    if (g && normalizedChildKeys.length) {
      return `group:${g}|children:${normalizedChildKeys.slice().sort().join(',')}`;
    }
    if (g) return `group:${g}`;
    if (normalizedChildKeys.length) return `children:${normalizedChildKeys.slice().sort().join(',')}`;
    return null;
  }

  function buildGroupMarkerKeyFromData(group) {
    const groupSubject = typeof group?.Subject === 'string' ? group.Subject : '';
    const children = Array.isArray(group?.Children) ? group.Children : [];
    const childKeys = children
      .map((child) => buildChildMarkerKeyFromData(child, group))
      .filter((key) => typeof key === 'string' && key);
    return buildGroupMarkerKey(groupSubject, childKeys);
  }

  function buildGroupMarkerKeyFromDom(groupPanel) {
    const groupSubject = getGroupSubjectFromPanel(groupPanel) || '';
    const childKeys = getGroupChildPanels(groupPanel)
      .map((childPanel) => buildChildMarkerKeyFromHeading(getChildHeading(childPanel), groupPanel))
      .filter((key) => typeof key === 'string' && key);
    return buildGroupMarkerKey(groupSubject, childKeys);
  }

  function findParentGroupPanelForChild(childPanel) {
    if (!childPanel) return null;
    const groups = getGroupPanels();
    for (const groupPanel of groups) {
      if (groupPanel.contains(childPanel)) return groupPanel;
    }
    return null;
  }

  function rebuildAlertDataIndex(payload) {
    const nextIndex = alertsDataApi?.rebuildAlertDataIndex?.(payload, {
      buildChildMarkerKeyFromData,
      buildGroupMarkerKeyFromData
    }) || {
      childOldNoNoteById: new Map(),
      childOldNoNoteByKey: new Map(),
      childHasNoteById: new Map(),
      childHasNoteByKey: new Map(),
      groupHasOldNoNoteByKey: new Map(),
      groupHasAnyNoteByKey: new Map(),
      groupHasOldNoNoteBySubject: new Map(),
      groupHasAnyNoteBySubject: new Map()
    };
    childOldNoNoteById.clear();
    childOldNoNoteByKey.clear();
    childHasNoteById.clear();
    childHasNoteByKey.clear();
    groupHasOldNoNoteByKey.clear();
    groupHasAnyNoteByKey.clear();
    groupHasOldNoNoteBySubject.clear();
    groupHasAnyNoteBySubject.clear();
    for (const [key, value] of nextIndex.childOldNoNoteById) childOldNoNoteById.set(key, value);
    for (const [key, value] of nextIndex.childOldNoNoteByKey) childOldNoNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.childHasNoteById) childHasNoteById.set(key, value);
    for (const [key, value] of nextIndex.childHasNoteByKey) childHasNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasOldNoNoteByKey) groupHasOldNoNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyNoteByKey) groupHasAnyNoteByKey.set(key, value);
    for (const [key, value] of nextIndex.groupHasOldNoNoteBySubject) groupHasOldNoNoteBySubject.set(key, value);
    for (const [key, value] of nextIndex.groupHasAnyNoteBySubject) groupHasAnyNoteBySubject.set(key, value);
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

  function resolveChildState(panel, parentGroupPanel = null) {
    const heading = getChildHeading(panel);
    if (!heading) return 'none';

    const panelId = getPanelIdFromHeading(heading);
    const groupPanel = parentGroupPanel || findParentGroupPanelForChild(panel);
    const childKey = buildChildMarkerKeyFromHeading(heading, groupPanel);

    let oldNoNote = false;
    let hasNote = false;

    if (panelId) {
      if (childOldNoNoteById.has(panelId)) oldNoNote = childOldNoNoteById.get(panelId) === true;
      if (childHasNoteById.has(panelId)) hasNote = childHasNoteById.get(panelId) === true;
    }

    if (!oldNoNote && !hasNote && childKey) {
      if (childOldNoNoteByKey.has(childKey)) oldNoNote = childOldNoNoteByKey.get(childKey) === true;
      if (childHasNoteByKey.has(childKey)) hasNote = childHasNoteByKey.get(childKey) === true;
    }

    if (oldNoNote) return 'warning';
    if (hasNote) return 'note';
    return 'none';
  }

  function resolveGroupStateFromDom(groupPanel) {
    if (!groupPanel) return 'none';

    const childPanels = getGroupChildPanels(groupPanel);

    let hasWarning = false;
    let hasNote = false;

    for (const childPanel of childPanels) {
      const state = resolveChildState(childPanel, groupPanel);
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
    const groupKey = buildGroupMarkerKeyFromDom(groupPanel);
    const groupSubject = getGroupSubjectFromPanel(groupPanel);

    const domState = resolveGroupStateFromDom(groupPanel);
    if (domState !== 'none') {
      if (groupKey) lastResolvedParentStateByKey.set(groupKey, domState);
      return domState;
    }

    if (groupKey) {
      const hasOldNoNote = groupHasOldNoNoteByKey.get(groupKey) === true;
      const hasAnyNote = groupHasAnyNoteByKey.get(groupKey) === true;

      if (hasOldNoNote) {
        lastResolvedParentStateByKey.set(groupKey, 'warning');
        return 'warning';
      }
      if (hasAnyNote) {
        lastResolvedParentStateByKey.set(groupKey, 'note');
        return 'note';
      }

      const stickyState = lastResolvedParentStateByKey.get(groupKey);
      if (stickyState === 'warning' || stickyState === 'note') {
        return stickyState;
      }
    }

    if (groupSubject) {
      const hasOldNoNoteBySubject = groupHasOldNoNoteBySubject.get(groupSubject) === true;
      const hasAnyNoteBySubject = groupHasAnyNoteBySubject.get(groupSubject) === true;

      if (hasOldNoNoteBySubject) return 'warning';
      if (hasAnyNoteBySubject) return 'note';
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
      if (!alertsDataApi?.fetchAlertsDataViaFetch || !alertsDataApi?.fetchAlertsDataViaXHR) {
        throw new Error('alerts-data module unavailable');
      }
      try {
        payload = await alertsDataApi.fetchAlertsDataViaFetch();
      } catch (_) {
        payload = await alertsDataApi.fetchAlertsDataViaXHR();
      }

      rebuildAlertDataIndex(payload);
      needAckBaselineApi?.process?.(payload);
      applyNeedsAckMarkersFromData();
      ensureCopyButtons();
      markNoSelectElements();
      refreshSilencedBadges();
      reportDiagnostics('refresh-ok', 'alerts payload received');
    } catch (err) {
      console.warn('[Bosun plugin] Failed to refresh alerts data:', err);
      reportDiagnostics('refresh-failed', err?.message || 'unknown-error');
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

    function isNeedsAckNode(node, needsAckRoot) {
      if (!node || node.nodeType !== 1) return false;

      if (needsAckRoot && (node === needsAckRoot || needsAckRoot.contains(node))) {
        return true;
      }

      if (node.matches?.('[ts-ack-group="schedule.Groups.NeedAck"]')) {
        return true;
      }

      return !!node.querySelector?.('[ts-ack-group="schedule.Groups.NeedAck"]');
    }

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
        if (target.id === TOP_BAR_ID || target.closest?.(`#${TOP_BAR_ID}`)) continue;
        if (target.classList?.contains(OLD_NO_NOTE_ICON_CLASS) || target.closest?.(`.${OLD_NO_NOTE_ICON_CLASS}`)) continue;
        if (target.classList?.contains(HAS_NOTE_ICON_CLASS) || target.closest?.(`.${HAS_NOTE_ICON_CLASS}`)) continue;

        shouldRefreshUi = true;

        if (isNeedsAckNode(target, needsAckRoot)) {
          shouldRefreshData = true;
          continue;
        }

        if (mutation.type === 'childList') {
          const addedNodes = mutation.addedNodes ? Array.from(mutation.addedNodes) : [];
          const removedNodes = mutation.removedNodes ? Array.from(mutation.removedNodes) : [];
          const changedNodes = [...addedNodes, ...removedNodes];

          if (changedNodes.some((node) => isNeedsAckNode(node, needsAckRoot))) {
            shouldRefreshData = true;
          }
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
    restoreDiagnosticsLogFromStorage();
    injectStyles();
    installSelectionGuard();
    installUserActivityTracking();
    soundApi?.installAudioUnlockTracking?.();
    soundApi?.ensureAudioObjects?.();
    scheduleTopBarMount();
    restoreNeedAckSoundBaselineFromSession();

    loadState(() => {
      markUserActivity();
      ensureToggleExists();
      applyVisibility();
      ensureCopyButtons();
      markNoSelectElements();
      refreshSilencedBadges();
      applyActionPageTweaks();
      startObserver();
      refreshAlertsData();
      startDataRefreshLoop();
      startAutoRefreshLoop();

      setTimeout(() => {
        ensureToggleExists();
        applyVisibility();
        ensureCopyButtons();
        markNoSelectElements();
        refreshSilencedBadges();
        applyActionPageTweaks();
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