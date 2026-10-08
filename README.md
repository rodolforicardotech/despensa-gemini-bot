# 🛒 Leitor de Notas Fiscais Inteligente

Pipeline ponta a ponta de ingestão, OCR multimodal e controle de estoque doméstico utilizando **Telegram Bot**, **Google Apps Script**, **Gemini API** e **Google Sheets**.

---

## 📌 Visão Geral

Gerenciar compras domésticas, histórico de gastos e reposição de despensa costuma gerar atrito manual: digitar comprovantes item a item em planilhas ou escanear comprovantes manualmente.

Este projeto automatiza todo o ciclo com **zero esforço de digitação**:
1. O usuário envia uma foto do cupom fiscal diretamente para um bot privado no Telegram.
2. Um Webhook em Apps Script captura a imagem e armazena os bytes no Google Drive.
3. O modelo **Gemini 2.5 Flash Lite** processa o cupom com saída estruturada (*Structured Outputs / JSON Schema*).
4. O pipeline decifra abreviações fiscais (`FEC MAN PINHEIRO` ➔ `Fécula de Mandioca Pinheiro 1kg`), deduplica a nota por controle/chave fiscal e atualiza tanto o histórico analítico quanto o inventário de despensa.
5. Consultas rápidas podem ser feitas via comando `/estoque` diretamente no chat do Telegram.

---


## 🏗 Arquitetura da Solução

```text
[ Foto via Telegram ] 
          │
          ▼
[ Webhook doPost (Google Apps Script) ]
          │
          ├── Salva cópia bruta ──► [ Google Drive: Pasta Entrada ]
          │
          ▼
[ Gemini 2.5 Flash Lite API ]
  ├── OCR Multimodal
  ├── JSON Schema estrito
  └── Normalização de abreviações fiscais
          │
          ▼
[ Pipeline de Validação & Persistência ]
  ├── 1. Deduplicação via Chave/Controle NFC-e
  ├── 2. Inserção na aba 'Historico_Compras'
  ├── 3. Upsert na aba 'Estoque_Atual'
  └── 4. Arquivamento do arquivo ──► [ Google Drive: Pasta Processadas ]
          │
          ▼
[ Feedback Telegram ] ◄── Confirmação com total, local e quantidade de itens
```
---

## 🚀 Funcionalidades Principais

    Ingestão Simples via Telegram: Envio direto de fotos de cupons fiscais pelo celular com feedback em tempo real.

    Normalização de Entidades (OCR Fiscal): Separação automática entre o texto original impresso (Item_Original) e o nome canônico em português (Nome_Padronizado).

    Prevenção de Duplicidade: Extração de chave de acesso de 44 dígitos ou número de controle fiscal para barrar reprocessamento acidental de notas.

    Gestão de Estoque: Atualização de saldos de despensa e cálculo de ciclos de reposição com distinção entre itens perecíveis e de mercearia.

    Consulta Rápida (/estoque): Comando no bot para listar imediatamente os itens monitorados sem necessidade de abrir a planilha.

    Alertas Automáticos: Rotina diária de e-mail identificando itens esgotados ou a vencer nos próximos dias.

---

## 🛠 Tecnologias Utilizadas

    Linguagem & Runtime: JavaScript / Google Apps Script (V8 Engine)

    Visão Computacional & LLM: Google Gemini API (gemini-2.5-flash-lite) via REST com schema JSON estrito

    Interface & Mensageria: Telegram Bot API

    Armazenamento Transacional: Google Sheets & Google Drive

    Ferramentas de Desenvolvimento: @google/clasp, Git, GitHub



## 📁 Estrutura do RepositórioPlaintext
├── src/
│   ├── Code.js              # Lógica do Webhook, Gemini OCR, persistência e comandos
│   └── appsscript.json      # Manifesto do Google Apps Script
├── .gitignore
├── README.md
└── LICENSE

---

⚙️ Configuração e Implantação
1. Pré-requisitos

    Conta no Telegram e bot criado via @BotFather (obtenha o token HTTP da API).

    Chave de API no Google AI Studio.

    Uma planilha no Google Sheets com pastas criadas no Google Drive para arquivos de entrada e processadas.

    Node.js instalado com o clasp:

```npm install -g @google/clasp```


2. Clonar e VincularBashgit clone [https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git](https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git)
cd SEU_REPOSITORIO
clasp login
clasp clone "SEU_SCRIPT_ID"
3. Propriedades do Script (Script Properties)
Propriedade,Descrição
TELEGRAM_BOT_TOKEN,Token retornado pelo @BotFather
GEMINI_API_KEY,Chave de API do Google Gemini
FOLDER_ENTRADA_ID,ID da pasta do Drive para recebimento das fotos
FOLDER_PROCESSADAS_ID,ID da pasta do Drive de notas concluídas

4. Deploy do Web App

    Clique em Implantar > Nova implantação.

    Tipo: Aplicativo da Web.

    Executar como: Eu.

    Quem pode acessar: Qualquer pessoa.

    Copie a URL gerada (terminada em /exec).

5. Registrar o Webhook

Execute no Apps Script a função registrarWebhookTelegram(), passando a URL do seu Web App para registrar o endpoint na API do Telegram.

## 📊 Próximos Passos (Engenharia de Dados)
Ingestão periódica dos dados da planilha para camada Bronze em formato Delta Lake.
Modelagem dimensional Star Schema na camada Silver (dim_produto, dim_estabelecimento, fato_compras) com resolução de entidades via GTIN/EAN.
Construção de Data Marts analíticos (Gold) para métricas de inflação pessoal (IPCA próprio) e comparativo de preços entre estabelecimentos.