# Jev pre-delegation guard (etapa 2 do ciclo de dev)

Status: **informativo / shadow. Não bloqueia roteamento. Sem chamadores ligados por padrão.**

## Objetivo
Antes de delegar uma tarefa a um agente, sinalizar riscos e recomendar: revisão humana, teste obrigatório, divisão da tarefa.

## Regras
1. **Regra local decide primeiro** (`assessLocally`, determinística, sem rede).
   Flags: `auth_session`, `migration_rls`, `production`, `secrets`, `deploy`, `dependencies`.
   Risco local: `high` (auth/sessão, migração/RLS, segredos, ou produção + outra flag), `medium` (qualquer outra flag), `low`.
2. **Jev só endurece**: com `GATESWARM_JEV_MODE=shadow` o Jev recebe **apenas as flags** (nunca o texto da tarefa) e devolve `low|medium|high`. `final = max(local, jev)`; recomendações só são adicionadas, nunca removidas.
3. **Fail-open**: timeout 800 ms (`GATESWARM_JEV_TIMEOUT_MS`), sem chave/erro/HTTP != 200 → ignora o Jev. Tarefas `privacy:'private'` nunca são enviadas.
4. **Saída**: objeto com `note` (texto curto para anexar ao retorno) e uma linha JSONL em `data/jev-shadow/jev-predelegation.jsonl` (`GATESWARM_JEV_PREDELEGATION_LOG`), com hash, tamanho, flags e riscos — **sem texto da tarefa**.

## Uso
```ts
import { preDelegationCheck } from './src/jev/pre-delegation.js';
const r = await preDelegationCheck({ task, filesTouched: 4 });
console.log(r.note); // informativo; não altera tier/modelo
```

## Divisão sugerida
Texto > 1500 chars, >= 8 itens de lista, > 10 arquivos, ou >= 3 flags.

## Próximos passos
Ligar no fluxo de delegação (hoje só biblioteca), medir contra rótulos HITL antes de qualquer enforcement.
