const state = {
  timer: null,
  viewed: 0,
  flowId: null,
  sessionToken: localStorage.getItem('telegramSessionToken'),
  stopped: false,
};

const $ = (selector) => document.querySelector(selector);
const threshold = $('#threshold');
const thresholdValue = $('#thresholdValue');
const telegramForm = $('#telegramForm');
const codeForm = $('#codeForm');
const settingsForm = $('#settingsForm');
const pauseBtn = $('#pauseBtn');
const logoutBtn = $('#logoutBtn');
const startBtn = $('#startBtn');
const manualActions = $('#manualActions');
const messageForm = $('#messageForm');

threshold.addEventListener('input', () => {
  thresholdValue.textContent = `${threshold.value}%`;
});

telegramForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    apiId: $('#apiId').value.trim(),
    apiHash: $('#apiHash').value.trim(),
    phone: $('#phone').value.trim(),
  };
  const result = await api('/api/auth/send-code', payload, false);
  if (!result) return;
  state.flowId = result.flowId;
  codeForm.hidden = false;
  addLog(result.message);
  setStatus('Код надіслано', 'Введіть код підтвердження із Telegram.', 'active');
});

codeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await api('/api/auth/sign-in', {
    flowId: state.flowId,
    code: $('#code').value.trim(),
    password: $('#password').value,
  }, false);
  if (!result) return;
  connectSession(result.sessionToken, result.phone);
});

settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  startScanning();
});

pauseBtn.addEventListener('click', () => {
  stopTimer();
  state.stopped = true;
  setStatus('Пошук на паузі', 'Натисніть «Почати пошук», щоб продовжити.', '');
  addLog('Пошук поставлено на паузу.');
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/auth/logout', {});
  localStorage.removeItem('telegramSessionToken');
  state.sessionToken = null;
  startBtn.disabled = true;
  stopTimer();
  setStatus('Telegram не підключено', 'Введіть доступ у блоці Telegram та підтвердьте кодом.', 'stopped');
  addLog('Telegram-сесію вимкнено.');
});

manualActions.addEventListener('click', async (event) => {
  const action = event.target.dataset.action;
  if (!action) return;

  if (action === 'message') {
    messageForm.hidden = false;
    addLog('Відкрито поле для ручного повідомлення.');
    return;
  }

  const result = await api('/api/telegram/action', { action, botUsername: getBotUsername() });
  if (!result) return;
  addLog(`Надіслано дію в Telegram: ${result.message}`);
  manualActions.hidden = true;
  state.stopped = false;
  startScanning();
});

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#customMessage').value.trim();
  if (!message) return;
  const result = await api('/api/telegram/send', { botUsername: getBotUsername(), message });
  if (!result) return;
  addLog('Ручне повідомлення надіслано в Telegram.');
  $('#customMessage').value = '';
  messageForm.hidden = true;
});

async function startScanning() {
  if (!state.sessionToken) {
    setStatus('Telegram не підключено', 'Спочатку увійдіть у Telegram.', 'stopped');
    return;
  }
  stopTimer();
  state.stopped = false;
  manualActions.hidden = true;
  messageForm.hidden = true;
  setStatus('Пошук активний', 'Додаток перевіряє останню анкету й автоматично гортає слабкі збіги.', 'active');
  await scanOnce();
  if (!state.stopped) state.timer = window.setInterval(scanOnce, 2200);
}

async function scanOnce() {
  const result = await api('/api/telegram/scan-once', {
    botUsername: getBotUsername(),
    threshold: threshold.value,
    interests: $('#interests').value,
    keywords: $('#keywords').value,
  });
  if (!result) {
    stopTimer();
    return;
  }

  state.viewed += 1;
  $('#scanCounter').textContent = `${state.viewed} перевірено`;
  renderTelegramProfile(result);

  if (result.shouldStop) {
    state.stopped = true;
    stopTimer();
    manualActions.hidden = false;
    setStatus('Пошук зупинено', result.reason, 'stopped');
    addLog(`Зупинка: ${result.reason}`);
  } else {
    addLog(result.reason);
  }
}

function renderTelegramProfile(result) {
  $('#avatar').textContent = 'TG';
  $('#profileName').textContent = 'Анкета з DaVinci';
  $('#profileMeta').textContent = [
    result.matchedInterests.length ? `збіги: ${result.matchedInterests.join(', ')}` : 'збіги не знайдені',
    result.matchedKeywords.length ? `ключові слова: ${result.matchedKeywords.join(', ')}` : null,
  ].filter(Boolean).join(' · ');
  $('#profileBio').textContent = result.text || 'Повідомлення без тексту або з медіа.';
  $('#matchPercent').textContent = `${result.percent}%`;
  $('#matchProgress').value = result.percent;
  $('#matchReason').textContent = result.reason;
}

async function restoreSession() {
  if (!state.sessionToken) return;
  const result = await api('/api/auth/restore', { sessionToken: state.sessionToken }, false);
  if (result) connectSession(result.sessionToken, result.phone);
}

function connectSession(sessionToken, phone) {
  state.sessionToken = sessionToken;
  localStorage.setItem('telegramSessionToken', sessionToken);
  startBtn.disabled = false;
  setStatus('Telegram підключено', `Підключений акаунт: ${phone}. Можна запускати пошук.`, 'active');
  addLog(`Telegram підключено: ${phone}.`);
}

async function api(url, body, withToken = true) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(withToken && state.sessionToken ? { 'x-session-token': state.sessionToken } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Невідома помилка');
    return data;
  } catch (error) {
    setStatus('Помилка', error.message, 'stopped');
    addLog(`Помилка: ${error.message}`);
    return null;
  }
}

function getBotUsername() {
  return $('#botUsername').value.trim().replace(/^@/, '') || 'leomatchbot';
}

function setStatus(title, text, mode) {
  $('#statusTitle').textContent = title;
  $('#statusText').textContent = text;
  $('#statusDot').className = `status-dot ${mode}`.trim();
}

function addLog(message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString('uk-UA')}: ${message}`;
  $('#eventLog').prepend(item);
}

function stopTimer() {
  if (state.timer) {
    window.clearInterval(state.timer);
    state.timer = null;
  }
}

restoreSession();
