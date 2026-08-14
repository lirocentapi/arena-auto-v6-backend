# Backend GPT V7 - Arena Auto

Este servidor guarda a `OPENAI_API_KEY`. **Nunca coloque a chave OpenAI dentro do APK.**

## Variáveis

- `OPENAI_API_KEY`: chave da OpenAI.
- `OPENAI_MODEL`: padrão `gpt-5.6`.
- `ARENA_APP_TOKEN`: token que o app Android envia para o seu servidor.
- `PORT`: padrão `3000`.

## Rodar

```bash
npm install
export OPENAI_API_KEY="..."
export ARENA_APP_TOKEN="um-token-grande"
npm start
```

No Android, configure a URL pública HTTPS deste servidor e o mesmo `ARENA_APP_TOKEN`.

## Como funciona

O Android envia uma screenshot + perfil + memória curta. O GPT devolve no máximo 8 ações (`click`, `double_click`, `drag`, `wait`, `screenshot`) e uma memória atualizada. O app executa as ações via AccessibilityService, captura a próxima tela e repete.

- **COMPLETO**: esse ciclo fica ativo durante todo o fluxo.
- **HÍBRIDO**: o ciclo acontece somente quando uma parte gravada encontra um bloco 🧠 e termina quando `done=true`.
