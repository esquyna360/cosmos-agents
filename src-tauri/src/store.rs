use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentRecord {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub created_at: i64,
    pub last_active: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    /// JSON-encoded array of absolute folder paths.
    pub folders_json: String,
    pub memory: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    /// Filesystem-safe handle for the project — `slugify(name)` plus a
    /// collision-dedupe `-N` suffix. Sticky: generated at create time, never
    /// recomputed on rename. Drives `~/.cosmos/projects/<slug>/` paths.
    pub slug: String,
    /// JSON-encoded array of absolute folder paths (1..N).
    pub folders_json: String,
    pub memory: String,
    /// Absolute path the AI CLI should run in. For 1-folder projects this is
    /// `folders[0]` (no synthetic dir). For N-folder it's the materialized
    /// `~/.cosmos/projects/<slug>/`.
    pub cwd: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RunnerRow {
    pub id: String,
    pub project_id: String,
    /// "agent" or "shell".
    pub kind: String,
    pub name: String,
    pub program: String,
    /// JSON-encoded array of args.
    pub args_json: String,
    /// JSON-encoded {key: val} env overrides.
    pub env_json: String,
    pub with_status_fsm: bool,
    pub created_at: i64,
    pub last_active: i64,
}

impl Store {
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        // Legacy tables — kept around so the old agents_*/workspaces_* command
        // surface keeps working through Steps 1-3. Removed in Step 4.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS agents (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                cwd          TEXT NOT NULL,
                created_at   INTEGER NOT NULL,
                last_active  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_agents_last_active ON agents(last_active DESC);
            CREATE TABLE IF NOT EXISTS workspaces (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                folders      TEXT NOT NULL,
                memory       TEXT NOT NULL DEFAULT '',
                created_at   INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_workspaces_created ON workspaces(created_at DESC);
            CREATE TABLE IF NOT EXISTS projects (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                slug         TEXT NOT NULL DEFAULT '',
                folders_json TEXT NOT NULL,
                memory       TEXT NOT NULL DEFAULT '',
                cwd          TEXT NOT NULL,
                created_at   INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at DESC);
            -- NOTE: idx_projects_slug is created inside migrate_v1_to_v2,
            -- not here. On installs that pre-date the slug column, the index
            -- creation would fail with "no such column: slug" because the
            -- CREATE TABLE IF NOT EXISTS is a no-op against the legacy table.
            -- ALTER TABLE in the migration adds the column first; the index
            -- creation lives there.
            CREATE TABLE IF NOT EXISTS runners (
                id              TEXT PRIMARY KEY,
                project_id      TEXT NOT NULL,
                kind            TEXT NOT NULL,
                name            TEXT NOT NULL,
                program         TEXT NOT NULL,
                args_json       TEXT NOT NULL,
                env_json        TEXT NOT NULL DEFAULT '{}',
                with_status_fsm INTEGER NOT NULL DEFAULT 1,
                created_at      INTEGER NOT NULL,
                last_active     INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_runners_project ON runners(project_id);
            CREATE INDEX IF NOT EXISTS idx_runners_last_active ON runners(last_active DESC);
            "#,
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Migrates the schema forward. Idempotent — re-running is a no-op once
    /// at the latest version. Each step is wrapped in its own transaction so
    /// a crash mid-step doesn't half-apply.
    ///
    /// v0 → v1: converts legacy `workspaces` + `agents` tables into
    ///          `projects` + `runners`.
    /// v1 → v2: adds the `slug` column to `projects`, back-populates
    ///          `slug = id` for legacy rows (their dirs stay at their
    ///          existing UUID paths).
    pub fn migrate(&self, home: &Path) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let user_version: i32 =
            conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if user_version < 1 {
            Self::migrate_v0_to_v1(&mut conn, home)?;
        }
        if user_version < 2 {
            Self::migrate_v1_to_v2(&mut conn)?;
        }
        Ok(())
    }

    fn migrate_v0_to_v1(conn: &mut Connection, home: &Path) -> Result<()> {
        let tx = conn.transaction()?;

        // Cache workspace cwd → project_id. Workspace cwd is derived from id
        // (workspace_dir(home, id)), so we can compute it without a second
        // SELECT after the insert.
        let mut ws_cwd_to_id: HashMap<String, String> = HashMap::new();

        let workspaces: Vec<WorkspaceRow> = {
            let mut stmt = tx.prepare(
                "SELECT id, name, folders, memory, created_at \
                 FROM workspaces ORDER BY created_at DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(WorkspaceRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    folders_json: row.get(2)?,
                    memory: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        for ws in &workspaces {
            let cwd = home
                .join(".cosmos")
                .join("workspaces")
                .join(&ws.id)
                .to_string_lossy()
                .into_owned();
            ws_cwd_to_id.insert(cwd.clone(), ws.id.clone());
            tx.execute(
                r#"
                INSERT OR IGNORE INTO projects (id, name, folders_json, memory, cwd, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![ws.id, ws.name, ws.folders_json, ws.memory, cwd, ws.created_at],
            )?;
        }

        let agents: Vec<AgentRecord> = {
            let mut stmt = tx.prepare(
                "SELECT id, name, cwd, created_at, last_active \
                 FROM agents ORDER BY last_active DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(AgentRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    cwd: row.get(2)?,
                    created_at: row.get(3)?,
                    last_active: row.get(4)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        let default_program = "/bin/zsh".to_string();
        let default_args_json = serde_json::to_string(&[
            "-i",
            "-l",
            "-c",
            "exec env CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions",
        ])
        .unwrap();

        for ag in &agents {
            let normalized_cwd = ag.cwd.trim_end_matches('/').to_string();
            let project_id = if let Some(pid) = ws_cwd_to_id.get(&normalized_cwd) {
                pid.clone()
            } else if let Some(pid) = ws_cwd_to_id.get(&ag.cwd) {
                pid.clone()
            } else {
                // Folder-mode agent: synthesize a project at the agent's cwd.
                // ID is derived from agent.id so re-running is idempotent.
                let pid = format!("p_{}", ag.id);
                let folders = vec![ag.cwd.clone()];
                let folders_json = serde_json::to_string(&folders)?;
                tx.execute(
                    r#"
                    INSERT OR IGNORE INTO projects (id, name, folders_json, memory, cwd, created_at)
                    VALUES (?1, ?2, ?3, '', ?4, ?5)
                    "#,
                    params![pid, ag.name, folders_json, ag.cwd, ag.created_at],
                )?;
                pid
            };
            tx.execute(
                r#"
                INSERT OR IGNORE INTO runners
                    (id, project_id, kind, name, program, args_json, env_json, with_status_fsm, created_at, last_active)
                VALUES (?1, ?2, 'agent', ?3, ?4, ?5, '{}', 1, ?6, ?7)
                "#,
                params![
                    ag.id,
                    project_id,
                    ag.name,
                    default_program,
                    default_args_json,
                    ag.created_at,
                    ag.last_active,
                ],
            )?;
        }

        tx.execute_batch("PRAGMA user_version = 1")?;
        tx.commit().context("committing v0→v1 migration")?;
        Ok(())
    }

    fn migrate_v1_to_v2(conn: &mut Connection) -> Result<()> {
        let tx = conn.transaction()?;
        // Idempotent column add: SQLite errors if the column already exists.
        // We check first by inspecting the table schema instead of try-catch.
        let has_slug: bool = {
            let mut stmt = tx.prepare("PRAGMA table_info(projects)")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
            let mut found = false;
            for r in rows {
                if r? == "slug" {
                    found = true;
                    break;
                }
            }
            found
        };
        if !has_slug {
            tx.execute_batch(
                "ALTER TABLE projects ADD COLUMN slug TEXT NOT NULL DEFAULT ''",
            )?;
        }
        // Back-populate: legacy rows get slug = id so their UUID-named dirs
        // (where their data actually lives on disk) stay reachable.
        tx.execute(
            "UPDATE projects SET slug = id WHERE slug = '' OR slug IS NULL",
            [],
        )?;
        tx.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug)",
        )?;
        tx.execute_batch("PRAGMA user_version = 2")?;
        tx.commit().context("committing v1→v2 migration")?;
        Ok(())
    }

    /* ---------------------------- projects ---------------------------- */

    pub fn projects_list(&self) -> Result<Vec<ProjectRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, slug, folders_json, memory, cwd, created_at \
             FROM projects ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ProjectRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    slug: row.get(2)?,
                    folders_json: row.get(3)?,
                    memory: row.get(4)?,
                    cwd: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn projects_get(&self, id: &str) -> Result<Option<ProjectRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, slug, folders_json, memory, cwd, created_at FROM projects WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(ProjectRow {
                id: row.get(0)?,
                name: row.get(1)?,
                slug: row.get(2)?,
                folders_json: row.get(3)?,
                memory: row.get(4)?,
                cwd: row.get(5)?,
                created_at: row.get(6)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn projects_get_by_slug(&self, slug: &str) -> Result<Option<ProjectRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, slug, folders_json, memory, cwd, created_at FROM projects WHERE slug = ?1",
        )?;
        let mut rows = stmt.query(params![slug])?;
        if let Some(row) = rows.next()? {
            Ok(Some(ProjectRow {
                id: row.get(0)?,
                name: row.get(1)?,
                slug: row.get(2)?,
                folders_json: row.get(3)?,
                memory: row.get(4)?,
                cwd: row.get(5)?,
                created_at: row.get(6)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn projects_upsert(&self, row: &ProjectRow) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO projects (id, name, slug, folders_json, memory, cwd, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                folders_json = excluded.folders_json,
                memory = excluded.memory,
                cwd = excluded.cwd
            "#,
            // NOTE: slug is NOT updated on conflict — slug is sticky and
            // generated at create time only. Only name/folders/memory/cwd
            // change on update.
            params![row.id, row.name, row.slug, row.folders_json, row.memory, row.cwd, row.created_at],
        )?;
        Ok(())
    }

    pub fn projects_delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM runners WHERE project_id = ?1", params![id])?;
        tx.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /* ----------------------------- runners ---------------------------- */

    pub fn runners_list(&self) -> Result<Vec<RunnerRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, name, program, args_json, env_json, \
                    with_status_fsm, created_at, last_active \
             FROM runners ORDER BY last_active DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(RunnerRow {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    kind: row.get(2)?,
                    name: row.get(3)?,
                    program: row.get(4)?,
                    args_json: row.get(5)?,
                    env_json: row.get(6)?,
                    with_status_fsm: row.get::<_, i64>(7)? != 0,
                    created_at: row.get(8)?,
                    last_active: row.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn runners_upsert(&self, row: &RunnerRow) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO runners
                (id, project_id, kind, name, program, args_json, env_json,
                 with_status_fsm, created_at, last_active)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                project_id = excluded.project_id,
                kind = excluded.kind,
                name = excluded.name,
                program = excluded.program,
                args_json = excluded.args_json,
                env_json = excluded.env_json,
                with_status_fsm = excluded.with_status_fsm,
                last_active = excluded.last_active
            "#,
            params![
                row.id,
                row.project_id,
                row.kind,
                row.name,
                row.program,
                row.args_json,
                row.env_json,
                row.with_status_fsm as i64,
                row.created_at,
                row.last_active,
            ],
        )?;
        Ok(())
    }

    pub fn runners_delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM runners WHERE id = ?1", params![id])?;
        Ok(())
    }

    /* ------------------------- test-only seed ------------------------- */
    // The migration test needs to populate the legacy agents/workspaces
    // tables so migrate() has something to convert. We expose narrow seed
    // helpers under #[cfg(test)] rather than pulling in raw SQL boilerplate
    // at the test site.

    #[cfg(test)]
    fn legacy_workspaces_upsert(&self, row: &WorkspaceRow) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO workspaces (id, name, folders, memory, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![row.id, row.name, row.folders_json, row.memory, row.created_at],
        )?;
        Ok(())
    }

    #[cfg(test)]
    fn legacy_agents_upsert(&self, rec: &AgentRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO agents (id, name, cwd, created_at, last_active)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![rec.id, rec.name, rec.cwd, rec.created_at, rec.last_active],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_db() -> PathBuf {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("cosmos-test-{ts}.sqlite"))
    }

    /// Seed: 1 workspace with 2 sibling agents + 1 folder-mode agent. After
    /// migrate, expect 2 projects (1 from workspace, 1 from folder-agent) and
    /// 3 runners. Running migrate twice must yield the same state.
    #[test]
    fn migration_is_idempotent() {
        let home = std::env::temp_dir().join("cosmos-test-home");
        std::fs::create_dir_all(&home).unwrap();
        let path = tmp_db();
        let store = Store::open(path.clone()).unwrap();
        // PRAGMA user_version starts at 0.

        // Seed workspace.
        let ws = WorkspaceRow {
            id: "ws-1".into(),
            name: "Workspace One".into(),
            folders_json: serde_json::to_string(&["/a", "/b"]).unwrap(),
            memory: "".into(),
            created_at: 100,
        };
        store.legacy_workspaces_upsert(&ws).unwrap();

        // Sibling agents share the workspace cwd.
        let ws_cwd = home
            .join(".cosmos")
            .join("workspaces")
            .join("ws-1")
            .to_string_lossy()
            .into_owned();
        store
            .legacy_agents_upsert(&AgentRecord {
                id: "ag-1".into(),
                name: "main".into(),
                cwd: ws_cwd.clone(),
                created_at: 110,
                last_active: 110,
            })
            .unwrap();
        store
            .legacy_agents_upsert(&AgentRecord {
                id: "ag-2".into(),
                name: "side".into(),
                cwd: ws_cwd.clone(),
                created_at: 120,
                last_active: 120,
            })
            .unwrap();
        // Folder-mode agent (no matching workspace).
        store
            .legacy_agents_upsert(&AgentRecord {
                id: "ag-3".into(),
                name: "solo".into(),
                cwd: "/some/repo".into(),
                created_at: 130,
                last_active: 130,
            })
            .unwrap();

        store.migrate(&home).unwrap();

        let projects = store.projects_list().unwrap();
        assert_eq!(projects.len(), 2, "first migrate creates 2 projects");
        let runners = store.runners_list().unwrap();
        assert_eq!(runners.len(), 3, "first migrate creates 3 runners");

        // v1→v2: every legacy project must have slug == id (so its existing
        // UUID-named dir on disk stays reachable).
        for p in &projects {
            assert_eq!(p.slug, p.id, "legacy project should have slug == id");
        }

        // All 3 runners are agents.
        assert!(runners.iter().all(|r| r.kind == "agent"));
        // Two runners share project_id (the workspace ones), one stands alone.
        let projs_with_2: usize = projects
            .iter()
            .filter(|p| runners.iter().filter(|r| r.project_id == p.id).count() == 2)
            .count();
        assert_eq!(projs_with_2, 1, "exactly one project has 2 sibling runners");

        // Run migrate again — must be a no-op.
        store.migrate(&home).unwrap();
        let projects2 = store.projects_list().unwrap();
        let runners2 = store.runners_list().unwrap();
        assert_eq!(projects.len(), projects2.len());
        assert_eq!(runners.len(), runners2.len());

        let _ = std::fs::remove_file(&path);
    }

    /// Fresh install (no workspaces, no agents) must just bump user_version
    /// without inserting anything into projects/runners.
    #[test]
    fn fresh_install_migrate_is_safe() {
        let home = std::env::temp_dir().join("cosmos-test-home-fresh");
        std::fs::create_dir_all(&home).unwrap();
        let path = tmp_db();
        let store = Store::open(path.clone()).unwrap();
        store.migrate(&home).unwrap();
        assert!(store.projects_list().unwrap().is_empty());
        assert!(store.runners_list().unwrap().is_empty());
        store.migrate(&home).unwrap();
        let _ = std::fs::remove_file(&path);
    }

    /// `slugify` strips punctuation, lowercases, and kebab-cases. Empty input
    /// → "project". Long inputs get capped at 40 chars without a trailing
    /// dash.
    #[test]
    fn slugify_edge_cases() {
        use crate::projects::slugify;
        assert_eq!(slugify("Foo Bar"), "foo-bar");
        assert_eq!(slugify("  Cosmos!  "), "cosmos");
        assert_eq!(slugify("a/b/c"), "a-b-c");
        assert_eq!(slugify(""), "project");
        assert_eq!(slugify("!!!"), "project");
        assert_eq!(slugify("Foo___Bar"), "foo-bar");
        let long = "a".repeat(60);
        let s = slugify(&long);
        assert!(s.len() <= 40);
        assert!(!s.ends_with('-'));
    }

    /// `dedupe_slug` appends -2, -3 on collision and returns the first free.
    #[test]
    fn dedupe_slug_collision() {
        use crate::projects::{dedupe_slug, record_to_row};
        let home = std::env::temp_dir().join("cosmos-test-home-dedupe");
        std::fs::create_dir_all(&home).unwrap();
        let path = tmp_db();
        let store = Store::open(path.clone()).unwrap();
        store.migrate(&home).unwrap();

        // First "cosmos" is free.
        assert_eq!(dedupe_slug(&store, "cosmos").unwrap(), "cosmos");
        // Seed a row with slug=cosmos and check that the next dedupe shifts.
        let rec = crate::projects::ProjectRecord {
            id: "p1".into(),
            name: "Cosmos".into(),
            slug: "cosmos".into(),
            folders: vec!["/tmp/x".into()],
            memory: "".into(),
            cwd: "/tmp/x".into(),
            created_at: 0,
        };
        store.projects_upsert(&record_to_row(&rec).unwrap()).unwrap();
        assert_eq!(dedupe_slug(&store, "cosmos").unwrap(), "cosmos-2");
        let _ = std::fs::remove_file(&path);
    }
}

