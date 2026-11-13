# AndraScrapy

Recolhe produtos, categorias, preços, lojas e promoções de [ncrangola.com](https://www.ncrangola.com) com Puppeteer, guarda tudo em SQLite e apresenta os dados num dashboard com visão de BI.

## Requisitos

- Node.js 21 ou superior
- Google Chrome ou Chromium instalado (outro caminho: variável `ANDRA_CHROME`)

## Comandos

```bash
npm install
npm run css            # compila o Tailwind para public/css/app.css
npm run sync           # faz uma recolha agora
npm run dashboard      # abre o dashboard em http://127.0.0.1:3000
npm test               # testa a deteção de alterações

npm run cron:install   # instala a tarefa horária no crontab
npm run cron:status    # mostra a tarefa instalada
npm run cron:remove    # remove a tarefa, sem tocar nas restantes
```

Os registos do cron ficam em `logs/cron.log` e a base de dados em `data/andrascrapy.db`.

## De onde vêm os dados

O site corre em VTEX. O Puppeteer abre o site e faz os pedidos dentro da página, com a sessão do browser.

| Dados | Fonte |
|---|---|
| Categorias | `/api/catalog_system/pub/category/tree` |
| Produtos, preços e promoções | `/api/catalog_system/pub/products/search`, 50 de cada vez |
| Stock real | `/api/checkout/pub/orderForms/simulation`, sem criar carrinho nem reservar nada |
| Lojas físicas | Página `/nossas-lojas`, renderizada no browser |
| Pontos de levantamento | `/api/checkout/pub/pickup-points` |

Um produto está em promoção quando o preço de venda é inferior ao preço de tabela.

## Como ler o stock

- O catálogo só publica escalões: `1`, `10` (2 a 10), `100` (11 a 100) e `99999` (mais de 100).
- A simulação do checkout confirma a quantidade até 50 unidades por item.
- Abaixo de 50 o valor é exato. A partir daí aparece `50+`, e uma descida dentro dessa faixa não é visível.
- O stock é o total online: o site não o divide por loja.
- O catálogo só lista produtos disponíveis. Um produto esgotado tende a desaparecer dele, e por isso conta como "Saiu do catálogo" nas reduções.

## Sincronização

Cada execução compara a recolha com a base de dados e regista as diferenças como eventos: produtos novos, stock, preços e promoções.

- A primeira recolha serve de base e não gera eventos.
- Só uma recolha completa, com pelo menos 90% dos produtos ativos, pode marcar produtos como removidos.
- Se a leitura de stock falhar, mantém-se o valor anterior e não se cria nenhuma alteração.
- Um ficheiro de bloqueio impede duas sincronizações em simultâneo.
- O limite de produtos é 3000 (`ANDRA_MAX_PRODUCTS`).

## Rodar e acompanhar

Na página **Execuções** do dashboard:

- **Rodar agora** inicia uma recolha em segundo plano e abre o acompanhamento. A recolha continua mesmo que o dashboard seja fechado, e os registos ficam em `logs/manual.log`.
- **Acompanhar ao vivo** mostra a imagem do browser, a etapa atual e cada página aberta, clique e pedido.

Só corre uma recolha de cada vez, incluindo as do cron. As execuções iniciadas por **Rodar agora** carregam o site completo para o mostrar, por isso são mais pesadas. As do cron só escrevem o registo, sem imagem.

## Configuração

| Variável | Predefinição | Função |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Endereço do dashboard |
| `ANDRA_DB` | `data/andrascrapy.db` | Caminho da base de dados |
| `ANDRA_DELAY_MS` | `600` | Pausa entre pedidos ao site |
| `ANDRA_CHROME` | Deteção automática | Caminho do browser |
| `ANDRA_NO_SANDBOX` | Desligado | `1` desliga o sandbox do Chrome (só em contentores) |
