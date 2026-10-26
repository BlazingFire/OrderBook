//! Pure domain logic mirrored from the TypeScript sources of truth.
//!
//! Each function here keeps the exact observable behavior of its TypeScript
//! twin (`master/src/lib/csv.ts`, `shared/src/domain/pick-score.ts`,
//! `shared/src/domain/record-search.ts`). The TypeScript modules stay the
//! contract: callers fall back to them whenever the helper binary is missing,
//! so a behavioral drift here can never become a feature change.

/// Renders one CSV field: quoted when needed, formula-injection-guarded.
///
/// Mirrors `csvCell` in `master/src/lib/csv.ts`: a leading `=`, `+`, `-`,
/// `@`, TAB or CR (after any number of leading apostrophes) takes a guard
/// apostrophe; a field containing `,`, `"`, CR or LF is quoted with `"`
/// doubled.
pub fn csv_cell(text: &str) -> String {
    let guarded = if needs_formula_guard(text) {
        format!("'{text}")
    } else {
        text.to_string()
    };
    if guarded.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

fn needs_formula_guard(text: &str) -> bool {
    let stripped = text.trim_start_matches('\'');
    matches!(
        stripped.chars().next(),
        Some('=') | Some('+') | Some('-') | Some('@') | Some('\t') | Some('\r')
    )
}

/// Renders rows as CSV lines, each ending in CRLF, for a document built a
/// batch at a time. Mirrors `csvLines` in `master/src/lib/csv.ts`.
pub fn csv_lines(rows: &[Vec<String>]) -> String {
    let mut out = String::new();
    for row in rows {
        for (index, cell) in row.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&csv_cell(cell));
        }
        out.push_str("\r\n");
    }
    out
}

/// Score tiers for the picker. Higher is better; `0` means no match.
/// Mirrors `PICK_SCORE` in `shared/src/domain/pick-score.ts`.
pub const PICK_NONE: u8 = 0;
pub const PICK_SUBSTRING: u8 = 1;
pub const PICK_WORD_START: u8 = 2;
pub const PICK_PREFIX: u8 = 3;
pub const PICK_EXACT: u8 = 4;

/// Exactly the whitespace `String.prototype.trim` and `\s` remove: WhiteSpace
/// plus LineTerminator. Notably narrower than the Unicode White_Space
/// property — U+0085 NEL splits a Rust `split_whitespace` but never a
/// JavaScript split, so the set is spelled out instead of derived.
fn is_js_space(ch: char) -> bool {
    matches!(ch,
        '\u{9}'..='\u{D}' | '\u{20}' | '\u{A0}' | '\u{1680}'
        | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}'
        | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// Tests one UTF-16 unit the way the `/[\p{L}\p{N}]/u` test in the
/// TypeScript twin tests `text[index - 1]`: a lone surrogate half is simply
/// not a letter or digit, while a BMP letter or digit is.
fn unit_is_letter_or_digit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(|ch| ch.is_alphabetic() || ch.is_numeric())
}

fn is_word_start(text: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    // Mirrors the twin's `indexOf` loop over UTF-16 units, not chars: a needle
    // right after an astral-plane letter still counts as a word start there,
    // because the preceding unit is a lone surrogate half.
    let text16: Vec<u16> = text.encode_utf16().collect();
    let needle16: Vec<u16> = needle.encode_utf16().collect();
    if needle16.is_empty() || needle16.len() > text16.len() {
        return false;
    }
    for start in 0..=text16.len() - needle16.len() {
        if text16[start..start + needle16.len()] != needle16[..] {
            continue;
        }
        if start == 0 {
            return true;
        }
        if !unit_is_letter_or_digit(text16[start - 1]) {
            return true;
        }
    }
    false
}

fn score_one(haystack: &str, needle: &str) -> u8 {
    if haystack.is_empty() {
        return PICK_NONE;
    }
    // Same Unicode default case mapping `String.prototype.toLowerCase` uses.
    let text = haystack.to_lowercase();
    if text == needle {
        return PICK_EXACT;
    }
    if text.starts_with(needle) {
        return PICK_PREFIX;
    }
    if is_word_start(&text, needle) {
        return PICK_WORD_START;
    }
    if text.contains(needle) {
        return PICK_SUBSTRING;
    }
    PICK_NONE
}

/// The best score any of a row's searchable fields achieves — best, never a
/// sum. Mirrors `pickScore` in `shared/src/domain/pick-score.ts`. Callers
/// pass `""` for absent fields (the TypeScript twin maps nullish to `""`
/// before scoring), and a pre-trimmed, pre-lowercased term.
pub fn pick_score(fields: &[&str], needle: &str) -> u8 {
    if js_trim(needle).is_empty() {
        return PICK_NONE;
    }
    let needle = js_trim(needle).to_lowercase();
    let mut best = PICK_NONE;
    for field in fields {
        let score = score_one(field, &needle);
        if score > best {
            best = score;
        }
    }
    best
}

