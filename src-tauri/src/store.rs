use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Result;
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

impl Store {
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
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
            "#,
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list(&self) -> Result<Vec<AgentRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, cwd, created_at, last_active FROM agents ORDER BY last_active DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AgentRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    cwd: row.get(2)?,
                    created_at: row.get(3)?,
                    last_active: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn upsert(&self, rec: &AgentRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO agents (id, name, cwd, created_at, last_active)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                cwd = excluded.cwd,
                last_active = excluded.last_active
            "#,
            params![rec.id, rec.name, rec.cwd, rec.created_at, rec.last_active],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM agents WHERE id = ?1", params![id])?;
        Ok(())
    }

    /* --------------------------- workspaces --------------------------- */

    pub fn workspaces_list(&self) -> Result<Vec<WorkspaceRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, folders, memory, created_at \
             FROM workspaces ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(WorkspaceRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    folders_json: row.get(2)?,
                    memory: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn workspaces_upsert(&self, row: &WorkspaceRow) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO workspaces (id, name, folders, memory, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                folders = excluded.folders,
                memory = excluded.memory
            "#,
            params![row.id, row.name, row.folders_json, row.memory, row.created_at],
        )?;
        Ok(())
    }

    pub fn workspaces_get(&self, id: &str) -> Result<Option<WorkspaceRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, folders, memory, created_at FROM workspaces WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(WorkspaceRow {
                id: row.get(0)?,
                name: row.get(1)?,
                folders_json: row.get(2)?,
                memory: row.get(3)?,
                created_at: row.get(4)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn workspaces_delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }
}
