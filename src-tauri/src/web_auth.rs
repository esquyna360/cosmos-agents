//! Who may use the web UI.
//!
//! A browser gets in by typing a pairing code the desktop app is showing:
//! six digits, good for a few minutes and for one device. In exchange it
//! receives a session token in an httpOnly cookie. Only the token's hash is
//! kept, so the device list on disk opens nothing by itself; each device can
//! be revoked on its own, and a session nobody uses expires.
//!
//! The address may be public (the tunnel), so guessing is priced in: a code
//! dies after a handful of misses, an address that keeps missing is locked
//! out, and enough misses from anywhere close pairing until a new code is
//! asked for at the desk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CODE_TTL: i64 = 5 * 60;
pub const SESSION_TTL: i64 = 30 * 24 * 3600;
const CODE_MISSES: u32 = 5;
const ADDRESS_MISSES: u32 = 5;
const ADDRESS_WINDOW: i64 = 15 * 60;
const GLOBAL_MISSES: usize = 20;
const GLOBAL_WINDOW: i64 = 3600;
const MAX_DEVICES: usize = 24;
/// How often a live session's `last_seen` is written to disk.
const TOUCH_EVERY: i64 = 10 * 60;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    /// SHA-256 of the session token.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hash: String,
    pub created: i64,
    pub last_seen: i64,
    pub expires: i64,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub agent: String,
}

