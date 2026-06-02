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
      'You are an expert Midjourney prompt engineer. Do NOT literally describe what is in this image. ' +
      'Instead, write ONE Midjourney prompt that would GENERATE NEW images with the same overall look and vibe — ' +
      'matching the aesthetic, style, mood, color grading, lighting, camera/film look, grain/texture, and composition feel, ' +
      'so the results feel like they belong to the same series. Keep the subject general enough to allow variation ' +
      'rather than copying the exact scene. Use concise, comma-separated style descriptors (medium/art style, lighting, ' +
      'color palette, mood, lens or film stock, grain, era, composition). ' +
      'Output ONLY the prompt text — no quotes, no preamble, no explanation. End the prompt with " --ar 9:16".';

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 320,
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
