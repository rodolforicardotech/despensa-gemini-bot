/**
 * Webhook do Telegram adaptado: direto ao ponto e sem complexidade.
 */
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const telegramToken = (props.getProperty("TELEGRAM_BOT_TOKEN") || "").trim();
  const geminiKey = (props.getProperty("GEMINI_API_KEY") || "").replace(/["'\s]/g, "");
  const folderEntradaId = (props.getProperty("FOLDER_ENTRADA_ID") || "").trim();
  const folderProcessadasId = (props.getProperty("FOLDER_PROCESSADAS_ID") || "").trim();

  try {
    if (!e || !e.postData || !e.postData.contents) return HtmlService.createHtmlOutput();

    const contents = JSON.parse(e.postData.contents);
    if (!contents.message) return HtmlService.createHtmlOutput();

    const chatId = contents.message.chat.id;
    const texto = (contents.message.text || "").trim().toLowerCase();
    const photoArray = contents.message.photo;

    // 1. Comando simples de consulta
    if (texto === "/estoque" || texto === "/compras") {
      const respostaEstoque = consultarEstoqueTelegram();
      enviarMensagemTelegram(chatId, respostaEstoque, telegramToken);
      return HtmlService.createHtmlOutput();
    }

    if (texto === "/start" || texto === "/ajuda") {
      enviarMensagemTelegram(chatId, "Mande uma foto de nota fiscal para cadastrar ou digite /estoque para ver os itens.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // Se não for foto
    if (!photoArray || photoArray.length === 0) {
      enviarMensagemTelegram(chatId, "Envie uma foto da nota fiscal ou digite /estoque.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    enviarMensagemTelegram(chatId, "Lendo nota fiscal...", telegramToken);

    // 2. Baixa a foto do Telegram
    const fileId = photoArray[photoArray.length - 1].file_id;
    const getFileUrl = `https://api.telegram.org/bot${telegramToken}/getFile?file_id=${fileId}`;
    const fileRes = UrlFetchApp.fetch(getFileUrl, { muteHttpExceptions: true });
    const fileJson = JSON.parse(fileRes.getContentText());

    if (!fileJson.ok || !fileJson.result.file_path) {
      enviarMensagemTelegram(chatId, "Erro ao baixar a imagem do Telegram.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    const downloadUrl = `https://api.telegram.org/file/bot${telegramToken}/${fileJson.result.file_path}`;
    const responseImg = UrlFetchApp.fetch(downloadUrl, { headers: { "Accept": "image/*" }, muteHttpExceptions: true });
    const blob = responseImg.getBlob();

    const nomeArquivo = `Telegram_${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss")}.jpg`;
    blob.setName(nomeArquivo);

    // Salva na entrada e converte
    const pastaEntrada = DriveApp.getFolderById(folderEntradaId);
    const driveFile = pastaEntrada.createFile(blob);

    const imageBytes = driveFile.getBlob().getBytes();
    const imageBase64 = Utilities.base64Encode(imageBytes);
    const mimeType = driveFile.getMimeType() || "image/jpeg";

    // 3. Processa no Gemini com as regras existentes (deduplicação e padronização)
    const dadosNota = extrairDadosViaGemini(imageBase64, mimeType, geminiKey);

    if (!dadosNota || !dadosNota.itens || dadosNota.itens.length === 0) {
      enviarMensagemTelegram(chatId, "Não consegui identificar itens nesta foto.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // Se já foi cadastrada, avisa e não duplica
    const identificador = (dadosNota.identificador_nota || "").trim();
    if (identificador && notaJaCadastrada(identificador)) {
      if (folderProcessadasId) driveFile.moveTo(DriveApp.getFolderById(folderProcessadasId));
      enviarMensagemTelegram(chatId, `⚠️ Esta nota (${identificador}) já tinha sido cadastrada!`, telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // 4. Grava no seu histórico e no seu estoque consolidado
    gravarNaPlanilha(dadosNota, nomeArquivo);

    // Move para processadas
    if (folderProcessadasId) {
      driveFile.moveTo(DriveApp.getFolderById(folderProcessadasId));
    }

    // 5. Retorno curto e limpo no Telegram
    const total = dadosNota.itens.reduce((acc, it) => acc + (Number(it.preco_total) || 0), 0);
    const mercado = dadosNota.estabelecimento || "Mercado";
    const qtd = dadosNota.itens.length;
    enviarMensagemTelegram(chatId, `✅ Salvo!\n🏪 ${mercado}\n📦 ${qtd} itens cadastrados\n💰 Total: R$ ${total.toFixed(2).replace('.', ',')}`, telegramToken);

  } catch (err) {
    Logger.log("Erro no doPost: " + err.toString());
  }

  return HtmlService.createHtmlOutput();
}

/**
 * Consulta simples: lê a aba Estoque_Atual existente e lista os itens e quantidades.
 */
function consultarEstoqueTelegram() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const abaEstoque = ss.getSheetByName("Estoque_Atual");

  if (!abaEstoque || abaEstoque.getLastRow() <= 1) {
    return "Nenhum item encontrado no estoque.";
  }

  // Pega os itens da aba Estoque_Atual (Item na Coluna A, Qtd na Coluna C)
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
 * Consulta a aba Estoque_Atual e formata um resumo para o Telegram.
 */
function gerarRelatorioEstoqueTelegram() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const abaEstoque = ss.getSheetByName("Estoque_Atual");

  if (!abaEstoque) return "Aba de estoque não configurada.";

  const dados = abaEstoque.getDataRange().getValues();
  if (dados.length <= 1) return "O estoque ainda está vazio. Envie fotos de notas para preenchê-lo.";

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const urgentes = [];
  const reporLogo = [];
  let totalItens = 0;

  for (let r = 1; r < dados.length; r++) {
    const nome = dados[r][0];
    const dataPrevisao = dados[r][5];

    if (!nome || !(dataPrevisao instanceof Date)) continue;
    totalItens++;

    const diffDias = Math.ceil((dataPrevisao.getTime() - hoje.getTime()) / 86400000);

    if (diffDias <= 0) {
      urgentes.push(`🔴 *${nome}* (Esgotado há ${Math.abs(diffDias)}d)`);
    } else if (diffDias <= 3) {
      reporLogo.push(`🟡 *${nome}* (Acaba em ${diffDias}d)`);
    }
  }

  let resposta = `📋 *Status do Estoque Doméstico*\n\n`;

  if (urgentes.length === 0 && reporLogo.length === 0) {
    return resposta + `🟢 Tudo em dia! Nenhum dos ${totalItens} itens precisa de reposição no momento.`;
  }

  if (urgentes.length > 0) {
    resposta += `*Esgotados:*\n` + urgentes.join("\n") + `\n\n`;
  }

  if (reporLogo.length > 0) {
    resposta += `*Previsão de término em breve:*\n` + reporLogo.join("\n") + `\n\n`;
  }

  resposta += `_Total de produtos monitorados: ${totalItens}_`;
  return resposta;
}

/**
 * Verifica se a nota já foi registrada na aba Historico_Compras pelo identificador.
 */
function notaJaCadastrada(identificador) {
  if (!identificador) return false;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const abaHistorico = ss.getSheetByName("Historico_Compras");
  if (!abaHistorico) return false;

  const dados = abaHistorico.getDataRange().getValues();
  for (let i = 1; i < dados.length; i++) {
    // Coluna J (índice 9) armazena o Identificador_Nota
    if (dados[i][9] && String(dados[i][9]).trim() === identificador) {
      return true;
    }
  }
  return false;
}

/**
 * Gemini OCR: extrai dados e normaliza nomes com JSON Schema estrito.
 */
function extrairDadosViaGemini(base64Image, mimeType, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;

  const promptTexto = `
Você é um especialista em OCR e normalização de cupons fiscais brasileiros.
Analise a nota fiscal e extraia os dados reais.

Campos obrigatórios:
1. data_compra: Data no formato YYYY-MM-DD.
2. estabelecimento: Nome ou razão social.
3. identificador_nota: O número do CONTROLE (ex: "046617"), COO, número do Extrato NFC-e ou os 44 dígitos da chave de acesso. NUNCA deixe vazio se houver controle/chave impresso.
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
      identificador_nota: { type: "STRING", description: "Número de controle, extrato ou chave de 44 dígitos" },
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
 * Grava na planilha (incluindo o Identificador_Nota para controle de duplicidade).
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
 * Atualiza o estoque considerando giro diferenciado para perecíveis vs não-perecíveis.
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
      "Tipo_Validade" // Perecível ou Despensa Geral
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

    // Heurística de giro inicial: perecíveis têm ciclos curtos
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
 * Disparo matinal: e-mail dividido em 'Atenção ao Vencimento' e 'Lista de Reposição'.
 */
function verificarEstoqueENotificar() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const abaEstoque = ss.getSheetByName("Estoque_Atual");
  if (!abaEstoque) return;

  const dados = abaEstoque.getDataRange().getValues();
  if (dados.length <= 1) return;

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const pereciveisAlerta = [];
  const despensaAlerta = [];

  for (let i = 1; i < dados.length; i++) {
    const nome = dados[i][0];
    const dataPrevisao = dados[i][5];
    const tipo = dados[i][6] || "Despensa";

    if (!nome || !(dataPrevisao instanceof Date)) continue;

    const diffDias = Math.ceil((dataPrevisao.getTime() - hoje.getTime()) / 86400000);

    if (diffDias <= 2) {
      const obj = {
        item: nome,
        dias: diffDias,
        dataPrevisao: Utilities.formatDate(dataPrevisao, Session.getScriptTimeZone(), "dd/MM/yyyy")
      };

      if (tipo === "Perecível") {
        pereciveisAlerta.push(obj);
      } else {
        despensaAlerta.push(obj);
      }
    }
  }

  if (pereciveisAlerta.length > 0 || despensaAlerta.length > 0) {
    enviarEmailDividido(pereciveisAlerta, despensaAlerta);
  }
}

/**
 * Monta e envia o e-mail em dois blocos.
 */
function enviarEmailDividido(pereciveis, despensa) {
  const destinatario = Session.getActiveUser().getEmail();
  const assunto = `🛒 [Alerta Despensa] ${pereciveis.length + despensa.length} itens demandam atenção hoje`;

  let html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #222; max-width: 600px;">
      <h2 style="color: #1a73e8; margin-bottom: 5px;">Relatório de Estoque e Consumo</h2>
      <p style="color: #666; font-size: 14px;">Atualizado automaticamente com base nas notas fiscais.</p>
  `;

  // BLOCO 1: PERECÍVEIS
  if (pereciveis.length > 0) {
    html += `
      <div style="background: #fff3f0; border-left: 4px solid #d93025; padding: 12px; margin-top: 15px;">
        <h3 style="color: #d93025; margin: 0 0 8px 0;">🥩 Perecíveis / Consumo Imediato</h3>
        <p style="font-size: 13px; margin: 0 0 10px 0;">Itens abertos ou refrigerados próximos do limite de conservação:</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
    `;
    pereciveis.forEach(p => {
      const tag = p.dias <= 0 ? `<b style="color:red;">Consumir Já!</b>` : `Resta ${p.dias} dia(s)`;
      html += `<tr><td style="padding: 4px 0;">• <b>${p.item}</b></td><td style="text-align: right;">${tag}</td></tr>`;
    });
    html += `</table></div>`;
  }

  // BLOCO 2: DESPENSA
  if (despensa.length > 0) {
    html += `
      <div style="background: #f1f8e9; border-left: 4px solid #388e3c; padding: 12px; margin-top: 15px;">
        <h3 style="color: #2e7d32; margin: 0 0 8px 0;">📦 Lista de Compras (Despensa)</h3>
        <p style="font-size: 13px; margin: 0 0 10px 0;">Itens secos e utilidades cujo ciclo estimado terminou:</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
    `;
    despensa.forEach(d => {
      const tag = d.dias <= 0 ? `<b style="color:#d93025;">Esgotado</b>` : `Acaba em ${d.dias} dia(s)`;
      html += `<tr><td style="padding: 4px 0;">• <b>${d.item}</b></td><td style="text-align: right;">${tag}</td></tr>`;
    });
    html += `</table></div>`;
  }

  html += `
      <p style="margin-top: 25px; font-size: 12px; color: #888;">Consulte a planilha ou use o comando /estoque no Telegram.</p>
    </div>
  `;

  MailApp.sendEmail({
    to: destinatario,
    subject: assunto,
    htmlBody: html
  });
}

function enviarMensagemTelegram(chatId, texto, token) {
  UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "Markdown" }),
    muteHttpExceptions: true
  });
}

/**
 * Processa notas fiscais colocadas diretamente na pasta de entrada do Google Drive.
 * Mantém paridade com o Telegram: deduplica, normaliza nomes e move para 'Processadas'.
 */
function processarNotasFiscais() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = (props.getProperty("GEMINI_API_KEY") || "").replace(/["'\s]/g, "");
  const folderEntradaId = (props.getProperty("FOLDER_ENTRADA_ID") || "").trim();
  const folderProcessadasId = (props.getProperty("FOLDER_PROCESSADAS_ID") || "").trim();

  if (!apiKey || !folderEntradaId || !folderProcessadasId) {
    throw new Error("Configure GEMINI_API_KEY, FOLDER_ENTRADA_ID e FOLDER_PROCESSADAS_ID nas Propriedades do Script.");
  }

  const pastaEntrada = DriveApp.getFolderById(folderEntradaId);
  const pastaProcessadas = DriveApp.getFolderById(folderProcessadasId);
  const arquivos = pastaEntrada.getFiles();

  const mimeTypesValidos = ["image/jpeg", "image/png", "image/webp", "image/heic"];
  let processados = 0;

  while (arquivos.hasNext()) {
    const arquivo = arquivos.next();
    const mimeType = arquivo.getMimeType();

    if (!mimeTypesValidos.includes(mimeType)) {
      Logger.log(`Ficheiro ignorado (formato incompatível): ${arquivo.getName()}`);
      continue;
    }

    Logger.log(`A processar do Drive: ${arquivo.getName()}...`);

    try {
      const imageBytes = arquivo.getBlob().getBytes();
      const imageBase64 = Utilities.base64Encode(imageBytes);

      // 1. Extração estruturada via Gemini
      const dadosNota = extrairDadosViaGemini(imageBase64, mimeType, apiKey);

      if (!dadosNota || !dadosNota.itens || dadosNota.itens.length === 0) {
        Logger.log(`Nenhum item detetado em: ${arquivo.getName()}`);
        continue;
      }

      // 2. Validação de duplicidade por chave/controlo
      const identificador = (dadosNota.identificador_nota || "").trim();
      if (identificador && notaJaCadastrada(identificador)) {
        Logger.log(`Aviso: Cupom ${identificador} já existe na planilha. A mover sem duplicar...`);
        arquivo.moveTo(pastaProcessadas);
        continue;
      }

      // 3. Registo nas abas Historico_Compras e Estoque_Atual
      gravarNaPlanilha(dadosNota, arquivo.getName());
      Logger.log(`Gravados ${dadosNota.itens.length} itens do ficheiro ${arquivo.getName()}.`);

      // 4. Arquivo na pasta de processadas
      arquivo.moveTo(pastaProcessadas);
      processados++;

    } catch (err) {
      Logger.log(`Erro ao processar ${arquivo.getName()}: ${err.message}`);
    }
  }

  Logger.log(`Concluído. Total de notas do Drive processadas: ${processados}`);
}