/// Scores every row of `rows` against `needle` in one pass, so a caller can
/// rank a whole picker page with a single helper round trip. Same tiers as
/// `pick_score`; absent fields arrive as `""`.
pub fn pick_batch(rows: &[Vec<String>], needle: &str) -> Vec<u8> {
    rows.iter()
        .map(|row| {
            let refs: Vec<&str> = row.iter().map(String::as_str).collect();
            pick_score(&refs, needle)
        })
        .collect()
}

/// Scores every whitespace-separated word of `term` against many pre-built
/// haystacks in one pass, so a list screen filters with a single helper
/// round trip. Same rule as `matches_record` per row.
pub fn matches_batch(haystacks: &[String], term: &str) -> Vec<bool> {
    haystacks
        .iter()
        .map(|hay| matches_record(hay, term))
        .collect()
}

/// The exact string a release signature is made over: the signed fields in
/// `SIGNED_MANIFEST_FIELDS` order as `name=value` lines. Values arrive
/// stringified exactly as the twin's `String(value)` stringifies them; the
/// `sha256` hex is lowercased here like the twin lowercases it, so a
/// manifest written by hand with uppercase hex signs the same payload.
/// Mirrors `canonicalManifestPayload` in
/// `shared/src/domain/release-signature.ts`.
pub fn canonical_manifest_payload(
    panel: &str,
    platform: &str,
    version: &str,
    file: &str,
    size_bytes: &str,
    sha256: &str,
    released_at: &str,
) -> String {
    let sha = sha256.to_lowercase();
    [
        ("panel", panel),
        ("platform", platform),
        ("version", version),
        ("file", file),
        ("sizeBytes", size_bytes),
        ("sha256", sha.as_str()),
        ("releasedAt", released_at),
    ]
    .iter()
    .map(|(name, value)| format!("{name}={value}"))
    .collect::<Vec<_>>()
    .join("\n")
}

/// The separator the first line uses: a comma, or the semicolon / tab a
/// non-English Excel writes. Counts outside quotes; stops at the first line
/// break once anything counted. Mirrors `detectDelimiter` in
/// `master/src/lib/spreadsheet.ts`.
pub fn detect_delimiter(text: &str) -> char {
    let delims = [',', ';', '\t'];
    let mut counts = [0usize; 3];
    let mut quoted = false;
    for ch in text.chars() {
        if ch == '"' {
            quoted = !quoted;
        } else if !quoted && (ch == '\n' || ch == '\r') {
            if counts.iter().any(|&n| n > 0) {
                break;
            }
        } else if !quoted {
            if let Some(pos) = delims.iter().position(|&d| d == ch) {
                counts[pos] += 1;
            }
        }
    }
    let mut best = ',';
    let mut best_count = 0;
    for (index, delim) in delims.iter().enumerate() {
        if counts[index] > best_count {
            best_count = counts[index];
            best = *delim;
        }
    }
    best
}

/// Undoes the export's formula guard on one parsed cell: exactly one leading
/// apostrophe comes off when apostrophes-then-`=`/`+`/`-`/`@`/TAB/CR follow,
/// so an export re-imports unchanged. Mirrors the `endCell` strip in
/// `parseCsv` (`master/src/lib/spreadsheet.ts`); the CSV writer's own guard
/// is `csv_cell` above.
fn strip_formula_guard(cell: &str) -> String {
    if let Some(rest) = cell.strip_prefix('\'') {
        let after = rest.trim_start_matches('\'');
        if matches!(
            after.chars().next(),
            Some('=') | Some('+') | Some('-') | Some('@') | Some('\t') | Some('\r')
        ) {
            return rest.to_string();
        }
    }
    cell.to_string()
}

fn finish_cell(raw: &str) -> String {
    strip_formula_guard(js_trim(raw))
}

/// RFC 4180 records, one array per line **including blank ones**, so the
/// index is the row number Excel shows. Quoted fields may hold the delimiter,
/// quotes (`""`) and line breaks. Mirrors `parseCsv` in
/// `master/src/lib/spreadsheet.ts`, including the unit-by-unit walk (an
/// astral character passes through as its two halves and reassembles).
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let delimiter = detect_delimiter(text);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut touched = false;

    let chars: Vec<char> = text.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        let ch = chars[at];
        if quoted {
            if ch != '"' {
                cell.push(ch);
            } else if chars.get(at + 1) == Some(&'"') {
                cell.push('"');
                at += 1;
            } else {
                quoted = false;
            }
        } else if ch == '"' && js_trim(&cell).is_empty() {
            quoted = true;
            touched = true;
        } else if ch == delimiter {
            row.push(finish_cell(&cell));
            cell.clear();
            touched = true;
        } else if ch == '\r' || ch == '\n' {
            if ch == '\r' && chars.get(at + 1) == Some(&'\n') {
                at += 1;
            }
            row.push(finish_cell(&cell));
            cell.clear();
            rows.push(std::mem::take(&mut row));
            touched = false;
        } else {
            cell.push(ch);
            touched = true;
        }
        at += 1;
    }
    if touched || !cell.is_empty() {
        row.push(finish_cell(&cell));
        rows.push(row);
    }
    rows
}

