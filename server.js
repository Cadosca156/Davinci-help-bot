const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const DEFAULT_BOT_USERNAME = 'leomatchbot';
const TELEGRAM_FLOOD_WAIT = 'Telegram тимчасово обмежив частоту дій. Зачекайте і спробуйте ще раз.';

const app = express();
const loginFlows = new Map();
const connectedClients = new Map();
let savedSessions = {};

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizeList(value = '') {
  return String(value)
    .split(/[\n,]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

function safeError(error) {
  const message = error && error.message ? error.message : String(error);
  if (message.includes('PHONE_CODE_INVALID')) return 'Невірний код підтвердження Telegram.';
  if (message.includes('PHONE_PASSWORD_PROTECTED') || message.includes('SESSION_PASSWORD_NEEDED')) return 'Потрібен пароль двофакторної автентифікації.';
  if (message.includes('PASSWORD_HASH_INVALID')) return 'Невірний пароль 2FA.';
  if (message.includes('FLOOD')) return TELEGRAM_FLOOD_WAIT;
  return message;
}

async function loadSessions() {
  try {
    savedSessions = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
  } catch (error) {
    savedSessions = {};
  }
}

async function saveSessions() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(savedSessions, null, 2));
}

async function buildClient(apiId, apiHash, session = '') {
  const client = new TelegramClient(new StringSession(session), Number(apiId), apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  return client;
}

function requireClient(req, res, next) {
  const token = req.get('x-session-token') || req.body.sessionToken;
  const record = token ? connectedClients.get(token) : null;
  if (!record) {
    return res.status(401).json({ error: 'Telegram-сесію не знайдено. Увійдіть у Telegram ще раз.' });
  }
  req.telegram = { token, ...record };
  next();
}

app.get('/api/status', requireClient, async (req, res) => {
  const authorized = await req.telegram.client.isUserAuthorized();
  res.json({ authorized, phone: req.telegram.phone, botUsername: req.telegram.botUsername || DEFAULT_BOT_USERNAME });
});

app.post('/api/auth/send-code', async (req, res) => {
  const { apiId, apiHash, phone } = req.body;
  if (!apiId || !apiHash || !phone) {
    return res.status(400).json({ error: 'Вкажіть apiId, apiHash і номер телефону.' });
  }

  try {
    const client = await buildClient(apiId, apiHash);
    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: Number(apiId),
        apiHash,
        settings: new Api.CodeSettings({}),
      }),
    );
    const flowId = createToken();
    loginFlows.set(flowId, { client, apiId: Number(apiId), apiHash, phone, phoneCodeHash: result.phoneCodeHash });
    res.json({ flowId, message: 'Код надіслано у Telegram.' });
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

app.post('/api/auth/sign-in', async (req, res) => {
  const { flowId, code, password } = req.body;
  const flow = loginFlows.get(flowId);
  if (!flow || !code) {
    return res.status(400).json({ error: 'Немає активного входу або не вказано код.' });
  }

  try {
    try {
      await flow.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: flow.phone,
          phoneCodeHash: flow.phoneCodeHash,
          phoneCode: code,
        }),
      );
    } catch (error) {
      if (!String(error.message).includes('SESSION_PASSWORD_NEEDED') && !String(error.message).includes('PHONE_PASSWORD_PROTECTED')) {
        throw error;
      }
      if (!password) {
        return res.status(401).json({ needsPassword: true, error: 'Для акаунта увімкнено 2FA. Введіть пароль.' });
      }
      await flow.client.checkPassword(password);
    }

    const sessionToken = createToken();
    const sessionString = flow.client.session.save();
    savedSessions[sessionToken] = {
      apiId: flow.apiId,
      apiHash: flow.apiHash,
      phone: flow.phone,
      session: sessionString,
      createdAt: new Date().toISOString(),
    };
    await saveSessions();
    connectedClients.set(sessionToken, { client: flow.client, phone: flow.phone, apiId: flow.apiId, apiHash: flow.apiHash });
    loginFlows.delete(flowId);
    res.json({ sessionToken, phone: flow.phone });
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

app.post('/api/auth/restore', async (req, res) => {
  const { sessionToken } = req.body;
  const record = savedSessions[sessionToken];
  if (!record) return res.status(404).json({ error: 'Збережену сесію не знайдено.' });

  try {
    const client = await buildClient(record.apiId, record.apiHash, record.session);
    if (!(await client.isUserAuthorized())) {
      delete savedSessions[sessionToken];
      await saveSessions();
      return res.status(401).json({ error: 'Сесія Telegram більше не активна.' });
    }
    connectedClients.set(sessionToken, { client, phone: record.phone, apiId: record.apiId, apiHash: record.apiHash });
    res.json({ sessionToken, phone: record.phone });
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

app.post('/api/auth/logout', requireClient, async (req, res) => {
  try {
    await req.telegram.client.disconnect();
  } catch (error) {
    // Disconnect best effort only.
  }
  connectedClients.delete(req.telegram.token);
  delete savedSessions[req.telegram.token];
  await saveSessions();
  res.json({ ok: true });
});

app.post('/api/telegram/send', requireClient, async (req, res) => {
  const { botUsername = DEFAULT_BOT_USERNAME, message } = req.body;
  if (!message) return res.status(400).json({ error: 'Немає тексту повідомлення.' });

  try {
    const sent = await req.telegram.client.sendMessage(botUsername, { message });
    res.json({ ok: true, id: sent.id });
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

app.post('/api/telegram/action', requireClient, async (req, res) => {
  const { botUsername = DEFAULT_BOT_USERNAME, action } = req.body;
  const actionMap = {
    like: '❤️',
    skip: '👎',
    message: '💌',
  };
  const message = actionMap[action];
  if (!message) return res.status(400).json({ error: 'Невідома дія.' });

  try {
    const sent = await req.telegram.client.sendMessage(botUsername, { message });
    res.json({ ok: true, id: sent.id, message });
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

app.post('/api/telegram/scan-once', requireClient, async (req, res) => {
  const { botUsername = DEFAULT_BOT_USERNAME, threshold = 70, interests = '', keywords = '' } = req.body;
  try {
    const entity = await req.telegram.client.getEntity(botUsername);
    const messages = await req.telegram.client.getMessages(entity, { limit: 1 });
    const message = messages[0];
    if (!message) return res.status(404).json({ error: 'Повідомлення від бота не знайдено. Напишіть /start боту з додатка.' });

    const text = message.message || '';
    const userInterests = normalizeList(interests);
    const stopWords = normalizeList(keywords);
    const lowerText = text.toLowerCase();
    const matchedInterests = userInterests.filter((item) => lowerText.includes(item));
    const matchedKeywords = stopWords.filter((word) => lowerText.includes(word));
    const percent = userInterests.length ? Math.round((matchedInterests.length / userInterests.length) * 100) : 0;
    const shouldStop = percent >= Number(threshold) || matchedKeywords.length > 0;

    if (!shouldStop) {
      await req.telegram.client.sendMessage(entity, { message: '👎' });
    }

    res.json({
      text,
      percent,
      matchedInterests,
      matchedKeywords,
      shouldStop,
      reason: shouldStop
        ? matchedKeywords.length
          ? `Знайдено ключові слова: ${matchedKeywords.join(', ')}`
          : `Збіг ${percent}% перевищив поріг ${threshold}%`
        : `Збіг ${percent}% нижче порогу ${threshold}%, автоматично пролистано.`,
    });
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

loadSessions().then(() => {
  app.listen(PORT, () => {
    console.log(`DaVinci Match Helper запущено: http://localhost:${PORT}`);
  });
});
