# tether-mcp

MCP do **Trail** - conecta o Claude Code (a IA) ao tracker de roadmap da sua equipe.

Este pacote e so o **cliente**: ele fala com o seu servidor do Trail. Qualquer um pode instalar,
mas para usar precisa de uma **conta** no seu Trail (criada pelo admin) - a trava de acesso e o
login do servidor, nao este codigo. O login e pelo site (device flow, estilo `gh auth login`):
voce nao copia token a mao. Cada pessoa conecta a propria maquina e o Claude passa a escrever
**como ela**, so nos projetos que ela pode ver, e no projeto da **pasta aberta** (nao mistura).

Leve: so `@modelcontextprotocol/sdk` + `zod` + `fetch` nativo (fala com a API REST; sem banco).

## Instalar (cada dev, uma vez)

O conector e **baixado** para a sua maquina (git clone), nao puxado de um pacote remoto a cada
abertura: nao existe pacote publicado em npm, o codigo fica visivel na sua pasta, e a
auto-atualizacao (`git pull --ff-only` a cada 6h) so funciona porque existe um `.git` ao lado.

O admin te passa **o endereco do Trail** (a URL) e cria sua conta. Depois:

```bash
# 1. baixa o conector e instala as dependencias dele
git clone https://github.com/arsprengel/tether-mcp.git ~/.trail-mcp
npm --prefix ~/.trail-mcp install --omit=dev

# 2. registra o MCP no Claude Code (escopo user = vale em todos os seus projetos)
claude mcp add trail -s user -- node ~/.trail-mcp/bin.js

# 3. conecta esta maquina a sua conta (troque pela URL que o admin te passou)
TETHER_API_URL=https://SEU-TETHER node ~/.trail-mcp/bin.js login
```

No Windows, troque `~` pelo caminho real da sua pasta de usuario: o `claude mcp add` guarda o
argumento cru e o Node nao expande `~`.

O login abre o navegador numa pagina `/conectar`; voce confirma (ja logado) e o terminal recebe
o token sozinho. A URL fica salva, entao o Claude ja sobe conectado nas proximas vezes.

Pronto. Abra o Claude em qualquer projeto e peca "lista as pendencias do tether".

## Comandos

```bash
TETHER_API_URL=https://SEU-TETHER node ~/.trail-mcp/bin.js login   # conecta esta maquina
node ~/.trail-mcp/bin.js status                                    # url, projeto, token
node ~/.trail-mcp/bin.js logout                                    # apaga o token salvo
node ~/.trail-mcp/bin.js doctor                                    # destrava a auto-atualizacao
```

O token fica em `~/.config/tether/token.json` (chmod 600). Revogue quando quiser pelo painel
"Token da IA" do dashboard.

## Como funciona o escopo de projeto

O tracker e um banco unico com varios projetos. O MCP usa **a pasta aberta** como projeto (o nome
da pasta, ou a env `TETHER_PROJECT`). Assim o Claude escreve no projeto certo e nao mistura. Para
mexer em outro projeto, a IA passa `project` explicito na tool.

## Configuracao (env)

- `TETHER_API_URL` - endereco do seu Trail. Obrigatorio no 1o login; depois fica salvo.
- `TETHER_PROJECT` - forca o nome do projeto (default: o nome da pasta aberta).
- `TETHER_API_TOKEN` - token direto (pula o login pelo site; util em CI).

## Tools expostas

Itens: `list_items`, `get_item`, `add_item`, `update_item`, `move_item`, `get_next`, `delete_item`.

MRP (Memoria Referencial de Projeto, v1.1.0+): `list_memory`, `add_memory`, `update_memory` -
o conhecimento duravel do projeto (comandos, deploy, gotchas, decisoes, contexto), compartilhado
entre todos os participantes. A IA consulta ao comecar a trabalhar e registra o que descobre;
no dashboard e a aba "Referencia".

## Hooks de sessao (v1.3.0+, recomendado)

`node <pasta>/bin.js hooks install` registra no seu `~/.claude/settings.json` (com backup e sem
duplicar) o hook de ABERTURA: ao abrir uma sessao do Claude num projeto com tracker, os itens
abertos e a MRP entram automaticos no contexto (a IA nasce sabendo, sem depender de chamar
tool), junto com a convencao de manter o status dos itens em dia. Sempre fail-silent: sem
login/rede o hook sai quieto e nada quebra. `hooks uninstall` desfaz.

O hook de FECHAMENTO saiu na **v1.11.0** (e o install remove o que estiver registrado). Ele
cobrava reconciliar item in_progress no fim de cada turno, e isso saia na tela do usuario como
"Stop hook error" com o comando do hook junto. Medido no proprio Claude Code: qualquer palavra
que um hook devolva no fim do turno - inclusive contexto "silencioso" - reabre o turno e faz o
modelo emitir MAIS UMA resposta na tela; calado, sai uma resposta so. A cobranca migrou pro
texto de abertura, onde nao custa nada. Quem ainda tiver o hook antigo registrado nao precisa
fazer nada: o comando existe e nao fala mais.
O install.sh ja oferece esse registro no final.

## Atualizar (pegar tools novas)

A partir da **v1.2.0** o cliente instalado por clone se atualiza SOZINHO: ao subir, dispara um
`git pull` silencioso em background (no maximo a cada 6h) - a sessao atual segue como esta e a
PROXIMA ja sobe na versao nova. Sem rede ou com conflito local, nada acontece (fail-silent).

Se a sua instalacao e anterior a v1.2.0, atualize UMA ultima vez na mao: entre na pasta do
clone, `git pull` e reinicie as sessoes do Claude. Se instalou via `npx github:...`: limpe o
cache do npx (`rm -rf ~/.npm/_npx`) e reinicie (via npx nao ha auto-update; prefira o clone).
