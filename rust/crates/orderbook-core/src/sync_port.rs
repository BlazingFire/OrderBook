//! Pure Rust ports of the offline-sync primitives in
//! `shared/src/sync/merge.ts` (`mergeFields`, `sameLines`, `lineKey`) and
//! `shared/src/sync/hlc.ts` (`tickHlc`, `observeHlc`, `compareHlc`).
//!
//! The TypeScript modules stay the contract: behavior here mirrors them
//! exactly, including edge cases (counter overflow errors, malformed-HLC
//! handling, bookkeeping-field filtering). Timestamps keep the fixed-width
//! string encoding from `hlc.ts`:
//!
//! ```text
//! 0001700000000000-00000-A3F9K2
//! └ physical ms ──┘ └cnt┘ └device┘
//! ```
//!
//! so lexicographic order is causal order.

use super::js_trim;
use std::collections::HashMap;

/// Wall-clock milliseconds, zero-padded so string order matches numeric order.
pub const PHYSICAL_DIGITS: usize = 16;
/// Ticks within the same millisecond.
pub const COUNTER_DIGITS: usize = 5;
/// 99_999 events in one ms is not reachable; past it the clock errors loudly.
pub const COUNTER_MAX: u32 = 99_999;
/// Device codes are 6 chars (`DEVICE_CODE_LENGTH` in `shared/src/sync/ids.ts`).
pub const DEVICE_CODE_LENGTH: usize = 6;

/// A device's clock. A value plus pure transitions, never a hidden clock
/// read: the caller passes wall time in. Mirrors `HlcState` in `hlc.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlcState {
    pub device_code: String,
    pub physical: u64,
    pub counter: u32,
}

/// A decoded HLC timestamp. Mirrors `HlcParts` in `hlc.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlcParts {
    pub physical: u64,
    pub counter: u32,
    pub device_code: String,
}

/// The stamped result of `tick_hlc` / `observe_hlc`. Mirrors the
/// `{ state, hlc }` pair those TypeScript functions return.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlcTick {
    pub state: HlcState,
    pub hlc: String,
}

/// Mirrors `formatHlc`: zero-padded physical, counter, then the device code.
pub fn format_hlc(parts: &HlcParts) -> String {
    format!(
        "{:0>physical$}-{:0>counter$}-{}",
        parts.physical,
        parts.counter,
        parts.device_code,
        physical = PHYSICAL_DIGITS,
        counter = COUNTER_DIGITS,
    )
}

/// Mirrors `parseHlc`: fixed slices (`[0..16]`, `[17..22]`, `[23..]`),
/// `Number()` conversion, and the throw on a non-finite part or an empty
/// device code (reported here as `Err` with the same message text).
///
/// Well-formed timestamps always hold integer physical/counter values, so
/// those parse into `u64`/`u32`; anything else fails as malformed.
pub fn parse_hlc(value: &str) -> Result<HlcParts, String> {
    let malformed = || format!("Malformed HLC timestamp: {value}");
    let chars: Vec<char> = value.chars().collect();
    let physical_text: String = chars.iter().take(PHYSICAL_DIGITS).collect();
    let counter_text: String = chars
        .iter()
        .skip(PHYSICAL_DIGITS + 1)
        .take(COUNTER_DIGITS)
        .collect();
    let device_code: String = chars
        .iter()
        .skip(PHYSICAL_DIGITS + COUNTER_DIGITS + 2)
        .collect();

    let physical = js_string_to_number(&physical_text);
    let counter = js_string_to_number(&counter_text);
    if !physical.is_finite() || !counter.is_finite() || device_code.is_empty() {
        return Err(malformed());
    }
    if physical < 0.0 || physical.fract() != 0.0 || counter < 0.0 || counter.fract() != 0.0 {
        return Err(malformed());
    }
    if physical > u64::MAX as f64 || counter > u32::MAX as f64 {
        return Err(malformed());
    }
    Ok(HlcParts {
        physical: physical as u64,
        counter: counter as u32,
        device_code,
    })
}

/// Total order over HLC timestamps: a plain string comparison, exactly like
/// `compareHlc` (`-1`, `0`, or `1`).
pub fn compare_hlc(a: &str, b: &str) -> i32 {
    if a < b {
        -1
    } else if a > b {
        1
    } else {
        0
    }
}

/// Mirrors `initialHlcState`, including the device-code length check
/// (length in UTF-16 units, as TypeScript's `length` counts them).
pub fn initial_hlc_state(device_code: &str) -> Result<HlcState, String> {
    if device_code.encode_utf16().count() != DEVICE_CODE_LENGTH {
        return Err(format!(
            "Device code must be {DEVICE_CODE_LENGTH} characters, got \"{device_code}\""
        ));
    }
    Ok(HlcState {
        device_code: device_code.to_string(),
        physical: 0,
        counter: 0,
    })
}

