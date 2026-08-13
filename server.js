'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function readBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of Array.isArray(data.output) ? data.output : []) {
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function parseJsonFromModel(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('model_did_not_return_json');
  return JSON.parse(text.slice(first, last + 1));
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

async function analyze(body) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY_not_configured');
  const imageBase64 = String(body.image_base64 || '');
  if (!imageBase64) throw new Error('image_base64_required');

  const learned = Array.isArray(body.learned_abilities)
    ? body.learned_abilities.map(String).slice(0, 80)
    : [];

  const prompt = `Você é o supervisor visual do aplicativo Arena Auto para o jogo Duelo Ninja.\n\nSua função NESTA FASE é somente OBSERVAR a captura de tela e RECOMENDAR a próxima ação. Não execute nada.\n\nPerfil atual: ${String(body.profile || 'não informado')}\nHabilidades que o usuário já ensinou ao app: ${learned.length ? learned.join(' | ') : 'nenhuma cadastrada'}\n\nAnalise a tela e responda APENAS um objeto JSON válido, sem markdown, com exatamente estes campos:\n{\n  "screen_name": "nome curto da tela",\n  "recommended_action": "o que uma pessoa deveria fazer agora, em português",\n  "recommended_skill": "uma habilidade da lista acima, ou NONE",\n  "confidence": 0.0,\n  "reason": "justificativa curta baseada no que está visível",\n  "wait_ms": 3500,\n  "needs_teaching": false\n}\n\nRegras:\n- confidence deve ficar entre 0 e 1.\n- Se a tela estiver carregando, em animação ou incerta, recommended_action = "Aguardar", confidence baixa e wait_ms entre 2500 e 6000.\n- Só escolha recommended_skill se a tela realmente combinar com uma habilidade ensinada.\n- Se houver uma situação nova que não esteja coberta pelas habilidades conhecidas, recommended_skill = "NONE" e needs_teaching = true.\n- Não invente textos, recompensas ou botões que não estejam visíveis.\n- Seja conservador: dúvida é melhor que recomendação errada.\n- Não forneça coordenadas nesta versão.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      store: false,
      max_output_tokens: 350,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBase64}` }
        ]
      }]
    })
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`openai_${response.status}: ${rawText.slice(0, 500)}`);
  }

  const data = JSON.parse(rawText);
  const modelText = extractOutputText(data);
  const parsed = parseJsonFromModel(modelText);

  return {
    screen_name: String(parsed.screen_name || 'Tela não identificada').slice(0, 100),
    recommended_action: String(parsed.recommended_action || 'Aguardar').slice(0, 160),
    recommended_skill: String(parsed.recommended_skill || 'NONE').slice(0, 100),
    confidence: clamp01(parsed.confidence),
    reason: String(parsed.reason || 'Sem justificativa').slice(0, 220),
    wait_ms: Math.max(2500, Math.min(8000, Number(parsed.wait_ms) || 3500)),
    needs_teaching: Boolean(parsed.needs_teaching)
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'arena-auto-v6-ai-backend',
      model: OPENAI_MODEL,
      key_configured: Boolean(OPENAI_API_KEY)
    });
  }

  if (req.method === 'POST' && req.url === '/analyze') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      const result = await analyze(body);
      return json(res, 200, result);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const status = message === 'payload_too_large' ? 413 : 500;
      return json(res, status, { error: message });
    }
  }

  return json(res, 404, { error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Arena Auto V6 AI backend listening on port ${PORT}`);
  console.log(`Model: ${OPENAI_MODEL}`);
  console.log(`OPENAI_API_KEY configured: ${Boolean(OPENAI_API_KEY)}`);
});
