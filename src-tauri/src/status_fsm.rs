use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Idle,
    Streaming,
    AwaitingInput,
    ToolRunning,
    Error,
}

/// Heuristic state machine that infers what an interactive CLI agent
/// (Claude Code) is currently doing, from its byte stream alone.
///
/// Two inputs: `on_chunk` (each PTY chunk) and `on_tick` (periodic poll).
/// Returns `Some(new_state)` only on transitions, so the supervisor can emit
/// an event without spamming the frontend.
pub struct StatusFsm {
    state: Status,
    last_byte_at: Instant,
    tail: Vec<u8>,
}

/// Window of recent bytes kept for pattern matching. Big enough to span the
/// last few lines of output, small enough to keep regex/contains cheap.
const TAIL_CAP: usize = 4096;

/// How long without bytes before we consider the agent "settled" and look at
/// the tail to decide between idle / awaiting_input / tool_running.
const SETTLE_AFTER: Duration = Duration::from_millis(2500);

/// How long without bytes before we drop to plain idle.
const IDLE_AFTER: Duration = Duration::from_secs(3);

/// Minimum printable (non-escape) bytes for a chunk to count as actual content.
/// Claude's TUI emits frequent micro-chunks of pure ANSI (cursor moves, spinner
/// frames, status-line redraws) — those must not renew the activity timer or the
/// FSM stays in Streaming forever.
const CONTENT_MIN_PRINTABLE: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChunkKind {
    Content,
    Control,
}

/// Walks the chunk byte-by-byte, skipping anything that lives inside an ANSI/CSI
/// escape sequence, and counts printable bytes. ≥8 printable bytes = real
/// output worth waking the FSM for.
fn classify(chunk: &[u8]) -> ChunkKind {
    let mut printable = 0usize;
    let mut i = 0;
    while i < chunk.len() {
        let b = chunk[i];
        if b == 0x1b {
            // ESC: skip the rest of the escape sequence.
            i += 1;
            if i >= chunk.len() {
                break;
            }
            match chunk[i] {
                // CSI: ESC [ ... <final byte 0x40..=0x7e>
                b'[' => {
                    i += 1;
                    while i < chunk.len() && !matches!(chunk[i], 0x40..=0x7e) {
                        i += 1;
                    }
                    if i < chunk.len() {
                        i += 1;
                    }
                }
                // OSC: ESC ] ... BEL or ESC \
                b']' => {
                    i += 1;
                    while i < chunk.len() && chunk[i] != 0x07 && chunk[i] != 0x1b {
                        i += 1;
                    }
                    if i < chunk.len() && chunk[i] == 0x1b && i + 1 < chunk.len() && chunk[i + 1] == b'\\' {
                        i += 2;
                    } else if i < chunk.len() {
                        i += 1;
                    }
                }
                // Two-byte sequences (e.g. ESC =, ESC >): skip one more.
                _ => i += 1,
            }
            continue;
        }
        // Most control bytes are noise (BS, CR, etc) except real text whitespace.
        if b == b'\n' || (b >= 0x20 && b < 0x7f) {
            printable += 1;
            if printable >= CONTENT_MIN_PRINTABLE {
                return ChunkKind::Content;
            }
        }
        i += 1;
    }
    if printable >= CONTENT_MIN_PRINTABLE {
        ChunkKind::Content
    } else {
        ChunkKind::Control
    }
}

impl StatusFsm {
    pub fn new() -> Self {
        Self {
            state: Status::Idle,
            last_byte_at: Instant::now(),
            tail: Vec::with_capacity(TAIL_CAP),
        }
    }

    pub fn state(&self) -> Status {
        self.state
    }

    pub fn on_chunk(&mut self, chunk: &[u8]) -> Option<Status> {
        // Always keep the tail current (so awaiting-input regex sees the latest
        // bytes), but ignore pure control noise for activity tracking.
        self.tail.extend_from_slice(chunk);
        if self.tail.len() > TAIL_CAP {
            let drop = self.tail.len() - TAIL_CAP;
            self.tail.drain(..drop);
        }
        if classify(chunk) == ChunkKind::Control {
            return None;
        }
        self.last_byte_at = Instant::now();
        self.transition(Status::Streaming)
    }

    pub fn on_tick(&mut self) -> Option<Status> {
        let elapsed = self.last_byte_at.elapsed();
        if elapsed < SETTLE_AFTER {
            return None;
        }
        // After SETTLE quiet, we trust that the agent is between turns. Only
        // upgrade to awaiting_input on a VERY strong pattern — `--dangerously-
        // skip-permissions` makes real blocking prompts rare, so we err toward
        // silence rather than false alarms.
        let next = if matches_strong_awaiting(&self.tail) {
            Status::AwaitingInput
        } else {
            Status::Idle
        };
        // IDLE_AFTER isn't used as a hard threshold anymore — once settled,
        // we're idle until either a new chunk or a strong prompt pattern.
        let _ = IDLE_AFTER;
        self.transition(next)
    }

