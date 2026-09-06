// A lingua do que o conector escreve NA TELA da pessoa. Nada aqui toca o protocolo nem o texto
// que a IA le: o envelope do gancho e o resumo de abertura continuam sendo os mesmos bytes em
// qualquer lingua, porque quem consome aquilo e programa, nao gente.
//
// O PADRAO E INGLES, de proposito. O produto e vendido em ingles - o guia, a ficha do catalogo
// oficial e as vitrines - e a maquina de um desconhecido raramente declara lingua nenhuma
// (WSL sai de fabrica com C.UTF-8, o Windows nao exporta LANG). Cair em portugues nesse silencio
// e o defeito que este arquivo existe pra evitar.
//
// So vira portugues quando ALGUEM DISSE que e portugues: a variavel do proprio Trail, ou a lingua
// declarada pelo sistema. TRAIL_LANG ganha do sistema, e serve tanto pra pessoa que quer o
// conector na sua lingua quanto pra provar as duas saidas no teste.
function escolher() {
  const forcado = process.env.TRAIL_LANG || process.env.TETHER_LANG || ''
  if (forcado.trim()) return /^pt/i.test(forcado.trim()) ? 'pt' : 'en'
  const sistema = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  return /^pt/i.test(sistema) ? 'pt' : 'en'
}

export const idioma = escolher()

// Os dois textos ficam lado a lado na propria linha de codigo, em vez de um dicionario com
// chaves: assim nao existe chave orfa nem frase que ficou pra tras sem ninguem ver.
export const t = (pt, en) => (idioma === 'pt' ? pt : en)
