const http = require('http');
const { LUMI_PERSONALITY } = require('./personality');

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const allowed = new Set([
  'happy',
  'shy',
  'surprised',
  'playful',
  'angry',
  'sad',
  'distracted'
]);

let tiktokModulePromise = null;
let tiktokConnection = null;
let tiktokStatus = {
  connected: false,
  connecting: false,
  username: '',
  roomId: '',
  error: ''
};
let tiktokEvents = [];
let nextEventId = 1;

function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });

  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', chunk => {
      raw += chunk;

      if (raw.length > 50000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function parseJsonText(text) {
  text = String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  return JSON.parse(text);
}

function makeContents(history, message) {
  const contents = [];

  for (const item of history) {
    if (!item || typeof item.content !== 'string') continue;

    if (item.role === 'user') {
      contents.push({
        role: 'user',
        parts: [{ text: item.content }]
      });
    }

    if (item.role === 'assistant') {
      contents.push({
        role: 'model',
        parts: [{ text: item.content }]
      });
    }
  }

  contents.push({
    role: 'user',
    parts: [{ text: message }]
  });

  return contents;
}

function emotionOverride(message, modelEmotion) {
  const m = String(message || '').toLowerCase();

  const distractedPatterns = [
    /what (are|r) you doing/,
    /what you doing/,
    /what('s| is) lumi doing/,
    /are you busy/,
    /on your phone/,
    /using your phone/,
    /checking your phone/,
    /on the computer/,
    /using the computer/,
    /at the computer/,
    /typing/,
    /checking something/
  ];

  if (distractedPatterns.some(pattern => pattern.test(m))) {
    return 'distracted';
  }

  return modelEmotion;
}

function pushTikTokEvent(event) {
  const item = {
    id: nextEventId++,
    at: Date.now(),
    ...event
  };

  tiktokEvents.push(item);

  if (tiktokEvents.length > 200) {
    tiktokEvents = tiktokEvents.slice(-200);
  }

  return item;
}

async function loadTikTokModule() {
  if (!tiktokModulePromise) {
    tiktokModulePromise = import('tiktok-live-connector');
  }

  return tiktokModulePromise;
}

async function disconnectTikTok() {
  if (tiktokConnection) {
    try {
      tiktokConnection.disconnect();
    } catch (error) {
      console.error('TikTok disconnect error:', error);
    }
  }

  tiktokConnection = null;
  tiktokStatus.connected = false;
  tiktokStatus.connecting = false;
  tiktokStatus.roomId = '';
}

async function connectTikTok(username) {
  const cleanUsername = String(username || '')
    .trim()
    .replace(/^@/, '');

  if (!cleanUsername) {
    throw new Error('TikTok username is required');
  }

  await disconnectTikTok();

  tiktokStatus = {
    connected: false,
    connecting: true,
    username: cleanUsername,
    roomId: '',
    error: ''
  };

  const { TikTokLiveConnection, WebcastEvent } =
    await loadTikTokModule();

  const connection = new TikTokLiveConnection(cleanUsername, {
    processInitialData: false,
    enableExtendedGiftInfo: true
  });

  connection.on(WebcastEvent.CHAT, data => {
    const viewer =
      data?.user?.uniqueId ||
      data?.user?.nickname ||
      'viewer';

    const comment = String(data?.comment || '').trim();

    if (!comment) return;

    pushTikTokEvent({
      type: 'chat',
      viewer,
      comment
    });
  });

  tiktokConnection = connection;

  try {
    const state = await connection.connect();

    tiktokStatus.connected = true;
    tiktokStatus.connecting = false;
    tiktokStatus.roomId = String(
      state?.roomId ||
      connection?.roomId ||
      ''
    );
    tiktokStatus.error = '';

    return { ...tiktokStatus };
  } catch (error) {
    tiktokStatus.connected = false;
    tiktokStatus.connecting = false;
    tiktokStatus.error =
      error?.message || 'TikTok connection failed';
    tiktokConnection = null;
    throw error;
  }
}

async function handleBrainChat(req, res) {
  if (!API_KEY) {
    return send(res, 503, {
      error:
        'Lumi Brain is not configured. Add GEMINI_API_KEY in Render.'
    });
  }

  try {
    const body = await readBody(req);
    const message = String(body.message || '').trim();

    if (!message) {
      return send(res, 400, {
        error: 'Message is required'
      });
    }

    const history = Array.isArray(body.history)
      ? body.history
          .slice(-12)
          .filter(
            item =>
              item &&
              ['user', 'assistant'].includes(item.role) &&
              typeof item.content === 'string'
          )
      : [];

    const apiUrl =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(MODEL) +
      ':generateContent';

    let response;

    for (let attempt = 0; attempt < 4; attempt++) {
      response = await fetch(apiUrl, {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': API_KEY
        },

        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: LUMI_PERSONALITY
              }
            ]
          },

          contents: makeContents(history, message),

          generationConfig: {
            temperature: 0.85,
            responseMimeType: 'application/json'
          }
        })
      });

      if (response.status !== 503 || attempt === 3) {
        break;
      }

      const waitMs = 1000 * Math.pow(2, attempt);
      await new Promise(resolve =>
        setTimeout(resolve, waitMs)
      );
    }

    if (!response.ok) {
      const detail = await response.text();

      throw new Error(
        'Gemini error ' +
          response.status +
          ': ' +
          detail.slice(0, 300)
      );
    }

    const data = await response.json();

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part?.text || '')
        .join('')
        .trim() || '';

    const output = parseJsonText(text);

    if (
      typeof output.reply !== 'string' ||
      !output.reply.trim() ||
      !allowed.has(output.emotion)
    ) {
      throw new Error(
        'Gemini returned an invalid Lumi response'
      );
    }

    const finalEmotion = emotionOverride(
      message,
      output.emotion
    );

    return send(res, 200, {
      reply: output.reply.trim(),
      emotion: finalEmotion
    });

  } catch (error) {
    console.error('LUMI ERROR:', error);

    return send(res, 500, {
      error: error.message || 'Lumi Brain error'
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return send(res, 204, {});
  }

  const requestUrl = new URL(
    req.url,
    'http://localhost'
  );

  if (
    req.method === 'GET' &&
    (requestUrl.pathname === '/' ||
      requestUrl.pathname === '/health')
  ) {
    return send(res, 200, {
      ok: true,
      service: 'Lumi Brain',
      configured: Boolean(API_KEY),
      tiktok: {
        installed: true,
        connected: tiktokStatus.connected,
        username: tiktokStatus.username
      }
    });
  }

  if (
    requestUrl.pathname === '/lumi/chat' &&
    req.method === 'POST'
  ) {
    return handleBrainChat(req, res);
  }

  if (
    requestUrl.pathname === '/tiktok/status' &&
    req.method === 'GET'
  ) {
    return send(res, 200, {
      ok: true,
      ...tiktokStatus
    });
  }

  if (
    requestUrl.pathname === '/tiktok/events' &&
    req.method === 'GET'
  ) {
    const after = Number(
      requestUrl.searchParams.get('after') || 0
    );

    const events = tiktokEvents.filter(
      item => item.id > after
    );

    return send(res, 200, {
      ok: true,
      events
    });
  }

  if (
    requestUrl.pathname === '/tiktok/connect' &&
    req.method === 'POST'
  ) {
    try {
      const body = await readBody(req);
      const status = await connectTikTok(
        body.username
      );

      return send(res, 200, {
        ok: true,
        ...status
      });
    } catch (error) {
      return send(res, 400, {
        ok: false,
        error:
          error?.message ||
          'TikTok connection failed',
        ...tiktokStatus
      });
    }
  }

  if (
    requestUrl.pathname === '/tiktok/disconnect' &&
    req.method === 'POST'
  ) {
    await disconnectTikTok();

    return send(res, 200, {
      ok: true,
      ...tiktokStatus
    });
  }

  return send(res, 404, {
    error: 'Not found'
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Lumi Brain ready on port ${PORT}`
  );
});
