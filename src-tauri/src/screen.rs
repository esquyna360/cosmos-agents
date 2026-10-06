//! What a PTY's screen looks like right now, as text the UI can draw small.
//!
//! Each runner feeds its output through a headless terminal emulator, so a
//! card on the canvas can show the real screen (Claude's TUI redraws in place
//! and means nothing as a byte tail) without owning an xterm instance.

use serde::Serialize;

/// A stretch of cells that share a style.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Run {
    pub t: String,
    /// `"0"`..`"15"` for the theme's ANSI palette, `"#rrggbb"` otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub c: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub b: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub d: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Snapshot {
    pub id: String,
    /// Bumps on every chunk; the caller sends back the last one it drew.
    pub ver: u64,
    pub cols: u16,
    pub lines: Vec<Vec<Run>>,
}

pub struct Screen {
    parser: vt100::Parser,
    ver: u64,
}

impl Screen {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self { parser: vt100::Parser::new(rows.max(2), cols.max(2), 0), ver: 0 }
    }

    /// Runs on the PTY reader thread, so an emulator bug must never take the
    /// terminal down with it: on a panic the screen starts over, blank.
    pub fn feed(&mut self, chunk: &[u8]) {
        let fed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.parser.process(chunk)));
        if fed.is_err() {
            let (rows, cols) = self.parser.screen().size();
            self.parser = vt100::Parser::new(rows, cols, 0);
        }
        self.ver += 1;
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser.screen_mut().set_size(rows.max(2), cols.max(2));
        self.ver += 1;
    }

    pub fn ver(&self) -> u64 {
        self.ver
    }

    /// The last `want` rows that have something on them.
    pub fn tail(&self, want: usize) -> (u16, Vec<Vec<Run>>) {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let mut lines: Vec<Vec<Run>> = (0..rows).map(|r| row_runs(screen, r, cols)).collect();
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        let skip = lines.len().saturating_sub(want);
        (cols, lines.split_off(skip))
    }
}

fn css(color: vt100::Color) -> Option<String> {
    match color {
        vt100::Color::Default => None,
        vt100::Color::Idx(n) if n < 16 => Some(n.to_string()),
        vt100::Color::Idx(n) if n < 232 => {
            let n = n - 16;
            let level = |v: u8| if v == 0 { 0 } else { 55 + 40 * v };
            Some(format!("#{:02x}{:02x}{:02x}", level(n / 36), level(n / 6 % 6), level(n % 6)))
        }
        vt100::Color::Idx(n) => {
            let v = 8 + 10 * (n - 232);
            Some(format!("#{v:02x}{v:02x}{v:02x}"))
        }
        vt100::Color::Rgb(r, g, b) => Some(format!("#{r:02x}{g:02x}{b:02x}")),
    }
}

fn row_runs(screen: &vt100::Screen, row: u16, cols: u16) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for col in 0..cols {
        let Some(cell) = screen.cell(row, col) else { continue };
        if cell.is_wide_continuation() {
            continue;
        }
        let text = cell.contents();
        let text = if text.is_empty() { " " } else { text };
        let (c, b, d) = (css(cell.fgcolor()), cell.bold(), cell.dim());
        match runs.last_mut() {
            Some(last) if last.c == c && last.b == b && last.d == d => last.t.push_str(text),
            _ => runs.push(Run { t: text.to_string(), c, b, d }),
        }
    }
    while let Some(last) = runs.last_mut() {
        let kept = last.t.trim_end().len();
        if kept > 0 {
            last.t.truncate(kept);
            break;
        }
        runs.pop();
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(lines: &[Vec<Run>]) -> Vec<String> {
        lines.iter().map(|l| l.iter().map(|r| r.t.as_str()).collect()).collect()
    }

    #[test]
    fn a_redraw_in_place_leaves_only_the_final_screen() {
        let mut s = Screen::new(20, 5);
        s.feed(b"working 1%\r\x1b[2Kworking 99%\r\n\x1b[32mdone\x1b[0m");
        let (cols, lines) = s.tail(10);
        assert_eq!(cols, 20);
        assert_eq!(text(&lines), ["working 99%", "done"]);
        assert_eq!(lines[1][0].c.as_deref(), Some("2"));
    }

    #[test]
    fn the_tail_keeps_the_bottom_rows_and_the_version_moves() {
        let mut s = Screen::new(10, 6);
        s.feed(b"a\r\nb\r\nc\r\nd");
        assert_eq!(text(&s.tail(2).1), ["c", "d"]);
        let before = s.ver();
        s.resize(30, 4);
        assert!(s.ver() > before);
    }

    /// `COSMOS_CAPTURE=<file> cargo test real_capture -- --ignored --nocapture`
    /// prints what a recorded PTY stream ends up looking like.
    #[test]
    #[ignore]
    fn real_capture() {
        let path = std::env::var("COSMOS_CAPTURE").expect("COSMOS_CAPTURE");
        let mut s = Screen::new(120, 40);
        for chunk in std::fs::read(path).unwrap().chunks(977) {
            s.feed(chunk);
        }
        for line in text(&s.tail(14).1) {
            println!("|{line}");
        }
    }

    #[test]
    fn extended_colors_become_hex() {
        assert_eq!(css(vt100::Color::Idx(196)).as_deref(), Some("#ff0000"));
        assert_eq!(css(vt100::Color::Rgb(1, 2, 3)).as_deref(), Some("#010203"));
        assert_eq!(css(vt100::Color::Default), None);
    }
}
