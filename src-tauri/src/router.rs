//! Where a task should go: an agent that already exists, a new agent in the
//! right project, or nowhere (the Hub answers it itself), and on which model.
//!
//! Deterministic on purpose. The Hub is an LLM and has the last word, but it
//! decides better and faster from a ranked shortlist with reasons than from a
//! raw `cosmos status` dump, and the UI can show the same shortlist while the
//! person is still typing.

use serde::Serialize;

use crate::providers::{Provider, Tier, ANTHROPIC};

pub struct ProjectView {
    pub slug: String,
    pub name: String,
    pub folders: Vec<String>,
    pub is_master: bool,
}

pub struct AgentView {
    pub id: String,
    pub name: String,
    pub project_slug: String,
    pub task: String,
    /// Session title Claude wrote, when there is one.
    pub title: String,
    pub live: bool,
    pub status: String,
    pub last_active: i64,
    pub is_master: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub project: String,
    pub project_name: String,
    /// Empty for a project with no fitting agent.
    pub runner_id: String,
    pub runner_name: String,
    pub status: String,
    pub live: bool,
    pub score: i32,
    pub reasons: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelPick {
    pub provider: String,
    pub model: String,
    pub label: String,
    pub tier: Tier,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// `send` to an existing agent, `spawn` a new one, or `self`.
    pub action: String,
    pub summary: String,
    /// Ready to run. Empty for `self`.
    pub command: String,
    pub model: ModelPick,
    pub candidates: Vec<Candidate>,
}

const STOPWORDS: &[&str] = &[
    "para", "pra", "com", "sem", "uma", "uns", "umas", "dos", "das", "nos", "nas", "que", "por",
    "the", "and", "for", "with", "from", "this", "that", "isso", "esse", "essa", "este", "esta",
    "como", "mais", "menos", "muito", "tudo", "todo", "toda", "quero", "preciso", "fazer", "faca",
    "faz", "criar", "cria", "crie", "novo", "nova", "agente", "agent", "projeto", "project",
    "app", "apps", "jogo", "game", "code", "repo", "main", "claude", "users", "bruno", "tools",
    "games", "saas", "src", "sobre", "onde", "quando", "tem", "ter", "ser", "sao", "esta",
];

fn fold(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
        'é' | 'ê' | 'è' | 'ë' => 'e',
        'í' | 'î' | 'ì' | 'ï' => 'i',
        'ó' | 'ô' | 'õ' | 'ò' | 'ö' => 'o',
        'ú' | 'û' | 'ù' | 'ü' => 'u',
        'ç' => 'c',
        other => other,
    }
}

fn normalize(text: &str) -> String {
    text.to_lowercase().chars().map(fold).collect()
}

/// Words worth matching on: folded, 3+ chars, no filler.
fn tokens(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in normalize(text).split(|c: char| !c.is_alphanumeric()) {
        if word.len() >= 3 && !STOPWORDS.contains(&word) && !out.iter().any(|w| w == word) {
            out.push(word.to_string());
        }
    }
    out
}

fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path)
}

/// `splat-up` is one name, and so is `splat up` or `splatup` in a sentence.
fn mentions_name(task_norm: &str, task_tokens: &[String], name: &str) -> bool {
    let parts = tokens(name);
    if parts.is_empty() {
        return false;
    }
    if parts.iter().all(|p| task_tokens.contains(p)) {
        return true;
    }
    let glued: String = normalize(name).chars().filter(|c| c.is_alphanumeric()).collect();
    glued.len() >= 4
        && task_norm
            .split(|c: char| !c.is_alphanumeric())
            .any(|w| w == glued)
}

fn project_score(task_norm: &str, task_tokens: &[String], p: &ProjectView) -> (i32, Vec<String>) {
    let mut score = 0;
    let mut reasons = Vec::new();
    if let Some(folder) = p.folders.iter().find(|f| f.len() > 1 && task_norm.contains(&normalize(f))) {
        score += 10;
        reasons.push(format!("a tarefa cita a pasta {folder}"));
    }
    let mut names = vec![p.name.as_str(), p.slug.as_str()];
    names.extend(p.folders.iter().map(|f| basename(f)));
    if let Some(hit) = names.iter().find(|n| mentions_name(task_norm, task_tokens, n)) {
        score += 6;
        reasons.push(format!("a tarefa cita `{hit}`"));
    }
    (score, reasons)
}