/// Stamps a locally-originated event. Wall time arrives as `now_ms`
/// (mirrors the `wallClockMs` argument; this module never reads a clock).
/// The clock never runs backwards: a wall time behind `state.physical` keeps
/// the old physical and advances the counter instead.
pub fn tick_hlc(state: &HlcState, now_ms: u64) -> Result<HlcTick, String> {
    let physical = state.physical.max(now_ms);
    let counter = if physical == state.physical {
        state.counter.saturating_add(1)
    } else {
        0
    };
    assert_counter_in_range(counter, physical)?;
    let next = HlcState {
        device_code: state.device_code.clone(),
        physical,
        counter,
    };
    let hlc = format_hlc(&HlcParts {
        physical,
        counter,
        device_code: next.device_code.clone(),
    });
    Ok(HlcTick { state: next, hlc })
}

/// Folds a timestamp from another device into this clock, so everything
/// stamped afterwards sorts after that remote edit. Mirrors `observeHlc`.
pub fn observe_hlc(state: &HlcState, remote: &str, now_ms: u64) -> Result<HlcTick, String> {
    let incoming = parse_hlc(remote)?;
    let physical = state.physical.max(incoming.physical).max(now_ms);

    let counter = if physical == state.physical && physical == incoming.physical {
        state.counter.max(incoming.counter).saturating_add(1)
    } else if physical == state.physical {
        state.counter.saturating_add(1)
    } else if physical == incoming.physical {
        incoming.counter.saturating_add(1)
    } else {
        0
    };
    assert_counter_in_range(counter, physical)?;

    let next = HlcState {
        device_code: state.device_code.clone(),
        physical,
        counter,
    };
    let hlc = format_hlc(&HlcParts {
        physical,
        counter,
        device_code: next.device_code.clone(),
    });
    Ok(HlcTick { state: next, hlc })
}

fn assert_counter_in_range(counter: u32, physical: u64) -> Result<(), String> {
    if counter > COUNTER_MAX {
        return Err(format!("HLC counter overflow at physical time {physical}"));
    }
    Ok(())
}

/// A field value travelling through the merge. Missing map entries and
/// `Undefined` both stand for JavaScript `undefined`, which the merge treats
/// identically (property lookup cannot tell them apart). Objects keep
/// insertion order in a `Vec` so structural comparison matches
/// `JSON.stringify` key-for-key.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldValue {
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
    Array(Vec<FieldValue>),
    Object(Vec<(String, FieldValue)>),
    Undefined,
}

/// Structural comparison mirroring `valuesEqual` in `merge.ts`: `===` for
/// primitives (so `NaN` differs from `NaN`, `-0` equals `0`), then a
/// `JSON.stringify` comparison for containers — where `undefined` array items
/// read as `null` and `undefined`-valued keys are dropped.
pub fn values_equal(a: &FieldValue, b: &FieldValue) -> bool {
    match (a, b) {
        (FieldValue::Null, FieldValue::Null) | (FieldValue::Undefined, FieldValue::Undefined) => {
            true
        }
        (FieldValue::Bool(x), FieldValue::Bool(y)) => x == y,
        // `f64 ==` is the `===` rule: NaN != NaN, -0.0 == 0.0.
        (FieldValue::Number(x), FieldValue::Number(y)) => x == y,
        (FieldValue::Str(x), FieldValue::Str(y)) => x == y,
        (
            FieldValue::Array(_) | FieldValue::Object(_),
            FieldValue::Array(_) | FieldValue::Object(_),
        ) => stringify_value(a) == stringify_value(b),
        _ => false,
    }
}

/// Mirrors `JSON.stringify` for merge values. `None` is the `undefined`
/// result (top-level `undefined`); inside arrays it becomes `"null"` and
/// inside objects the key is dropped.
fn stringify_value(value: &FieldValue) -> Option<String> {
    match value {
        FieldValue::Null => Some("null".to_string()),
        FieldValue::Undefined => None,
        FieldValue::Bool(true) => Some("true".to_string()),
        FieldValue::Bool(false) => Some("false".to_string()),
        FieldValue::Number(n) => Some(js_number_to_json_string(*n)),
        FieldValue::Str(s) => Some(json_quote(s)),
        FieldValue::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .map(|item| stringify_value(item).unwrap_or_else(|| "null".to_string()))
                .collect();
            Some(format!("[{}]", parts.join(",")))
        }
        FieldValue::Object(entries) => {
            let mut parts = Vec::new();
            for (key, val) in entries {
                if let Some(text) = stringify_value(val) {
                    parts.push(format!("{}:{text}", json_quote(key)));
                }
            }
            Some(format!("{{{}}}", parts.join(",")))
        }
    }
}

