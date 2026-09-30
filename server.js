const http = require('http');
const { LUMI_PERSONALITY } = require('./personality');

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const allowed = new Set([
  'happy',
  'shy',
  'surprised',
  'playful',
  'angry',
  'sad'
]);

function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });

  res.end(JSON.stringify(obj));
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

const server = http.createServer(async (req, res) => {

  if (req.method === 'OPTIONS') {
    return send(res, 204, {});
  }

  if (
    req.method === 'GET' &&
    (req.url === '/' || req.url === '/health')
  ) {
    return send(res, 200, {
      ok: true,
      service: 'Lumi Brain',
      configured: Boolean(API_KEY)
    });
  }

  if (req.url !== '/lumi/chat' || req.method !== 'POST') {
    return send(res, 404, {
      error: 'Not found'
    });
  }

  if (!API_KEY) {
    return send(res, 503, {
      error:
        'Lumi Brain is not configured. Add GEMINI_API_KEY in Render.'
    });
  }

  let raw = '';

  req.on('data', chunk => {
    raw += chunk;

    if (raw.length > 50000) {
      req.destroy();
    }
  });

  req.on('end', async () => {
    try {

      const body = JSON.parse(raw || '{}');
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

      const response = await fetch(apiUrl, {
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

      return send(res, 200, {
        reply: output.reply.trim(),
        emotion: output.emotion
      });

    } catch (error) {

      return send(res, 500, {
        error: error.message || 'Lumi Brain error'
      });

    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Lumi Brain ready on port ${PORT}`
  );
});