/// Offline-sync primitives (HLC clock, LWW field merge, line identity),
/// mirroring `shared/src/sync/merge.ts` and `shared/src/sync/hlc.ts`.
pub mod sync_port;

/// Every whitespace-separated word of `term` must appear somewhere in the
/// pre-built `haystack` (already joined and filtered exactly as the
/// TypeScript twin joins it). Case-blind. An empty term matches everything.
/// Mirrors `matchesRecordSearch` in `shared/src/domain/record-search.ts`.
pub fn matches_record(haystack: &str, term: &str) -> bool {
    // Lowercased before splitting, like the twin: no case mapping produces
    // whitespace, but the order is kept so the two stay in lockstep.
    let lowered = term.to_lowercase();
    let words: Vec<&str> = lowered
        .split(is_js_space)
        .filter(|word| !word.is_empty())
        .collect();
    if words.is_empty() {
        return true;
    }
    let haystack = haystack.to_lowercase();
    words.iter().all(|word| haystack.contains(word))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_quotes_and_guards_like_the_typescript_twin() {
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell(""), "");
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell("line1\nline2"), "\"line1\nline2\"");
        // Formula guard: one leading apostrophe, quoting still applies.
        assert_eq!(csv_cell("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(csv_cell("@home"), "'@home");
        assert_eq!(csv_cell("-5"), "'-5");
        assert_eq!(csv_cell("+91 98250"), "'+91 98250");
        // A value that is only apostrophes plus a formula start is guarded.
        assert_eq!(csv_cell("'=x"), "''=x");
        // A leading apostrophe before ordinary text is not a guard.
        assert_eq!(csv_cell("'hello"), "'hello");
        // Quotes and commas combine: guard first, then quote and double.
        assert_eq!(csv_cell("=a,\"b\""), "\"'=a,\"\"b\"\"\"");
    }

    #[test]
    fn csv_lines_end_every_row_with_crlf() {
        let rows = vec![
            vec!["a".to_string(), "b,c".to_string()],
            vec!["=SUM(A1)".to_string()],
        ];
        assert_eq!(csv_lines(&rows), "a,\"b,c\"\r\n'=SUM(A1)\r\n");
        assert_eq!(csv_lines(&[]), "");
    }

    #[test]
    fn pick_score_tiers_match() {
        assert_eq!(pick_score(&["matt"], "matt"), PICK_EXACT);
        assert_eq!(pick_score(&["matt finish"], "matt"), PICK_PREFIX);
        assert_eq!(pick_score(&["ivory matt"], "matt"), PICK_WORD_START);
        assert_eq!(pick_score(&["formatted"], "matt"), PICK_SUBSTRING);
        assert_eq!(pick_score(&["glossy"], "matt"), PICK_NONE);
    }

    #[test]
    fn pick_score_takes_the_best_field_and_ignores_empty_terms() {
        assert_eq!(pick_score(&["Formatted Tile", "MATT"], "matt"), PICK_EXACT);
        assert_eq!(pick_score(&["anything"], "   "), PICK_NONE);
        assert_eq!(pick_score(&["", ""], "matt"), PICK_NONE);
        assert_eq!(pick_score(&["IVORY"], "ivory"), PICK_EXACT);
    }

    #[test]
    fn pick_score_counts_astral_letters_like_index_of() {
        // U+10437 is an alphabetic astral letter: the unit before the needle
        // is a lone surrogate half, which the twin's `\p{L}` test rejects,
        // so this is a word start, not a substring.
        assert_eq!(pick_score(&["a\u{10437}matt"], "matt"), PICK_WORD_START);
        assert_eq!(pick_score(&["abmatt"], "matt"), PICK_SUBSTRING);
    }

    #[test]
    fn pick_score_tolerates_regex_characters_in_the_term() {
        assert_eq!(pick_score(&["600x600 (matt)"], "(matt"), PICK_SUBSTRING);
        assert_eq!(pick_score(&["a+b"], "+"), PICK_SUBSTRING);
    }

    #[test]
    fn pick_batch_scores_each_row_like_pick_score() {
        let rows = vec![
            vec!["matt".to_string()],
            vec!["formatted".to_string()],
            vec!["glossy".to_string()],
        ];
        assert_eq!(
            pick_batch(&rows, "matt"),
            vec![PICK_EXACT, PICK_SUBSTRING, PICK_NONE]
        );
        assert_eq!(pick_batch(&[], "matt"), Vec::<u8>::new());
    }

    #[test]
    fn matches_record_needs_every_word_in_any_order() {
        let haystack = "LD0000000003 New Home Ceramics Asha noon 29 Damru DPV-0001 Grass";
        assert!(matches_record(haystack, "  "));
        assert!(matches_record(haystack, "damru"));
        assert!(matches_record(haystack, "GRASS damru"));
        assert!(!matches_record(haystack, "damru box"));
        assert!(!matches_record(haystack, "00043"));
        // U+0085 NEL is not JavaScript whitespace: the term stays one word
        // and matches nothing, instead of splitting into two hits.
        assert!(!matches_record("a b", "a\u{85}b"));
    }
}

mod import;
pub use import::*;
