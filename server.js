// Prompt Hub backend — serves the static page and proxies image→prompt requests
// to OpenAI so the API key stays on the server (never in the browser).
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Serve the static site (index.html etc.) from this folder
app.use(express.static(__dirname));

// Builds a strong "make this version different" instruction for regenerations.
const VARIATION_AXES = [
  'an extreme wide establishing shot', 'a tight intimate close-up', 'a high overhead / aerial angle',
  'a low-angle shot looking up', 'a candid over-the-shoulder snapshot', 'a profile side view',
  'shot on a disposable camera with harsh direct flash', 'shot on grainy Super 8 film',
  'shot on large-format film with shallow depth of field', 'a CCTV / security-camera still',
  'a blurry motion-filled action frame', 'a mirror / reflection shot',
  'golden-hour warm light', 'cold blue 3am light', 'harsh midday sun', 'neon-soaked night',
  'foggy / hazy atmosphere', 'rain-soaked reflective surfaces', 'backlit silhouette', 'deep shadow chiaroscuro'
];
function divergenceNote(previous) {
  if (!previous || !previous.trim()) return '';
  const a = VARIATION_AXES[Math.floor(Math.random() * VARIATION_AXES.length)];
  let b = VARIATION_AXES[Math.floor(Math.random() * VARIATION_AXES.length)];
  if (b === a) b = VARIATION_AXES[(VARIATION_AXES.indexOf(a) + 5) % VARIATION_AXES.length];
  return '\n\nIMPORTANT: This is an ALTERNATE version. Keep ONLY the same overall vibe and aesthetic family ' +
    '(mood, genre, color world, era) — but make the actual image clearly DIFFERENT, NOT a near-duplicate. ' +
    'Change the specific scene and location, the subjects and what they are doing, the composition, camera angle, ' +
    'lens/film stock, lighting, time of day, and color accents. For this version specifically, reinterpret it as ' +
    a + ' and ' + b + '. Previous prompt to clearly diverge from: "' + previous.trim() + '".';
}

// ---- Persistent storage (tabs, prompts, moodboard images) ----
// Uses a Render persistent disk mounted at /var/data (override with DATA_DIR).
const DATA_DIR = process.env.DATA_DIR || '/var/data';
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const IMG_DIR = path.join(DATA_DIR, 'img');
function ensureDataDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.mkdirSync(IMG_DIR, { recursive: true }); } catch (e) {} }
ensureDataDir();

// Serve stored moodboard images as files
app.use('/img', express.static(IMG_DIR));

// One-time migration: pull any base64 images out of state.json into individual files
function migrateImagesToFiles() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!state || !state.images || typeof state.images !== 'object') return;
    let changed = false;
    for (const tab of Object.keys(state.images)) {
      const arr = Array.isArray(state.images[tab]) ? state.images[tab] : [];
      state.images[tab] = arr.map(im => {
        if (im && im.dataUrl) {
          const m = /^data:image\/(\w+);base64,(.*)$/.exec(im.dataUrl);
          if (m) {
            const ext = m[1].replace('jpeg', 'jpg');
            const id = im.id || ('img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
            try {
              fs.writeFileSync(path.join(IMG_DIR, id + '.' + ext), Buffer.from(m[2], 'base64'));
              changed = true;
              return { id: id, ext: ext, ts: im.ts || Date.now() };
            } catch (e) { return im; }
          }
        }
        return im;
      });
    }
    if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  } catch (e) { console.log('image migration skipped:', e.message); }
}
migrateImagesToFiles();

