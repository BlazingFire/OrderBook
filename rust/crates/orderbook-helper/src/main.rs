//! Sidecar helper: one JSON request on stdin, one JSON response on stdout.
//!
//! The TypeScript `rust-bridge` spawns this binary with a request shaped as
//! one of:
//!   {"op":"csv","rows":[["a","b"]]}
//!   {"op":"pickScore","fields":["..."],"term":"..."}
//!   {"op":"pickBatch","rows":[[...]],"term":"..."}
//!   {"op":"parseCsv","text":"a,b"}
//!   {"op":"parseImportSheet","headerRow":[...],"rows":[[...]],"rowNumbers":["2"],"restore":"false","updateOnly":"false"}
//! Rows and row numbers run in parallel: the caller filters blank and
//! out-of-scope rows first, exactly as the TypeScript loop does, so the
//! helper never invents a row number. Scalars travel stringified — the only
//! shapes on this wire are strings and lists of strings.
//!
//! (`matches_batch` and `canonical_manifest_payload` stay core-only for now:
//! their call chains are browser-side filtering and synchronous manifest
//! verification, neither of which can await a sidecar without changing
//! behavior. They are covered by the core unit tests instead.)
//!   {"op":"matchesRecord","haystack":"...","term":"..."}
//! and reads back `{"ok":true,"value":...}` or `{"ok":false,"error":"..."}`.
//! Anything unparseable answers `ok:false`; the caller always falls back to
//! the TypeScript implementation, so a helper failure is never a feature
//! change. Only the standard library is used: no network, no filesystem
//! access, no dependencies to vendor.

use orderbook_core::{
    csv_lines, match_headers, matches_record, parse_csv, parse_import_row, pick_batch, pick_score,
    ImportIssue, ImportProduct, ImportRow, ImportVariant, ParseOptions,
};
use std::io::Read;

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        print_error("cannot read stdin");
        return;
    }
    match handle(&input) {
        Ok(value_json) => println!("{{\"ok\":true,\"value\":{value_json}}}"),
        Err(message) => print_error(&message),
    }
}

fn print_error(message: &str) {
    println!("{{\"ok\":false,\"error\":{}}}", escape_json(message));
}

