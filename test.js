// Teste básico para validar que o bot.js pode ser carregado sem erros
try {
    require('./bot.js');
    console.log("Teste passou: bot.js carregado com sucesso.");
    process.exit(0); // Sinaliza sucesso
  } catch (error) {
    console.error("Teste falhou:", error);
    process.exit(1); // Sinaliza falha
  }
  