app.get('/api/data', (req, res) => {
  try {
    if (fs.existsSync(DATA_FILE)) {
      res.type('application/json').send(fs.readFileSync(DATA_FILE, 'utf8'));
    } else {
      res.json({});
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/data', (req, res) => {
  try {
    ensureDataDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify(req.body || {}));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/image  { dataUrl }  -> saves image file, returns { id, ext }
app.post('/api/image', (req, res) => {
  try {
    const dataUrl = (req.body && req.body.dataUrl) || '';
    const m = /^data:image\/(\w+);base64,(.*)$/.exec(dataUrl);
    if (!m) return res.status(400).json({ error: 'Bad image data.' });
    ensureDataDir();
    const ext = m[1].replace('jpeg', 'jpg');
    const id = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    fs.writeFileSync(path.join(IMG_DIR, id + '.' + ext), Buffer.from(m[2], 'base64'));
    res.json({ id: id, ext: ext });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected server error.' });
  }
});

// DELETE /api/image/:file  -> removes an image/video file
app.delete('/api/image/:file', (req, res) => {
  try { fs.unlinkSync(path.join(IMG_DIR, path.basename(req.params.file))); } catch (e) {}
  res.json({ ok: true });
});

// GET /api/media-files  -> lists every image/video file currently on disk (for recovery)
app.get('/api/media-files', (req, res) => {
  try {
    ensureDataDir();
    const files = fs.readdirSync(IMG_DIR).filter(f => !f.startsWith('.'));
    const list = files.map(f => { const i = f.lastIndexOf('.'); return { id: i >= 0 ? f.slice(0, i) : f, ext: i >= 0 ? f.slice(i + 1) : '' }; });
    res.json({ files: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/upload?ext=mp4  (raw binary body) -> streams file to disk, returns { id, ext }
// Used for moodboard images AND videos. Streaming avoids loading the whole file into memory.
app.post('/api/upload', (req, res) => {
  try {
    ensureDataDir();
    const ext = String(req.query.ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
    const id = 'med_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const filePath = path.join(IMG_DIR, id + '.' + ext);
    const ws = fs.createWriteStream(filePath);
    let done = false;
    const fail = (e) => { if (done) return; done = true; try { ws.destroy(); fs.unlinkSync(filePath); } catch (x) {} res.status(500).json({ error: (e && e.message) || 'upload failed' }); };
    req.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => { if (done) return; done = true; res.json({ id: id, ext: ext }); });
    req.pipe(ws);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected server error.' });
  }
});

// POST /api/prompt  { image: "data:image/...;base64,..." }  ->  { prompt: "..." }
app.post('/api/prompt', async (req, res) => {
  try {
    const { image, previous } = req.body || {};
    if (!image) return res.status(400).json({ error: 'No image provided.' });
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing OPENAI_API_KEY.' });
    }

    let instruction =
      'You are an expert Midjourney prompt writer who creates PHOTO-REALISTIC, candid images that do NOT look AI-generated. ' +
      'Study the uploaded image and write ONE detailed prompt that recreates its vibe as a believable real photograph: ' +
      'the setting and scene, the exact number of people and what they are doing, their wardrobe and styling, the location, ' +
      'the lighting, and a real camera / film look. Favour authentic detail — natural skin texture, slight motion blur, ' +
      'candid framing, real imperfections, everyday realism. Always name a concrete camera or film look such as ' +
      '"shot on Kodak Gold 200 35mm film", "candid direct-flash snapshot", "grainy disposable camera photo", or "amateur iPhone photo". ' +
      'Avoid CGI / render words like hyperrealistic, 8k, ultra-detailed, octane, cinematic render. ' +
      'Match the realistic style of these examples:\n' +
      '"Formula 1 VIP box at sunset, 4 guests leaning over the balcony with headphones on while cars speed through the corner below, warm orange track light, champagne bucket, realistic grainy motorsport photography"\n' +
      '"modern Formula 1 suite bathroom mirror photo, 2 people only, race track visible through the window behind them, champagne, wristbands, designer sunglasses, candid flash, subtle analog grain"\n' +
      'Write about 35-60 words as comma-separated descriptive phrases. ' +
      'Output ONLY the prompt text — no quotes, no preamble, no explanation. End the prompt with " --ar 9:16".';
    instruction += divergenceNote(previous);

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 400,
        temperature: 1.05,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: image } }
          ]
        }]
      })
    });

    const data = await r.json();
    if (!r.ok || data.error) {
      return res.status(502).json({ error: (data.error && data.error.message) || ('OpenAI error ' + r.status) });
    }
    const prompt = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    res.json({ prompt });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected server error.' });
  }
});

// POST /api/text-prompt  { text: "rough idea" }  ->  { prompt: "..." }
app.post('/api/text-prompt', async (req, res) => {
  try {
    const { text, previous } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'No description provided.' });
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing OPENAI_API_KEY.' });
    }

    let instruction =
      'You are an expert Midjourney prompt writer who creates PHOTO-REALISTIC, candid images that do NOT look AI-generated. ' +
      'Take the user\'s short idea and expand it into ONE detailed prompt that reads like a believable real photograph: ' +
      'a specific setting and scene, the exact number of people and what they are doing, their wardrobe and styling, the ' +
      'location, the lighting, and a real camera / film look. Favour authentic detail — natural skin texture, slight motion ' +
      'blur, candid framing, real imperfections, everyday realism. Always name a concrete camera or film look such as ' +
      '"shot on Kodak Gold 200 35mm film", "candid direct-flash snapshot", "grainy disposable camera photo", or "amateur iPhone photo". ' +
      'Avoid CGI / render words like hyperrealistic, 8k, ultra-detailed, octane, cinematic render. ' +
      'Match the realistic style of these examples:\n' +
      '"Formula 1 VIP box at sunset, 4 guests leaning over the balcony with headphones on while cars speed through the corner below, warm orange track light, champagne bucket, realistic grainy motorsport photography"\n' +
      '"modern Formula 1 suite bathroom mirror photo, 2 people only, race track visible through the window behind them, champagne, wristbands, designer sunglasses, candid flash, subtle analog grain"\n' +
      'Write about 35-60 words as comma-separated descriptive phrases. ' +
      'Output ONLY the prompt text — no quotes, no preamble, no explanation. End the prompt with " --ar 9:16".';
    instruction += divergenceNote(previous);

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 400,
        temperature: 1.05,
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: 'Idea: ' + text }
        ]
      })
    });

    const data = await r.json();
    if (!r.ok || data.error) {
      return res.status(502).json({ error: (data.error && data.error.message) || ('OpenAI error ' + r.status) });
    }
    const prompt = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    res.json({ prompt });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected server error.' });
  }
});