fn handle(input: &str) -> Result<String, String> {
    let request = parse_object(input.trim())?;
    let op = request
        .iter()
        .find(|(key, _)| key == "op")
        .map(|(_, value)| value.clone())
        .ok_or_else(|| "missing \"op\"".to_string())?;
    let op = as_string(&op).ok_or_else(|| "\"op\" must be a string".to_string())?;
    match op.as_str() {
        "csv" => {
            let rows = request
                .iter()
                .find(|(key, _)| key == "rows")
                .map(|(_, value)| value.clone())
                .ok_or_else(|| "missing \"rows\"".to_string())?;
            Ok(escape_json(&csv_lines(&as_string_rows(&rows)?)))
        }
        "pickScore" => {
            let fields = request
                .iter()
                .find(|(key, _)| key == "fields")
                .map(|(_, value)| value.clone())
                .ok_or_else(|| "missing \"fields\"".to_string())?;
            let term = request
                .iter()
                .find(|(key, _)| key == "term")
                .map(|(_, value)| value.clone())
                .ok_or_else(|| "missing \"term\"".to_string())?;
            let fields = as_string_list(&fields)?;
            let refs: Vec<&str> = fields.iter().map(String::as_str).collect();
            let term = as_string(&term).ok_or_else(|| "\"term\" must be a string".to_string())?;
            Ok(pick_score(&refs, &term).to_string())
        }
        "pickBatch" => {
            let rows = request
                .iter()
                .find(|(key, _)| key == "rows")
                .map(|(_, value)| value.clone())
                .ok_or_else(|| "missing \"rows\"".to_string())?;
            let term = request
                .iter()
                .find(|(key, _)| key == "term")
                .map(|(_, value)| value.clone())
                .ok_or_else(|| "missing \"term\"".to_string())?;
            let term = as_string(&term).ok_or_else(|| "\"term\" must be a string".to_string())?;
            let scores = pick_batch(&as_string_rows(&rows)?, &term);
            let body = scores
                .iter()
                .map(u8::to_string)
                .collect::<Vec<_>>()
                .join(",");
            Ok(format!("[{body}]"))
        }
        "parseCsv" => {
            let text = request
                .iter()
                .find(|(key, _)| key == "text")
                .map(|(_, value)| value.clone())
                .ok_or_else(|| "missing \"text\"".to_string())?;
            let text = as_string(&text).ok_or_else(|| "\"text\" must be a string".to_string())?;
            Ok(json_of_rows(&parse_csv(&text)))
        }
        "parseImportSheet" => {
            let get = |name: &str| {
                request
                    .iter()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.clone())
                    .ok_or_else(|| format!("missing \"{name}\""))
            };
            let header_row = as_string_list(&get("headerRow")?)?;
            let rows = as_string_rows(&get("rows")?)?;
            let row_numbers = as_string_list(&get("rowNumbers")?)?;
            if row_numbers.len() != rows.len() {
                return Err("rowNumbers must run parallel to rows".to_string());
            }
            let flag = |name: &str| match &get(name)? {
                Json::Str(text) if text == "true" => Ok(true),
                Json::Str(text) if text == "false" => Ok(false),
                _ => Err(format!("invalid \"{name}\"")),
            };
            let options = ParseOptions {
                restore: flag("restore")?,
                update_only: flag("updateOnly")?,
            };
            let matched = match_headers(&header_row.iter().map(String::as_str).collect::<Vec<_>>());
            let header_refs: Vec<&str> = header_row.iter().map(String::as_str).collect();
            let mut out = String::from("[");
            for (index, cells) in rows.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                let row_number: u32 = row_numbers[index]
                    .parse()
                    .map_err(|_| "invalid \"rowNumbers\" entry".to_string())?;
                let refs: Vec<&str> = cells.iter().map(String::as_str).collect();
                let parsed = parse_import_row(&refs, &matched, &header_refs, row_number, options);
                out.push_str(&json_of_parsed_row(parsed.input.as_ref(), &parsed.issues));
            }
            out.push(']');
            Ok(out)
        }
        "matchesRecord" => {
            let haystack = request
                .iter()
                .find(|(key, _)| key == "haystack")
                .map(|(_, value)| value.clone())
                .ok_or_else(|| "missing \"haystack\"".to_string())?;
            let term = request
                .iter()
                .find(|(key, _)| key == "term")
                .map(|(_, value)| value.clone())
                .ok_or_else(|| "missing \"term\"".to_string())?;
            let haystack =
                as_string(&haystack).ok_or_else(|| "\"haystack\" must be a string".to_string())?;
            let term = as_string(&term).ok_or_else(|| "\"term\" must be a string".to_string())?;
            Ok(matches_record(&haystack, &term).to_string())
        }
        other => Err(format!("unknown \"op\": {other}")),
    }
}

// --- Minimal JSON support (only what the protocol above needs) ---

#[derive(Clone, Debug)]
enum Json {
    Str(String),
    List(Vec<Json>),
}

fn as_string(value: &Json) -> Option<String> {
    match value {
        Json::Str(text) => Some(text.clone()),
        Json::List(_) => None,
    }
}

fn as_string_list(value: &Json) -> Result<Vec<String>, String> {
    match value {
        Json::List(items) => items
            .iter()
            .map(|item| as_string(item).ok_or_else(|| "expected a string".to_string()))
            .collect(),
        Json::Str(_) => Err("expected a list".to_string()),
    }
}

fn as_string_rows(value: &Json) -> Result<Vec<Vec<String>>, String> {
    match value {
        Json::List(rows) => rows
            .iter()
            .map(|row| match row {
                Json::List(cells) => cells
                    .iter()
                    .map(|cell| as_string(cell).ok_or_else(|| "expected a string cell".to_string()))
                    .collect(),
                Json::Str(_) => Err("expected a row list".to_string()),
            })
            .collect(),
        Json::Str(_) => Err("expected a rows list".to_string()),
    }
}

