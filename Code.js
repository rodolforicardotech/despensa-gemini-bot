/**
 * Trata requisições diretas no navegador (GET).
 */
function doGet(e) {
  return ContentService.createTextOutput("✅ Webhook ativo e operacional!");
}

/**
 * Webhook do Telegram (POST) - Suporta fotos de notas fiscais e textos livres.
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
    const texto = (contents.message.text || "").trim();
    const textoLower = texto.toLowerCase();
    const photoArray = contents.message.photo;

    // 1. Comandos fixos
    if (textoLower === "/estoque" || textoLower === "/compras") {
      const respostaEstoque = consultarEstoqueTelegram();
      enviarMensagemTelegram(chatId, respostaEstoque, telegramToken);
      return HtmlService.createHtmlOutput();
    }

    if (textoLower === "/start" || textoLower === "/ajuda") {
      enviarMensagemTelegram(
        chatId, 
        "Envie uma foto de nota fiscal, registre um gasto (ex: 'almoço 35 no vr') ou avise quando algo acabar (ex: 'acabou o café').", 
        telegramToken
      );
      return HtmlService.createHtmlOutput();
    }

    let dadosNota = null;
    let nomeArquivo = "";
    let driveFile = null;

    // 2. ROTA A: Envio de FOTO de cupom fiscal
    if (photoArray && photoArray.length > 0) {
      enviarMensagemTelegram(chatId, "⏳ Baixando a imagem do Telegram...", telegramToken);

      if (!folderEntradaId) {
        enviarMensagemTelegram(chatId, "❌ Erro: FOLDER_ENTRADA_ID não configurado.", telegramToken);
        return HtmlService.createHtmlOutput();
      }

      const foto = photoArray[photoArray.length - 1];
      const getFileUrl = `https://api.telegram.org/bot${telegramToken}/getFile?file_id=${foto.file_id}`;
      const fileRes = UrlFetchApp.fetch(getFileUrl, { muteHttpExceptions: true });
      const fileJson = JSON.parse(fileRes.getContentText());

      if (!fileJson.ok || !fileJson.result || !fileJson.result.file_path) {
        enviarMensagemTelegram(chatId, "❌ Erro ao obter caminho do arquivo no Telegram.", telegramToken);
        return HtmlService.createHtmlOutput();
      }

      const downloadUrl = `https://api.telegram.org/file/bot${telegramToken}/${fileJson.result.file_path}`;
      const responseImg = UrlFetchApp.fetch(downloadUrl, { headers: { "Accept": "image/*" }, muteHttpExceptions: true });
      const blob = responseImg.getBlob();

      nomeArquivo = `Telegram_${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss")}.jpg`;
      blob.setName(nomeArquivo);

      const pastaEntrada = DriveApp.getFolderById(folderEntradaId);
      driveFile = pastaEntrada.createFile(blob);

      enviarMensagemTelegram(chatId, "📸 Imagem salva! Analisando com Gemini...", telegramToken);

      const imageBytes = driveFile.getBlob().getBytes();
      const imageBase64 = Utilities.base64Encode(imageBytes);
      const mimeType = driveFile.getMimeType() || "image/jpeg";

      // Extração real da imagem via Gemini
      dadosNota = extrairDadosViaGemini(imageBase64, mimeType, geminiKey);

    // 3. ROTA B: Mensagem de TEXTO LIVRE
    } else if (texto && texto.length > 3) {
      enviarMensagemTelegram(chatId, "✍️ Processando mensagem com Gemini...", telegramToken);

      const resultadoGemini = extrairDadosViaTexto(texto, geminiKey);

      if (!resultadoGemini) {
        enviarMensagemTelegram(chatId, "⚠️ Não consegui entender o texto. Ex: 'acabou o arroz' ou 'almoço 30 no vale'.", telegramToken);
        return HtmlService.createHtmlOutput();
      }

      // SUB-ROTA 1: O usuário avisou que um produto esgotou
      if (resultadoGemini.intencao === "item_esgotado" && resultadoGemini.item_esgotado) {
        adicionarListaCompras(
          resultadoGemini.item_esgotado,
          resultadoGemini.categoria,
          resultadoGemini.urgencia
        );

        const prioridade = resultadoGemini.urgencia === "Alta" ? "🚨 Prioridade: Alta" : "📌 Prioridade: Normal";

        enviarMensagemTelegram(
          chatId,
          `📝 *Adicionado à lista de compras!*\n\n` +
          `🛒 *Produto:* ${resultadoGemini.item_esgotado}\n` +
          `🏷️ *Categoria:* ${resultadoGemini.categoria || "Geral"}\n` +
          `${prioridade}\n` +
          `📉 *Estoque:* Zerado na despensa`,
          telegramToken
        );
        return HtmlService.createHtmlOutput();
      }

      // SUB-ROTA 2: Registro financeiro/almoço manual
      dadosNota = resultadoGemini;
      nomeArquivo = "Lancamento_Manual_Telegram";

      // BLINDAGEM: Garante a criação de 'itens' caso o Gemini devolva valores na raiz do JSON
      if (!dadosNota.itens || dadosNota.itens.length === 0) {
        const valorDetectado = Number(dadosNota.preco_total || dadosNota.valor || dadosNota.preco || 0);
        const nomeDetectado = dadosNota.nome_padronizado || dadosNota.estabelecimento || dadosNota.descricao || "Almoço / Lanche";

        if (valorDetectado > 0) {
          dadosNota.itens = [{
            nome_original: texto,
            nome_padronizado: nomeDetectado,
            categoria: dadosNota.categoria || "Alimentação Fora",
            quantidade: 1,
            unidade: "un",
            preco_unitario: valorDetectado,
            preco_total: valorDetectado
          }];
        }
      }

    } else {
      enviarMensagemTelegram(chatId, "Envie uma foto de nota fiscal ou digite um comando/gasto.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // Validação de segurança para fluxo de gastos
    if (!dadosNota || !dadosNota.itens || dadosNota.itens.length === 0) {
      enviarMensagemTelegram(chatId, "⚠️ Não foi possível identificar os dados deste registro.", telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // Higienização de chave
    let identificador = "";
    if (dadosNota.identificador_nota) {
      identificador = String(dadosNota.identificador_nota).replace(/\D/g, "").trim();
      dadosNota.identificador_nota = identificador;
    }

    // Sanitização de data
    if (typeof validarECorrigirData === "function") {
      dadosNota.data_compra = validarECorrigirData(dadosNota.data_compra, identificador);
    }

    // Validação de duplicados (apenas notas fiscais reais)
    if (identificador && !identificador.startsWith("MANUAL") && notaJaCadastrada(identificador)) {
      if (driveFile && folderProcessadasId) driveFile.moveTo(DriveApp.getFolderById(folderProcessadasId));
      enviarMensagemTelegram(chatId, `⚠️ Esta nota (${identificador}) já tinha sido cadastrada!`, telegramToken);
      return HtmlService.createHtmlOutput();
    }

    // 4. Gravação na planilha e no Firebase
    gravarNaPlanilha(dadosNota, nomeArquivo);
    salvarNoFirebase(dadosNota, nomeArquivo);

    if (driveFile && folderProcessadasId) {
      driveFile.moveTo(DriveApp.getFolderById(folderProcessadasId));
    }

    // 5. Confirmação do gasto registrado
    const total = dadosNota.itens.reduce((acc, it) => acc + (Number(it.preco_total) || 0), 0);
    const local = dadosNota.estabelecimento || "Supermercado / Refeição";
    const qtd = dadosNota.itens.length;
    const pagto = dadosNota.forma_pagamento ? `💳 Forma: ${dadosNota.forma_pagamento}\n` : "";

    let dataFormatada = dadosNota.data_compra;
    if (dataFormatada && dataFormatada.includes("-")) {
      const p = dataFormatada.split("-");
      if (p.length === 3) dataFormatada = `${p[2]}/${p[1]}/${p[0]}`;
    }

    enviarMensagemTelegram(
      chatId,
      `✅ Salvo com sucesso!\n📅 Data: ${dataFormatada}\n🏪 Local: ${local}\n📦 Itens: ${qtd}\n${pagto}💰 Total: R$ ${total.toFixed(2).replace('.', ',')}`,
      telegramToken
    );

  } catch (err) {
    Logger.log("Erro no doPost: " + err.toString());
    if (chatId && telegramToken) {
      enviarMensagemTelegram(chatId, `❌ Erro na execução: ${err.message}`, telegramToken);
    }
  }

  return HtmlService.createHtmlOutput();
}

/**
 * Chamada à API Gemini com Structured Outputs para FOTOS de Notas Fiscais.
 */
