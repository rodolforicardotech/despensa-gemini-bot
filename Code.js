/**
 * Trata requisições diretas no navegador (GET).
 */
function doGet(e) {
  return ContentService.createTextOutput("✅ Webhook ativo e operacional!");
}

/**
 * Webhook do Telegram (POST).
 */
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const telegramToken = (props.getProperty("TELEGRAM_BOT_TOKEN") || "").trim();
  const geminiKey = (props.getProperty("GEMINI_API_KEY") || "").replace(/["'\s]/g, "");
  const folderEntradaId = (props.getProperty("FOLDER_ENTRADA_ID") || "").trim();
  const folderProcessadasId = (props.getProperty("FOLDER_PROCESSADAS_ID") || "").trim();

  let chatId = null;

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return HtmlService.createHtmlOutput();
    }

    const contents = JSON.parse(e.postData.contents);
    if (!contents.message) {
      return HtmlService.createHtmlOutput();
    }

    chatId = contents.message.chat.id;
    const texto = (contents.message.text || "").trim().toLowerCase();
    const photoArray = contents.message.photo;

    // 1. Comandos de texto
    if (texto === "/estoque" || texto === "/compras") {
      const respostaEstoque = consultarEstoqueTelegram();
      enviarMensagemTelegram(chatId, respostaEstoque, telegramToken);
      return HtmlService.createHtmlOutput();
    }

    if (texto === "/start" || texto === "/ajuda") {
      enviarMensagemTelegram(chatId, "Envie uma foto de nota fiscal para cadastrar ou digite /estoque para ver os itens.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // Validação de recebimento de imagem
    if (!photoArray || photoArray.length === 0) {
      enviarMensagemTelegram(chatId, "Envie uma foto da nota fiscal ou digite /estoque.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    enviarMensagemTelegram(chatId, "⏳ A descarregar imagem do Telegram...", telegramToken);

    if (!folderEntradaId) {
      enviarMensagemTelegram(chatId, "❌ Erro: FOLDER_ENTRADA_ID não configurado.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // 2. Descarregar fotografia em maior resolução
    const foto = photoArray[photoArray.length - 1];
    const getFileUrl = `https://api.telegram.org/bot${telegramToken}/getFile?file_id=${foto.file_id}`;
    const fileRes = UrlFetchApp.fetch(getFileUrl, { muteHttpExceptions: true });
    const fileJson = JSON.parse(fileRes.getContentText());

    if (!fileJson.ok || !fileJson.result || !fileJson.result.file_path) {
      enviarMensagemTelegram(chatId, "❌ Erro ao obter caminho do ficheiro no Telegram.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    const downloadUrl = `https://api.telegram.org/file/bot${telegramToken}/${fileJson.result.file_path}`;
    const responseImg = UrlFetchApp.fetch(downloadUrl, { headers: { "Accept": "image/*" }, muteHttpExceptions: true });
    const blob = responseImg.getBlob();

    const nomeArquivo = `Telegram_${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss")}.jpg`;
    blob.setName(nomeArquivo);

    // Gravar na pasta de entrada do Drive
    const pastaEntrada = DriveApp.getFolderById(folderEntradaId);
    const driveFile = pastaEntrada.createFile(blob);

    enviarMensagemTelegram(chatId, "📸 Ficheiro guardado! A analisar com Gemini...", telegramToken);

    const imageBytes = driveFile.getBlob().getBytes();
    const imageBase64 = Utilities.base64Encode(imageBytes);
    const mimeType = driveFile.getMimeType() || "image/jpeg";

    // 3. Processamento no Gemini
    const dadosNota = extrairDadosViaGemini(imageBase64, mimeType, geminiKey);

    if (!dadosNota || !dadosNota.itens || dadosNota.itens.length === 0) {
      enviarMensagemTelegram(chatId, "⚠️ Não consegui identificar itens nesta fatura.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // Higienização da chave / identificador
    let identificador = "";
    if (dadosNota.identificador_nota) {
      identificador = String(dadosNota.identificador_nota).replace(/\D/g, "").trim();
      dadosNota.identificador_nota = identificador;
    }

    // Verificação de duplicados
    if (identificador && notaJaCadastrada(identificador)) {
      if (folderProcessadasId) driveFile.moveTo(DriveApp.getFolderById(folderProcessadasId));
      enviarMensagemTelegram(chatId, `⚠️ Esta nota (${identificador}) já tinha sido cadastrada!`, telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // 4. Gravação na Folha de Cálculo e no Firebase
    gravarNaPlanilha(dadosNota, nomeArquivo);
    salvarNoFirebase(dadosNota, nomeArquivo);

    // Mover para a pasta de processadas
    if (folderProcessadasId) {
      driveFile.moveTo(DriveApp.getFolderById(folderProcessadasId));
    }

    // 5. Confirmação no Telegram
    const total = dadosNota.itens.reduce((acc, it) => acc + (Number(it.preco_total) || 0), 0);
    const mercado = dadosNota.estabelecimento || "Supermercado";
    const qtd = dadosNota.itens.length;
    enviarMensagemTelegram(chatId, `✅ Salvo!\n🏪 ${mercado}\n📦 ${qtd} itens registados\n💰 Total: R$ ${total.toFixed(2).replace('.', ',')}`, telegramToken);

  } catch (err) {
    Logger.log("Erro no doPost: " + err.toString());
    if (chatId && telegramToken) {
      enviarMensagemTelegram(chatId, `❌ Erro na execução: ${err.message}`, telegramToken);
    }
  }

  return HtmlService.createHtmlOutput();
}

/**
 * Consulta simples do stock consolidado.
 */
function consultarEstoqueTelegram() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const abaEstoque = ss.getSheetByName("Estoque_Atual");

  if (!abaEstoque || abaEstoque.getLastRow() <= 1) {
    return "Nenhum item encontrado no estoque.";
  }

  const dados = abaEstoque.getDataRange().getValues();
  let resposta = "📦 *Itens no Estoque:*\n\n";

  for (let i = 1; i < dados.length; i++) {
    const nome = dados[i][0];
    const qtd = dados[i][2];
    if (nome) {
      resposta += `• ${nome} (${qtd})\n`;
    }
  }

  return resposta;
}

/**
 * Verificação de duplicados na aba Historico_Compras.
 */
function notaJaCadastrada(identificador) {
  if (!identificador) return false;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const abaHistorico = ss.getSheetByName("Historico_Compras");
  if (!abaHistorico) return false;

  const dados = abaHistorico.getDataRange().getValues();
  for (let i = 1; i < dados.length; i++) {
    if (dados[i][9] && String(dados[i][9]).trim() === identificador) {
      return true;
    }
  }
  return false;
}

/**
 * Chamada à API Gemini com Structured Outputs.
 */
function extrairDadosViaGemini(base64Image, mimeType, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;

  const promptTexto = `
Você é um especialista em OCR e normalização de cupons fiscais brasileiros.
Analise a nota fiscal e extraia os dados reais.

ATENÇÃO CRÍTICA PARA 'identificador_nota':
- PRIORIDADE MÁXIMA: Procure a "Chave de Acesso" de 44 dígitos (localizada no rodapé ou próxima ao QR Code, ex: "2326 0606 8876 6800 2718 6510 2000 0437 8617 3057 3679").
- EXTRAIA OS 44 DÍGITOS NUMÉRICOS CONTÍNUOS, SEM ESPAÇOS.
- APENAS se a nota estiver cortada ou ilegível no rodapé, utilize o número do CONTROLE / COO / Extrato.

Campos obrigatórios:
1. data_compra: Data no formato YYYY-MM-DD.
2. estabelecimento: Nome ou razão social.
3. identificador_nota: A Chave de Acesso de 44 dígitos contínuos (ou controle se ausente).
4. itens:
   - nome_original: Descrição exatamente como impressa.
   - nome_padronizado: Nome decifrado e legível em português.
   - categoria: Carnes/Aves, Laticínios/Frios, Hortifrúti, Padaria, Mercearia, Limpeza, Higiene, Bebidas.
   - quantidade: Numérico.
   - unidade: un, kg, g, l.
   - preco_unitario: Numérico decimal.
   - preco_total: Numérico decimal.
  `;

  const jsonSchema = {
    type: "OBJECT",
    properties: {
      data_compra: { type: "STRING", description: "YYYY-MM-DD" },
      estabelecimento: { type: "STRING" },
      identificador_nota: { 
        type: "STRING", 
        description: "Chave de Acesso de 44 dígitos contínuos (sem espaços). Se ausente, número de controle." 
      },
      itens: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            nome_original: { type: "STRING" },
            nome_padronizado: { type: "STRING" },
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
    required: ["data_compra", "estabelecimento", "identificador_nota", "itens"]
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

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const response = UrlFetchApp.fetch(url, options);
    const statusCode = response.getResponseCode();

    if (statusCode === 200) {
      const jsonResponse = JSON.parse(response.getContentText());
      return JSON.parse(jsonResponse.candidates[0].content.parts[0].text);
    }

    if ((statusCode === 503 || statusCode === 429) && tentativa < 3) {
      Utilities.sleep(3000 * tentativa);
      continue;
    }

    throw new Error(`Erro na API do Gemini (${statusCode}): ${response.getContentText()}`);
  }
}

/**
 * Registo na aba Historico_Compras.
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
      "Identificador_Nota",
      "Arquivo_Origem"
    ]);
  }

  const dataCompra = dadosNota.data_compra || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const identificador = dadosNota.identificador_nota || "";

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
    identificador,
    nomeArquivo
  ]);

  abaHistorico.getRange(abaHistorico.getLastRow() + 1, 1, linhasHistorico.length, linhasHistorico[0].length).setValues(linhasHistorico);

  atualizarOuInserirEstoque(ss, dadosNota);
}

/**
 * Atualização da aba Estoque_Atual.
 */
function atualizarOuInserirEstoque(ss, dadosNota) {
  let abaEstoque = ss.getSheetByName("Estoque_Atual");

  if (!abaEstoque) {
    abaEstoque = ss.insertSheet("Estoque_Atual");
    abaEstoque.appendRow([
      "Item",
      "Categoria",
      "Qtd_Total_Comprada",
      "Ultima_Compra",
      "Consumo_Medio_Dias",
      "Previsao_Acabar",
      "Tipo_Validade"
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
        consumoDias: Number(dados[r][4]) || 30,
        tipo: dados[r][6] || "Despensa"
      });
    }
  }

  const novasLinhas = [];

  dadosNota.itens.forEach(item => {
    const nome = (item.nome_padronizado || item.nome_original || "").trim();
    const chave = nome.toLowerCase();
    const qtdComprada = Number(item.quantidade) || 1;
    const cat = item.categoria || "Geral";

    const ehPerecivel = /(carnes|aves|latic[íi]nios|frios|hortifr[úu]ti|padaria)/i.test(cat);
    const giroPadraoDias = ehPerecivel ? 7 : 30;
    const tipoValidade = ehPerecivel ? "Perecível" : "Despensa";

    if (mapaItens.has(chave)) {
      const itemExistente = mapaItens.get(chave);
      const novaQtd = itemExistente.qtd + qtdComprada;
      const dataMaisRecente = (!itemExistente.ultimaData || dataCompra > itemExistente.ultimaData) 
        ? dataCompra 
        : itemExistente.ultimaData;

      const dias = itemExistente.consumoDias > 0 ? itemExistente.consumoDias : giroPadraoDias;
      const novaPrevisao = new Date(dataMaisRecente.getTime() + dias * 86400000);

      abaEstoque.getRange(itemExistente.linhaIndex, 3).setValue(novaQtd);
      abaEstoque.getRange(itemExistente.linhaIndex, 4).setValue(dataMaisRecente);
      abaEstoque.getRange(itemExistente.linhaIndex, 6).setValue(novaPrevisao);

      itemExistente.qtd = novaQtd;
      itemExistente.ultimaData = dataMaisRecente;
    } else {
      const previsaoAcabar = new Date(dataCompra.getTime() + giroPadraoDias * 86400000);

      novasLinhas.push([
        nome,
        cat,
        qtdComprada,
        dataCompra,
        giroPadraoDias,
        previsaoAcabar,
        tipoValidade
      ]);

      mapaItens.set(chave, {
        linhaIndex: dados.length + novasLinhas.length,
        qtd: qtdComprada,
        ultimaData: dataCompra,
        consumoDias: giroPadraoDias,
        tipo: tipoValidade
      });
    }
  });

  if (novasLinhas.length > 0) {
    abaEstoque.getRange(abaEstoque.getLastRow() + 1, 1, novasLinhas.length, novasLinhas[0].length).setValues(novasLinhas);
  }
}

/**
 * Salva no Firebase Realtime Database.
 */
function salvarNoFirebase(dadosNota, nomeArquivo) {
  const props = PropertiesService.getScriptProperties();
  const dbUrl = (props.getProperty("FIREBASE_DB_URL") || "").trim().replace(/\/$/, "");
  const dbSecret = (props.getProperty("FIREBASE_SECRET") || "").trim();

  if (!dbUrl || !dbSecret) {
    Logger.log("Aviso: Configurações do Firebase ausentes. A saltar gravação.");
    return;
  }

  const authQuery = `?auth=${dbSecret}`;
  const dataHoje = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");

  const payloadCompra = {
    estabelecimento: dadosNota.estabelecimento || "Supermercado",
    data_compra: dadosNota.data_compra || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"),
    identificador_nota: dadosNota.identificador_nota || "",
    arquivo_origem: nomeArquivo,
    processado_em: dataHoje,
    itens: dadosNota.itens || []
  };

  try {
    const urlCompras = `${dbUrl}/compras.json${authQuery}`;
    UrlFetchApp.fetch(urlCompras, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payloadCompra),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log("Erro ao salvar compra no Firebase: " + err.message);
  }

  if (dadosNota.itens && dadosNota.itens.length > 0) {
    dadosNota.itens.forEach(item => {
      const nomePadronizado = (item.nome_padronizado || item.nome_original || "").trim();
      if (!nomePadronizado) return;

      const chaveSegura = sanitizarChaveFirebase(nomePadronizado.toLowerCase());
      const urlItemEstoque = `${dbUrl}/estoque/${chaveSegura}.json${authQuery}`;

      let qtdAtual = 0;
      try {
        const res = UrlFetchApp.fetch(urlItemEstoque, { muteHttpExceptions: true });
        const itemExistente = JSON.parse(res.getContentText());
        if (itemExistente && itemExistente.quantidade_total) {
          qtdAtual = Number(itemExistente.quantidade_total) || 0;
        }
      } catch (e) {
        // Primeiro registo do item
      }

      const payloadEstoque = {
        nome: nomePadronizado,
        categoria: item.categoria || "Geral",
        quantidade_total: qtdAtual + (Number(item.quantidade) || 1),
        unidade: item.unidade || "un",
        ultima_compra: dadosNota.data_compra || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"),
        ultimo_preco_unitario: item.preco_unitario || 0,
        atualizado_em: dataHoje
      };

      try {
        UrlFetchApp.fetch(urlItemEstoque, {
          method: "put",
          contentType: "application/json",
          payload: JSON.stringify(payloadEstoque),
          muteHttpExceptions: true
        });
      } catch (errItem) {
        Logger.log(`Erro ao atualizar item ${nomePadronizado} no Firebase: ` + errItem.message);
      }
    });
  }
}

/**
 * Normaliza chaves para o Firebase.
 */
function sanitizarChaveFirebase(chave) {
  return chave
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[.#$\[\]\/]/g, "_")
    .replace(/\s+/g, "_");
}

/**
 * Envia mensagens formatadas no Telegram.
 */
function enviarMensagemTelegram(chatId, texto, token) {
  UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "Markdown" }),
    muteHttpExceptions: true
  });
}


/**
 * Roda o teste com a imagem que acabou de ser salva no Drive e imprime o erro real no console.
 */
function testarChamadaGemini() {
  const props = PropertiesService.getScriptProperties();
  const geminiKey = (props.getProperty("GEMINI_API_KEY") || "").replace(/["'\s]/g, "");
  const folderEntradaId = (props.getProperty("FOLDER_ENTRADA_ID") || "").trim();

  const pasta = DriveApp.getFolderById(folderEntradaId);
  const arquivos = pasta.getFiles();

  if (!arquivos.hasNext()) {
    Logger.log("Nenhum arquivo na pasta de entrada.");
    return;
  }

  const arquivo = arquivos.next();
  Logger.log("Testando com o arquivo: " + arquivo.getName());

  const imageBytes = arquivo.getBlob().getBytes();
  const imageBase64 = Utilities.base64Encode(imageBytes);
  const mimeType = arquivo.getMimeType() || "image/jpeg";

  try {
    const dados = extrairDadosViaGemini(imageBase64, mimeType, geminiKey);
    Logger.log("SUCESSO! Dados retornados:");
    Logger.log(JSON.stringify(dados, null, 2));
  } catch (e) {
    Logger.log("ERRO DETALHADO DO GEMINI:");
    Logger.log(e.toString());
  }
}