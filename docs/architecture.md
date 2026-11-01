# Decisoes de projeto

HTTP -> autenticacao -> namespace da chave -> SearchService -> SQLite / provedor de modelo.

O filtro de equipe acontece na consulta SQL, antes do ranking. As chaves compostas incluem a equipe nas tabelas e na foreign key. O mesmo id de documento pode existir em duas equipes sem colisoes. Testes tentam pesquisar e excluir documentos de outra equipe.

Na ingestao, chunks mantem linhas do texto original. Os embeddings sao calculados antes da transacao. Se o provedor falhar, a versao anterior continua disponivel. A troca de documento usa BEGIN IMMEDIATE / COMMIT / ROLLBACK e foreign keys com cascade.

O nome do modelo e salvo junto de cada vetor. Mudar de modelo exige reindexacao mesmo quando a dimensao continua igual: espacos vetoriais diferentes nao sao comparaveis. Um modo lexical explicito permite estudar o ganho dos embeddings sem depender de downloads para rodar a demo.

O limiar cosseno 0.15 e apenas um valor inicial configurado em codigo, sem calibracao estatistica. Deve ser ajustado em conjunto de validacao. Nao e uma probabilidade de resposta correta.

Em producao, os proximos passos seriam um provedor de identidade, rotacao de chaves, limite de uso por equipe e indice vetorial persistente. A implementacao atual prioriza um fluxo auditavel em um unico processo. Texto sensivel deve seguir as politicas de retencao e do servidor de modelos escolhido.