/// Mirrors `JSON.stringify` number output: non-finite becomes `null`, `-0`
/// prints as `0`. (Past 1e21 JavaScript switches to exponential notation
/// while Rust prints full digits; quantities never reach there.)
fn js_number_to_json_string(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    if !value.is_finite() {
        return "null".to_string();
    }
    format!("{value}")
}

/// Mirrors `JSON.stringify` string quoting: `"`, `\`, and control escapes;
/// every other char passes through raw (including U+2028/29, as in ES2019+).
fn json_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Mirrors `Number()` applied to a string: JS-whitespace trim, empty trims to
/// `0`, exact `Infinity` forms, `0x`/`0b`/`0o` prefixes (unsigned only —
/// a sign before them is `NaN`), then the decimal grammar. Anything Rust's
/// parser accepts but JavaScript rejects (`inf`, `nan`, stray letters) is
/// `NaN` here too.
fn js_string_to_number(text: &str) -> f64 {
    let s = js_trim(text);
    if s.is_empty() {
        return 0.0;
    }
    // JavaScript's numeric grammar has no digit separators: `Number("1_0")`
    // is NaN, while Rust's parser would read it as 10.
    if s.contains('_') {
        return f64::NAN;
    }
    if s == "Infinity" || s == "+Infinity" {
        return f64::INFINITY;
    }
    if s == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    let has_sign = s.starts_with(['+', '-']);
    if !has_sign {
        if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
            return parse_int_digits(hex, 16);
        }
        if let Some(bin) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
            return parse_int_digits(bin, 2);
        }
        if let Some(oct) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
            return parse_int_digits(oct, 8);
        }
    }
    if s.bytes()
        .any(|b| b.is_ascii_alphabetic() && b != b'e' && b != b'E')
    {
        return f64::NAN;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

fn parse_int_digits(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut acc: f64 = 0.0;
    for ch in digits.chars() {
        match ch.to_digit(radix) {
            Some(d) => acc = acc * f64::from(radix) + f64::from(d),
            None => return f64::NAN,
        }
    }
    acc
}

/// Whether a field's disagreement is worth surfacing for human review.
/// Mirrors `isConflictWorthy`: derived bookkeeping is last-write-wins without
/// a peep; business fields are always reported.
pub fn is_conflict_worthy(field: &str) -> bool {
    !matches!(field, "updatedAt" | "version" | "hlc" | "searchVector")
}

/// `applied` when no field clashed, `merged` when at least one did.
/// Mirrors the `MergeOutcome` status strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeStatus {
    Applied,
    Merged,
}

impl MergeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            MergeStatus::Applied => "applied",
            MergeStatus::Merged => "merged",
        }
    }
}

/// One field that lost the merge. `None` values are JavaScript `undefined`
/// (the side simply had nothing there). Mirrors `MutationFieldConflict`.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldConflict {
    pub field: String,
    pub losing_value: Option<FieldValue>,
    pub winning_value: Option<FieldValue>,
    pub winning_hlc: String,
    pub winning_device_code: String,
}

/// The stored record side of the merge. Mirrors `MergeTarget`.
#[derive(Debug, Clone, Default)]
pub struct MergeTarget {
    pub values: HashMap<String, FieldValue>,
    pub field_hlc: HashMap<String, String>,
}

/// The incoming edit side of the merge. Mirrors `MergeCandidate`.
#[derive(Debug, Clone)]
pub struct MergeCandidate {
    /// Fields this edit asserts; fields outside this list are left alone.
    pub fields: Vec<String>,
    pub values: HashMap<String, FieldValue>,
    /// Per-field HLC the editing panel believed was current.
    pub base_field_hlc: HashMap<String, String>,
    pub hlc: String,
    pub device_code: String,
}

/// The merge result. Mirrors `MergeOutcome`.
#[derive(Debug, Clone)]
pub struct MergeOutcome {
    /// Fields to write, already filtered to the ones that won.
    pub accepted: HashMap<String, FieldValue>,
    /// The record's `fieldHlc` map after the merge.
    pub field_hlc: HashMap<String, String>,
    /// Every conflict-worthy field where two panels disagreed.
    pub conflicts: Vec<FieldConflict>,
    pub status: MergeStatus,
}

