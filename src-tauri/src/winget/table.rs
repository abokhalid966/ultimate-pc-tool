//! Pure parsing of winget's console output: its tables, progress lines and result codes.
//!
//! winget has no machine-readable output for `upgrade` and `list`, so its tables are read by the
//! column positions of their header line. Positions are measured in screen cells (East Asian
//! characters take two, like winget measures them), which works in every display language because
//! nothing depends on the header words themselves. Kept free of Tauri and Windows APIs so it can
//! be unit tested anywhere.

use serde::{Deserialize, Serialize};

/// A table from winget's output: the header names and each row's cells, in column order.
#[derive(Debug, Clone, PartialEq)]
pub struct Table {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// The sentence just above the header, if it ends with a colon. winget introduces its second
    /// `upgrade` table ("...require explicit targeting for upgrade:") this way.
    pub intro: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpgrade {
    pub name: String,
    pub id: String,
    /// winget shortened the id to fit its table (it ended in "…"): it is matched as a prefix.
    pub partial_id: bool,
    pub version: String,
    pub available: String,
    pub source: Option<String>,
    /// winget only updates it when asked by name (it is pinned, or its publisher requires it),
    /// so "Update all" leaves it out.
    pub explicit: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListedPackage {
    pub name: String,
    pub id: String,
    pub partial_id: bool,
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Install,
    Upgrade,
}

// ---- Screen rendering ----

/// Removes color and cursor escape sequences (CSI, OSC and two-character ones).
fn strip_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // Parameters and intermediates, then one final byte in @..~.
            Some('[') => {
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            // Up to BEL or ESC \.
            Some(']') => {
                while let Some(n) = chars.next() {
                    if n == '\x07' {
                        break;
                    }
                    if n == '\x1b' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// One line as a console would show it: `\r` goes back to the start and later text overwrites,
/// `\b` steps back one cell. winget draws its spinner and progress bars this way.
fn render_line(raw: &str) -> String {
    let mut cells: Vec<char> = Vec::new();
    let mut col = 0usize;
    for c in raw.chars() {
        match c {
            '\r' => col = 0,
            '\u{8}' => col = col.saturating_sub(1),
            '\t' | ' ' => {
                put(&mut cells, col, ' ');
                col += 1;
            }
            c if c.is_control() => {}
            c => {
                put(&mut cells, col, c);
                col += 1;
            }
        }
    }
    let line: String = cells.into_iter().collect();
    line.trim_end().to_string()
}

fn put(cells: &mut Vec<char>, col: usize, c: char) {
    if col < cells.len() {
        cells[col] = c;
    } else {
        cells.resize(col, ' ');
        cells.push(c);
    }
}

/// The output as it would look on screen, one entry per line.
pub fn screen_lines(output: &str) -> Vec<String> {
    strip_escapes(output).split('\n').map(render_line).collect()
}

/// Spinner frames and progress bars, which say nothing once the run is over.
fn is_noise(line: &str) -> bool {
    let t = line.trim();
    matches!(t, "-" | "\\" | "|" | "/") || t.contains('█') || t.contains('▒')
}

/// winget's output without spinners, progress bars or runs of blank lines.
pub fn clean_output(output: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in screen_lines(output) {
        if is_noise(&line) {
            continue;
        }
        if line.trim().is_empty() && lines.last().is_none_or(|l| l.trim().is_empty()) {
            continue;
        }
        lines.push(line);
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

/// The last line worth showing, e.g. "Installer failed with exit code: 1603".
pub fn last_message(clean: &str) -> Option<String> {
    clean
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty() && !is_noise(l))
        .map(|l| l.chars().take(300).collect())
}

// ---- Tables ----

/// Screen cells taken by a character: 0 for combining marks, 2 for wide East Asian ones.
fn char_width(c: char) -> usize {
    let cp = c as u32;
    let zero = matches!(cp, 0x0300..=0x036F | 0x200B..=0x200F | 0x20D0..=0x20FF | 0xFE00..=0xFE0F);
    if zero {
        return 0;
    }
    let wide = matches!(cp,
        0x1100..=0x115F
        | 0x2E80..=0x303E
        | 0x3041..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x1F300..=0x1F64F
        | 0x1F900..=0x1F9FF
        | 0x20000..=0x3FFFD);
    if wide { 2 } else { 1 }
}

/// One screen cell of a line: the bytes it shows (empty for the second half of a wide character).
#[derive(Clone, Copy)]
struct Cell {
    start: usize,
    end: usize,
    blank: bool,
}

fn cells(line: &str) -> Vec<Cell> {
    let mut cells: Vec<Cell> = Vec::new();
    for (i, c) in line.char_indices() {
        let end = i + c.len_utf8();
        match char_width(c) {
            0 => match cells.last_mut() {
                Some(last) => last.end = end,
                None => cells.push(Cell { start: i, end, blank: false }),
            },
            1 => cells.push(Cell { start: i, end, blank: c == ' ' }),
            _ => {
                cells.push(Cell { start: i, end, blank: false });
                cells.push(Cell { start: end, end, blank: false });
            }
        }
    }
    cells
}

/// A row of dashes under a header.
fn is_rule(line: &str) -> bool {
    let t = line.trim();
    t.len() >= 8 && t.chars().all(|c| c == '-' || c == '─')
}

/// Where each column starts: every word of the header that follows a space.
fn column_starts(header: &[Cell]) -> Vec<usize> {
    (0..header.len())
        .filter(|&p| !header[p].blank && header[p].end > header[p].start && (p == 0 || header[p - 1].blank))
        .collect()
}

/// A column boundary for one row. Columns are always separated by a space, so when the cell just
/// before the boundary isn't blank, this row is shifted (a character winget measured differently)
/// and the boundary moves left to a space at most three cells away. `None` when there is none:
/// the line crosses the column, so it isn't a row (e.g. a footer like "2 upgrades available.").
fn snap(row: &[Cell], b: usize) -> Option<usize> {
    if b == 0 || b >= row.len() || row[b - 1].blank {
        return Some(b);
    }
    (b.saturating_sub(4)..b - 1).rev().find(|&p| row[p].blank).map(|p| p + 1)
}

fn split_row(line: &str, starts: &[usize]) -> Option<Vec<String>> {
    let row = cells(line);
    let bounds = starts.iter().map(|&b| snap(&row, b)).chain([Some(usize::MAX)]).collect::<Option<Vec<usize>>>()?;
    let fields = bounds
        .windows(2)
        .map(|w| {
            let (a, b) = (w[0].min(row.len()), w[1].min(row.len()));
            if a >= b { String::new() } else { line[row[a].start..row[b - 1].end].trim().to_string() }
        })
        .collect();
    Some(fields)
}

/// Every table in winget's output (a header line, a row of dashes, then rows up to a blank line).
pub fn parse_tables(output: &str) -> Vec<Table> {
    let lines = screen_lines(output);
    let mut tables = Vec::new();
    let mut i = 0;
    while i + 1 < lines.len() {
        if lines[i].trim().is_empty() || is_rule(&lines[i]) || !is_rule(&lines[i + 1]) {
            i += 1;
            continue;
        }
        let header = cells(&lines[i]);
        let starts = column_starts(&header);
        if starts.len() < 2 {
            i += 1;
            continue;
        }
        let Some(headers) = split_row(&lines[i], &starts) else {
            i += 1;
            continue;
        };
        let intro = lines[..i]
            .iter()
            .rev()
            .map(|l| l.trim())
            .find(|l| !l.is_empty() && !is_noise(l))
            .filter(|l| l.ends_with(':') || l.ends_with('：'))
            .map(String::from);
        let mut rows = Vec::new();
        let mut j = i + 2;
        while j < lines.len() && !lines[j].trim().is_empty() && !(j + 1 < lines.len() && is_rule(&lines[j + 1])) {
            if !is_noise(&lines[j])
                && let Some(row) = split_row(&lines[j], &starts)
            {
                rows.push(row);
            }
            j += 1;
        }
        tables.push(Table { headers, rows, intro });
        i = j;
    }
    tables
}

/// Ids never contain spaces; this also drops footers like "2 upgrades available." that spill
/// into the Id column.
fn plausible_id(id: &str) -> bool {
    !id.is_empty() && !id.chars().any(char::is_whitespace)
}

fn strip_ellipsis(s: &str) -> (String, bool) {
    match s.strip_suffix('…') {
        Some(prefix) => (prefix.trim_end().to_string(), true),
        None => (s.to_string(), false),
    }
}

/// Apps with an update, from `winget upgrade`. Columns: Name, Id, Version, Available, Source.
pub fn parse_upgrades(output: &str) -> Vec<AppUpgrade> {
    let mut list = Vec::new();
    for table in parse_tables(output) {
        let columns = table.headers.len();
        if columns < 4 {
            continue;
        }
        for row in &table.rows {
            let get = |i: usize| row.get(i).map(String::as_str).unwrap_or("");
            let (name, id, version, available) = (get(0), get(1), get(2), get(3));
            if name.is_empty() || !plausible_id(id) || version.is_empty() || available.is_empty() {
                continue;
            }
            let (id, partial_id) = strip_ellipsis(id);
            if partial_id && id.len() < 4 {
                continue;
            }
            let source = (columns >= 5).then(|| get(columns - 1)).filter(|s| !s.is_empty()).map(String::from);
            list.push(AppUpgrade {
                name: name.to_string(),
                id,
                partial_id,
                version: version.to_string(),
                available: available.to_string(),
                source,
                explicit: table.intro.is_some(),
            });
        }
    }
    list
}

/// Installed packages from `winget list`: name and id are the first two columns.
pub fn parse_listed(output: &str) -> Vec<ListedPackage> {
    let mut list = Vec::new();
    for table in parse_tables(output) {
        for row in &table.rows {
            let (Some(name), Some(id)) = (row.first(), row.get(1)) else { continue };
            if name.is_empty() || !plausible_id(id) {
                continue;
            }
            let (id, partial_id) = strip_ellipsis(id);
            list.push(ListedPackage { name: name.clone(), id, partial_id });
        }
    }
    list
}

// ---- Running ----

/// Ids as winget writes them, e.g. `Google.Chrome`, `Notepad++.Notepad++`, `9NKSQGP7F2NH`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && !id.starts_with(['-', '.']) && id.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
}

/// Arguments for installing or updating one app, matched by its exact id (or, when winget
/// shortened the id in its table, by the start of it).
pub fn run_args(action: Action, id: &str, partial_id: bool, source: Option<&str>) -> Result<Vec<String>, String> {
    if !valid_id(id) || (partial_id && id.len() < 4) {
        return Err("That app's id doesn't look right, so nothing was run.".into());
    }
    let verb = match action {
        Action::Install => "install",
        Action::Upgrade => "upgrade",
    };
    let mut args = vec![verb.to_string(), "--id".into(), id.into()];
    if !(partial_id && action == Action::Upgrade) {
        args.push("--exact".into());
    }
    if let Some(source) = source.filter(|s| matches!(*s, "winget" | "msstore")) {
        args.extend(["--source".into(), source.into()]);
    }
    args.extend(["--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"].map(String::from));
    Ok(args)
}

// ---- Result codes (winget's returnCodes.md) ----

pub const NO_APPLICATIONS_FOUND: u32 = 0x8A15_0014;
pub const UPDATE_NOT_APPLICABLE: u32 = 0x8A15_002B;
pub const PACKAGE_ALREADY_INSTALLED: u32 = 0x8A15_0061;
const INSTALLER_HASH_MISMATCH: u32 = 0x8A15_0011;
const REBOOT_TO_FINISH: u32 = 0x8A15_0109;
const REBOOT_INITIATED: u32 = 0x8A15_010B;

/// Plain-language reasons for the result codes winget maps installer errors to.
const FAILURES: &[(u32, &str)] = &[
    (NO_APPLICATIONS_FOUND, "winget couldn't find this app. It may have been renamed or removed from its catalog."),
    (INSTALLER_HASH_MISMATCH, "The downloaded installer didn't match what was expected, so it wasn't run. Try again later."),
    (0x8A15_0101, "The app is open. Close it, then try again."),
    (0x8A15_0102, "Another installation is already running. Wait for it to finish, then try again."),
    (0x8A15_0103, "Some of the app's files are in use. Close the app, then try again."),
    (0x8A15_0104, "The app needs another component that isn't on this PC."),
    (0x8A15_0105, "Your drive is full. Free up some space, then try again."),
    (0x8A15_0106, "There isn't enough free memory. Close some apps, then try again."),
    (0x8A15_0107, "There's no internet connection. Connect, then try again."),
    (0x8A15_0108, "The app's installer ran into a problem. Its publisher may be able to help."),
    (0x8A15_010A, "Windows needs a restart first. Restart your PC, then try again."),
    (0x8A15_010C, "The installation was cancelled."),
    (0x8A15_010D, "Another version of this app is already installed."),
    (0x8A15_010E, "A newer version of this app is already installed."),
    (0x8A15_010F, "Your organization's policies block installing this app."),
    (0x8A15_0110, "Something this app needs couldn't be installed."),
    (0x8A15_0111, "The app is being used by another app. Close it, then try again."),
    (0x8A15_0113, "This app doesn't support your version of Windows."),
    (0x8A15_0114, "This app can't be updated in place. Uninstall it first, then install it again."),
];

#[derive(Debug, PartialEq, Eq)]
pub enum Meaning {
    Success,
    /// Finished, but a restart is needed to complete it.
    Restart,
    /// Nothing to do: already installed or already up to date.
    Unchanged(&'static str),
    Failure(&'static str),
    Unknown,
}

pub fn meaning(code: i32) -> Meaning {
    let code = code as u32;
    match code {
        0 => Meaning::Success,
        REBOOT_TO_FINISH | REBOOT_INITIATED => Meaning::Restart,
        UPDATE_NOT_APPLICABLE => Meaning::Unchanged("Already up to date."),
        PACKAGE_ALREADY_INSTALLED => Meaning::Unchanged("Already installed."),
        _ => FAILURES.iter().find(|(c, _)| *c == code).map_or(Meaning::Unknown, |(_, text)| Meaning::Failure(text)),
    }
}

/// winget's own codes in hex (as its documentation lists them), small installer codes in decimal.
pub fn code_label(code: i32) -> String {
    if (0..=0xFFFF).contains(&code) { code.to_string() } else { format!("0x{:08X}", code as u32) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UPGRADE: &str = "\r   - \r   \\ \r                                                                                                                        \rName                                   Id                         Version        Available      Source\n\
---------------------------------------------------------------------------------------------------------------------\n\
Microsoft Edge                         Microsoft.Edge             120.0.2210.91  121.0.2277.83  winget\n\
7-Zip 22.01 (x64)                      7zip.7zip                  22.01          23.01          winget\n\
Microsoft Visual C++ 2015-2022 Redist… Microsoft.VCRedist.2015+.… 14.32.31332.0  14.38.33135.0  winget\n\
3 upgrades available.\n\
\n\
The following packages have an upgrade available, but require explicit targeting for upgrade:\n\
Name    Id              Version  Available Source\n\
-------------------------------------------------\n\
Discord Discord.Discord 1.0.9013 1.0.9030  winget\n";

    #[test]
    fn renders_carriage_returns_and_backspaces_like_a_console() {
        assert_eq!(render_line("\r-\r\\\r|\r \rDone"), "Done");
        assert_eq!(render_line("abc\u{8}\u{8}X"), "aXc");
        assert_eq!(screen_lines("\x1b[32mgreen\x1b[0m\r\nnext"), vec!["green", "next"]);
        assert_eq!(strip_escapes("a\x1b]0;title\x07b\x1b[2Kc"), "abc");
    }

    #[test]
    fn parses_upgrade_tables_including_truncated_ids_and_the_explicit_table() {
        let list = parse_upgrades(UPGRADE);
        assert_eq!(list.len(), 4);
        assert_eq!(list[0].name, "Microsoft Edge");
        assert_eq!(list[0].id, "Microsoft.Edge");
        assert_eq!(list[0].version, "120.0.2210.91");
        assert_eq!(list[0].available, "121.0.2277.83");
        assert_eq!(list[0].source.as_deref(), Some("winget"));
        assert!(!list[0].explicit && !list[0].partial_id);
        assert_eq!(list[1].name, "7-Zip 22.01 (x64)");
        assert_eq!(list[2].id, "Microsoft.VCRedist.2015+.");
        assert!(list[2].partial_id);
        assert_eq!(list[2].name, "Microsoft Visual C++ 2015-2022 Redist…");
        assert_eq!(list[3].id, "Discord.Discord");
        assert!(list[3].explicit);
    }

    #[test]
    fn measures_wide_characters_in_two_cells() {
        // "微信" takes four cells, so its Id still starts at cell 10.
        let out = "Name      Id             Version Available Source\n-------------------------------------------------\n微信      Tencent.WeChat 3.9     3.9.8     winget\nAppé      App.E          1.0     1.1       winget\n";
        let tables = parse_tables(out);
        assert_eq!(tables[0].rows[0][0], "微信");
        assert_eq!(tables[0].rows[0][1], "Tencent.WeChat");
        assert_eq!(tables[0].rows[1][0], "Appé");
        assert_eq!(tables[0].rows[1][1], "App.E");
    }

    #[test]
    fn recovers_rows_shifted_by_a_character_measured_differently() {
        // winget measured a character in this row differently, so the rest of the row is one cell left.
        let out = "Name        Id        Version  Available\n---------------------------------------\nNotes 📝   Notes.App 1.0      2.0\n";
        let row = &parse_tables(out)[0].rows[0];
        assert_eq!(row[1], "Notes.App");
        assert_eq!(row[2], "1.0");
    }

    #[test]
    fn localized_headers_and_no_results() {
        let german = "Name   ID          Version Verfügbar Quelle\n-------------------------------------------\nGit    Git.Git     2.40.0  2.43.0    winget\n1 Aktualisierungen verfügbar.\n";
        assert_eq!(parse_tables(german)[0].rows.len(), 1, "the footer isn't a row");
        let list = parse_upgrades(german);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "Git.Git");
        assert!(parse_upgrades("No installed package found matching input criteria.\n").is_empty());
        assert!(parse_tables("").is_empty());
    }

    #[test]
    fn short_name_column_does_not_turn_the_footer_into_a_row() {
        let out = "Name Id      Version Available Source\n-------------------------------------\nGit  Git.Git 2.40    2.43      winget\n1 upgrades available.\n";
        // Here the footer lines up with the columns, so it is dropped for its empty Available cell.
        assert_eq!(parse_upgrades(out).len(), 1);
    }

    #[test]
    fn lists_installed_ids() {
        let out = "Name              Id                       Version\n--------------------------------------------------\nGoogle Chrome     Google.Chrome            120.0\nSome Old App      ARP\\Machine\\X64\\Old App 1.0\nVery Long Name    Microsoft.VisualStudioC… 1.85\n";
        let list = parse_listed(out);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "Google.Chrome");
        assert_eq!(list[1].id, "Microsoft.VisualStudioC");
        assert!(list[1].partial_id);
    }

    #[test]
    fn cleans_progress_from_output() {
        let raw = "Found Google Chrome [Google.Chrome]\r\n  ██████▒▒▒▒  10 MB / 100 MB\r  ██████████  100 MB / 100 MB\r\nSuccessfully verified installer hash\r\n\r\n\r\n-\r\\\rSuccessfully installed\r\n";
        assert_eq!(clean_output(raw), "Found Google Chrome [Google.Chrome]\nSuccessfully verified installer hash\n\nSuccessfully installed");
        assert_eq!(last_message(&clean_output(raw)).as_deref(), Some("Successfully installed"));
    }

    #[test]
    fn builds_safe_arguments() {
        let args = run_args(Action::Install, "Notepad++.Notepad++", false, Some("winget")).unwrap();
        assert_eq!(&args[..6], ["install", "--id", "Notepad++.Notepad++", "--exact", "--source", "winget"]);
        assert!(args.contains(&"--accept-package-agreements".to_string()));
        assert!(args.contains(&"--disable-interactivity".to_string()));
        let partial = run_args(Action::Upgrade, "Microsoft.VCRedist.2015+.", true, Some("bogus")).unwrap();
        assert!(!partial.contains(&"--exact".to_string()));
        assert!(!partial.contains(&"--source".to_string()));
        assert!(run_args(Action::Install, "--force", false, None).is_err());
        assert!(run_args(Action::Install, "a b", false, None).is_err());
        assert!(run_args(Action::Upgrade, "Ab", true, None).is_err());
    }

    #[test]
    fn explains_result_codes() {
        assert_eq!(meaning(0), Meaning::Success);
        assert_eq!(meaning(0x8A15_002Bu32 as i32), Meaning::Unchanged("Already up to date."));
        assert_eq!(meaning(0x8A15_0109u32 as i32), Meaning::Restart);
        assert!(matches!(meaning(0x8A15_0101u32 as i32), Meaning::Failure(t) if t.contains("open")));
        assert_eq!(meaning(1603), Meaning::Unknown);
        assert_eq!(code_label(0x8A15_0101u32 as i32), "0x8A150101");
        assert_eq!(code_label(1603), "1603");
    }
}
