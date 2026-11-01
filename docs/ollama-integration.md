# Validação com Ollama real

`npm test` cobre contratos e falhas de forma isolada. O comando `npm run verify:ollama` é uma validação diferente: conecta ao servidor Ollama e à API HTTP já iniciados, calcula embeddings reais, indexa um documento temporário e exige uma resposta gerada com um fato correto e uma citação para esse documento. Ele não inicia serviços nem baixa modelos.

## Modelos e configuração

A configuração usada para a validação completa é:

```text
SEARCH_MODE=semantic
EMBEDDING_MODEL=embeddinggemma:300m
GENERATION_MODEL=qwen2.5:1.5b
REQUEST_TIMEOUT_MS=120000
```

[EmbeddingGemma](https://ollama.com/library/embeddinggemma) usa aproximadamente 622 MB para o arquivo do modelo, tem contexto de 2K e requer Ollama 0.11.10 ou posterior. Foi treinado com mais de 100 idiomas. [Qwen2.5 1.5B](https://ollama.com/library/qwen2.5:1.5b) ocupa aproximadamente 986 MB no formato publicado e oferece geração multilíngue. Os tamanhos de download não equivalem à RAM necessária para inferência; contexto e runtime também consomem memória.

Alternativas menores para um teste controlado são [all-minilm:22m](https://ollama.com/library/all-minilm), com cerca de 46 MB e contexto de 512 tokens, e [qwen2.5:0.5b](https://ollama.com/library/qwen2.5:0.5b), com cerca de 398 MB. Modelos menores podem recuperar pior em português ou deixar de seguir o formato de citação. Trocar de embedding exige reindexar os documentos; vetores de modelos diferentes não são comparáveis.

O adaptador usa [`POST /api/embed`](https://docs.ollama.com/api/embed) com `input` em lote e `truncate:false`. Uma entrada fora do contexto falha antes de substituir o documento existente. Isso evita armazenar um vetor calculado sobre um texto truncado silenciosamente. O tamanho em caracteres dos chunks não garante que eles caibam em qualquer tokenizer; adapte o chunking se adotar um modelo de contexto curto.

## Executar contra os serviços iniciados

O servidor precisa estar com modo semântico, geração habilitada e os modelos já presentes no Ollama. Use o procedimento de inicialização do README ou do Compose do ambiente local. Depois, nesta pasta:

```powershell
$env:EVIDENCE_URL = 'http://127.0.0.1:8004'
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
$env:EMBEDDING_MODEL = 'embeddinggemma:300m'
$env:GENERATION_MODEL = 'qwen2.5:1.5b'
$env:EVIDENCE_API_KEY = 'demo-team-a'
$env:EVIDENCE_OTHER_API_KEY = 'demo-team-b'
npm.cmd run verify:ollama
```

O script não carrega `.env` automaticamente. As chaves usadas devem pertencer a equipes diferentes configuradas no servidor. Para serviços no Docker, os valores acima são os endereços publicados para o host; dentro da rede Compose, o endereço do Ollama normalmente usa o nome do serviço.

## O que é verificado

1. Versão do Ollama e capacidades dos dois modelos via `/api/show`.
2. Embeddings reais de dois textos, dimensão consistente e valores finitos não nulos.
3. `/health` confirma modo semântico na API.
4. Ingestão por HTTP de uma política fictícia com um prazo de 37 dias.
5. Busca recupera essa política, enquanto outra equipe não consegue obtê-la, mesmo enviando um campo `tenant` no corpo.
6. `/v1/answer` gera texto contendo o prazo correto e cita um chunk retornado como evidência.
7. O documento temporário é removido ao terminar, inclusive após uma falha posterior à ingestão.

O relatório fica em `var/ollama-integration.json` por padrão, incluindo versão, dimensão, duração de cada etapa, resposta e evidências. `INTEGRATION_REPORT` altera o destino; `INTEGRATION_TIMEOUT_MS` altera o prazo do cliente de validação. Se uma etapa falhar, o processo termina com código 1 e registra o erro. Nenhuma resposta inválida é substituída por uma resposta preparada.

## Falha encontrada com o modelo real

A primeira execução com Qwen2.5 1.5B recuperou a evidência correta, mas a geração omitiu a citação. A API recusou a resposta com `502 invalid_citations`, como previsto pelo contrato. O registro anterior à correção está em [`reports/ollama-integration-before-citation-fix.json`](../reports/ollama-integration-before-citation-fix.json).

Uma tentativa de resolver apenas com instruções mais explícitas continuou falhando para outro UUID. Esse segundo resultado está em [`reports/ollama-integration-after-prompt-only-fix.json`](../reports/ollama-integration-after-prompt-only-fix.json). Manter somente o prompt não resolveu a confiabilidade do formato.

A geração passou a solicitar uma [saída estruturada no Ollama](https://docs.ollama.com/api/generate), com `answer`, `citations` e `abstain`. O schema enumera os IDs das evidências recuperadas. A aplicação ainda faz a própria validação do JSON, dos campos e de cada ID; não confia apenas no schema do provedor. O texto da resposta vem do modelo e a aplicação apenas formata os marcadores dos IDs validados. O contrato HTTP continua retornando `answer`, `generated`, `reason` e `evidence`.

Temperatura zero, seed fixa e limite de 512 tokens reduzem a variação e limitam a saída. Não há resposta preparada nem redução da exigência de fonte. A regressão cobre JSON inválido, campos incompletos, IDs desconhecidos, abstenção explícita e citações inventadas dentro do texto. O teste de integração também exige o fato correto da fixture, para que apenas devolver um ID não seja suficiente.

## Resultado após a correção

Com Ollama 0.40.11, `embeddinggemma:300m` e `qwen2.5:1.5b`, o container corrigido passou em três execuções consecutivas, cada uma com um novo UUID de documento. Todas recuperaram a política, preservaram o prazo de 37 dias e retornaram a citação exata do chunk. O isolamento entre equipes e a remoção da fixture também passaram em todas as execuções.

O embedding tinha 768 dimensões e a similaridade da consulta com a fixture foi 0,886982. As etapas de geração levaram aproximadamente 4,09 s, 3,19 s e 3,20 s naquele ambiente. São medidas desse caso local, não metas de latência. O texto e a pergunta permaneceram iguais; variar os UUIDs verifica o formato de citação sem representar perguntas independentes ou maior diversidade de avaliação.

O [sumário versionado](../reports/ollama-integration.json) aponta para os três registros completos: [execução 1](../reports/ollama-integration-run-1.json), [execução 2](../reports/ollama-integration-run-2.json) e [execução 3](../reports/ollama-integration-run-3.json). Foram 21 etapas aprovadas no total. A suíte isolada contém 14 testes aprovados, e a verificação de tipos também passou.

O comando de integração continua gravando um relatório por execução no destino indicado em `INTEGRATION_REPORT`. A configuração reduz a variação do modelo; não garante respostas idênticas entre versões ou hardwares.

Esse teste confirma o caminho integrado de uma fixture controlada. Ele não estima a qualidade de recuperação ou geração sobre uma base real, nem comprova que todas as afirmações de uma resposta com citações sejam sustentadas. Para isso, é necessário um conjunto de avaliação maior e revisão do conteúdo.