// POST /api/chat  { messages: [{role, content}] }  ->  { reply: "..." }
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'No messages provided.' });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Server is missing OPENAI_API_KEY.' });

    const system = {
      role: 'system',
      content:
        'You are a creative director helping the user develop Midjourney image prompts that look like PHOTO-REALISTIC, ' +
        'candid real photographs — NOT AI-generated or cinematic CGI. Chat naturally and briefly to help shape their idea, ' +
        'asking the occasional clarifying question. Whenever you propose a ready-to-use prompt, put it on its own line and ' +
        'write it as comma-separated descriptive phrases covering: the setting/scene, the exact number of people and what ' +
        'they are doing, wardrobe/styling, location, lighting, and a concrete camera or film look (e.g. "shot on Kodak Gold ' +
        '200 35mm film", "candid direct-flash snapshot", "grainy disposable camera photo", "amateur iPhone photo"). Favour ' +
        'authentic detail — natural skin texture, slight motion blur, real imperfections — and avoid render words like ' +
        'hyperrealistic, 8k, ultra-detailed, octane, cinematic render. Style reference: "modern Formula 1 suite bathroom ' +
        'mirror photo, 2 people only, race track visible through the window behind them, champagne, designer sunglasses, ' +
        'candid flash, subtle analog grain". End each prompt line with " --ar 9:16". Keep replies concise.'
    };

    const clean = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content)))
      .slice(-20)
      .map(m => ({ role: m.role, content: m.content }));

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 500,
        temperature: 0.9,
        messages: [system, ...clean]
      })
    });

    const data = await r.json();
    if (!r.ok || data.error) {
      return res.status(502).json({ error: (data.error && data.error.message) || ('OpenAI error ' + r.status) });
    }
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected server error.' });
  }
});

// GET /api/tiktok?username=&sort_by=&limit=  -> Chartex video statistics for an account
app.get('/api/tiktok', async (req, res) => {
  try {
    const username = String(req.query.username || '').replace(/^@/, '').trim();
    if (!username) return res.status(400).json({ error: 'No username provided.' });
    if (!process.env.CHARTEX_APP_ID || !process.env.CHARTEX_APP_TOKEN) {
      return res.status(500).json({ error: 'Server is missing Chartex credentials.' });
    }
    const params = new URLSearchParams();
    params.set('limit', String(req.query.limit || '100'));
    if (req.query.page) params.set('page', String(req.query.page));
    if (req.query.sort_by) params.set('sort_by', String(req.query.sort_by));
    params.set('include_image_url', 'true');
    const url = 'https://api.chartex.com/external/v1/tiktok/accounts/' +
      encodeURIComponent(username) + '/video-statistics/?' + params.toString();
    const r = await fetch(url, {
      headers: { 'X-APP-ID': process.env.CHARTEX_APP_ID, 'X-APP-TOKEN': process.env.CHARTEX_APP_TOKEN }
    });
    const text = await r.text();
    if (r.status === 404 || /not_found/i.test(text)) return res.json({ notTracked: true });
    if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: 'Chartex ' + r.status + ': ' + text.slice(0, 200) });
    let data;
    try { data = JSON.parse(text); } catch (e) { return res.status(502).json({ error: 'Unexpected response from Chartex.' }); }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected server error.' });
  }
});

// POST /api/tiktok-add  { username }  -> adds/tracks the account on Chartex
app.post('/api/tiktok-add', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').replace(/^@/, '').trim();
    if (!username) return res.status(400).json({ error: 'No username provided.' });
    if (!process.env.CHARTEX_APP_ID || !process.env.CHARTEX_APP_TOKEN) {
      return res.status(500).json({ error: 'Server is missing Chartex credentials.' });
    }
    const r = await fetch('https://api.chartex.com/external/v1/tiktok/accounts/add/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-APP-ID': process.env.CHARTEX_APP_ID,
        'X-APP-TOKEN': process.env.CHARTEX_APP_TOKEN
      },
      body: JSON.stringify({ identifier: username })
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: 'Chartex ' + r.status + ': ' + text.slice(0, 200) });
    let data; try { data = JSON.parse(text); } catch (e) { data = { ok: true }; }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected server error.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Prompt Hub listening on port ' + PORT));
