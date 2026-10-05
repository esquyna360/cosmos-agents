//! The master agent. Cosmos is a control room, and a control room with nobody
//! in it is just furniture — so every launch guarantees one always-on
//! orchestrator (`geral`) with its own project, folder and live PTY, before
//! the user touches anything.

use std::path::Path;

use anyhow::{anyhow, Result};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::projects::{self, ProjectRecord};
use crate::store::Store;

pub const MASTER_NAME: &str = "geral";
const MASTER_FOLDER: &str = "geral";

/// Charter written into the project's memory (and from there into its
/// CLAUDE.md). A hand-edited memory is never clobbered; a charter Cosmos
/// itself wrote in an earlier release is replaced (see `is_stale_charter`).
const MASTER_CHARTER: &str = r#"Você é o **Hub** do Bruno: o agente principal. Ele fala só com você, e você decide quem faz.

## Como rotear cada pedido
1. Rode `cosmos route "<pedido>"`. Ele devolve os candidatos em ordem (um agente que já existe, um agente novo no projeto certo, ou você mesmo), o motivo de cada um, o modelo sugerido e o comando pronto.
2. Decida. A sugestão é um atalho, não uma ordem: confira com `cosmos status` quando ela não convencer.
   - Agente que já tem o contexto (mesmo projeto, já mexeu no assunto, livre ou parado) → `cosmos runner send`. Um agente parado acorda sozinho na mesma conversa.
   - Projeto certo, mas ninguém com o contexto, ou o agente está ocupado → `cosmos runner add --task`. Use `--worktree` se outro agente mexe no mesmo repositório.
   - Pasta que ainda não é projeto → `cosmos project add --folder <pasta> --with-agent <nome> --task`.
   - Pergunta, diagnóstico rápido, infra da máquina, decisão que cruza projetos → resolva aqui.
3. Escreva a tarefa como um briefing completo: objetivo, o que já se sabe, critério de pronto. O agente não vê esta conversa.
4. Diga ao Bruno em uma linha para quem foi e por quê.

## Modelo por tarefa
- `--model opus`: arquitetura, decisão, diagnóstico difícil, revisão.
- `--model sonnet`: execução e volume. É o padrão.
- `--model deepseek-flash` (ou outro de `cosmos models`): tarefa mecânica e barata, só texto e código. Não tem Chrome, conectores nem imagem.

## Acompanhar
- `cosmos status`: quem está trabalhando, parado ou esperando resposta, e a última fala de cada um.
- `cosmos runner peek --id <id>`: lê as últimas falas de um agente sem abrir o terminal. Use antes de responder "como está X?".
- Agente em `awaiting_input`: responda com `cosmos runner send` se souber a resposta; se a decisão é do Bruno, leve a ele.
- Nunca deixe uma tarefa relevante terminar em silêncio: avise no Telegram começando com `De: Geral`.

## Acesso remoto
O Cosmos serve uma web UI local com túnel Cloudflare. `cosmos web` mostra a URL
atual: é assim que o Bruno fala com você do celular."#;

/// True for a charter an earlier release wrote and nobody edited since: it
/// opens with the old first line and has exactly the old sections. Anything
/// else is the person's own text and stays.
fn is_stale_charter(memory: &str) -> bool {
    let headings: Vec<&str> = memory.lines().filter(|l| l.starts_with("## ")).collect();
    memory.trim_start().starts_with("Você é o **agente mestre** do Bruno.")
        && headings == ["## Papel", "## Delegar vs fazer", "## Acesso remoto"]
}

/// Idempotent: ensures the master project, its folder, its agent runner and a
/// live PTY. Safe to call on every boot.
pub fn ensure(app: &AppHandle) -> Result<()> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| anyhow!(e.to_string()))?;
    let store = app.state::<Store>();

    let project = ensure_project(&home, &store)?;
    let runner = ensure_runner(&store, &project)?;

    // As a chat the master starts on its first message; a PTY on top of that
    // would be a second writer on the same session.
    if runner.mode != "chat" {
        crate::ops::spawn_pty(app, &project, &runner, "")?;
    }

    let _ = app.emit("projects-changed", json!({ "reason": "master.ensure" }));
    let _ = app.emit(
        "runners-changed",
        json!({ "reason": "master.ensure", "projectId": project.id }),
    );
    Ok(())
}

fn ensure_project(home: &Path, store: &Store) -> Result<ProjectRecord> {
    let existing = projects::list(store)?
        .into_iter()
        .find(|p| p.name.eq_ignore_ascii_case(MASTER_NAME));

    if let Some(mut project) = existing {
        if project.memory.trim().is_empty() || is_stale_charter(&project.memory) {
            project.memory = MASTER_CHARTER.to_string();
            store.projects_upsert(&projects::record_to_row(&project)?)?;
            let _ = projects::refresh_claude_md(
                home,
                &project.slug,
                &project.name,
                &project.folders,
                &project.memory,
            );
        }
        return Ok(project);
    }

    let folder = home.join(MASTER_FOLDER);
    std::fs::create_dir_all(&folder)?;
    projects::create_project(
        home,
        store,
        MASTER_NAME.to_string(),
        vec![folder.to_string_lossy().to_string()],
        MASTER_CHARTER.to_string(),
        crate::uuid_v4_for_ipc(),
        now_unix(),
    )
}

fn ensure_runner(store: &Store, project: &ProjectRecord) -> Result<projects::RunnerRecord> {
    let existing = projects::runners_list(store)?.into_iter().find(|r| {
        r.project_id == project.id && r.kind == "agent" && r.name.eq_ignore_ascii_case(MASTER_NAME)
    });
    if let Some(runner) = existing {
        return Ok(runner);
    }

    let mut record = projects::build_runner_record(
        crate::uuid_v4_for_ipc(),
        project.id.clone(),
        "agent".to_string(),
        MASTER_NAME.to_string(),
        None,
        None,
        None,
        now_unix(),
    );
    if crate::projects::CHAT_ENABLED {
        record.mode = "chat".to_string();
    }
    store.runners_upsert(&projects::runner_record_to_row(&record)?)?;
    Ok(record)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const V1: &str = "Você é o **agente mestre** do Bruno. Não é um agente de projeto.\n\n## Papel\n- x\n\n## Delegar vs fazer\n- y\n\n## Acesso remoto\nz";

    #[test]
    fn an_untouched_old_charter_is_replaced_and_an_edited_one_is_not() {
        assert!(is_stale_charter(V1));
        assert!(!is_stale_charter(&format!("{V1}\n\n## Minhas regras\n- nunca delegue o Ninar")));
        assert!(!is_stale_charter("Anotações do Bruno"));
        assert!(!is_stale_charter(MASTER_CHARTER));
    }
}
