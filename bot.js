// Importa os pacotes necessários
const { CosmosClient } = require("@azure/cosmos");
const restify = require("restify");
const { ActivityHandler, CloudAdapter, ConfigurationBotFrameworkAuthentication } = require("botbuilder");
const axios = require("axios"); // Para chamadas à API da OpenAI

// Configuração do Cosmos DB
const cosmosConfig = {
  endpoint: "https://jean.documents.azure.com:443/",
  key: "dHJ3aQ1k3KyN0oGfwJIz44gyEANz5G27ID7pA6CkqaETau5JXIxtwfxvjq5VcTJltNi1ZY3j2KWeACDb7Vk0qA==",
  databaseId: "rpg_game",
  containerId: "game_states",
};

const client = new CosmosClient({ endpoint: cosmosConfig.endpoint, key: cosmosConfig.key });
let container;

(async () => {
  try {
    // Garante que o banco de dados e o contêiner existem
    const { database } = await client.databases.createIfNotExists({ id: cosmosConfig.databaseId });
    const { container: createdContainer } = await database.containers.createIfNotExists({
      id: cosmosConfig.containerId,
      partitionKey: { paths: ["/gameId"] },
    });
    container = createdContainer;
    console.log("Conexão ao Cosmos DB configurada com sucesso.");
  } catch (error) {
    console.error("Erro ao configurar o Cosmos DB:", error);
  }
})();

// Configuração da API da Azure OpenAI
const openAiConfig = {
  apiKey: "3XMEL1Q2n2mPNsv9WIqpViflQQJvJ5Z9w4orlUw8xvldGaxbgTuqJQQJ99BAACZoyfiXJ3w3AAABACOGozqP",
  model: "gpt-4",
  endpoint: "https://rpgzadaa.openai.azure.com",
};

const requestQueue = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue) return;

  isProcessingQueue = true;
  while (requestQueue.length > 0) {
    const { messages, resolve, reject } = requestQueue.shift();
    try {
      const response = await callOpenAiApi(messages);
      resolve(response);
    } catch (error) {
      reject(error);
    }
  }
  isProcessingQueue = false;
}

async function callOpenAiWithQueue(messages) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ messages, resolve, reject });
    processQueue();
  });
}

// Função para chamar a API da Azure OpenAI
async function callOpenAiApi(messages) {
  try {
    const response = await axios.post(
      `${openAiConfig.endpoint}/openai/deployments/${openAiConfig.model}/chat/completions?api-version=2023-05-15`,
      {
        messages: messages,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "api-key": openAiConfig.apiKey,
        },
      }
    );
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error("Erro ao chamar a API da Azure OpenAI:", error);
    throw new Error("Não foi possível gerar uma resposta da IA no momento.");
  }
}

// Configura o servidor Restify
const server = restify.createServer();
server.use(restify.plugins.bodyParser());
server.listen(3978, () => {
  console.log("Servidor rodando em https://rpgdoscria.azurewebsites.net");
});

// Configuração do adaptador de bot com autenticação
const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
  MicrosoftAppId: "c31976a5-d316-4d73-a425-ec32bb60dbdc",
  MicrosoftAppPassword: "pw28Q~U3vUHWDkm0vWaxu38bdiLG2OG~Tc~~hb1P",
  MicrosoftTenantId: "5281979b-f3d7-4b26-a251-85c48ff97483",
});

const adapter = new CloudAdapter(botFrameworkAuth);
const bot = new ActivityHandler();

// Função para salvar estado do jogo
async function saveGameState(gameId, state) {
  try {
    const { resource: savedState } = await container.items.upsert({
      gameId,
      ...state,
    });
    return savedState;
  } catch (error) {
    console.error("Erro ao salvar o estado do jogo:", error);
  }
}

// Função para carregar estado do jogo
async function loadGameState(gameId) {
  try {
    const { resources: gameStates } = await container.items.query({
      query: "SELECT * FROM c WHERE c.gameId = @gameId",
      parameters: [{ name: "@gameId", value: gameId }],
    }).fetchAll();
    return gameStates[0];
  } catch (error) {
    console.error("Erro ao carregar o estado do jogo:", error);
  }
}

// Função para carregar todas as ações
async function loadAllGameStates() {
  try {
    const { resources: allGameStates } = await container.items.query({
      query: "SELECT * FROM c",
    }).fetchAll();
    return allGameStates;
  } catch (error) {
    console.error("Erro ao carregar todos os estados do jogo:", error);
  }
}

// Lógica de mensagens do bot
bot.onMessage(async (context, next) => {
  const userMessage = context.activity.text;
  const conversationId = context.activity.conversation.id;
  const userId = context.activity.from.id;

  console.log("Mensagem recebida do usuário:", userMessage);

  try {
    // Carrega o estado atual do jogo
    let gameState = await loadGameState(conversationId);

    if (!gameState) {
      gameState = { gameId: conversationId, userId, attributes: {}, history: [] };
    }

    // Adiciona a mensagem do usuário ao histórico
    gameState.history.push({ from: "user", text: userMessage });

    let botResponse;

    // Carrega todas as ações de todos os jogadores
    const allGameStates = await loadAllGameStates();
    const sharedContext = allGameStates.flatMap((state) => state.history);

    // Prepara o contexto para a API da Azure OpenAI
    const messages = [
      { role: "system", content: "Você é um assistente de RPG interativo." },
      ...sharedContext.slice(-10).map((entry) => ({
        role: entry.from === "user" ? "user" : "assistant",
        content: entry.text,
      })),
      { role: "user", content: userMessage },
    ];

    // Chama a API da Azure OpenAI para gerar a resposta
    botResponse = await callOpenAiWithQueue(messages);

    // Adiciona a resposta do bot ao histórico
    gameState.history.push({ from: "bot", text: botResponse });

    // Salva o estado atualizado no Cosmos DB
    await saveGameState(conversationId, gameState);

    // Envia a resposta para o usuário
    await context.sendActivity(botResponse);
  } catch (error) {
    console.error("Erro no processamento da mensagem:", error);
    if (error.message.includes("429")) {
      await context.sendActivity("Estou processando muitas requisições agora. Por favor, tente novamente em alguns instantes.");
    } else {
      await context.sendActivity("Ocorreu um erro ao processar sua mensagem. Tente novamente mais tarde.");
    }
  }

  await next();
});

// Configuração dos endpoints de mensagens para dois jogadores
server.post("/api/messages/player1", async (req, res) => {
  console.log("Requisição recebida no endpoint /api/messages/player1");

  try {
    await adapter.process(req, res, async (context) => {
      await bot.run(context);
    });
  } catch (error) {
    console.error("Erro ao processar a requisição para player1:", error);
    res.status(500);
    res.send({ error: "Erro interno no servidor" });
  }
});

server.post("/api/messages/player2", async (req, res) => {
  console.log("Requisição recebida no endpoint /api/messages/player2");

  try {
    await adapter.process(req, res, async (context) => {
      await bot.run(context);
    });
  } catch (error) {
    console.error("Erro ao processar a requisição para player2:", error);
    res.status(500);
    res.send({ error: "Erro interno no servidor" });
  }
});