function extrairDadosViaGemini(base64Image, mimeType, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;

  const promptTexto = `
Você é um especialista em OCR e normalização de cupons fiscais brasileiros.
Analise a nota fiscal e extraia os dados reais.

ATENÇÃO CRÍTICA PARA 'data_compra':
- O padrão impresso no cabeçalho costuma ser DD-MM-AA (ex: "21-10-26" significa 21 de outubro de 2026).
- Converta SEMPRE para o formato completo YYYY-MM-DD (ex: "2026-10-21"). NUNCA interprete o dia como o ano 2021.

ATENÇÃO CRÍTICA PARA 'identificador_nota':
- PRIORIDADE MÁXIMA: Procure a "Chave de Acesso" de 44 dígitos no rodapé ou próxima ao QR Code.
- EXTRAIA OS 44 DÍGITOS NUMÉRICOS CONTÍNUOS, SEM ESPAÇOS.
- APENAS se a nota estiver rasgada, use o número do CONTROLE / COO / Extrato.

Campos obrigatórios:
1. data_compra: Data no formato YYYY-MM-DD.
2. estabelecimento: Nome ou razão social.
3. identificador_nota: A Chave de Acesso de 44 dígitos (ou controle se ausente).
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

    if ((statusCode === 500 || statusCode === 503 || statusCode === 429) && tentativa < 3) {
      Utilities.sleep(3000 * tentativa);
      continue;
    }

    throw new Error(`Erro na API do Gemini (${statusCode}): ${response.getContentText()}`);
  }
}

/**
 * Chamada à API Gemini para TEXTOS LIVRES (Almoços, Gastos Rápidos ou Itens Esgotados).
 */
function extrairDadosViaTexto(mensagemTexto, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;
  const dataHoje = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

  const promptTexto = `
Você é um assistente financeiro pessoal.
Analise a mensagem e identifique a intenção: "registro_gasto" ou "item_esgotado".
Data base de hoje: ${dataHoje}.

Se a mensagem indicar despesa, alimentação, lanche ou valor pago (ex: "Alimentação tapioca 9 reais", "almoço 35 no va"):
- intencao: "registro_gasto"
- data_compra: Se houver data no texto (ex: 09/11/2026), converta para YYYY-MM-DD. Se não houver, use ${dataHoje}.
- estabelecimento: Nome do local/restaurante ou "Alimentação / Lanche".
- forma_pagamento: "Vale-Alimentação", "Vale-Refeição", "Débito", "Crédito", "Pix" ou "Outro".
- OBRIGATÓRIO preencher o array "itens" com exatamente 1 item contendo:
  * nome_original: texto original
  * nome_padronizado: nome limpo (ex: "Tapioca", "Almoço", "Lanche")
  * categoria: "Alimentação Fora"
  * quantidade: 1
  * unidade: "un"
  * preco_unitario: valor numérico (ex: 9.00)
  * preco_total: valor numérico (ex: 9.00)

Se a mensagem indicar que algo acabou (ex: "acabou o café"):
- intencao: "item_esgotado"
- item_esgotado: nome do produto
- categoria: categoria do item
- urgencia: "Normal" ou "Alta"
- itens: []

Mensagem do usuário: "${mensagemTexto}"
  `;

  const jsonSchema = {
    type: "OBJECT",
    properties: {
      intencao: { type: "STRING" },
      item_esgotado: { type: "STRING" },
      categoria: { type: "STRING" },
      urgencia: { type: "STRING" },
      data_compra: { type: "STRING" },
      estabelecimento: { type: "STRING" },
      forma_pagamento: { type: "STRING" },
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
          required: ["nome_padronizado", "quantidade", "preco_total"]
        }
      }
    },
    required: ["intencao"]
  };

  const payload = {
    contents: [{ parts: [{ text: promptTexto }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: jsonSchema,
      temperature: 0.1
    }
  };

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const statusCode = response.getResponseCode();

    if (statusCode === 200) {
      const json = JSON.parse(response.getContentText());
      return JSON.parse(json.candidates[0].content.parts[0].text);
    }

    if ((statusCode === 500 || statusCode === 503 || statusCode === 429) && tentativa < 3) {
      Utilities.sleep(2000 * tentativa);
      continue;
    }

    throw new Error(`Erro na API do Gemini Texto (${statusCode}): ${response.getContentText()}`);
  }
}

/**
 * Consulta simples do estoque consolidado.
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
 * Garante que a data esteja no formato YYYY-MM-DD e corrige inversões.
 */
function validarECorrigirData(dataStr, chaveAcesso) {
  const anoAtual = new Date().getFullYear();

  if (dataStr) {
    const partes = String(dataStr).trim().split(/[-/]/);
    
    if (partes.length === 3) {
      let [p1, p2, p3] = partes.map(Number);

      if (p1 < 2000) {
        if (p3 >= 20 && p3 <= 40) p3 = 2000 + p3;
        if (p2 <= 12 && p1 <= 31) {
          const ano = p3 >= 2000 ? p3 : anoAtual;
          return `${ano}-${String(p2).padStart(2, '0')}-${String(p1).padStart(2, '0')}`;
        }
      } else {
        if (chaveAcesso && chaveAcesso.length >= 6) {
          const anoChave = 2000 + parseInt(chaveAcesso.substring(2, 4), 10);
          const mesChave = parseInt(chaveAcesso.substring(4, 6), 10);
          if (p1 !== anoChave && anoChave >= 2020) {
            p1 = anoChave;
            if (p2 !== mesChave && mesChave <= 12) p2 = mesChave;
            return `${p1}-${String(p2).padStart(2, '0')}-${String(p3).padStart(2, '0')}`;
          }
        }
        return `${p1}-${String(p2).padStart(2, '0')}-${String(p3).padStart(2, '0')}`;
      }
    }
  }

  if (chaveAcesso && chaveAcesso.length >= 6) {
    const ano = 2000 + parseInt(chaveAcesso.substring(2, 4), 10);
    const mes = chaveAcesso.substring(4, 6);
    const diaHoje = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd");
    return `${ano}-${mes}-${diaHoje}`;
  }

  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

/**
 * Registro na folha de cálculo (aba Historico_Compras).
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

  abaHistorico.getRange(
    abaHistorico.getLastRow() + 1, 
    1, 
    linhasHistorico.length, 
    linhasHistorico[0].length
  ).setValues(linhasHistorico);

  if (dadosNota.tipo_gasto !== "Almoço") {
    atualizarOuInserirEstoque(ss, dadosNota);
  }
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
        // Primeiro registro do item
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
 * Registra um item na aba Lista_Compras e no Firebase.
 */
function adicionarListaCompras(itemNome, categoria, urgencia) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let abaLista = ss.getSheetByName("Lista_Compras");

  if (!abaLista) {
    abaLista = ss.insertSheet("Lista_Compras");
    abaLista.appendRow(["Item", "Categoria", "Urgencia", "Data_Inclusao", "Status"]);
  }

  const dataHoje = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
  abaLista.appendRow([itemNome, categoria || "Geral", urgencia || "Normal", dataHoje, "Pendente"]);

  const props = PropertiesService.getScriptProperties();
  const dbUrl = (props.getProperty("FIREBASE_DB_URL") || "").trim().replace(/\/$/, "");
  const dbSecret = (props.getProperty("FIREBASE_SECRET") || "").trim();

  if (dbUrl && dbSecret) {
    const chave = sanitizarChaveFirebase(itemNome.toLowerCase());
    const url = `${dbUrl}/lista_compras/${chave}.json?auth=${dbSecret}`;
    const payload = {
      nome: itemNome,
      categoria: categoria || "Geral",
      urgencia: urgencia || "Normal",
      adicionado_em: dataHoje,
      status: "Pendente"
    };
    UrlFetchApp.fetch(url, {
      method: "put",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  }

  zerarItemEstoque(itemNome);
}

/**
 * Zera a quantidade do item na aba Estoque_Atual.
 */
function zerarItemEstoque(nomeItem) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const abaEstoque = ss.getSheetByName("Estoque_Atual");
  if (!abaEstoque) return;

  const dados = abaEstoque.getDataRange().getValues();
  const busca = nomeItem.trim().toLowerCase();

  for (let r = 1; r < dados.length; r++) {
    if (String(dados[r][0]).trim().toLowerCase() === busca) {
      abaEstoque.getRange(r + 1, 3).setValue(0);
      break;
    }
  }
}
