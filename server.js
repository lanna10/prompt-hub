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
function ensureDataDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} }
ensureDataDir();

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

// POST /api/prompt  { image: "data:image/...;base64,..." }  ->  { prompt: "..." }
app.post('/api/prompt', async (req, res) => {
  try {
    const { image, previous } = req.body || {};
    if (!image) return res.status(400).json({ error: 'No image provided.' });
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing OPENAI_API_KEY.' });
    }

    let instruction =
      'You are an expert Midjourney prompt writer for moody, cinematic nightlife and fashion content. ' +
      'Study the uploaded image closely and write ONE richly descriptive, highly detailed Midjourney prompt that ' +
      'faithfully recreates its vibe so generated results closely match it: the setting and scene, the subjects and ' +
      'their styling, the lighting, color palette, mood, era, and the camera/film texture. Be specific and evocative — ' +
      'name concrete real-world references, locations, eras, and aesthetics where they fit. ' +
      'Match the style of these examples:\n' +
      '"Berlin Berghain-inspired techno club, massive concrete industrial hall, black-clad crowd dancing under harsh ' +
      'strobe lights, smoke machines, dark corners, steel railings, red ambient lighting, gritty documentary realism, ' +
      'grainy early 2000s flash photography, underground nightlife atmosphere"\n' +
      '"1980s European jet-set nightclub on the Amalfi Coast, glamorous crowd dancing beneath disco lights beside the ' +
      'sea, cigarette smoke, champagne towers, shadowy VIP corridors, cinematic analog film grain, decadent ' +
      'Mediterranean nightlife atmosphere"\n' +
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
      'You are an expert Midjourney prompt writer for moody, cinematic nightlife and fashion content. ' +
      'Take the user\'s short idea and expand it into ONE richly descriptive, highly detailed Midjourney prompt that ' +
      'brings it to life: a vivid setting and scene, the subjects and their styling, lighting, color palette, mood, era, ' +
      'and camera/film texture. Be specific and evocative — name concrete real-world references, locations, eras, and ' +
      'aesthetics where they fit, while staying true to the user\'s idea. ' +
      'Match the style of these examples:\n' +
      '"Berlin Berghain-inspired techno club, massive concrete industrial hall, black-clad crowd dancing under harsh ' +
      'strobe lights, smoke machines, dark corners, steel railings, red ambient lighting, gritty documentary realism, ' +
      'grainy early 2000s flash photography, underground nightlife atmosphere"\n' +
      '"1980s European jet-set nightclub on the Amalfi Coast, glamorous crowd dancing beneath disco lights beside the ' +
      'sea, cigarette smoke, champagne towers, shadowy VIP corridors, cinematic analog film grain, decadent ' +
      'Mediterranean nightlife atmosphere"\n' +
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
        'You are a creative director helping the user develop Midjourney image prompts for moody, cinematic ' +
        'nightlife and fashion content (same world as: "Berlin Berghain-inspired techno club… gritty documentary ' +
        'realism, grainy early 2000s flash photography" and "1980s Amalfi Coast jet-set nightclub… cinematic analog ' +
        'film grain"). Chat naturally and briefly to help them shape their idea, asking the occasional clarifying ' +
        'question. Whenever you propose a ready-to-use prompt, put it on its own line, write it as rich comma-separated ' +
        'descriptive phrases (setting, subjects, styling, lighting, color, mood, era, film texture), and end that line ' +
        'with " --ar 9:16". Keep replies concise.'
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
    params.set('limit', String(req.query.limit || '12'));
    if (req.query.sort_by) params.set('sort_by', String(req.query.sort_by));
    params.set('include_image_url', 'true');
    const url = 'https://api.chartex.com/external/v1/tiktok/accounts/' +
      encodeURIComponent(username) + '/video-statistics/?' + params.toString();
    const r = await fetch(url, {
      headers: { 'X-APP-ID': process.env.CHARTEX_APP_ID, 'X-APP-TOKEN': process.env.CHARTEX_APP_TOKEN }
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: 'Chartex ' + r.status + ': ' + text.slice(0, 200) });
    let data;
    try { data = JSON.parse(text); } catch (e) { return res.status(502).json({ error: 'Unexpected response from Chartex.' }); }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unexpected server error.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Prompt Hub listening on port ' + PORT));
