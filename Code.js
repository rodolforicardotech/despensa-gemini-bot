/**
 * Função principal: processa notas fiscais pendentes na pasta de entrada.
 */
function processarNotasFiscais() {
  const props = PropertiesService.getScriptProperties();
  
  // Sanitiza a chave e IDs para evitar espaços ou quebras de linha acidentais
  const rawKey = props.getProperty("GEMINI_API_KEY") || "";
  const apiKey = rawKey.replace(/["'\s]/g, "");
  const folderEntradaId = (props.getProperty("FOLDER_ENTRADA_ID") || "").trim();
  const folderProcessadasId = (props.getProperty("FOLDER_PROCESSADAS_ID") || "").trim();

  if (!apiKey || !folderEntradaId || !folderProcessadasId) {
    throw new Error("Configure as propriedades GEMINI_API_KEY, FOLDER_ENTRADA_ID e FOLDER_PROCESSADAS_ID nas Propriedades do Script.");
  }

  const pastaEntrada = DriveApp.getFolderById(folderEntradaId);
  const pastaProcessadas = DriveApp.getFolderById(folderProcessadasId);
  const arquivos = pastaEntrada.getFiles();

  const mimeTypesPermitidos = ["image/jpeg", "image/png", "image/webp", "image/heic"];
  let arquivosProcessados = 0;

  while (arquivos.hasNext()) {
    const arquivo = arquivos.next();
    const mimeType = arquivo.getMimeType();

    if (!mimeTypesPermitidos.includes(mimeType)) {
      Logger.log(`Arquivo ignorado (formato não suportado): ${arquivo.getName()}`);
      continue;
    }

    Logger.log(`Processando: ${arquivo.getName()}...`);

    try {
      // 1. Converte imagem para base64
      const imageBytes = arquivo.getBlob().getBytes();
      const imageBase64 = Utilities.base64Encode(imageBytes);

      // 2. Extrai dados estruturados usando o modelo gemini-3.5-flash-lite
      const dadosNota = extrairDadosViaGemini(imageBase64, mimeType, apiKey);

      // 3. Grava no Google Sheets
      if (dadosNota && dadosNota.itens && dadosNota.itens.length > 0) {
        gravarNaPlanilha(dadosNota, arquivo.getName());
        Logger.log(`Gravados ${dadosNota.itens.length} itens da nota.`);
      } else {
        Logger.log(`Nenhum item detectado em: ${arquivo.getName()}`);
      }

      // 4. Move o arquivo para a pasta 'Processadas'
      arquivo.moveTo(pastaProcessadas);
      Logger.log(`Arquivo ${arquivo.getName()} movido com sucesso.`);

      arquivosProcessados++;
    } catch (erro) {
      Logger.log(`Erro ao processar o arquivo ${arquivo.getName()}: ${erro.message}`);
    }
  }

  Logger.log(`Concluído. Total de notas processadas nesta execução: ${arquivosProcessados}`);
}

/**
 * Envia a imagem para a API do Gemini com o modelo gemini-3.5-flash-lite e JSON Schema.
 */
/**
 * Envia a imagem para a API do Gemini com a estrutura REST exata (inline_data).
 */
function extrairDadosViaGemini(base64Image, mimeType, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;

  const promptTexto = `
Você é um especialista em OCR e normalização de cupons fiscais brasileiros.
Analise a nota fiscal e extraia os dados reais.

Para cada produto, forneça:
1. nome_original: O texto impresso na nota fiscal exatamente como veio, com as abreviações fiscais (ex: "FEC MAN PINHEIRO 1KG", "MARG QUALY 500G C/S").
2. nome_padronizado: A versão por extenso, corrigida e legível em português (ex: "Fécula de Mandioca Pinheiro 1kg", "Margarina Qualy com Sal 500g"). Decifre todas as abreviações (FEC -> Fécula, P ALHO -> Pão de Alho, REQ -> Requeijão, SASSAMI -> Filé de Sassami de Frango, QJ -> Queijo, FGO -> Frango, B LACT -> Bebida Láctea, etc.).
3. categoria: Categoria do item (Hortifrúti, Padaria, Carnes/Aves, Laticínios/Frios, Mercearia, Bebidas, Limpeza, etc.).
4. quantidade: Numérico.
5. unidade: Ex: un, kg, g, l.
6. preco_unitario: Numérico decimal.
7. preco_total: Numérico decimal.
  `;

  const jsonSchema = {
    type: "OBJECT",
    properties: {
      data_compra: { type: "STRING", description: "Formato YYYY-MM-DD" },
      estabelecimento: { type: "STRING" },
      itens: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            nome_original: { type: "STRING", description: "Texto exato do cupom" },
            nome_padronizado: { type: "STRING", description: "Nome decifrado e legível" },
            categoria: { type: "STRING" },
            quantidade: { type: "NUMBER" },
            unidade: { type: "STRING" },
            preco_unitario: { type: "NUMBER" },
            preco_total: { type: "NUMBER" }
          },
          required: ["nome_original", "nome_padronizado", "categoria", "quantidade", "preco_total"]
        }
      }
    },
    required: ["data_compra", "estabelecimento", "itens"]
  };

  const payload = {
    contents: [
      {
        parts: [
          { text: promptTexto },
          {
            inline_data: {
              mime_type: mimeType || "image/jpeg",
              data: base64Image
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: jsonSchema,
      temperature: 0.1
    }
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const maxTentativas = 3;
  let esperaMs = 3000;

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    const response = UrlFetchApp.fetch(url, options);
    const statusCode = response.getResponseCode();

    if (statusCode === 200) {
      const jsonResponse = JSON.parse(response.getContentText());
      const respostaTexto = jsonResponse.candidates[0].content.parts[0].text;
      return JSON.parse(respostaTexto);
    }

    if ((statusCode === 503 || statusCode === 429) && tentativa < maxTentativas) {
      Utilities.sleep(esperaMs);
      esperaMs *= 2;
      continue;
    }

    throw new Error(`Erro na API do Gemini (${statusCode}): ${response.getContentText()}`);
  }
}

/**
 * Grava os itens estruturados na aba Historico_Compras.
 */
/**
 * Grava os itens estruturados no Histórico e atualiza o Estoque Atual.
 */
function gravarNaPlanilha(dadosNota, nomeArquivo) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let abaHistorico = ss.getSheetByName("Historico_Compras");

  if (!abaHistorico) {
    abaHistorico = ss.insertSheet("Historico_Compras");
    abaHistorico.appendRow([
      "Data_Compra", 
      "Estabelecimento", 
      "Item_Original", 
      "Nome_Padronizado", 
      "Categoria", 
      "Qtd", 
      "Unidade", 
      "Preco_Unit", 
      "Preco_Total", 
      "Arquivo_Origem"
    ]);
  }

  const dataCompra = dadosNota.data_compra || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

  const linhasHistorico = dadosNota.itens.map(item => [
    dataCompra,
    dadosNota.estabelecimento || "Supermercado",
    item.nome_original || item.nome_padronizado || "",
    item.nome_padronizado || item.nome_original || "",
    item.categoria || "Geral",
    item.quantidade || 1,
    item.unidade || "un",
    item.preco_unitario || (item.preco_total / (item.quantidade || 1)),
    item.preco_total || 0,
    nomeArquivo
  ]);

  abaHistorico.getRange(abaHistorico.getLastRow() + 1, 1, linhasHistorico.length, linhasHistorico[0].length).setValues(linhasHistorico);

  atualizarOuInserirEstoque(ss, dadosNota);
}

/**
 * Atualiza ou insere itens na aba Estoque_Atual automaticamente.
 */
function atualizarOuInserirEstoque(ss, dadosNota) {
  let abaEstoque = ss.getSheetByName("Estoque_Atual");

  if (!abaEstoque) {
    abaEstoque = ss.insertSheet("Estoque_Atual");
    abaEstoque.appendRow([
      "Item",                  // Nome padronizado
      "Categoria",             
      "Qtd_Total_Comprada",    
      "Ultima_Compra",         
      "Consumo_Medio_Dias",    
      "Previsao_Acabar",       
      "Status"                 
    ]);
  }

  const dataCompraStr = dadosNota.data_compra || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const partesData = dataCompraStr.split("-");
  const dataCompra = new Date(Number(partesData[0]), Number(partesData[1]) - 1, Number(partesData[2]));

  const dados = abaEstoque.getDataRange().getValues();
  const mapaItens = new Map();

  for (let r = 1; r < dados.length; r++) {
    const nomeExistente = String(dados[r][0]).trim().toLowerCase();
    if (nomeExistente) {
      mapaItens.set(nomeExistente, {
        linhaIndex: r + 1,
        qtd: Number(dados[r][2]) || 0,
        ultimaData: dados[r][3] instanceof Date ? dados[r][3] : new Date(dados[r][3]),
        consumoDias: Number(dados[r][4]) || 30
      });
    }
  }

  const novasLinhas = [];

  dadosNota.itens.forEach(item => {
    // Usa prioritariamente o nome padronizado para o estoque
    const nomePadronizado = (item.nome_padronizado || item.nome_original || "").trim();
    const chave = nomePadronizado.toLowerCase();
    const qtdComprada = Number(item.quantidade) || 1;

    if (mapaItens.has(chave)) {
      const itemExistente = mapaItens.get(chave);
      const novaQtd = itemExistente.qtd + qtdComprada;
      
      const dataMaisRecente = (!itemExistente.ultimaData || dataCompra > itemExistente.ultimaData) 
        ? dataCompra 
        : itemExistente.ultimaData;

      const consumoDias = itemExistente.consumoDias > 0 ? itemExistente.consumoDias : 30;
      const novaPrevisao = new Date(dataMaisRecente.getTime() + consumoDias * 86400000);

      abaEstoque.getRange(itemExistente.linhaIndex, 3).setValue(novaQtd);
      abaEstoque.getRange(itemExistente.linhaIndex, 4).setValue(dataMaisRecente);
      abaEstoque.getRange(itemExistente.linhaIndex, 6).setValue(novaPrevisao);
      
      itemExistente.qtd = novaQtd;
      itemExistente.ultimaData = dataMaisRecente;

    } else {
      const consumoPadraoDias = 30;
      const previsaoAcabar = new Date(dataCompra.getTime() + consumoPadraoDias * 86400000);

      novasLinhas.push([
        nomePadronizado,
        item.categoria || "Geral",
        qtdComprada,
        dataCompra,
        consumoPadraoDias,
        previsaoAcabar,
        ""
      ]);

      mapaItens.set(chave, {
        linhaIndex: dados.length + novasLinhas.length,
        qtd: qtdComprada,
        ultimaData: dataCompra,
        consumoDias: consumoPadraoDias
      });
    }
  });

  if (novasLinhas.length > 0) {
    abaEstoque.getRange(abaEstoque.getLastRow() + 1, 1, novasLinhas.length, novasLinhas[0].length).setValues(novasLinhas);
    Logger.log(`Adicionados ${novasLinhas.length} novos produtos padronizados ao Estoque_Atual.`);
  }
}

/**
 * Verifica o estoque e envia e-mail com os itens a vencer/repor nos próximos 2 dias.
 */
function verificarEstoqueENotificar() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const abaEstoque = ss.getSheetByName("Estoque_Atual");

  if (!abaEstoque) {
    Logger.log("Aba 'Estoque_Atual' não encontrada.");
    return;
  }

  const dados = abaEstoque.getDataRange().getValues();
  if (dados.length <= 1) {
    Logger.log("Nenhum dado na aba Estoque_Atual.");
    return;
  }

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const itensParaRepor = [];

  // Pula a linha 0 (cabeçalho)
  for (let i = 1; i < dados.length; i++) {
    const nomeItem = dados[i][0]; // Coluna A
    const previsaoAcabar = dados[i][5]; // Coluna F (Data)
    const status = dados[i][6]; // Coluna G

    if (!nomeItem || !(previsaoAcabar instanceof Date)) continue;

    // Diferença em dias
    const diffTempo = previsaoAcabar.getTime() - hoje.getTime();
    const diasRestantes = Math.ceil(diffTempo / (1000 * 60 * 60 * 24));

    // Se estiver a 2 dias ou menos de acabar, ou vencido
    if (diasRestantes <= 2) {
      itensParaRepor.push({
        item: nomeItem,
        dias: diasRestantes,
        dataPrevisao: Utilities.formatDate(previsaoAcabar, Session.getScriptTimeZone(), "dd/MM/yyyy")
      });
    }
  }

  if (itensParaRepor.length > 0) {
    enviarEmailAlerta(itensParaRepor);
    Logger.log(`E-mail enviado com ${itensParaRepor.length} itens sugeridos para reposição.`);
  } else {
    Logger.log("Estoque em dia. Nenhuma notificação necessária hoje.");
  }
}

/**
 * Monta e envia o e-mail de alerta formatado.
 */
function enviarEmailAlerta(listaItens) {
  const destinatario = Session.getActiveUser().getEmail() || "rodolforicardotech@gmail.com";
  const assunto = `🛒 [Alerta Despensa] Lista de Reposição - ${listaItens.length} itens precisando de atenção`;

  let corpoTexto = "Olá!\n\nAqui está a lista de itens da sua despensa que precisam de reposição:\n\n";
  let corpoHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <h2 style="color: #d93025;">🛒 Alerta de Reposição de Estoque</h2>
      <p>Os seguintes itens estão acabando ou já atingiram a previsão de consumo:</p>
      <table style="border-collapse: collapse; width: 100%; max-width: 500px;">
        <tr style="background-color: #f2f2f2; text-align: left;">
          <th style="padding: 8px; border: 1px solid #ddd;">Item</th>
          <th style="padding: 8px; border: 1px solid #ddd;">Previsão</th>
          <th style="padding: 8px; border: 1px solid #ddd;">Situação</th>
        </tr>
  `;

  listaItens.forEach(i => {
    let situacao = i.dias <= 0 ? `<b style="color:red;">Acabou!</b>` : `Acaba em ${i.dias} dia(s)`;
    corpoTexto += `- ${i.item}: Previsão ${i.dataPrevisao} (${i.dias <= 0 ? 'URGENTE' : i.dias + ' dia(s)'})\n`;
    corpoHtml += `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd;">${i.item}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${i.dataPrevisao}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${situacao}</td>
      </tr>
    `;
  });

  corpoTexto += "\nAbra sua planilha para conferir o estoque completo.";
  corpoHtml += `
      </table>
      <p style="margin-top: 20px; font-size: 12px; color: #777;">Automação gerada pelo Google Apps Script & Gemini.</p>
    </div>
  `;

  MailApp.sendEmail({
    to: destinatario,
    subject: assunto,
    body: corpoTexto,
    htmlBody: corpoHtml
  });
}

/**
 * Função de teste: dispara um e-mail com dados simulados
 * para você validar o visual na sua caixa de entrada.
 */
function testarEnvioEmailAlerta() {
  const itensSimulados = [
    {
      item: "Arroz Parboilizado 5kg",
      dias: 0,
      dataPrevisao: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy")
    },
    {
      item: "Café Torrado e Moído 250g",
      dias: 1,
      dataPrevisao: Utilities.formatDate(new Date(Date.now() + 86400000), Session.getScriptTimeZone(), "dd/MM/yyyy")
    },
    {
      item: "Detergente Líquido 500ml",
      dias: 2,
      dataPrevisao: Utilities.formatDate(new Date(Date.now() + 2 * 86400000), Session.getScriptTimeZone(), "dd/MM/yyyy")
    }
  ];

  enviarEmailAlerta(itensSimulados);
  Logger.log("E-mail de teste enviado com sucesso!");
}

/**
 * Ponto de entrada do Webhook: o Telegram dispara esta função via POST ao receber mensagens.
 */
/**
 * Ponto de entrada do Webhook Telegram com salvamento direto no Drive.
 */
/**
 * Ponto de entrada do Webhook Telegram blindado.
 */
/**
 * Ponto de entrada do Webhook Telegram com salvamento e movimentação para 'Processadas'.
 */
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const telegramToken = (props.getProperty("TELEGRAM_BOT_TOKEN") || "").trim();
  const geminiKey = (props.getProperty("GEMINI_API_KEY") || "").replace(/["'\s]/g, "");
  const folderEntradaId = (props.getProperty("FOLDER_ENTRADA_ID") || "").trim();
  const folderProcessadasId = (props.getProperty("FOLDER_PROCESSADAS_ID") || "").trim();

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return HtmlService.createHtmlOutput("Sem dados");
    }

    const contents = JSON.parse(e.postData.contents);
    if (!contents.message) return HtmlService.createHtmlOutput("Sem mensagem");

    const chatId = contents.message.chat.id;
    const photoArray = contents.message.photo;

    if (!photoArray || photoArray.length === 0) {
      enviarMensagemTelegram(chatId, "👋 Por favor, envie uma foto da sua nota fiscal!", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    enviarMensagemTelegram(chatId, "⏳ Imagem recebida! Baixando e processando...", telegramToken);

    // Pega a versão de melhor resolução
    const fileId = photoArray[photoArray.length - 1].file_id;

    // 1. Busca o caminho do arquivo
    const getFileUrl = `https://api.telegram.org/bot${telegramToken}/getFile?file_id=${fileId}`;
    const fileRes = UrlFetchApp.fetch(getFileUrl, { muteHttpExceptions: true });
    const fileJson = JSON.parse(fileRes.getContentText());

    if (!fileJson.ok || !fileJson.result.file_path) {
      enviarMensagemTelegram(chatId, "❌ Falha ao obter dados da imagem no Telegram.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    const downloadUrl = `https://api.telegram.org/file/bot${telegramToken}/${fileJson.result.file_path}`;
    
    // 2. Baixa o blob binário da foto
    const responseImg = UrlFetchApp.fetch(downloadUrl, {
      headers: { "Accept": "image/*" },
      muteHttpExceptions: true
    });
    
    const blob = responseImg.getBlob();
    const tamanhoBytes = blob.getBytes().length;

    if (tamanhoBytes < 1000) {
      enviarMensagemTelegram(chatId, `⚠ Erro: a foto recebida está vazia (${tamanhoBytes} bytes).`, telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // 3. Salva no Google Drive (pasta de Entrada)
    const nomeArquivo = `Telegram_${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss")}.jpg`;
    blob.setName(nomeArquivo);
    
    const pastaEntrada = DriveApp.getFolderById(folderEntradaId);
    const driveFile = pastaEntrada.createFile(blob);

    // 4. Converte os bytes para Base64
    const imageBytes = driveFile.getBlob().getBytes();
    const imageBase64 = Utilities.base64Encode(imageBytes);
    const mimeType = driveFile.getMimeType() || "image/jpeg";

    // 5. Envia para o Gemini
    const dadosNota = extrairDadosViaGemini(imageBase64, mimeType, geminiKey);

    if (!dadosNota || !dadosNota.itens || dadosNota.itens.length === 0) {
      enviarMensagemTelegram(chatId, "⚠ Não consegui reconhecer os produtos na imagem. Tente aproximar um pouco mais.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // 6. Grava no Histórico e Estoque
    gravarNaPlanilha(dadosNota, nomeArquivo);

    // 7. MOVE O ARQUIVO PARA A PASTA DE PROCESSADAS
    if (folderProcessadasId) {
      const pastaProcessadas = DriveApp.getFolderById(folderProcessadasId);
      driveFile.moveTo(pastaProcessadas);
    }

    // 8. Envia o resumo formatado
    const total = dadosNota.itens.reduce((acc, it) => acc + (Number(it.preco_total) || 0), 0);
    const msg = 
      `✅ *Nota Fiscal Processada!*\n\n` +
      `🏪 *Estabelecimento:* ${dadosNota.estabelecimento || "Mercado"}\n` +
      `📅 *Data:* ${dadosNota.data_compra || "Não identificada"}\n` +
      `🛒 *Itens:* ${dadosNota.itens.length}\n` +
      `💵 *Total:* R$ ${total.toFixed(2).replace('.', ',')}\n\n` +
      `_Arquivo arquivado em Processadas e planilha atualizada!_`;

    enviarMensagemTelegram(chatId, msg, telegramToken);

  } catch (err) {
    Logger.log("Erro fatal no doPost: " + err.toString());
  }

  return HtmlService.createHtmlOutput();
}

/**
 * Busca a URL pública temporária da imagem nos servidores do Telegram.
 */
function obterUrlArquivoTelegram(fileId, token) {
  const getFileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
  const res = UrlFetchApp.fetch(getFileUrl);
  const data = JSON.parse(res.getContentText());
  const filePath = data.result.file_path;
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

/**
 * Envia mensagem de texto de volta ao usuário no Telegram.
 */
function enviarMensagemTelegram(chatId, texto, token) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: texto,
    parse_mode: "Markdown"
  };

  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

/**
 * Registra a URL do Web App diretamente na API do Telegram.
 */
function registrarWebhookTelegram() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("TELEGRAM_BOT_TOKEN");
  
  // Substitua pela URL exata da sua implantação:
  const webAppUrl = "https://script.google.com/macros/s/AKfycbzfM5uOzIRSGrd6q_PFCJwWQvY0TgIef9b5QEwOdF8C_j5pnm7ndgngy04S13VcG7TT/exec";

  const url = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webAppUrl)}`;
  const response = UrlFetchApp.fetch(url);
  Logger.log("Retorno do Telegram: " + response.getContentText());
}

function checarStatusWebhook() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("TELEGRAM_BOT_TOKEN");
  
  const res = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  Logger.log("Status atual do Webhook: " + res.getContentText());
}