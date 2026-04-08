(() => {
  'use strict';

  function createAlertsData(options) {
    const { oldNoNoteMinutes } = options;

    function isOlderThanThreshold(agoValue) {
      if (!agoValue) return false;
      const ts = Date.parse(agoValue);
      if (!Number.isFinite(ts)) return false;
      return (Date.now() - ts) >= oldNoNoteMinutes * 60 * 1000;
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

    function rebuildAlertDataIndex(payload, helpers) {
      const {
        buildChildMarkerKeyFromData,
        buildGroupMarkerKeyFromData
      } = helpers;

      const nextIndex = {
        childOldNoNoteById: new Map(),
        childOldNoNoteByKey: new Map(),
        childHasNoteById: new Map(),
        childHasNoteByKey: new Map(),
        groupHasOldNoNoteByKey: new Map(),
        groupHasAnyNoteByKey: new Map(),
        groupHasOldNoNoteBySubject: new Map(),
        groupHasAnyNoteBySubject: new Map()
      };

      const groups = payload?.Groups?.NeedAck;
      if (!Array.isArray(groups)) return nextIndex;

      for (const group of groups) {
        let groupHasOldNoNote = false;
        let groupHasAnyNote = false;

        const children = Array.isArray(group?.Children) ? group.Children : [];
        for (const child of children) {
          const childId = child?.State?.Id != null ? String(child.State.Id) : null;
          const childKey = buildChildMarkerKeyFromData(child, group);

          const oldEnough = isOlderThanThreshold(child?.Ago);
          const hasNote = hasNoteFromActions(child?.State?.Actions);
          const oldNoNote = oldEnough && !hasNote;

          if (childId) {
            nextIndex.childOldNoNoteById.set(childId, oldNoNote);
            nextIndex.childHasNoteById.set(childId, hasNote);
          }
          if (childKey) {
            nextIndex.childOldNoNoteByKey.set(childKey, oldNoNote);
            nextIndex.childHasNoteByKey.set(childKey, hasNote);
          }

          if (oldNoNote) groupHasOldNoNote = true;
          if (hasNote) groupHasAnyNote = true;
        }

        const groupKey = buildGroupMarkerKeyFromData(group);
        if (groupKey) {
          const prevOld = nextIndex.groupHasOldNoNoteByKey.get(groupKey) === true;
          const prevNote = nextIndex.groupHasAnyNoteByKey.get(groupKey) === true;
          nextIndex.groupHasOldNoNoteByKey.set(groupKey, prevOld || groupHasOldNoNote);
          nextIndex.groupHasAnyNoteByKey.set(groupKey, prevNote || groupHasAnyNote);
        }

        const groupSubject = typeof group?.Subject === 'string' ? group.Subject.trim() : '';
        if (groupSubject) {
          const prevOldBySubject = nextIndex.groupHasOldNoNoteBySubject.get(groupSubject) === true;
          const prevNoteBySubject = nextIndex.groupHasAnyNoteBySubject.get(groupSubject) === true;
          nextIndex.groupHasOldNoNoteBySubject.set(groupSubject, prevOldBySubject || groupHasOldNoNote);
          nextIndex.groupHasAnyNoteBySubject.set(groupSubject, prevNoteBySubject || groupHasAnyNote);
        }
      }

      return nextIndex;
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

    return {
      rebuildAlertDataIndex,
      fetchAlertsDataViaFetch,
      fetchAlertsDataViaXHR
    };
  }

  globalThis.BosunSilenceHiderAlertsData = {
    createAlertsData
  };
})();