/// Parses a flat JSON object whose values are strings or nested lists of
/// strings. Returns the entries in order. Errors name the problem; the
/// caller reports them as `ok:false`.
fn parse_object(input: &str) -> Result<Vec<(String, Json)>, String> {
    let bytes = input.as_bytes();
    let mut pos = skip_ws(bytes, 0);
    if bytes.get(pos) != Some(&b'{') {
        return Err("request must be a JSON object".to_string());
    }
    pos += 1;
    let mut entries = Vec::new();
    loop {
        pos = skip_ws(bytes, pos);
        if bytes.get(pos) == Some(&b'}') {
            return Ok(entries);
        }
        if !entries.is_empty() {
            if bytes.get(pos) != Some(&b',') {
                return Err("expected ',' between entries".to_string());
            }
            pos = skip_ws(bytes, pos + 1);
        }
        let (key, next) = parse_string(bytes, pos)?;
        pos = skip_ws(bytes, next);
        if bytes.get(pos) != Some(&b':') {
            return Err("expected ':' after a key".to_string());
        }
        let (value, next) = parse_value(bytes, skip_ws(bytes, pos + 1))?;
        entries.push((key, value));
        pos = next;
    }
}

fn parse_value(bytes: &[u8], pos: usize) -> Result<(Json, usize), String> {
    match bytes.get(pos) {
        Some(b'"') => parse_string(bytes, pos).map(|(text, next)| (Json::Str(text), next)),
        Some(b'[') => {
            let mut items = Vec::new();
            let mut at = skip_ws(bytes, pos + 1);
            if bytes.get(at) == Some(&b']') {
                return Ok((Json::List(items), at + 1));
            }
            loop {
                let (value, next) = parse_value(bytes, at)?;
                items.push(value);
                at = skip_ws(bytes, next);
                match bytes.get(at) {
                    Some(b',') => at = skip_ws(bytes, at + 1),
                    Some(b']') => return Ok((Json::List(items), at + 1)),
                    _ => return Err("expected ',' or ']' in a list".to_string()),
                }
            }
        }
        _ => Err("only strings and lists are supported".to_string()),
    }
}

fn parse_string(bytes: &[u8], pos: usize) -> Result<(String, usize), String> {
    if bytes.get(pos) != Some(&b'"') {
        return Err("expected a string".to_string());
    }
    let mut out = String::new();
    let mut at = pos + 1;
    loop {
        let byte = *bytes
            .get(at)
            .ok_or_else(|| "unterminated string".to_string())?;
        if byte == b'"' {
            return Ok((out, at + 1));
        }
        if byte != b'\\' {
            // Bytes are UTF-8; decoding one char at a time from the slice.
            let rest =
                std::str::from_utf8(&bytes[at..]).map_err(|_| "invalid utf-8".to_string())?;
            let ch = rest
                .chars()
                .next()
                .ok_or_else(|| "unterminated string".to_string())?;
            out.push(ch);
            at += ch.len_utf8();
            continue;
        }
        let esc = *bytes
            .get(at + 1)
            .ok_or_else(|| "unterminated escape".to_string())?;
        match esc {
            b'"' => {
                out.push('"');
                at += 2;
            }
            b'\\' => {
                out.push('\\');
                at += 2;
            }
            b'n' => {
                out.push('\n');
                at += 2;
            }
            b'r' => {
                out.push('\r');
                at += 2;
            }
            b't' => {
                out.push('\t');
                at += 2;
            }
            b'u' => {
                let hex = bytes
                    .get(at + 2..at + 6)
                    .ok_or_else(|| "bad \\u escape".to_string())?;
                let hex = std::str::from_utf8(hex).map_err(|_| "bad \\u escape".to_string())?;
                let code =
                    u32::from_str_radix(hex, 16).map_err(|_| "bad \\u escape".to_string())?;
                // Surrogate halves from JSON `\u` escapes: keep the replacement
                // character rather than failing the whole request.
                out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                at += 6;
            }
            _ => return Err("bad escape".to_string()),
        }
    }
}

