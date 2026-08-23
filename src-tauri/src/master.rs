//! The master agent. Cosmos is a control room, and a control room with nobody
//! in it is just furniture — so every launch guarantees one always-on
//! orchestrator (`geral`) with its own project, folder and live PTY, before
//! the user touches anything.

use std::path::Path;

use anyhow::{anyhow, Result};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::projects::{self, ProjectRecord};
use crate::pty_supervisor::{PtySupervisor, RunnerKind};
use crate::store::Store;

pub const MASTER_NAME: &str = "geral";
const MASTER_FOLDER: &str = "geral";
const SPAWN_COLS: u16 = 120;
const SPAWN_ROWS: u16 = 32;

/// Charter written into the project's memory (and from there into its
/// CLAUDE.md) the first time the master is created. Only applied when memory
/// is empty so later hand-edits are never clobbered.
const MASTER_CHARTER: &str = r#"Você é o **agente mestre** do Bruno. Não é um agente de projeto — é o topo da cadeia.

## Papel
- Ponto de entrada de tudo: recebe o pedido, decide se resolve aqui ou delega.
- Conhece todos os projetos do Cosmos e o estado deles.
- Spawna, acompanha e mata agentes filhos via CLI `cosmos`.
- Trabalha autonomamente: decide, executa, documenta. Não para pra pedir permissão.

## Delegar vs fazer
- Tarefa de um projeto específico → `cosmos project add` / `cosmos runner add` e delega.
- Pergunta, diagnóstico, decisão de arquitetura, infra da máquina → resolve aqui.
- Nunca deixa uma tarefa relevante terminar em silêncio: avisa no Telegram começando com `De: Geral`.

## Acesso remoto
O Cosmos serve uma web UI local com túnel Cloudflare. `cosmos web` mostra a URL
atual e o link autenticado — é assim que o Bruno fala com você do celular."#;

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

    let supervisor = app.state::<PtySupervisor>();
    if supervisor.status(&runner.id).is_none() {
        supervisor.spawn_with_slug(
            app.clone(),
            runner.id.clone(),
            project.id.clone(),
            project.slug.clone(),
            RunnerKind::from_str(&runner.kind),
            project.cwd.clone(),
            runner.program.clone(),
            runner.args.clone(),
            SPAWN_COLS,
            SPAWN_ROWS,
        )?;
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
        // Backfill the charter for a master that predates it — but only into
        // an empty memory, never over something the user wrote.
        if project.memory.trim().is_empty() {
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

    let record = projects::build_runner_record(
        crate::uuid_v4_for_ipc(),
        project.id.clone(),
        "agent".to_string(),
        MASTER_NAME.to_string(),
        None,
        None,
        None,
        now_unix(),
    );
    store.runners_upsert(&projects::runner_record_to_row(&record)?)?;
    Ok(record)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
