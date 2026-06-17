// FitTrack server: serves the static app + an AI food-estimate API.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.FITTRACK_MODEL || 'claude-opus-4-8';

// Lazily construct the Anthropic client so the static site still serves
// even if the SDK or API key isn't present.
let anthropic = null;
function getClient() {
  if (anthropic) return anthropic;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return anthropic;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const NUTRITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    food: { type: 'string', description: 'Cleaned, concise name of the food/meal' },
    kcal: { type: 'integer', description: 'Total calories for the serving described' },
    protein: { type: 'integer', description: 'Protein in grams' },
    carbs: { type: 'integer', description: 'Carbohydrates in grams' },
    fat: { type: 'integer', description: 'Fat in grams' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    assumptions: { type: 'string', description: 'One short sentence on portion/ingredient assumptions' },
  },
  required: ['food', 'kcal', 'protein', 'carbs', 'fat', 'confidence', 'assumptions'],
};

const SYSTEM_PROMPT =
  'You are a precise nutrition estimator for a personal calorie-tracking app. ' +
  'Given a free-text food or meal description, estimate the calories and macronutrients ' +
  'for a single typical serving exactly as described. Reason carefully about the actual ' +
  'ingredients and realistic portion sizes — restaurant and takeout portions are larger ' +
  'than home-cooked ones, and composed dishes (e.g. a salmon bagel with cream cheese and onion) ' +
  'are the sum of their parts. If the user states a quantity or size, honor it precisely; ' +
  'otherwise assume one normal serving. Return integer grams and calories. ' +
  'Set confidence honestly (low if the description is vague or portion is ambiguous). ' +
  'Keep assumptions to one short sentence.';

async function estimate(description) {
  const client = getClient();
  if (!client) {
    const e = new Error('AI estimator not configured: ANTHROPIC_API_KEY is not set on the server.');
    e.code = 'NO_KEY';
    throw e;
  }
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: 'Estimate nutrition for: ' + description }],
    output_config: { format: { type: 'json_schema', schema: NUTRITION_SCHEMA } },
  });
  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No response from model');
  return JSON.parse(textBlock.text);
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  // ---- API: POST /api/estimate { description } ----
  if (req.method === 'POST' && req.url === '/api/estimate') {
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4000) { tooBig = true; req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return sendJSON(res, 413, { error: 'Description too long.' });
      let description = '';
      try { description = (JSON.parse(raw).description || '').toString().trim(); } catch (e) {}
      if (!description) return sendJSON(res, 400, { error: 'Please enter a food to estimate.' });
      try {
        const result = await estimate(description);
        sendJSON(res, 200, result);
      } catch (err) {
        if (err.code === 'NO_KEY') return sendJSON(res, 503, { error: err.message, code: 'NO_KEY' });
        console.error('estimate error:', err && err.message);
        sendJSON(res, 502, { error: 'Could not estimate that food. Try rephrasing, or add it manually.' });
      }
    });
    return;
  }

  // ---- Static files ----
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(__dirname, safe);

  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('FitTrack running on port ' + PORT + ' (model: ' + MODEL + ')'));
