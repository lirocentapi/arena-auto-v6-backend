import express from "express";
import OpenAI from "openai";

const app = express();
const port = Number(process.env.PORT || 3000);
const model = process.env.OPENAI_MODEL || "gpt-5.6";
const appToken = process.env.ARENA_APP_TOKEN || "";

if (!process.env.OPENAI_API_KEY) {
  console.error("ERRO: defina OPENAI_API_KEY no servidor.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Screenshots de celular podem ter alguns MB em base64.
app.use(express.json({ limit: "18mb" }));

function authorized(req) {
  if (!appToken) return true;
  return req.headers.authorization === `Bearer ${appToken}`;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, model, service: "arena-auto-gpt-v7" });
});

const actionSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: ["click", "double_click", "drag", "wait", "screenshot", "resume_macro", "stop"],
      description: "Ação Android. Para campos não usados, envie 0."
    },
    x: { type: "integer", description: "Coordenada X em pixels da screenshot atual; 0 se não usada." },
    y: { type: "integer", description: "Coordenada Y em pixels da screenshot atual; 0 se não usada." },
    x2: { type: "integer", description: "X final de drag em pixels; 0 se não usado." },
    y2: { type: "integer", description: "Y final de drag em pixels; 0 se não usado." },
    duration_ms: { type: "integer", description: "Espera ou duração do arrasto em ms; 0 se não usada." }
  },
  required: ["type", "x", "y", "x2", "y2", "duration_ms"],
  additionalProperties: false
};

const tools = [
  {
    type: "function",
    name: "play_duelo_ninja",
    description: "Retorna o próximo pequeno lote de ações para jogar Duelo Ninja na tela Android fornecida.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        done: {
          type: "boolean",
          description: "true somente quando a tarefa atual terminou e o app pode parar ou retomar a macro."
        },
        memory: {
          type: "string",
          description: "Memória curta atualizada: tela/etapa, contadores, vitórias, compras e fatos necessários no próximo ciclo."
        },
        note: {
          type: "string",
          description: "Resumo curto em português do que viu e do que decidiu."
        },
        actions: {
          type: "array",
          maxItems: 8,
          items: actionSchema,
          description: "Ações em ordem. Prefira poucos cliques e peça nova screenshot depois de mudanças importantes."
        }
      },
      required: ["done", "memory", "note", "actions"],
      additionalProperties: false
    }
  }
];

function sanitizeDecision(raw, width, height) {
  const maxX = Math.max(1, width - 1);
  const maxY = Math.max(1, height - 1);
  const clamp = (v, max) => Math.max(0, Math.min(max, Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0));
  const allowed = new Set(["click", "double_click", "drag", "wait", "screenshot", "resume_macro", "stop"]);

  const actions = Array.isArray(raw.actions) ? raw.actions.slice(0, 8).map((a) => ({
    type: allowed.has(a?.type) ? a.type : "screenshot",
    x: clamp(a?.x, maxX),
    y: clamp(a?.y, maxY),
    x2: clamp(a?.x2, maxX),
    y2: clamp(a?.y2, maxY),
    duration_ms: Math.max(0, Math.min(5000, Math.round(Number(a?.duration_ms) || 0)))
  })) : [];

  return {
    done: Boolean(raw.done),
    memory: String(raw.memory || "").slice(0, 12000),
    note: String(raw.note || "").slice(0, 500),
    actions
  };
}

app.post("/v1/arena/decide", async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ error: "token inválido" });
  }

  try {
    const {
      session_id = "",
      mode = "HYBRID",
      task = "",
      memory = "",
      screen_width,
      screen_height,
      profile = {},
      screenshot_base64 = ""
    } = req.body || {};

    const width = Number(screen_width);
    const height = Number(screen_height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) {
      return res.status(400).json({ error: "screen_width/screen_height inválidos" });
    }
    if (!screenshot_base64 || screenshot_base64.length < 1000) {
      return res.status(400).json({ error: "screenshot ausente" });
    }

    const instructions = `
Você é o jogador visual do Arena Auto no jogo Duelo Ninja em um celular Android.
MODO: ${mode}
SESSÃO: ${session_id}
TAMANHO EXATO DA SCREENSHOT: ${width} x ${height} pixels.

TAREFA ATUAL:
${task}

PERFIL CONFIGURADO PELO DONO DA CONTA:
${JSON.stringify(profile)}

MEMÓRIA DA ETAPA ANTERIOR:
${memory || "(vazia)"}

REGRAS DE CONTROLE:
1. Olhe a screenshot atual antes de decidir. Use coordenadas em PIXELS da imagem ${width}x${height}.
2. Clique no elemento visual correto, preferindo o centro do texto/botão clicável. Não clique por aproximação se a tela não estiver clara.
3. Após um clique que muda a tela, prefira encerrar o lote e observar nova screenshot em vez de encadear muitos cliques cegos.
4. Se a luta/animação estiver em andamento e não houver ação necessária, use wait.
5. Use screenshot quando quiser apenas uma nova observação sem interagir.
6. No modo HYBRID, done=true significa: esta decisão terminou e a macro local pode continuar.
7. No modo COMPLETE, done=true somente quando o fluxo completo terminou ou não existe ação segura possível.
8. Atualize memory com contadores/fatos necessários. Seja curto para economizar tokens.
9. Nunca altere configurações, faça compras ou gaste recursos fora das regras explícitas do perfil/tarefa.
`;

    const response = await openai.responses.create({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: instructions },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${screenshot_base64}`,
              detail: "original"
            }
          ]
        }
      ],
      tools,
      tool_choice: { type: "function", name: "play_duelo_ninja" },
      max_output_tokens: 1400
    });

    const call = response.output.find(
      (item) => item.type === "function_call" && item.name === "play_duelo_ninja"
    );

    if (!call) {
      return res.status(502).json({ error: "GPT não retornou play_duelo_ninja" });
    }

    const parsed = JSON.parse(call.arguments || "{}");
    return res.json(sanitizeDecision(parsed, width, height));
  } catch (error) {
    console.error(error);
    const message = error?.message || String(error);
    return res.status(500).json({ error: message.slice(0, 800) });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Arena Auto GPT V7 ouvindo na porta ${port} com ${model}`);
});
