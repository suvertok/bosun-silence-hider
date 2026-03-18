(function() {
    'use strict';
  
    const HIDDEN_CLASS = 'bosun-silence-hidden';
    let isShowingSilenced = false; // false = скрыты (режим по умолчанию), true = показаны
  
    // Внедряем стили один раз
    function injectStyles() {
      if (document.getElementById('bosun-silence-styles')) return;
      const style = document.createElement('style');
      style.id = 'bosun-silence-styles';
      style.textContent = `
        .${HIDDEN_CLASS} {
          display: none !important;
        }
      `;
      document.head.appendChild(style);
    }
  
    // Основная функция скрытия
    function hideSilencedAlerts() {
      // Если пользователь нажал "Показать", мы не скрываем
      if (isShowingSilenced) return;
  
      const silencedIcons = document.querySelectorAll(
        'span.fa-volume-off[title="This mute icon represents that the alert has been silenced."]'
      );
  
      silencedIcons.forEach(icon => {
        // Ищем контейнер алерта (строка таблицы или div)
        const alertRow = icon.closest('tr, .alert-row, [ng-repeat*="alert"], .panel, .alert-item, tbody > tr');
        
        if (alertRow && !alertRow.classList.contains(HIDDEN_CLASS)) {
          alertRow.classList.add(HIDDEN_CLASS);
        }
      });
    }
  
    // Переключатель видимости
    function toggleSilencedAlerts() {
      isShowingSilenced = !isShowingSilenced;
      const btn = document.getElementById('bosun-toggle-silenced');
      
      // Находим все алерты, которые потенциально могут быть скрыты
      const silencedIcons = document.querySelectorAll(
        'span.fa-volume-off[title="This mute icon represents that the alert has been silenced."]'
      );
  
      silencedIcons.forEach(icon => {
        const alertRow = icon.closest('tr, .alert-row, [ng-repeat*="alert"], .panel, .alert-item, tbody > tr');
        if (alertRow) {
          if (isShowingSilenced) {
            alertRow.classList.remove(HIDDEN_CLASS);
          } else {
            alertRow.classList.add(HIDDEN_CLASS);
          }
        }
      });
  
      if (btn) {
        btn.textContent = isShowingSilenced ? '🔈 Скрыть сайленсы' : '🔇 Показать сайленсы';
      }
    }
  
    // Инициализация
    injectStyles();
    hideSilencedAlerts();
  
    // Observer для отслеживания изменений в DOM (AngularJS обновляет данные динамически)
    const observer = new MutationObserver(() => {
      // Небольшая задержка, чтобы Angular отрисовал элементы перед скрытием
      setTimeout(hideSilencedAlerts, 100);
    });
  
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  
    // Добавление кнопки управления
    function addToggleControl() {
      if (document.getElementById('bosun-toggle-silenced')) return;
      
      const btn = document.createElement('button');
      btn.id = 'bosun-toggle-silenced';
      btn.textContent = '🔇 Показать сайленсы';
      btn.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 9999;
        padding: 8px 12px;
        background: #6c757d;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      `;
      
      btn.onclick = toggleSilencedAlerts;
      document.body.appendChild(btn);
    }
  
    setTimeout(addToggleControl, 1000);
  })();