/// Field-level merge: edits to different fields both survive; edits to the
/// same field resolve to the higher HLC with the loser kept visible.
/// Mirrors `mergeFields` exactly:
/// - stored clock equal to the editor's base is an ordinary sequential edit:
///   accepted silently (comparison is on clock presence too, so a field
///   absent from both maps counts as equal);
/// - an unseen stored clock (`None`) loses to any incoming HLC, but a
///   conflict is recorded only when a stored clock existed and the values
///   actually differ;
/// - an older incoming edit is dropped but still recorded;
/// - bookkeeping fields still write, but never produce conflicts;
/// - `status` is `merged` only when at least one conflict was recorded.
pub fn merge_fields(target: &MergeTarget, incoming: &MergeCandidate) -> MergeOutcome {
    static UNDEFINED: FieldValue = FieldValue::Undefined;
    let mut accepted: HashMap<String, FieldValue> = HashMap::new();
    let mut field_hlc = target.field_hlc.clone();
    let mut conflicts: Vec<FieldConflict> = Vec::new();

    for field in &incoming.fields {
        let incoming_value = incoming.values.get(field).unwrap_or(&UNDEFINED);
        let stored_hlc = target.field_hlc.get(field);
        let base_hlc = incoming.base_field_hlc.get(field);

        // The editor was looking at the value they replaced. The key is
        // always written, even when the incoming side carries nothing for
        // it: the twin assigns `undefined` there, and callers test presence
        // with `in` and `Object.keys`, which see such keys.
        if stored_hlc == base_hlc {
            accepted.insert(
                field.clone(),
                incoming
                    .values
                    .get(field)
                    .cloned()
                    .unwrap_or(FieldValue::Undefined),
            );
            field_hlc.insert(field.clone(), incoming.hlc.clone());
            continue;
        }

        let stored_value = target.values.get(field).unwrap_or(&UNDEFINED);
        let incoming_is_newer = match stored_hlc {
            None => true,
            Some(stored) => compare_hlc(&incoming.hlc, stored) > 0,
        };
        if incoming_is_newer {
            accepted.insert(
                field.clone(),
                incoming
                    .values
                    .get(field)
                    .cloned()
                    .unwrap_or(FieldValue::Undefined),
            );
            field_hlc.insert(field.clone(), incoming.hlc.clone());
            if stored_hlc.is_some()
                && !values_equal(stored_value, incoming_value)
                && is_conflict_worthy(field)
            {
                conflicts.push(FieldConflict {
                    field: field.clone(),
                    losing_value: target.values.get(field).cloned(),
                    winning_value: incoming.values.get(field).cloned(),
                    winning_hlc: incoming.hlc.clone(),
                    winning_device_code: incoming.device_code.clone(),
                });
            }
            continue;
        }

        // The stored value is newer: the edit loses but stays visible.
        if !values_equal(stored_value, incoming_value) && is_conflict_worthy(field) {
            let stored = stored_hlc.map(String::as_str).unwrap_or("");
            conflicts.push(FieldConflict {
                field: field.clone(),
                losing_value: incoming.values.get(field).cloned(),
                winning_value: target.values.get(field).cloned(),
                winning_hlc: stored.to_string(),
                winning_device_code: safe_device_code(stored),
            });
        }
    }

    MergeOutcome {
        accepted,
        field_hlc,
        status: if conflicts.is_empty() {
            MergeStatus::Applied
        } else {
            MergeStatus::Merged
        },
        conflicts,
    }
}

/// A base for an edit that carries none. The outbox stores `{}` as the base
/// of every lead and order edit, so each field's stored clock is taken as the
/// base when it predates this edit. Mirrors `baseForUnversionedEdit` in
/// `merge.ts` (a missing or empty stored clock is not a base).
pub fn base_for_unversioned_edit(
    fields: &[String],
    field_hlc: &HashMap<String, String>,
    hlc: &str,
) -> HashMap<String, String> {
    let mut base = HashMap::new();
    for field in fields {
        if let Some(stored) = field_hlc.get(field) {
            if !stored.is_empty() && compare_hlc(hlc, stored) > 0 {
                base.insert(field.clone(), stored.clone());
            }
        }
    }
    base
}

/// Extracts the device code from a stored HLC, or `"unknown"` when it does
/// not parse. Mirrors `safeDeviceCode` in `merge.ts`.
fn safe_device_code(hlc: &str) -> String {
    parse_hlc(hlc)
        .map(|parts| parts.device_code)
        .unwrap_or_else(|_| "unknown".to_string())
}

/// One order line as seen by the merge: everything a person can edit. The
/// snapshot fields (name, code, weight) never reach here — they come from the
/// catalogue, not the person. `None` is a missing/`null` value.
#[derive(Debug, Clone, Default)]
pub struct LineRef<'a> {
    pub product_id: Option<&'a FieldValue>,
    pub variant_id: Option<&'a FieldValue>,
    pub quantity: Option<&'a FieldValue>,
    pub colour: Option<&'a FieldValue>,
    pub grade: Option<&'a FieldValue>,
    pub packaging: Option<&'a FieldValue>,
    pub notes: Option<&'a FieldValue>,
}