fn overlap(task_tokens: &[String], text: &str) -> Vec<String> {
    let words = tokens(text);
    task_tokens.iter().filter(|t| words.contains(t)).cloned().collect()
}

const DAY: i64 = 86_400;

fn agent_score(task_tokens: &[String], a: &AgentView, now: i64) -> (i32, Vec<String>) {
    let mut score = 0;
    let mut reasons = Vec::new();
    let mut shared = overlap(task_tokens, &a.name);
    for w in overlap(task_tokens, &a.task).into_iter().chain(overlap(task_tokens, &a.title)) {
        if !shared.contains(&w) {
            shared.push(w);
        }
    }
    if !shared.is_empty() {
        score += (shared.len() as i32 * 2).min(6);
        reasons.push(format!("já trabalhou com: {}", shared.join(", ")));
    }
    match (a.live, a.status.as_str()) {
        (true, "idle") => {
            score += 2;
            reasons.push("está aberto e livre".into());
        }
        (true, "awaiting_input") => {
            score -= 1;
            reasons.push("está esperando uma resposta".into());
        }
        (true, _) => {
            score -= 3;
            reasons.push("está ocupado agora".into());
        }
        (false, _) => reasons.push("está parado (acorda com o contexto que tinha)".into()),
    }
    let age = now - a.last_active;
    if age < DAY {
        score += 1;
    } else if age > 7 * DAY {
        score -= 2;
        reasons.push(format!("sem uso há {} dias", age / DAY));
    }
    (score, reasons)
}

const DEEP_HINTS: &[&str] = &[
    "arquitetura", "arquitetar", "arquitetural", "decisao", "decidir", "decida", "estrategia",
    "planejar", "planeje", "plano", "roadmap", "tradeoff", "trade off", "investigar", "investigue",
    "diagnostico", "diagnosticar", "causa raiz", "root cause", "auditoria", "auditar", "audite",
    "seguranca", "security", "code review", "revisar", "revise", "redesenhar", "migracao",
    "migrar", "modelagem", "design de sistema", "por que", "debug", "debugar", "depurar",
    "race condition", "concorrencia", "escalar", "avaliar", "avalie", "comparar", "compare",
];

const CHEAP_HINTS: &[&str] = &[
    "traduzir", "traduza", "traducao", "renomear", "renomeie", "formatar", "formate", "lint",
    "resumir", "resuma", "resumo", "changelog", "typo", "typos", "ortografia", "boilerplate",
    "converter", "converta", "listar", "liste", "extrair", "extraia", "em massa", "em lote",
    "bulk", "batch", "comentarios", "docstring", "docstrings", "ordenar", "planilha", "csv",
    "barato", "barata",
];

/// Tasks a non-Anthropic endpoint can't do: no browser, no connectors.
const NEEDS_CLAUDE_HINTS: &[&str] = &[
    "chrome", "navegador", "browser", "console", "app store", "loja", "lojas", "upload",
    "publicar", "publique", "print", "prints", "screenshot", "screenshots", "imagem", "imagens",
    "video", "telegram", "slack", "figma", "login", "deploy", "release",
];

/// Whole words only: `liste` must not fire on `listener`.
fn first_hit<'a>(task_norm: &str, hints: &[&'a str]) -> Option<&'a str> {
    let words: Vec<&str> = task_norm
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let padded = format!(" {} ", words.join(" "));
    hints.iter().copied().find(|h| padded.contains(&format!(" {h} ")))
}

/// Opus for architecture and decisions, Sonnet for execution, the cheapest
/// available provider for mechanical work that needs no browser or connector.
pub fn pick_model(task: &str, providers: &[Provider]) -> ModelPick {
    let norm = normalize(task);
    let anthropic = providers.iter().find(|p| p.id == ANTHROPIC);
    let of = |p: &Provider, tier: Tier, reason: String| {
        let m = p
            .models
            .iter()
            .find(|m| m.tier == tier)
            .or(p.models.first())
            .expect("a provider always has a model");
        ModelPick {
            provider: if p.is_anthropic() { String::new() } else { p.id.clone() },
            model: m.id.clone(),
            label: m.label.clone(),
            tier,
            reason,
        }
    };
    let anthropic = match anthropic {
        Some(p) => p,
        None => {
            return ModelPick {
                provider: String::new(),
                model: String::new(),
                label: String::new(),
                tier: Tier::Work,
                reason: "padrão do CLI".into(),
            }
        }
    };
    if let Some(hit) = first_hit(&norm, DEEP_HINTS) {
        return of(anthropic, Tier::Deep, format!("pede raciocínio (\"{hit}\")"));
    }
    if let Some(hit) = first_hit(&norm, CHEAP_HINTS) {
        if first_hit(&norm, NEEDS_CLAUDE_HINTS).is_none() {
            let cheap = providers
                .iter()
                .find(|p| !p.is_anthropic() && p.available && p.models.iter().any(|m| m.tier == Tier::Cheap));
            return match cheap {
                Some(p) => of(p, Tier::Cheap, format!("tarefa mecânica (\"{hit}\"), vai no mais barato")),
                None => of(anthropic, Tier::Cheap, format!("tarefa mecânica (\"{hit}\")")),
            };
        }
    }
    of(anthropic, Tier::Work, "execução".into())
}

