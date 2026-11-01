![Evidence Search: respostas com fontes](docs/assets/banner.svg)

# Evidence Search

Uma pergunta chega à API; o serviço recupera trechos da equipe autorizada e pode pedir a um modelo local uma resposta com referências. O objetivo é permitir que quem consulta confira a origem da informação.

**Documento → trechos indexados → busca → resposta + evidências**

O backend em TypeScript usa SQLite e oferece busca lexical ou semântica. No modo semântico, um **modelo de embeddings** representa os trechos para a busca; um **modelo de linguagem** pode gerar a resposta com as evidências encontradas. Ambos podem executar localmente pelo Ollama. O conteúdo da demonstração é fictício.

## Exemplo: pergunta com fonte

Uma política fictícia é indexada, um trecho é recuperado e o modelo responde com o identificador da evidência. A animação mostra as três etapas da execução registrada.

![Documento, busca e resposta com fonte](docs/assets/demo.gif)

[Explorar as etapas](docs/demo/index.html) · [Consultar o registro](docs/demo/run.json) · [Guia da demonstração](docs/PRESENTATION.md)

<details><summary>Ver a captura do painel</summary>

![Resposta e trecho recuperado](docs/assets/screenshot.jpg)

</details>

## Primeiros passos

Requer Node.js 24 ou superior. O TypeScript é executado pelo Node sem build; `tsc` faz a verificação estática.

```powershell
npm ci
Copy-Item .env.example .env
npm test
npm run typecheck
npm run demo
npm run evaluate
npm start
```

A demonstração e a avaliação usam uma base em memória e não precisam de `.env`, Ollama ou chave paga. A API usa SQLite em `var/documents.sqlite`. O Node pode emitir um aviso sobre `node:sqlite`.

```powershell
$headers = @{Authorization = 'Bearer demo-team-a'}
$document = @{id='reembolso';title='Reembolso';source='manual.md';text='O pedido de reembolso deve ser enviado em ate 30 dias.'} | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:8004/v1/documents -Method Post -Headers $headers -ContentType 'application/json' -Body $document
$query = @{query='prazo para reembolso';topK=3} | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:8004/v1/search -Method Post -Headers $headers -ContentType 'application/json' -Body $query
Invoke-RestMethod http://127.0.0.1:8004/v1/answer -Method Post -Headers $headers -ContentType 'application/json' -Body $query
```

`POST /v1/documents` substitui atomicamente um documento de mesmo ID na mesma equipe. `DELETE /v1/documents/{id}` remove também os trechos. `GET /health` informa o modo configurado.

## Da ingestão à resposta

![Fluxo de dados e componentes do Evidence Search](docs/assets/architecture.svg)

Ingestão transacional e recuperação por equipe, com modelos Ollama opcionais e validação das fontes antes da resposta HTTP. Veja as [decisões técnicas](docs/architecture.md).

## Usar modelos reais

Instale o Ollama separadamente, escolha um modelo de embeddings disponível e obtenha-o com `ollama pull <modelo>`. Defina `SEARCH_MODE=semantic` e `EMBEDDING_MODEL=<modelo>` no `.env`. O exemplo sugere `embeddinggemma`; o modelo não vem no repositório. Reimporte os documentos depois de alterar o modelo. Para gerar respostas, obtenha um modelo de texto e preencha `GENERATION_MODEL`. Sem ele, `/v1/answer` devolve evidências e `answer: null`.

Para avaliar embeddings, carregue as variáveis explicitamente:

```powershell
node --env-file=.env scripts/evaluate.ts
```

A integração usa a API do Ollama: `/api/embed` e `/api/generate`. O cliente valida quantidade, dimensão, norma e valores dos vetores e aplica timeout. Os testes usam um servidor HTTP local controlado; não medem a qualidade de um modelo baixado.

Com os serviços e modelos iniciados, `npm run verify:ollama` valida embeddings, ingestão semântica, isolamento e uma resposta real com citação. Veja [o procedimento, os requisitos e a falha que levou a uma correção](docs/ollama-integration.md). A geração usa um esquema com resposta, IDs de citação e abstenção, validado novamente pela aplicação. O adaptador rejeita entradas fora do contexto do modelo em vez de truncar silenciosamente o documento.

A verificação registrada passou em três execuções consecutivas contra o contêiner com Ollama real, usando `embeddinggemma:300m` e `qwen2.5:1.5b`. O [sumário e os registros completos](reports/ollama-integration.json) incluem resposta, fonte e isolamento; a suíte isolada tem 14 testes aprovados. As duas falhas encontradas antes da correção foram preservadas nos relatórios para explicar a decisão técnica.

## Avaliação e limites

`data/corpus.json` contém seis documentos fictícios escritos para este projeto; `data/questions.json` contém doze perguntas com documento relevante anotado. `npm run evaluate` salva Recall@3, MRR@3, latências e casos em `var/evaluation.json`. Um conjunto escrito junto com o corpus é um teste inicial, com viés favorável; não prova generalização. Amplie com perguntas independentes antes de comparar modelos. A qualidade da geração não é medida por esse benchmark.

No modo gerado, citações inexistentes são recusadas. Uma citação existente não garante que toda afirmação esteja apoiada: esse julgamento ainda requer avaliação humana. Documentos e perguntas são enviados ao Ollama configurado. Os endpoints não fazem download de URLs recebidas como `source`.

SQLite e ranking em memória servem a bases pequenas. Não há índice vetorial aproximado, autenticação por usuário final nem suporte a PDF/OCR. Há limite de 150 KB por requisição e 100 mil caracteres de texto. As chaves do exemplo são públicas, apenas para desenvolvimento local.

## Docker

```powershell
docker build -t evidence-search .
docker run --rm -p 127.0.0.1:8004:8004 --env-file .env -e HOST=0.0.0.0 -v evidence-data:/app/var evidence-search
```

No Docker, `127.0.0.1` é o próprio contêiner. Para Ollama no host, ajuste `OLLAMA_URL` conforme seu ambiente.

Veja [docs/architecture.md](docs/architecture.md) e [COMMITS.txt](COMMITS.txt).