/// Whether two line sets say the same thing in the same order. Anything but
/// two present arrays (including two missing sides) is `false`, mirroring the
/// `Array.isArray` guards in `sameLines`.
pub fn same_lines(stored: Option<&[LineRef<'_>]>, incoming: Option<&[LineRef<'_>]>) -> bool {
    match (stored, incoming) {
        (Some(a), Some(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b.iter())
                    .all(|(x, y)| line_key(x) == line_key(y))
        }
        _ => false,
    }
}

/// Identity of one line for "did the lines change". Mirrors `lineKey`:
/// `JSON.stringify` of product, variant, `Number(quantity)`, and the four
/// text fields where only a non-empty string counts (anything else is null).
pub fn line_key(line: &LineRef<'_>) -> String {
    format!(
        "[{},{},{},{},{},{},{}]",
        key_scalar(line.product_id),
        key_scalar(line.variant_id),
        js_number_to_json_string(coerce_quantity(line.quantity)),
        line_text(line.colour),
        line_text(line.grade),
        line_text(line.packaging),
        line_text(line.notes),
    )
}

/// Mirrors `Number(value)` for a line quantity: missing is `NaN` (key
/// `null`), `null` is `0`, booleans are `1`/`0`, strings parse as numbers.
/// (Containers fall back to `NaN`; JavaScript would run `ToPrimitive` on
/// them, but a line quantity is never an array or object in practice.)
fn coerce_quantity(value: Option<&FieldValue>) -> f64 {
    match value {
        None | Some(FieldValue::Undefined) => f64::NAN,
        Some(FieldValue::Null) => 0.0,
        Some(FieldValue::Bool(true)) => 1.0,
        Some(FieldValue::Bool(false)) => 0.0,
        Some(FieldValue::Number(n)) => *n,
        Some(FieldValue::Str(s)) => js_string_to_number(s),
        Some(FieldValue::Array(_)) | Some(FieldValue::Object(_)) => f64::NAN,
    }
}

/// Mirrors the `text()` helper in `lineKey`: a non-empty string quotes as
/// itself, everything else is `null`.
fn line_text(value: Option<&FieldValue>) -> String {
    match value {
        Some(FieldValue::Str(s)) if !s.is_empty() => json_quote(s),
        _ => "null".to_string(),
    }
}