fn sh(v: &str) -> String {
    format!("'{}'", v.replace('\'', "'\\''"))
}

fn model_flags(m: &ModelPick) -> String {
    let mut out = String::new();
    if !m.model.is_empty() {
        out.push_str(&format!(" --model {}", m.model));
    }
    if !m.provider.is_empty() {
        out.push_str(&format!(" --provider {}", m.provider));
    }
    out
}

fn agent_name(task: &str) -> String {
    let name: Vec<&str> = task.split_whitespace().take(5).collect();
    let name = name.join(" ");
    name.chars().take(48).collect()
}

/// Ranks every place `task` could go and names the best one.
pub fn suggest(
    task: &str,
    projects: &[ProjectView],
    agents: &[AgentView],
    providers: &[Provider],
    now: i64,
) -> Suggestion {
    let model = pick_model(task, providers);
    let norm = normalize(task);
    let toks = tokens(task);
    let mut candidates: Vec<Candidate> = Vec::new();

    for p in projects.iter().filter(|p| !p.is_master) {
        let (pscore, preasons) = project_score(&norm, &toks, p);
        let mine: Vec<&AgentView> = agents
            .iter()
            .filter(|a| a.project_slug == p.slug && !a.is_master)
            .collect();
        for a in &mine {
            let (ascore, areasons) = agent_score(&toks, a, now);
            // An agent only counts when the project matched or its own
            // history did; liveness alone says nothing about fit.
            let history = areasons.iter().any(|r| r.starts_with("já trabalhou"));
            if pscore == 0 && !history {
                continue;
            }
            let mut reasons = preasons.clone();
            reasons.extend(areasons);
            candidates.push(Candidate {
                project: p.slug.clone(),
                project_name: p.name.clone(),
                runner_id: a.id.clone(),
                runner_name: a.name.clone(),
                status: a.status.clone(),
                live: a.live,
                score: pscore + ascore,
                reasons,
            });
        }
        if pscore > 0 {
            let mut reasons = preasons;
            reasons.push(if mine.is_empty() {
                "nenhum agente lá ainda".into()
            } else {
                "agente novo, contexto limpo".into()
            });
            candidates.push(Candidate {
                project: p.slug.clone(),
                project_name: p.name.clone(),
                runner_id: String::new(),
                runner_name: String::new(),
                status: String::new(),
                live: false,
                // A fresh agent beats a busy or unrelated one, and loses to
                // one that already holds the context.
                score: pscore + 2,
                reasons,
            });
        }
    }
    candidates.sort_by(|a, b| b.score.cmp(&a.score).then(b.live.cmp(&a.live)));
    candidates.truncate(6);

    let (action, summary, command) = match candidates.first() {
        Some(best) if !best.runner_id.is_empty() => (
            "send",
            format!("mandar para `{}` em {}", best.runner_name, best.project_name),
            format!(
                "cosmos runner send --id {} --message {}",
                best.runner_id,
                sh(task.trim())
            ),
        ),
        Some(best) => (
            "spawn",
            format!("subir um agente novo em {} ({})", best.project_name, model.label),
            format!(
                "cosmos runner add --project {} --name {} --task {}{}",
                best.project,
                sh(&agent_name(task)),
                sh(task.trim()),
                model_flags(&model)
            ),
        ),
        None => (
            "self",
            "nenhum projeto bate com a tarefa: o Hub resolve, ou cria o projeto".to_string(),
            String::new(),
        ),
    };
    Suggestion {
        action: action.into(),
        summary,
        command,
        model,
        candidates,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn providers(deepseek: bool) -> Vec<Provider> {
        let home = std::env::temp_dir().join(format!("cosmos-router-{deepseek}"));
        std::fs::create_dir_all(home.join(".private_keys")).unwrap();
        let key = home.join(".private_keys/deepseek_api_key");
        if deepseek {
            std::fs::write(&key, "k").unwrap();
        } else {
            let _ = std::fs::remove_file(&key);
        }
        crate::providers::list(&home)
    }

    fn project(slug: &str, folder: &str) -> ProjectView {
        ProjectView {
            slug: slug.into(),
            name: slug.into(),
            folders: vec![folder.into()],
            is_master: false,
        }
    }

    fn agent(id: &str, project: &str, task: &str, live: bool, status: &str) -> AgentView {
        AgentView {
            id: id.into(),
            name: id.into(),
            project_slug: project.into(),
            task: task.into(),
            title: String::new(),
            live,
            status: status.into(),
            last_active: NOW - 3600,
            is_master: false,
        }
    }

    fn world() -> (Vec<ProjectView>, Vec<AgentView>) {
        (
            vec![
                project("splat-up", "/Users/bruno/code/games/splat-up"),
                project("ninar", "/Users/bruno/code/apps/ninar"),
                project("cosmos", "/Users/bruno/code/tools/cosmos-agents"),
            ],
            vec![
                agent("ranking", "splat-up", "ranking semanal com firebase", false, "exited"),
                agent("loja", "splat-up", "screenshots da loja", true, "streaming"),
                agent("paywall", "ninar", "paywall revenuecat", true, "idle"),
            ],
        )
    }

    #[test]
    fn an_agent_that_holds_the_context_gets_the_task() {
        let (p, a) = world();
        let s = suggest("corrigir o ranking semanal do splat up", &p, &a, &providers(false), NOW);
        assert_eq!(s.action, "send");
        assert_eq!(s.candidates[0].runner_id, "ranking");
        assert!(s.command.starts_with("cosmos runner send --id ranking"));
    }

    #[test]
    fn a_matching_project_with_no_fitting_agent_gets_a_new_one() {
        let (p, a) = world();
        let s = suggest("implementar tela de onboarding no cosmos-agents", &p, &a, &providers(false), NOW);
        assert_eq!(s.action, "spawn");
        assert_eq!(s.candidates[0].project, "cosmos");
        assert!(s.command.contains("--project cosmos"));
        assert!(s.command.contains("--model sonnet"));
    }

    #[test]
    fn a_busy_agent_loses_to_a_fresh_one() {
        let (p, a) = world();
        let s = suggest("ajustar o tutorial do splat-up", &p, &a, &providers(false), NOW);
        assert_eq!(s.action, "spawn", "{:?}", s.candidates);
    }

    #[test]
    fn nothing_matching_stays_with_the_hub() {
        let (p, a) = world();
        let s = suggest("quanto de disco livre tem nesse mac?", &p, &a, &providers(false), NOW);
        assert_eq!(s.action, "self");
        assert!(s.command.is_empty());
    }

    #[test]
    fn a_folder_path_in_the_task_is_the_strongest_signal() {
        let (p, a) = world();
        let s = suggest(
            "olha /Users/bruno/code/apps/ninar e arruma o paywall",
            &p,
            &a,
            &providers(false),
            NOW,
        );
        assert_eq!(s.candidates[0].runner_id, "paywall");
    }

    #[test]
    fn models_follow_the_kind_of_work() {
        let none = providers(false);
        let with = providers(true);
        assert_eq!(pick_model("definir a arquitetura do sync offline", &none).model, "opus");
        assert_eq!(pick_model("implementar o botão de compartilhar", &none).model, "sonnet");
        let cheap = pick_model("traduzir as strings para espanhol", &with);
        assert_eq!((cheap.provider.as_str(), cheap.model.as_str()), ("deepseek", "deepseek-flash"));
        assert_eq!(pick_model("traduzir as strings para espanhol", &none).model, "haiku");
        // Mechanical, but it needs the browser: stays on Claude.
        assert_eq!(pick_model("resumir os comentários da loja no Play Console", &with).model, "sonnet");
        assert_eq!(pick_model("adicionar um listener de teclado", &with).model, "sonnet");
    }

    #[test]
    fn accents_and_glued_names_still_match() {
        let (p, a) = world();
        let s = suggest("Decisão: como monetizar o Splatup?", &p, &a, &providers(false), NOW);
        assert_eq!(s.candidates[0].project, "splat-up");
        assert_eq!(s.model.model, "opus");
    }
}