impl Device {
    /// The record without its hash, for showing.
    pub fn public(&self) -> Device {
        Device { hash: String::new(), ..self.clone() }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairCode {
    pub code: String,
    pub expires: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum PairError {
    /// No code is being shown, or it ran out.
    NoCode,
    Wrong { left: u32 },
    /// This code took too many misses and is gone.
    Burned,
    /// Too many misses; nothing is accepted for `retry_in` seconds.
    Locked { retry_in: i64 },
}

struct Code {
    digits: String,
    expires: i64,
    misses: u32,
}

#[derive(Default)]
struct Inner {
    code: Option<Code>,
    devices: Vec<Device>,
    /// Miss timestamps per address.
    misses: HashMap<String, Vec<i64>>,
    all_misses: Vec<i64>,
}

pub struct Auth {
    path: PathBuf,
    inner: Mutex<Inner>,
}

fn random(bytes: &mut [u8]) {
    getrandom::fill(bytes).expect("no source of randomness");
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_of(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

/// Equal without telling, through timing, how much of it matched.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn six_digits() -> String {
    loop {
        let mut raw = [0u8; 4];
        random(&mut raw);
        let n = u32::from_le_bytes(raw);
        // Reject the tail so every code is equally likely.
        if n < 4_294_000_000 {
            return format!("{:06}", n % 1_000_000);
        }
    }
}

impl Auth {
    pub fn load(home: &Path) -> Auth {
        let path = home.join(".cosmos").join("web-devices.json");
        let devices: Vec<Device> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Auth { path, inner: Mutex::new(Inner { devices, ..Inner::default() }) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn persist(&self, inner: &Inner) {
        let Ok(raw) = serde_json::to_string_pretty(&inner.devices) else { return };
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, raw).is_err() {
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        let _ = std::fs::rename(&tmp, &self.path);
    }

    /// A fresh code, replacing any other. Asking for one is something only
    /// the desk can do, so it also reopens pairing after a global lock.
    pub fn new_code(&self, now: i64) -> PairCode {
        let mut inner = self.lock();
        let digits = six_digits();
        inner.all_misses.clear();
        inner.code = Some(Code { digits: digits.clone(), expires: now + CODE_TTL, misses: 0 });
        PairCode { code: digits, expires: now + CODE_TTL }
    }

    /// The code on show, if it still stands.
    pub fn current_code(&self, now: i64) -> Option<PairCode> {
        let inner = self.lock();
        inner
            .code
            .as_ref()
            .filter(|c| c.expires > now)
            .map(|c| PairCode { code: c.digits.clone(), expires: c.expires })
    }

    pub fn cancel_code(&self) {
        self.lock().code = None;
    }

    fn locked(inner: &mut Inner, address: &str, now: i64) -> Option<i64> {
        inner.all_misses.retain(|t| now - t < GLOBAL_WINDOW);
        if inner.all_misses.len() >= GLOBAL_MISSES {
            return Some(GLOBAL_WINDOW - (now - inner.all_misses[0]));
        }
        let mine = inner.misses.entry(address.to_string()).or_default();
        mine.retain(|t| now - t < ADDRESS_WINDOW);
        if mine.len() as u32 >= ADDRESS_MISSES {
            return Some(ADDRESS_WINDOW - (now - mine[0]));
        }
        None
    }

    /// Trades a code for a session. Returns the token to put in the cookie.
    pub fn pair(&self, code: &str, name: &str, address: &str, agent: &str, now: i64) -> Result<(String, Device), PairError> {
        let mut inner = self.lock();
        if let Some(retry_in) = Self::locked(&mut inner, address, now) {
            return Err(PairError::Locked { retry_in: retry_in.max(1) });
        }
        let typed: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
        let Some(current) = inner.code.as_mut().filter(|c| c.expires > now) else {
            // Nothing is at stake while no code is on show, so a stale one
            // typed again and again does not lock its owner out.
            inner.code = None;
            return Err(PairError::NoCode);
        };
        if !same(&typed, &current.digits) {
            current.misses += 1;
            let left = CODE_MISSES.saturating_sub(current.misses);
            if left == 0 {
                inner.code = None;
            }
            inner.misses.entry(address.to_string()).or_default().push(now);
            inner.all_misses.push(now);
            return Err(if left == 0 { PairError::Burned } else { PairError::Wrong { left } });
        }
        inner.code = None;
        inner.misses.remove(address);

        let mut raw = [0u8; 32];
        random(&mut raw);
        let token = hex(&raw);
        let mut id = [0u8; 6];
        random(&mut id);
        let name: String = name.trim().chars().filter(|c| !c.is_control()).take(48).collect();
        let device = Device {
            id: hex(&id),
            name: if name.is_empty() { "Navegador".into() } else { name },
            hash: hash_of(&token),
            created: now,
            last_seen: now,
            expires: now + SESSION_TTL,
            address: address.to_string(),
            agent: agent.chars().filter(|c| !c.is_control()).take(200).collect(),
        };
        inner.devices.retain(|d| d.expires > now);
        inner.devices.push(device.clone());
        if inner.devices.len() > MAX_DEVICES {
            inner.devices.sort_by_key(|d| d.last_seen);
            let extra = inner.devices.len() - MAX_DEVICES;
            inner.devices.drain(..extra);
        }
        self.persist(&inner);
        Ok((token, device.public()))
    }

    /// The device behind a session token, if the session still stands. Using
    /// a session pushes its expiry forward.
    pub fn check(&self, token: &str, address: &str, now: i64) -> Option<Device> {
        if token.len() != 64 {
            return None;
        }
        let hash = hash_of(token);
        let mut inner = self.lock();
        let device = inner.devices.iter_mut().find(|d| same(&d.hash, &hash))?;
        if device.expires <= now {
            return None;
        }
        let stale = now - device.last_seen >= TOUCH_EVERY;
        if stale {
            device.last_seen = now;
            device.expires = now + SESSION_TTL;
            if !address.is_empty() {
                device.address = address.to_string();
            }
        }
        let out = device.public();
        if stale {
            self.persist(&inner);
        }
        Some(out)
    }

    pub fn devices(&self, now: i64) -> Vec<Device> {
        let mut inner = self.lock();
        let before = inner.devices.len();
        inner.devices.retain(|d| d.expires > now);
        if inner.devices.len() != before {
            self.persist(&inner);
        }
        let mut out: Vec<Device> = inner.devices.iter().map(Device::public).collect();
        out.sort_by_key(|d| std::cmp::Reverse(d.last_seen));
        out
    }

    /// Ends one device's session. True when there was one.
    pub fn revoke(&self, id: &str) -> bool {
        let mut inner = self.lock();
        let before = inner.devices.len();
        inner.devices.retain(|d| d.id != id);
        let gone = inner.devices.len() != before;
        if gone {
            self.persist(&inner);
        }
        gone
    }

    pub fn revoke_all(&self) -> usize {
        let mut inner = self.lock();
        let n = inner.devices.len();
        inner.devices.clear();
        self.persist(&inner);
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(tag: &str) -> (Auth, PathBuf) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let home = std::env::temp_dir().join(format!("cosmos-webauth-{tag}-{ts}"));
        std::fs::create_dir_all(&home).unwrap();
        (Auth::load(&home), home)
    }

    fn wrong(code: &str) -> String {
        if code == "000000" { "111111".into() } else { "000000".into() }
    }

    #[test]
    fn a_code_pairs_one_device_and_the_session_survives_a_restart() {
        let (auth, home) = auth("pair");
        assert_eq!(auth.pair("123456", "x", "1.1.1.1", "", 100), Err(PairError::NoCode));
        let code = auth.new_code(100);
        assert_eq!(code.code.len(), 6);
        assert_eq!(auth.current_code(100 + CODE_TTL - 1), Some(code.clone()));
        let spaced = format!("{} {}", &code.code[..3], &code.code[3..]);
        let (token, device) = auth.pair(&spaced, "  iPhone do Bruno ", "10.0.0.2", "Safari", 110).unwrap();
        assert_eq!(device.name, "iPhone do Bruno");
        assert!(device.hash.is_empty());
        assert_eq!(auth.pair(&code.code, "outro", "10.0.0.3", "", 111), Err(PairError::NoCode));
        assert_eq!(auth.check(&token, "10.0.0.2", 120).map(|d| d.id), Some(device.id.clone()));
        assert!(auth.check(&"0".repeat(64), "10.0.0.2", 120).is_none());

        let raw = std::fs::read_to_string(home.join(".cosmos/web-devices.json")).unwrap();
        assert!(!raw.contains(&token));
        let again = Auth::load(&home);
        assert!(again.check(&token, "10.0.0.2", 130).is_some());
        assert!(again.revoke(&device.id));
        assert!(again.check(&token, "10.0.0.2", 131).is_none());
        assert!(!again.revoke(&device.id));
    }

    #[test]
    fn a_code_expires_and_burns_after_too_many_misses() {
        let (auth, _) = auth("burn");
        let code = auth.new_code(0);
        assert_eq!(auth.pair(&code.code, "x", "a", "", CODE_TTL), Err(PairError::NoCode));

        let code = auth.new_code(1000);
        let bad = wrong(&code.code);
        for (i, address) in ["a", "b", "c", "d"].iter().enumerate() {
            assert_eq!(auth.pair(&bad, "x", address, "", 1000), Err(PairError::Wrong { left: 4 - i as u32 }));
        }
        assert_eq!(auth.pair(&bad, "x", "e", "", 1000), Err(PairError::Burned));
        assert_eq!(auth.pair(&code.code, "x", "f", "", 1001), Err(PairError::NoCode));
    }

    #[test]
    fn an_address_that_keeps_missing_is_locked_out_even_with_the_right_code() {
        let (auth, _) = auth("lock");
        for i in 0..ADDRESS_MISSES as i64 {
            let code = auth.new_code(i);
            assert!(matches!(auth.pair(&wrong(&code.code), "x", "6.6.6.6", "", i), Err(PairError::Wrong { .. })));
        }
        let code = auth.new_code(10);
        assert!(matches!(auth.pair(&code.code, "x", "6.6.6.6", "", 10), Err(PairError::Locked { .. })));
        assert!(auth.pair(&code.code, "x", "7.7.7.7", "", 11).is_ok());
        let code = auth.new_code(ADDRESS_WINDOW + 10);
        assert!(auth.pair(&code.code, "x", "6.6.6.6", "", ADDRESS_WINDOW + 10).is_ok());
    }

    #[test]
    fn misses_from_everywhere_close_pairing_until_the_desk_asks_again() {
        let (auth, _) = auth("global");
        let mut code = auth.new_code(0);
        let mut n = 0;
        while n < GLOBAL_MISSES {
            match auth.pair(&wrong(&code.code), "x", &format!("9.9.9.{n}"), "", 5) {
                Err(PairError::Burned) => {
                    // Simulates the attacker facing a still-valid code without
                    // the desk resetting the global count.
                    auth.lock().code = Some(Code { digits: code.code.clone(), expires: 500, misses: 0 });
                }
                Err(PairError::Wrong { .. }) => {}
                other => panic!("unexpected {other:?}"),
            }
            n += 1;
        }
        auth.lock().code = Some(Code { digits: code.code.clone(), expires: 500, misses: 0 });
        assert!(matches!(auth.pair(&code.code, "x", "8.8.8.8", "", 6), Err(PairError::Locked { .. })));
        code = auth.new_code(7);
        assert!(auth.pair(&code.code, "x", "8.8.8.8", "", 8).is_ok());
    }

    #[test]
    fn sessions_slide_while_used_and_die_when_forgotten() {
        let (auth, _) = auth("slide");
        let code = auth.new_code(0);
        let (token, device) = auth.pair(&code.code, "x", "a", "", 0).unwrap();
        assert_eq!(device.expires, SESSION_TTL);
        let later = SESSION_TTL - 60;
        assert_eq!(auth.check(&token, "b", later).unwrap().expires, later + SESSION_TTL);
        assert_eq!(auth.devices(later)[0].address, "b");
        assert!(auth.check(&token, "b", later + SESSION_TTL + 1).is_none());
        assert!(auth.devices(later + SESSION_TTL + 1).is_empty());
    }
}
