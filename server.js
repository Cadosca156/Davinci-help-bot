const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');

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
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSearchValue(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`ʼґ]/g, (char) => (char === 'ґ' ? 'г' : ''))
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemWord(word) {
  const normalized = normalizeSearchValue(word);
  if (normalized.length <= 4) return normalized;

  const suffixes = [
    'ського', 'цького', 'енький', 'енька', 'еньке', 'ання', 'ення', 'иями', 'ями', 'ами',
    'ого', 'ому', 'ими', 'ими', 'ою', 'ею', 'ією', 'ість', 'істю', 'ний', 'ній', 'ська',
    'ське', 'ські', 'ого', 'его', 'ими', 'ої', 'ій', 'их', 'им', 'ам', 'ям', 'ах', 'ях',
    'ою', 'ею', 'ю', 'а', 'я', 'и', 'і', 'ї', 'е', 'у', 'о', 'є', 'й', 'ь',
  ];

  for (const suffix of suffixes) {
    if (normalized.endsWith(suffix) && normalized.length - suffix.length >= 3) {
      return normalized.slice(0, -suffix.length);
    }
  }

  return normalized;
}

function tokenizeSearchText(value = '') {
  return normalizeSearchValue(value)
    .split(' ')
    .map(stemWord)
    .filter((word) => word.length >= 2);
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}

function wordsAreSimilar(queryWord, candidateWord) {
  if (!queryWord || !candidateWord) return false;
  if (queryWord === candidateWord) return true;
  if (queryWord.length >= 4 && candidateWord.length >= 4 && (queryWord.includes(candidateWord) || candidateWord.includes(queryWord))) return true;

  const longest = Math.max(queryWord.length, candidateWord.length);
  if (longest < 5) return false;
  const similarity = 1 - levenshteinDistance(queryWord, candidateWord) / longest;
  return similarity >= 0.72;
}

function findSimilarTerms(queries, text) {
  const textTokens = tokenizeSearchText(text);
  return queries.filter((query) => {
    const queryTokens = tokenizeSearchText(query);
    if (!queryTokens.length) return false;
    return queryTokens.every((queryToken) => textTokens.some((textToken) => wordsAreSimilar(queryToken, textToken)));
  });
}

const TRANSLATION_GROUPS = [
  ['music', 'музика', 'музыка'],
  ['rock', 'рок'],
  ['pop', 'поп', 'попса'],
  ['rap', 'реп', 'hip hop', 'хіп хоп', 'хип хоп'],
  ['r&b', 'rnb', 'рнб'],
  ['electronic', 'електроніка', 'электроника', 'edm'],
  ['jazz', 'джаз'],
  ['classical', 'класика', 'classical music'],
  ['indie', 'інді', 'инди'],
  ['metal', 'метал'],
  ['game', 'games', 'ігри', 'игры', 'gaming', 'геймінг', 'гейминг'],
  ['shooter', 'шутер', 'стрілялки', 'стрелялки'],
  ['rpg', 'рольові ігри', 'ролевые игры'],
  ['strategy', 'стратегія', 'стратегия'],
  ['moba', 'моба'],
  ['anime', 'аніме', 'аниме'],
  ['travel', 'подорожі', 'путешествия', 'travelling'],
  ['sport', 'спорт', 'sports'],
  ['books', 'книги', 'література', 'литература'],
  ['movies', 'фільми', 'кино', 'movies'],
];

const ARTIST_GENRES = [
  { names: ['the weeknd', 'weeknd', 'вікенд'], genres: ['pop', 'r&b', 'synth pop'] },
  { names: ['billie eilish', 'біллі айліш', 'билли айлиш'], genres: ['pop', 'alternative', 'indie'] },
  { names: ['taylor swift', 'тейлор свіфт', 'тейлор свифт'], genres: ['pop', 'country', 'indie'] },
  { names: ['eminem', 'емінем', 'эminem'], genres: ['rap', 'hip hop'] },
  { names: ['drake', 'дрейк'], genres: ['rap', 'hip hop', 'r&b'] },
  { names: ['metallica', 'металіка', 'металлика'], genres: ['metal', 'rock'] },
  { names: ['nirvana', 'нірвана', 'нирвана'], genres: ['rock', 'grunge'] },
  { names: ['шклярський', 'скрябін', 'скрябин', 'skryabin'], genres: ['pop rock', 'rock', 'ukrainian music'] },
  { names: ['океан ельзи', 'okean elzy'], genres: ['rock', 'pop rock', 'ukrainian music'] },
  { names: ['hardkiss', 'the hardkiss', 'хардкіс'], genres: ['rock', 'pop rock', 'alternative'] },
  { names: ['alyona alyona', 'альона альона'], genres: ['rap', 'hip hop', 'ukrainian music'] },
  { names: ['monatik', 'монатік', 'монатик'], genres: ['pop', 'dance'] },
];

const GAME_GENRES = [
  { names: ['counter strike', 'counter-strike', 'cs2', 'кс', 'контра'], genres: ['shooter', 'fps', 'esports'] },
  { names: ['dota', 'dota 2', 'дота'], genres: ['moba', 'strategy', 'esports'] },
  { names: ['league of legends', 'lol', 'ліга легенд', 'лига легенд'], genres: ['moba', 'strategy', 'esports'] },
  { names: ['valorant', 'валорант'], genres: ['shooter', 'fps', 'esports'] },
  { names: ['minecraft', 'майнкрафт'], genres: ['sandbox', 'survival', 'creative'] },
  { names: ['genshin impact', 'геншин'], genres: ['rpg', 'anime', 'adventure'] },
  { names: ['witcher', 'відьмак', 'ведьмак'], genres: ['rpg', 'fantasy', 'adventure'] },
  { names: ['stalker', 's.t.a.l.k.e.r', 'сталкер'], genres: ['shooter', 'survival', 'post apocalyptic'] },
  { names: ['civilization', 'цивілізація', 'цивилизация'], genres: ['strategy', 'turn based'] },
];

function expandTermsWithTranslations(terms) {
  const expanded = new Set(terms);
  for (const term of terms) {
    const normalizedTerm = normalizeSearchValue(term);
    for (const group of TRANSLATION_GROUPS) {
      if (group.some((variant) => wordsAreSimilar(stemWord(normalizedTerm), stemWord(variant)) || normalizeSearchValue(variant) === normalizedTerm)) {
        group.forEach((variant) => expanded.add(variant));
      }
    }
  }
  return [...expanded];
}

function detectKnownConcepts(text) {
  const artists = [];
  const games = [];
  for (const artist of ARTIST_GENRES) {
    if (findSimilarTerms(artist.names, text).length) artists.push(artist);
  }
  for (const game of GAME_GENRES) {
    if (findSimilarTerms(game.names, text).length) games.push(game);
  }
  return { artists, games };
}

function analyzeKnownConceptBonus(text, interests, keywords) {
  const concepts = detectKnownConcepts(text);
  const preferenceTerms = expandTermsWithTranslations([...interests, ...keywords]);
  const matchedConcepts = [];

  for (const artist of concepts.artists) {
    const matchedGenres = findSimilarTerms(preferenceTerms, artist.genres.join(' '));
    if (matchedGenres.length) {
      matchedConcepts.push({ type: 'artist', name: artist.names[0], genres: artist.genres, matchedBy: matchedGenres });
    }
  }

  for (const game of concepts.games) {
    const matchedGenres = findSimilarTerms(preferenceTerms, game.genres.join(' '));
    if (matchedGenres.length) {
      matchedConcepts.push({ type: 'game', name: game.names[0], genres: game.genres, matchedBy: matchedGenres });
    }
  }

  return {
    matchedConcepts,
    bonusPoints: Math.min(20, matchedConcepts.length * 8),
    explanation: matchedConcepts.length
      ? `Знайдено жанрові збіги: ${matchedConcepts.map((item) => `${item.name} → ${item.genres.join(', ')}`).join('; ')}`
      : '',
  };
}

function extractResponseText(response) {
  if (response.output_text) return response.output_text;
  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
    }
  }
  return chunks.join('\n');
}

async function analyzeProfileWithOpenAI({ text, media, interests, keywords }) {
  if (!process.env.OPENAI_API_KEY) return null;

  const imageInputs = media
    .filter((item) => item.kind === 'image' && item.dataUrl && !item.skipped)
    .slice(0, 3)
    .map((item) => ({ type: 'input_image', image_url: item.dataUrl }));

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6',
      input: [
        {
          role: 'system',
          content: 'You analyze dating profile text and images. Identify artists, games, hobbies, genres, multilingual keyword matches, and return strict JSON only.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Profile text:\n${text || '(no text)'}\n\nUser interests: ${interests.join(', ')}\nStop keywords: ${keywords.join(', ')}\n\nReturn JSON with keys: bonusPoints number 0-30, matchedConcepts array, translatedMatches array, explanation string in Ukrainian. Add bonus when an artist/game/object in text or image belongs to a genre/category matching interests or keywords in any language.`,
            },
            ...imageInputs,
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI analysis failed: ${errorText}`);
  }

  const data = await response.json();
  const outputText = extractResponseText(data).trim().replace(/^```json\s*|```$/g, '');
  const parsed = JSON.parse(outputText);
  return {
    bonusPoints: Math.max(0, Math.min(30, Number(parsed.bonusPoints || 0))),
    matchedConcepts: Array.isArray(parsed.matchedConcepts) ? parsed.matchedConcepts : [],
    translatedMatches: Array.isArray(parsed.translatedMatches) ? parsed.translatedMatches : [],
    explanation: parsed.explanation || '',
    usedOpenAI: true,
  };
}

async function buildSemanticAnalysis({ text, media, interests, keywords, aiEnabled }) {
  const expandedInterests = expandTermsWithTranslations(interests);
  const expandedKeywords = expandTermsWithTranslations(keywords);
  const knownConcepts = analyzeKnownConceptBonus(text, interests, keywords);
  const analysis = {
    enabled: Boolean(aiEnabled),
    usedOpenAI: false,
    bonusPoints: knownConcepts.bonusPoints,
    matchedConcepts: knownConcepts.matchedConcepts,
    translatedMatches: [],
    explanation: knownConcepts.explanation,
    warning: '',
  };

  if (aiEnabled) {
    try {
      const openAiAnalysis = await analyzeProfileWithOpenAI({ text, media, interests, keywords });
      if (openAiAnalysis) {
        analysis.usedOpenAI = true;
        analysis.bonusPoints = Math.min(30, analysis.bonusPoints + openAiAnalysis.bonusPoints);
        analysis.matchedConcepts = [...analysis.matchedConcepts, ...openAiAnalysis.matchedConcepts];
        analysis.translatedMatches = openAiAnalysis.translatedMatches;
        analysis.explanation = [analysis.explanation, openAiAnalysis.explanation].filter(Boolean).join(' ');
      } else {
        analysis.warning = 'OPENAI_API_KEY не задано, використано локальний словниковий AI-шар без аналізу фото.';
      }
    } catch (error) {
      analysis.warning = safeError(error);
    }
  }

  return { expandedInterests, expandedKeywords, analysis };
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


function getMessageMediaMeta(message) {
  const media = message.media;
  if (!media) return null;

  if (media.photo) {
    return { kind: 'image', mimeType: 'image/jpeg', fileName: 'profile-photo.jpg', size: 0 };
  }

  const document = media.document;
  const mimeType = document?.mimeType || '';
  if (!document || (!mimeType.startsWith('image/') && !mimeType.startsWith('video/'))) return null;

  return {
    kind: mimeType.startsWith('video/') ? 'video' : 'image',
    mimeType,
    fileName: document.attributes?.find((attribute) => attribute.fileName)?.fileName || `profile-media.${mimeType.split('/')[1] || 'bin'}`,
    size: Number(document.size || 0),
  };
}

async function extractMessageMedia(client, message) {
  const meta = getMessageMediaMeta(message);
  if (!meta) return [];

  const maxBytes = 20 * 1024 * 1024;
  if (meta.size > maxBytes) {
    return [{ ...meta, skipped: true, reason: 'Медіа більше 20 МБ, тому не вбудовано у сторінку.' }];
  }

  const buffer = await client.downloadMedia(message, { workers: 1 });
  if (!buffer || !buffer.length) return [];

  return [{
    ...meta,
    size: buffer.length,
    dataUrl: `data:${meta.mimeType};base64,${Buffer.from(buffer).toString('base64')}`,
  }];
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
      const passwordInfo = await flow.client.invoke(new Api.account.GetPassword());
      const passwordCheck = await computeCheck(passwordInfo, password);
      await flow.client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
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
  const { botUsername = DEFAULT_BOT_USERNAME, threshold = 70, interests = '', keywords = '', aiEnabled = false } = req.body;
  try {
    const entity = await req.telegram.client.getEntity(botUsername);
    const messages = await req.telegram.client.getMessages(entity, { limit: 1 });
    const message = messages[0];
    if (!message) return res.status(404).json({ error: 'Повідомлення від бота не знайдено. Напишіть /start боту з додатка.' });

    const text = message.message || '';
    const media = await extractMessageMedia(req.telegram.client, message);
    const userInterests = normalizeList(interests);
    const stopWords = normalizeList(keywords);
    const { expandedInterests, expandedKeywords, analysis } = await buildSemanticAnalysis({ text, media, interests: userInterests, keywords: stopWords, aiEnabled });
    const matchedInterests = findSimilarTerms(expandedInterests, text);
    const matchedKeywords = findSimilarTerms(expandedKeywords, text);
    const basePercent = userInterests.length ? Math.round((matchedInterests.length / userInterests.length) * 100) : 0;
    const percent = Math.min(100, basePercent + analysis.bonusPoints);
    const shouldStop = percent >= Number(threshold) || matchedKeywords.length > 0;

    if (!shouldStop) {
      await req.telegram.client.sendMessage(entity, { message: '👎' });
    }

    res.json({
      text,
      percent,
      basePercent,
      aiBonus: analysis.bonusPoints,
      aiAnalysis: analysis,
      matchedInterests,
      matchedKeywords,
      media,
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
