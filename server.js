// Prompt Hub backend — serves the static page and proxies image→prompt requests
// to OpenAI so the API key stays on the server (never in the browser).
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));

// Serve the static site (index.html etc.) from this folder
app.use(express.static(__dirname));

// POST /api/prompt  { image: "data:image/...;base64,..." }  ->  { prompt: "..." }
app.post('/api/prompt', async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ error: 'No image provided.' });
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing OPENAI_API_KEY.' });
    }

    const instruction =
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

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 400,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Prompt Hub listening on port ' + PORT));