    fn transition(&mut self, next: Status) -> Option<Status> {
        if next != self.state {
            self.state = next;
            Some(next)
        } else {
            None
        }
    }
}

impl Default for StatusFsm {
    fn default() -> Self {
        Self::new()
    }
}

/// Strong patterns that *only* appear when the CLI is genuinely blocking on a
/// keystroke from the user. Excludes Claude's always-present `❯ ` cursor and
/// any phrase that can show up in prose ("approve", "continue?", etc.).
fn matches_strong_awaiting(tail: &[u8]) -> bool {
    let s = String::from_utf8_lossy(tail);
    s.contains("[y/N]")
        || s.contains("[Y/n]")
        || s.contains("(y/n)")
        || s.contains("(Y/n)")
        || s.contains("Press any key")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTLED: Duration = Duration::from_millis(2600);

    #[test]
    fn content_chunk_marks_streaming() {
        let mut f = StatusFsm::new();
        assert_eq!(
            f.on_chunk(b"Generating a long answer..."),
            Some(Status::Streaming)
        );
        // Same state on next content chunk: no transition.
        assert_eq!(f.on_chunk(b"...more output here"), None);
    }

    #[test]
    fn short_chunk_is_treated_as_control() {
        let mut f = StatusFsm::new();
        // 5 chars, below the 8-byte content threshold.
        assert_eq!(f.on_chunk(b"hello"), None);
        assert_eq!(f.state(), Status::Idle);
    }

    #[test]
    fn tick_with_strong_awaiting_pattern() {
        let mut f = StatusFsm::new();
        f.on_chunk(b"Are you sure you want to delete? [y/N] ");
        std::thread::sleep(SETTLED);
        assert_eq!(f.on_tick(), Some(Status::AwaitingInput));
    }

    #[test]
    fn prose_does_not_trigger_awaiting() {
        let mut f = StatusFsm::new();
        f.on_chunk(b"I will approve this change. Do you want to continue? ");
        std::thread::sleep(SETTLED);
        assert_eq!(f.on_tick(), Some(Status::Idle));
    }

    #[test]
    fn always_present_cursor_does_not_trigger_awaiting() {
        let mut f = StatusFsm::new();
        f.on_chunk(b"Here is the answer you asked about.");
        std::thread::sleep(SETTLED);
        // The TUI redraws a cursor; tail now contains "❯ " but it's still Idle.
        f.on_chunk("\n❯ ".as_bytes());
        std::thread::sleep(SETTLED);
        assert_eq!(f.on_tick(), Some(Status::Idle));
    }

    #[test]
    fn tick_falls_to_idle_after_quiet() {
        let mut f = StatusFsm::new();
        f.on_chunk(b"Doing some real work here.");
        std::thread::sleep(SETTLED);
        assert_eq!(f.on_tick(), Some(Status::Idle));
    }

    #[test]
    fn no_emit_before_settle() {
        let mut f = StatusFsm::new();
        f.on_chunk(b"Some content output.");
        // SETTLE_AFTER not reached → no transition.
        assert_eq!(f.on_tick(), None);
    }

    #[test]
    fn classify_pure_cursor_move_is_control() {
        // ESC [ 1 ; 1 H  — move cursor to row 1 col 1.
        let chunk = b"\x1b[1;1H";
        assert_eq!(classify(chunk), ChunkKind::Control);
    }

    #[test]
    fn classify_spinner_frame_is_control() {
        // Hide cursor + small glyph + show cursor — typical claude redraw.
        let chunk = b"\x1b[?25l\x1b[2K\xe2\xa0\x8b\x1b[?25h";
        assert_eq!(classify(chunk), ChunkKind::Control);
    }

    #[test]
    fn classify_prose_is_content() {
        let chunk = b"\x1b[32mHello world, this is real output.\x1b[0m";
        assert_eq!(classify(chunk), ChunkKind::Content);
    }

    #[test]
    fn control_chunk_does_not_renew_activity() {
        let mut f = StatusFsm::new();
        // Real content puts us in Streaming.
        assert_eq!(
            f.on_chunk(b"Generating a long answer for you..."),
            Some(Status::Streaming)
        );
        std::thread::sleep(Duration::from_millis(1300));
        // Cursor noise arrives mid-quiet — must NOT reset the settle timer.
        assert_eq!(f.on_chunk(b"\x1b[1;1H\x1b[?25h"), None);
        std::thread::sleep(Duration::from_millis(1300));
        // Total elapsed > 2500ms even though "noise" arrived in the middle.
        assert_eq!(f.on_tick(), Some(Status::Idle));
    }
}