/// A raw key part: missing/`undefined` stringifies as `null`, like
/// `JSON.stringify` inside an array.
fn key_scalar(value: Option<&FieldValue>) -> String {
    match value {
        None | Some(FieldValue::Undefined) => "null".to_string(),
        Some(v) => stringify_value(v).unwrap_or_else(|| "null".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PANEL_A: &str = "A3F9K2";
    const PANEL_B: &str = "B7QMX4";
    const WALL: u64 = 1_700_000_000_000;

    fn strv(s: &str) -> FieldValue {
        FieldValue::Str(s.to_string())
    }

    fn stamp_a() -> String {
        tick_hlc(&initial_hlc_state(PANEL_A).unwrap(), WALL)
            .unwrap()
            .hlc
    }

    fn stamp_b() -> String {
        tick_hlc(&initial_hlc_state(PANEL_B).unwrap(), WALL + 60_000)
            .unwrap()
            .hlc
    }

    fn field_map(pairs: Vec<(&str, FieldValue)>) -> HashMap<String, FieldValue> {
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    fn hlc_map(pairs: Vec<(&str, String)>) -> HashMap<String, String> {
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    #[test]
    fn tick_advances_counter_within_same_ms() {
        let state = initial_hlc_state(PANEL_A).unwrap();
        let first = tick_hlc(&state, WALL).unwrap();
        let second = tick_hlc(&first.state, WALL).unwrap();
        assert_eq!(parse_hlc(&first.hlc).unwrap().counter, 0);
        assert_eq!(parse_hlc(&second.hlc).unwrap().counter, 1);
        assert!(compare_hlc(&first.hlc, &second.hlc) < 0);
    }

    #[test]
    fn tick_resets_counter_when_wall_moves_on() {
        let state = initial_hlc_state(PANEL_A).unwrap();
        let state = tick_hlc(&state, WALL).unwrap().state;
        let state = tick_hlc(&state, WALL).unwrap().state;
        let later = tick_hlc(&state, WALL + 1).unwrap();
        assert_eq!(parse_hlc(&later.hlc).unwrap().counter, 0);
    }

    #[test]
    fn tick_never_goes_backwards() {
        let state = initial_hlc_state(PANEL_A).unwrap();
        let before = tick_hlc(&state, WALL).unwrap();
        let after = tick_hlc(&before.state, WALL - 100_000_000).unwrap();
        assert!(compare_hlc(&before.hlc, &after.hlc) < 0);
        assert_eq!(parse_hlc(&after.hlc).unwrap().physical, WALL);
    }

    #[test]
    fn observe_sorts_after_remote_with_slow_clock() {
        let remote = tick_hlc(&initial_hlc_state(PANEL_A).unwrap(), WALL + 60_000)
            .unwrap()
            .hlc;
        let local = observe_hlc(&initial_hlc_state(PANEL_B).unwrap(), &remote, WALL).unwrap();
        assert!(compare_hlc(&remote, &local.hlc) < 0);
        assert_eq!(parse_hlc(&local.hlc).unwrap().physical, WALL + 60_000);
        assert_eq!(local.state.device_code, PANEL_B);
    }

    #[test]
    fn hlc_order_is_lexicographic_and_devices_differ() {
        let mut state = initial_hlc_state(PANEL_A).unwrap();
        let mut stamps = Vec::new();
        for i in 0..25 {
            let tick = tick_hlc(&state, WALL + (i % 3)).unwrap();
            state = tick.state.clone();
            stamps.push(tick.hlc);
        }
        let mut sorted = stamps.clone();
        sorted.sort();
        assert_eq!(sorted, stamps);

        let a = tick_hlc(&initial_hlc_state(PANEL_A).unwrap(), WALL)
            .unwrap()
            .hlc;
        let b = tick_hlc(&initial_hlc_state(PANEL_B).unwrap(), WALL)
            .unwrap()
            .hlc;
        assert_ne!(a, b);
        assert_ne!(compare_hlc(&a, &b), 0);
    }

    #[test]
    fn hlc_format_round_trips_and_rejects_garbage() {
        let tick = tick_hlc(&initial_hlc_state(PANEL_A).unwrap(), WALL).unwrap();
        let parts = parse_hlc(&tick.hlc).unwrap();
        assert_eq!(parts.physical, WALL);
        assert_eq!(parts.counter, 0);
        assert_eq!(parts.device_code, PANEL_A);
        assert_eq!(format_hlc(&parts), tick.hlc);
        assert!(parse_hlc("").is_err());
        assert!(parse_hlc("not-an-hlc").is_err());
        assert!(initial_hlc_state("short").is_err());
    }

    #[test]
    fn merge_keeps_edits_to_different_fields() {
        let stamp_a = stamp_a();
        let stamp_b = stamp_b();
        let outcome = merge_fields(
            &MergeTarget {
                values: field_map(vec![
                    ("notes", strv("called back")),
                    ("followUpDate", FieldValue::Null),
                ]),
                field_hlc: hlc_map(vec![("notes", stamp_a.clone())]),
            },
            &MergeCandidate {
                fields: vec!["followUpDate".to_string()],
                values: field_map(vec![("followUpDate", strv("2026-09-01"))]),
                base_field_hlc: HashMap::new(),
                hlc: stamp_b.clone(),
                device_code: PANEL_B.to_string(),
            },
        );
        assert_eq!(outcome.status.as_str(), "applied");
        assert!(outcome.conflicts.is_empty());
        assert_eq!(
            outcome.accepted.get("followUpDate"),
            Some(&strv("2026-09-01"))
        );
        assert_eq!(outcome.field_hlc.get("notes"), Some(&stamp_a));
        assert_eq!(outcome.field_hlc.get("followUpDate"), Some(&stamp_b));
    }

    #[test]
    fn merge_gives_field_to_higher_hlc_and_keeps_loser() {
        let stamp_a = stamp_a();
        let stamp_b = stamp_b();
        let outcome = merge_fields(
            &MergeTarget {
                values: field_map(vec![("notes", strv("A wrote this"))]),
                field_hlc: hlc_map(vec![("notes", stamp_a.clone())]),
            },
            &MergeCandidate {
                fields: vec!["notes".to_string()],
                values: field_map(vec![("notes", strv("B wrote this"))]),
                base_field_hlc: HashMap::new(),
                hlc: stamp_b.clone(),
                device_code: PANEL_B.to_string(),
            },
        );
        assert_eq!(outcome.status.as_str(), "merged");
        assert_eq!(outcome.accepted.get("notes"), Some(&strv("B wrote this")));
        assert_eq!(
            outcome.conflicts,
            vec![FieldConflict {
                field: "notes".to_string(),
                losing_value: Some(strv("A wrote this")),
                winning_value: Some(strv("B wrote this")),
                winning_hlc: stamp_b,
                winning_device_code: PANEL_B.to_string(),
            }]
        );
    }

    #[test]
    fn merge_refuses_stale_edit_but_records_it() {
        let stamp_a = stamp_a();
        let stamp_b = stamp_b();
        let outcome = merge_fields(
            &MergeTarget {
                values: field_map(vec![("notes", strv("B wrote this"))]),
                field_hlc: hlc_map(vec![("notes", stamp_b.clone())]),
            },
            &MergeCandidate {
                fields: vec!["notes".to_string()],
                values: field_map(vec![("notes", strv("A wrote this later"))]),
                base_field_hlc: HashMap::new(),
                hlc: stamp_a,
                device_code: PANEL_A.to_string(),
            },
        );
        assert_eq!(outcome.status.as_str(), "merged");
        assert!(outcome.accepted.is_empty());
        assert_eq!(outcome.field_hlc.get("notes"), Some(&stamp_b));
        assert_eq!(
            outcome.conflicts[0].losing_value,
            Some(strv("A wrote this later"))
        );
        assert_eq!(outcome.conflicts[0].winning_device_code, PANEL_B);
    }

    #[test]
    fn merge_treats_seen_base_as_ordinary_edit() {
        let stamp_a = stamp_a();
        let stamp_b = stamp_b();
        let outcome = merge_fields(
            &MergeTarget {
                values: field_map(vec![("notes", strv("A wrote this"))]),
                field_hlc: hlc_map(vec![("notes", stamp_a.clone())]),
            },
            &MergeCandidate {
                fields: vec!["notes".to_string()],
                values: field_map(vec![("notes", strv("B revised it"))]),
                base_field_hlc: hlc_map(vec![("notes", stamp_a)]),
                hlc: stamp_b,
                device_code: PANEL_B.to_string(),
            },
        );
        assert_eq!(outcome.status.as_str(), "applied");
        assert!(outcome.conflicts.is_empty());
        assert_eq!(outcome.accepted.get("notes"), Some(&strv("B revised it")));
    }

    #[test]
    fn merge_ignores_identical_values_and_bookkeeping() {
        let stamp_a = stamp_a();
        let stamp_b = stamp_b();
        let outcome = merge_fields(
            &MergeTarget {
                values: field_map(vec![
                    ("notes", strv("same text")),
                    ("updatedAt", strv("then")),
                ]),
                field_hlc: hlc_map(vec![
                    ("notes", stamp_a.clone()),
                    ("updatedAt", stamp_a.clone()),
                ]),
            },
            &MergeCandidate {
                fields: vec!["notes".to_string(), "updatedAt".to_string()],
                values: field_map(vec![
                    ("notes", strv("same text")),
                    ("updatedAt", strv("now")),
                ]),
                base_field_hlc: HashMap::new(),
                hlc: stamp_b.clone(),
                device_code: PANEL_B.to_string(),
            },
        );
        assert_eq!(outcome.status.as_str(), "applied");
        assert!(outcome.conflicts.is_empty());
        assert_eq!(outcome.accepted.get("updatedAt"), Some(&strv("now")));
        assert_eq!(outcome.field_hlc.get("updatedAt"), Some(&stamp_b));
    }

    #[test]
    fn merge_compares_arrays_structurally_and_names_unknown_devices() {
        let stamp_a = stamp_a();
        let stamp_b = stamp_b();
        let lines = || {
            FieldValue::Array(vec![FieldValue::Object(vec![
                ("productId".to_string(), strv("PR0000000001")),
                (
                    "quantities".to_string(),
                    FieldValue::Array(vec![FieldValue::Object(vec![
                        ("colour".to_string(), strv("white")),
                        ("quantity".to_string(), FieldValue::Number(2.0)),
                    ])]),
                ),
            ])])
        };
        let outcome = merge_fields(
            &MergeTarget {
                values: field_map(vec![("items", lines())]),
                field_hlc: hlc_map(vec![("items", stamp_a.clone())]),
            },
            &MergeCandidate {
                fields: vec!["items".to_string()],
                values: field_map(vec![("items", lines())]),
                base_field_hlc: HashMap::new(),
                hlc: stamp_b,
                device_code: PANEL_B.to_string(),
            },
        );
        assert!(outcome.conflicts.is_empty());

        // A stored clock that cannot be parsed still loses visibly as unknown.
        let stale = merge_fields(
            &MergeTarget {
                values: field_map(vec![("notes", strv("stored"))]),
                field_hlc: hlc_map(vec![("notes", "zzz".to_string())]),
            },
            &MergeCandidate {
                fields: vec!["notes".to_string()],
                values: field_map(vec![("notes", strv("incoming"))]),
                base_field_hlc: HashMap::new(),
                hlc: "0000000000000000-00000-AAAAAA".to_string(),
                device_code: PANEL_A.to_string(),
            },
        );
        assert_eq!(stale.status.as_str(), "merged");
        assert_eq!(stale.conflicts[0].winning_device_code, "unknown");
    }

    fn line_parts() -> (FieldValue, FieldValue, FieldValue, FieldValue, FieldValue) {
        (
            strv("P1"),
            strv("V1"),
            FieldValue::Number(4.0),
            strv("Box"),
            FieldValue::Null,
        )
    }

    fn test_line<'a>(
        pid: &'a FieldValue,
        vid: &'a FieldValue,
        qty: &'a FieldValue,
        pack: &'a FieldValue,
        colour: Option<&'a FieldValue>,
    ) -> LineRef<'a> {
        LineRef {
            product_id: Some(pid),
            variant_id: Some(vid),
            quantity: Some(qty),
            colour,
            grade: None,
            packaging: Some(pack),
            notes: None,
        }
    }

    #[test]
    fn same_lines_ignores_snapshots_and_coercions() {
        let (pid, vid, qty, pack, null) = line_parts();
        let stored = test_line(&pid, &vid, &qty, &pack, Some(&null));
        // `quantity: "4"` coerces like `Number("4")`; `""` colour reads as null.
        let qty_text = strv("4");
        let empty = strv("");
        let incoming = test_line(&pid, &vid, &qty_text, &pack, Some(&empty));
        assert!(same_lines(Some(&[stored]), Some(&[incoming])));
        // Same key either way: `4` and `"4"` agree, `null` and `""` agree.
        assert_eq!(
            line_key(&test_line(&pid, &vid, &qty, &pack, Some(&null))),
            line_key(&test_line(&pid, &vid, &qty_text, &pack, Some(&empty))),
        );
    }

    #[test]
    fn same_lines_sees_edits_order_count_and_missing() {
        let (pid, vid, qty, pack, null) = line_parts();
        let base = || test_line(&pid, &vid, &qty, &pack, Some(&null));
        let qty5 = FieldValue::Number(5.0);
        let grass = strv("Grass");
        let ivory = strv("Ivory");
        let vid2 = strv("V2");

        // Changed quantity, packaging, or colour.
        assert!(!same_lines(
            Some(&[base()]),
            Some(&[test_line(&pid, &vid, &qty5, &pack, Some(&null))]),
        ));
        assert!(!same_lines(
            Some(&[base()]),
            Some(&[test_line(&pid, &vid, &qty, &grass, Some(&null))]),
        ));
        assert!(!same_lines(
            Some(&[base()]),
            Some(&[test_line(&pid, &vid, &qty, &pack, Some(&ivory))]),
        ));
        // Order matters, and so does the count.
        let second = test_line(&vid2, &vid, &qty, &pack, Some(&null));
        assert!(!same_lines(
            Some(&[base(), second.clone()]),
            Some(&[second, base()]),
        ));
        assert!(!same_lines(Some(&[base()]), Some(&[base(), base()])));
        // Non-arrays (including two missing sides) are never "the same".
        assert!(!same_lines(None, Some(&[base()])));
        assert!(!same_lines(None, None));
    }

    #[test]
    fn line_key_covers_only_editable_fields() {
        let (pid, vid, qty, pack, null) = line_parts();
        // Grade and notes participate; a line differing only in them differs.
        let grade_a = strv("Premium");
        let with_grade = LineRef {
            grade: Some(&grade_a),
            ..test_line(&pid, &vid, &qty, &pack, Some(&null))
        };
        let without_grade = test_line(&pid, &vid, &qty, &pack, Some(&null));
        assert_ne!(line_key(&with_grade), line_key(&without_grade));
        // A missing quantity keys as null, `null` colour as null.
        assert!(line_key(&without_grade).contains(",null,"));
    }

    #[test]
    fn number_parser_rejects_digit_separators_like_javascript() {
        assert!(js_string_to_number("1_0").is_nan());
        assert!(js_string_to_number("1e1_0").is_nan());
        assert_eq!(js_string_to_number("0x10"), 16.0);
        assert_eq!(js_string_to_number("  42  "), 42.0);
        assert_eq!(js_string_to_number(""), 0.0);
    }

    #[test]
    fn merge_writes_absent_values_as_explicit_undefined() {
        // `in` and `Object.keys` see keys the twin assigns `undefined` to,
        // so the port writes `Undefined` instead of skipping the key.
        let target = MergeTarget::default();
        let incoming = MergeCandidate {
            fields: vec!["notes".to_string()],
            values: HashMap::new(),
            base_field_hlc: HashMap::new(),
            hlc: "0000001700000000001-00000-A3F9K2".to_string(),
            device_code: PANEL_A.to_string(),
        };
        let outcome = merge_fields(&target, &incoming);
        assert_eq!(outcome.accepted.get("notes"), Some(&FieldValue::Undefined));
    }

    #[test]
    fn unversioned_base_takes_only_predated_clocks() {
        let field_hlc = hlc_map(vec![
            ("a", "0000001700000000001-00000-A3F9K2".to_string()),
            ("b", "0000001700000000003-00000-A3F9K2".to_string()),
        ]);
        let fields = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let base =
            base_for_unversioned_edit(&fields, &field_hlc, "0000001700000000002-00000-A3F9K2");
        assert_eq!(base.len(), 1);
        assert_eq!(
            base.get("a"),
            Some(&"0000001700000000001-00000-A3F9K2".to_string())
        );
    }
}
