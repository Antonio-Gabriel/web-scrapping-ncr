# AndraScrapy

Recolhe produtos, categorias, preços, lojas e promoções de duas lojas online angolanas com Puppeteer, guarda tudo em SQLite e apresenta os dados num dashboard com visão de BI:

- [ncrangola.com](https://www.ncrangola.com) (NCR Angola, em VTEX)
- [querapidoangola.com](https://www.querapidoangola.com) (Que Rápido Angola, em WooCommerce)

A Visão geral do dashboard mostra o total das duas lojas. As outras páginas têm separadores para escolher a loja.

## Requisitos

- Node.js 21 ou superior
- Google Chrome ou Chromium instalado (outro caminho: variável `ANDRA_CHROME`)

## Comandos

```bash
npm install
npm run css                            # compila o Tailwind para public/css/app.css
npm run sync                           # recolhe a NCR Angola agora
node src/cli/sync.js --fonte=qr        # recolhe a Que Rápido agora
npm run dashboard                      # abre o dashboard em http://127.0.0.1:3000
npm test                               # testa a deteção de alterações

npm run cron:install   # instala as tarefas horárias no crontab: NCR às :00, Que Rápido às :30
npm run cron:status    # mostra as tarefas instaladas
npm run cron:remove    # remove as tarefas, sem tocar nas restantes
```

A base de dados fica em `data/andrascrapy.db`. Os registos do cron ficam em `logs/cron.log` (NCR) e `logs/cron-qr.log` (Que Rápido).

## De onde vêm os dados

Nas duas lojas, o Puppeteer abre o site e faz os pedidos dentro da página, com a sessão do browser.

### NCR Angola (VTEX)

| Dados | Fonte |
|---|---|
| Categorias | `/api/catalog_system/pub/category/tree` |
| Produtos, preços e promoções | `/api/catalog_system/pub/products/search`, 50 de cada vez |
| Stock real | `/api/checkout/pub/orderForms/simulation`, sem criar carrinho nem reservar nada |
| Lojas físicas | Página `/nossas-lojas`, renderizada no browser |
| Pontos de levantamento | `/api/checkout/pub/pickup-points` |

### Que Rápido Angola (WooCommerce)

| Dados | Fonte |
|---|---|
| Categorias | `/wp-json/wc/store/v1/products/categories` |
| Produtos, preços, promoções, marcas e estado do stock | `/wp-json/wc/store/v1/products`, 100 de cada vez, só com os campos necessários |
| Imagens | O mesmo endereço, pedido só para os produtos que ainda não têm imagem |

Nas duas lojas, um produto está em promoção quando o preço de venda é inferior ao preço de tabela.

## Como ler o stock

**NCR Angola**

- O catálogo só publica escalões: `1`, `10` (2 a 10), `100` (11 a 100) e `99999` (mais de 100).
- A simulação do checkout confirma a quantidade até 50 unidades por item.
- Abaixo de 50 o valor é exato. A partir daí aparece `50+`, e uma descida dentro dessa faixa não é visível.
- O stock é o total online: o site não o divide por loja.
- O catálogo só lista produtos disponíveis. Um produto esgotado tende a desaparecer dele, e por isso conta como "Saiu do catálogo" nas reduções.

**Que Rápido Angola**

- A loja não publica quantidades, só o estado: em stock, por encomenda ou fora de stock.
- As alterações registadas são as mudanças desse estado.

## Sincronização

Cada execução compara a recolha com a base de dados e regista as diferenças como eventos: produtos novos, stock, preços e promoções. Cada loja tem as suas tabelas (as da Que Rápido têm o prefixo `q_`), com as mesmas colunas.

- A primeira recolha de cada loja serve de base e não gera eventos.
- Só uma recolha completa, com pelo menos 90% dos produtos ativos, pode marcar produtos como removidos.
- Se a leitura de stock falhar, mantém-se o valor anterior e não se cria nenhuma alteração.
- Cada loja tem o seu ficheiro de bloqueio, que impede duas recolhas da mesma loja em simultâneo.
- Limite de produtos: 3000 na NCR (`ANDRA_MAX_PRODUCTS`). Na Que Rápido recolhem-se todos.

## Rodar e acompanhar

Na página **Execuções** do dashboard, com o separador da loja escolhido:

- **Rodar agora** inicia uma recolha dessa loja em segundo plano e abre o acompanhamento. A recolha continua mesmo que o dashboard seja fechado. Os registos ficam em `logs/manual.log` (NCR) e `logs/manual-qr.log` (Que Rápido).
- **Acompanhar ao vivo** mostra a imagem do browser, a etapa atual e cada página aberta, clique e pedido.

As execuções iniciadas por **Rodar agora** carregam o site completo para o mostrar, por isso são mais pesadas. As do cron e as da linha de comandos só escrevem o registo, sem imagem.

## Configuração

| Variável | Predefinição | Função |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Endereço do dashboard |
| `ANDRA_DB` | `data/andrascrapy.db` | Caminho da base de dados |
| `ANDRA_DELAY_MS` | `600` | Pausa entre pedidos ao site |
| `ANDRA_CHROME` | Deteção automática | Caminho do browser |
| `ANDRA_NO_SANDBOX` | Desligado | `1` desliga o sandbox do Chrome (só em contentores) |