fn skip_ws(bytes: &[u8], mut pos: usize) -> usize {
    while matches!(
        bytes.get(pos),
        Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')
    ) {
        pos += 1;
    }
    pos
}

fn json_of_rows(rows: &[Vec<String>]) -> String {
    let mut out = String::from("[");
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('[');
        for (cell_index, cell) in row.iter().enumerate() {
            if cell_index > 0 {
                out.push(',');
            }
            out.push_str(&escape_json(cell));
        }
        out.push(']');
    }
    out.push(']');
    out
}

/// `{"input":{...}|null,"issues":[...]}` for one parsed sheet row. Field
/// names are the twin's camelCase keys; a `None` product key is absent,
/// `Some(None)` is null — the absent-key vs null distinction the twin keeps.
fn json_of_parsed_row(input: Option<&ImportRow>, issues: &[ImportIssue]) -> String {
    let mut out = String::from("{\"input\":");
    match input {
        None => out.push_str("null"),
        Some(row) => {
            out.push_str("{\"product\":");
            out.push_str(&json_of_import_product(&row.product));
            out.push_str(",\"variant\":");
            out.push_str(&json_of_import_variant(&row.variant));
            out.push('}');
        }
    }
    out.push_str(",\"issues\":[");
    for (index, issue) in issues.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str("{\"row\":");
        out.push_str(&issue.row.to_string());
        out.push_str(",\"kind\":\"error\",");
        out.push_str("\"column\":");
        match &issue.column {
            None => out.push_str("null"),
            Some(column) => out.push_str(&escape_json(column)),
        }
        out.push_str(",\"messageKey\":");
        out.push_str(&escape_json(issue.message_key));
        out.push_str(",\"params\":");
        match &issue.params {
            None => out.push_str("null"),
            Some(params) => {
                out.push_str("{\"column\":");
                out.push_str(&escape_json(&params.column));
                match params.allowed {
                    None => out.push('}'),
                    Some(allowed) => {
                        out.push_str(",\"allowed\":");
                        out.push_str(&escape_json(allowed));
                        out.push('}');
                    }
                }
            }
        }
        out.push('}');
    }
    out.push_str("]}");
    out
}

fn json_of_field_string(key: &str, value: &Option<String>, out: &mut String, first: &mut bool) {
    if let Some(text) = value {
        if !*first {
            out.push(',');
        }
        *first = false;
        out.push_str(&escape_json(key));
        out.push(':');
        out.push_str(&escape_json(text));
    }
}

fn json_of_import_product(product: &ImportProduct) -> String {
    let mut out = String::from("{");
    let mut first = true;
    json_of_field_string(
        "categoryBrand",
        &product.category_brand,
        &mut out,
        &mut first,
    );
    json_of_field_string("categoryCode", &product.category_code, &mut out, &mut first);
    json_of_field_string("categoryName", &product.category_name, &mut out, &mut first);
    json_of_field_string("name", &product.name, &mut out, &mut first);
    match &product.size {
        None => {}
        Some(inner) => {
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str("\"size\":");
            match inner {
                None => out.push_str("null"),
                Some(text) => out.push_str(&escape_json(text)),
            }
        }
    }
    match &product.alias {
        None => {}
        Some(inner) => {
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str("\"alias\":");
            match inner {
                None => out.push_str("null"),
                Some(text) => out.push_str(&escape_json(text)),
            }
        }
    }
    if let Some(multi) = product.multi_colour {
        if !first {
            out.push(',');
        }
        out.push_str("\"multiColour\":");
        out.push_str(&multi.to_string());
    }
    out.push('}');
    out
}

fn json_of_import_variant(variant: &ImportVariant) -> String {
    let mut out = String::from("{\"code\":");
    out.push_str(&escape_json(&variant.code));
    out.push_str(",\"label\":");
    match &variant.label {
        None => out.push_str("null"),
        Some(label) => out.push_str(&escape_json(label)),
    }
    out.push_str(",\"weightKg\":");
    match variant.weight_kg {
        None => out.push_str("null"),
        Some(weight) => out.push_str(&weight.to_string()),
    }
    out.push('}');
    out
}

fn escape_json(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}
