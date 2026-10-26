//! Pure Rust ports of three TypeScript domain functions.
//!
//! Twins (the TypeScript modules stay the contract):
//! `master/src/domain/product-import.ts` (`parseImportRow` plus the tiny pure
//! cell helpers it needs), `master/src/domain/search-terms.ts`
//! (`prefixTsQuery`), and `master/src/domain/line-items.ts`
//! (`buildLineSnapshot`).
//!
//! JS-unicode edges are handled the way `lib.rs` does it: the exact
//! `String.prototype.trim` / `\s` set (`super::js_trim`,
//! `super::is_js_space`) and UTF-16 notes where the twin walks units.
//! Anything that needs I/O, the clock, the database or `node:` APIs was left
//! out — none of the three functions below needs any of that.
//!
//! One deliberate no-op: the twin's `parseImportRow` ends with
//! `validateProductInput(built.product)`, but the parser never sets the only
//! two keys that check reads (`sortOrder`, `variants`), so it can never throw
//! there. The port keeps that observable behavior (no issue is ever added) by
//! not calling it, instead of porting a check that cannot fire.

use super::{is_js_space, js_trim};

// ---------------------------------------------------------------------------
// Tiny pure cell helpers (`product-import.ts`)
// ---------------------------------------------------------------------------

/// Lower-case letters and digits only: "Weight (kg)" and "weight_kg" are the
/// same header. Mirrors `normalizeHeader`.
///
/// Edge: `str::to_lowercase` is the same Unicode default case mapping
/// `String.prototype.toLowerCase` uses (so `İ` still folds to `i` plus a
/// dropped combining dot), and an astral character vanishes whole here where
/// the twin drops its two UTF-16 halves — the same observable string either
/// way. Lone surrogates cannot occur in a `&str` (they are separators there).
pub fn normalize_header(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        .collect()
}

/// A row is blank when every cell is — skipped without a word.
/// Mirrors `isBlankRow`.
pub fn is_blank_row(cells: &[&str]) -> bool {
    cells.iter().all(|cell| js_trim(cell).is_empty())
}

/// Strips the `/\s*kgs?$/i` weight-unit suffix. ASCII case-insensitive, like
/// the twin's regex without a `u` flag; sheets write the unit in ASCII.
fn strip_kg_suffix(text: &str) -> &str {
    for unit in ["kgs", "kg"] {
        // Byte arithmetic can land inside a multi-byte character (`"éx"`),
        // which would panic the slice: only cut on a char boundary.
        if text.len() >= unit.len() {
            let at = text.len() - unit.len();
            if text.is_char_boundary(at) && text[at..].eq_ignore_ascii_case(unit) {
                return &text[..at];
            }
        }
    }
    text
}

fn is_ascii_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// `^-?\d+,\d+$` on ASCII digits: the decimal-comma Excel writes (`12,5`).
fn is_simple_decimal_comma(text: &str) -> bool {
    let body = text.strip_prefix('-').unwrap_or(text);
    match body.split_once(',') {
        Some((head, tail)) => !tail.contains(',') && is_ascii_digits(head) && is_ascii_digits(tail),
        None => false,
    }
}

/// `^-?\d{1,3}(\.\d{3})+,\d+$`: dot groups, then a decimal comma (`1.234,5`).
fn is_grouped_decimal_comma(text: &str) -> bool {
    let body = text.strip_prefix('-').unwrap_or(text);
    let Some((head, tail)) = body.split_once(',') else {
        return false;
    };
    if tail.contains(',') || !is_ascii_digits(tail) {
        return false;
    }
    let mut groups = head.split('.');
    let first = groups.next().unwrap_or("");
    if first.is_empty() || first.len() > 3 || !first.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let mut rest = false;
    for group in groups {
        if group.len() != 3 || !group.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        rest = true;
    }
    rest
}

/// `^-?(\d+\.?\d*|\.\d+)$` on ASCII digits: the only shapes `Number()` may see.
fn is_plain_number(text: &str) -> bool {
    let body = text.strip_prefix('-').unwrap_or(text);
    if body.is_empty() {
        return false;
    }
    match body.find('.') {
        Some(dot) => {
            let (head, tail) = body.split_at(dot);
            let tail = &tail[1..];
            if tail.contains('.') {
                return false;
            }
            if head.is_empty() {
                is_ascii_digits(tail)
            } else {
                head.bytes().all(|byte| byte.is_ascii_digit())
                    && tail.bytes().all(|byte| byte.is_ascii_digit())
            }
        }
        None => body.bytes().all(|byte| byte.is_ascii_digit()),
    }
}

/// `"1,200.50"`, `"12.5 kg"`, `"12,5"`, `"0,125"`, `"1.234,5"` → a number;
/// anything else, including `0x10` and `1e3` which `Number()` would accept, is
/// `None`. Mirrors `parseNumber`, including the lone-comma rule (a lone comma
/// is always the decimal mark: the one number column is a weight kept to
/// three decimals).
///
/// The caller reports a non-finite value as `notANumber`, exactly as the twin
/// reports `!Number.isFinite(value)`, so overflow (`Some(inf)`) is `Some` here.
fn parse_number(text: &str) -> Option<f64> {
    let bare: String = strip_kg_suffix(text)
        .chars()
        .filter(|ch| !is_js_space(*ch))
        .collect();
    let plain: String = if is_simple_decimal_comma(&bare) {
        bare.replacen(',', ".", 1)
    } else if is_grouped_decimal_comma(&bare) {
        bare.replace('.', "").replacen(',', ".", 1)
    } else {
        bare.replace(',', "")
    };
    if is_plain_number(&plain) {
        plain.parse::<f64>().ok()
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Header matching (`product-import.ts`)
// ---------------------------------------------------------------------------

/// Every column a sheet may carry, by the field key the twin stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ImportField {
    CategoryBrand,
    CategoryCode,
    CategoryName,
    Name,
    Size,
    ColourRule,
    Variant,
    Code,
    WeightKg,
    Alias,
    MultiColour,
}

/// The wire field key, as the twin echoes unknown columns back.
fn field_key(field: ImportField) -> &'static str {
    match field {
        ImportField::CategoryBrand => "categoryBrand",
        ImportField::CategoryCode => "categoryCode",
        ImportField::CategoryName => "categoryName",
        ImportField::Name => "name",
        ImportField::Size => "size",
        ImportField::ColourRule => "colourRule",
        ImportField::Variant => "variant",
        ImportField::Code => "code",
        ImportField::WeightKg => "weightKg",
        ImportField::Alias => "alias",
        ImportField::MultiColour => "multiColour",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportKind {
    Text,
    Number,
    Boolean,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColumnSpec {
    pub field: ImportField,
    pub label: &'static str,
    pub kind: ImportKind,
    pub required: bool,
    pub legacy: bool,
    pub min: Option<f64>,
    pub exclusive_min: bool,
}

/// Template order. Mirrors `IMPORT_COLUMNS` (notes omitted: they only feed the
/// template's Guide sheet, never parsing).
pub const IMPORT_COLUMNS: [ColumnSpec; 11] = [
    ColumnSpec {
        field: ImportField::CategoryBrand,
        label: "Brand",
        kind: ImportKind::Text,
        required: false,
        legacy: false,
        min: None,
        exclusive_min: false,
    },
    ColumnSpec {
        field: ImportField::CategoryCode,
        label: "Main product code",
        kind: ImportKind::Text,
        required: false,
        legacy: false,
        min: None,
        exclusive_min: false,
    },
    ColumnSpec {
        field: ImportField::CategoryName,
        label: "Main product",
        kind: ImportKind::Text,
        required: true,
        legacy: false,
        min: None,
        exclusive_min: false,
    },
    ColumnSpec {
        field: ImportField::Name,
        label: "Sub product",
        kind: ImportKind::Text,
        required: true,
        legacy: false,
        min: None,
        exclusive_min: false,
    },
    ColumnSpec {
        field: ImportField::Size,
        label: "Size",
        kind: ImportKind::Text,
        required: false,
        legacy: false,
        min: None,
        exclusive_min: false,
    },
    ColumnSpec {
        field: ImportField::ColourRule,
        label: "Colour rule",
        kind: ImportKind::Text,
        required: false,
        legacy: false,
        min: None,
        exclusive_min: false,
    },
    ColumnSpec {
        field: ImportField::Variant,
        label: "Colour",
        kind: ImportKind::Text,
        required: false,
        legacy: false,
        min: None,
        exclusive_min: false,
    },
    ColumnSpec {
        field: ImportField::Code,
        label: "Code",
        kind: ImportKind::Text,
        required: true,
        legacy: false,
        min: None,
        exclusive_min: false,
    },
    ColumnSpec {
        field: ImportField::WeightKg,
        label: "Weight (kg)",
        kind: ImportKind::Number,
        required: false,
        legacy: false,
        min: Some(0.0),
        exclusive_min: true,
    },
    ColumnSpec {
        field: ImportField::Alias,
        label: "Alias",
        kind: ImportKind::Text,
        required: false,
        legacy: false,
        min: None,
        exclusive_min: false,
    },
    ColumnSpec {
        field: ImportField::MultiColour,
        label: "Multicolour",
        kind: ImportKind::Boolean,
        required: false,
        legacy: true,
        min: None,
        exclusive_min: false,
    },
];

fn column_spec(field: ImportField) -> &'static ColumnSpec {
    IMPORT_COLUMNS
        .iter()
        .find(|column| column.field == field)
        .expect("every ImportField has a column")
}

/// The field a header cell names: the field key itself, the form's own
/// labels, and the trade shorthand — keyed by `normalize_header` form.
/// Mirrors `HEADER_ALIASES` exactly.
fn lookup_field(normalized: &str) -> Option<ImportField> {
    match normalized {
        "categoryname" | "category" | "mainproduct" | "mainproductname" => {
            Some(ImportField::CategoryName)
        }
        "categorycode" | "maincode" | "mainproductcode" => Some(ImportField::CategoryCode),
        "categorybrand" | "brand" | "brandname" | "make" => Some(ImportField::CategoryBrand),
        "name" | "productname" | "product" | "model" | "modelname" | "item" | "itemname"
        | "subproduct" | "subproductname" => Some(ImportField::Name),
        "variant" | "colour" | "color" | "variantname" | "colourvariant" | "shade" | "pattern"
        | "label" => Some(ImportField::Variant),
        "code" | "productcode" | "variantcode" | "sku" | "itemcode" | "articlecode" | "article" => {
            Some(ImportField::Code)
        }
        "weightkg" | "weight" | "weightkgs" | "kg" | "kgs" => Some(ImportField::WeightKg),
        "alias" | "shortname" | "nickname" => Some(ImportField::Alias),
        "size" | "dimensions" => Some(ImportField::Size),
        "colourrule" | "colorrule" | "rule" => Some(ImportField::ColourRule),
        "multicolour" | "multicolor" | "allcolours" | "allcolors" | "anycolour" | "anycolor" => {
            Some(ImportField::MultiColour)
        }
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderMatch {
    /// The column each header cell maps to, or `None` for one nothing knows.
    pub by_index: Vec<Option<ImportField>>,
    /// Header cells that matched nothing, or a field already claimed.
    pub ignored: Vec<String>,
    /// Required fields no header cell supplies.
    pub missing: Vec<ImportField>,
}

/// Mirrors `matchHeaders`, including the one pair where either will do: a
/// product named by its code needs no name column.
pub fn match_headers(header_row: &[&str]) -> HeaderMatch {
    let mut by_index = Vec::with_capacity(header_row.len());
    let mut ignored = Vec::new();
    let mut claimed: Vec<ImportField> = Vec::new();

    for cell in header_row {
        let text = js_trim(cell);
        let field = lookup_field(&normalize_header(text)).filter(|field| !claimed.contains(field));
        match field {
            Some(field) => {
                claimed.push(field);
                by_index.push(Some(field));
            }
            None => {
                by_index.push(None);
                if !text.is_empty() {
                    ignored.push(text.to_string());
                }
            }
        }
    }

    let supplied = |field: ImportField| {
        claimed.contains(&field)
            || (field == ImportField::CategoryName && claimed.contains(&ImportField::CategoryCode))
    };
    let missing: Vec<ImportField> = IMPORT_COLUMNS
        .iter()
        .filter(|column| column.required && !supplied(column.field))
        .map(|column| column.field)
        .collect();

    HeaderMatch {
        by_index,
        ignored,
        missing,
    }
}

// ---------------------------------------------------------------------------
// One row (`product-import.ts`: `parseImportRow`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportIssueKind {
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueParams {
    pub column: String,
    pub allowed: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportIssue {
    /// The spreadsheet row, as the person sees it in Excel: the header is row 1.
    pub row: u32,
    pub kind: ImportIssueKind,
    /// The header text exactly as written in the file, when one column is to blame.
    pub column: Option<String>,
    pub message_key: &'static str,
    pub params: Option<IssueParams>,
}

/// Product-level fields. `size`/`alias` are doubly optional: `None` leaves the
/// key out, `Some(None)` is a restore clearing the value to null, and
/// `Some(Some(_))` is a value — the twin's absent-key vs null distinction.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportProduct {
    pub category_brand: Option<String>,
    pub category_code: Option<String>,
    pub category_name: Option<String>,
    pub name: Option<String>,
    pub size: Option<Option<String>>,
    pub alias: Option<Option<String>>,
    pub multi_colour: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImportVariant {
    pub code: String,
    pub label: Option<String>,
    pub weight_kg: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImportRow {
    pub product: ImportProduct,
    pub variant: ImportVariant,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedImportRow {
    pub input: Option<ImportRow>,
    pub issues: Vec<ImportIssue>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ParseOptions {
    pub restore: bool,
    pub update_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColourRule {
    Fixed,
    Dedicated,
    MultiColour,
}

/// What the Colour rule column accepts, by `normalize_header` form; the stored
/// name is the variant returned. Mirrors `COLOUR_RULES`.
fn lookup_colour_rule(normalized: &str) -> Option<ColourRule> {
    match normalized {
        "fixed" => Some(ColourRule::Fixed),
        "dedicated" => Some(ColourRule::Dedicated),
        "multicolour" | "multicolor" | "selectable" => Some(ColourRule::MultiColour),
        _ => None,
    }
}

/// Sheets say "yes", "Y", "true", "1", "no", "N", "false", "0".
/// Mirrors `BOOLEAN_WORDS`.
fn lookup_boolean_word(word: &str) -> Option<bool> {
    match word {
        "yes" | "y" | "true" | "1" => Some(true),
        "no" | "n" | "false" | "0" => Some(false),
        _ => None,
    }
}

fn is_variant_field(field: ImportField) -> bool {
    matches!(
        field,
        ImportField::Variant | ImportField::Code | ImportField::WeightKg | ImportField::ColourRule
    )
}

#[allow(clippy::too_many_arguments)]
fn push_issue(
    issues: &mut Vec<ImportIssue>,
    row: u32,
    header_row: &[&str],
    index: Option<usize>,
    field: ImportField,
    message_key: &'static str,
    params: Option<IssueParams>,
) {
    // `(headerRow[index] ?? field ?? '').trim()`: a blank header cell leaves
    // the column out, while a missing column falls back to the field key.
    let cell = index
        .and_then(|at| header_row.get(at))
        .copied()
        .unwrap_or("");
    let trimmed = js_trim(cell);
    let column = if trimmed.is_empty() {
        if index.is_some() {
            None
        } else {
            Some(field_key(field).to_string())
        }
    } else {
        Some(trimmed.to_string())
    };
    issues.push(ImportIssue {
        row,
        kind: ImportIssueKind::Error,
        column,
        message_key,
        params,
    });
}

/// One row → one `ImportRow`, or the issues that stop it. Mirrors
/// `parseImportRow`: every column is checked rather than stopping at the
/// first problem, a blank Alias/Size cell on a restore clears the value to
/// null (never on an update-only file), and the colour rule decides what the
/// Colour cell means (a dedicated sub product carries none).
pub fn parse_import_row(
    cells: &[&str],
    matched: &HeaderMatch,
    header_row: &[&str],
    row: u32,
    options: ParseOptions,
) -> ParsedImportRow {
    let mut issues: Vec<ImportIssue> = Vec::new();
    let mut product = ImportProduct::default();
    let mut code: Option<String> = None;
    let mut colour: Option<String> = None;
    let mut weight_kg: Option<f64> = None;
    let mut colour_rule_text: Option<String> = None;

    for (index, slot) in matched.by_index.iter().enumerate() {
        let Some(field) = slot else { continue };
        let spec = column_spec(*field);
        let raw = js_trim(cells.get(index).copied().unwrap_or(""));
        if raw.is_empty() {
            if options.restore
                && !options.update_only
                && (*field == ImportField::Alias || *field == ImportField::Size)
            {
                if *field == ImportField::Alias {
                    product.alias = Some(None);
                } else {
                    product.size = Some(None);
                }
            }
            continue;
        }

        // `(headerRow[index] ?? field).trim() || field`, for issue params.
        let header_text = {
            let header = js_trim(header_row.get(index).copied().unwrap_or(""));
            if header.is_empty() {
                field_key(*field).to_string()
            } else {
                header.to_string()
            }
        };

        match spec.kind {
            ImportKind::Text => {
                // Inner runs of whitespace would otherwise make "ONE  PIECE" a
                // different product from "ONE PIECE"; a code is left as typed,
                // and so is a restore's cell.
                let value = if *field == ImportField::Code || options.restore {
                    raw.to_string()
                } else {
                    raw.split(is_js_space)
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join(" ")
                };
                if is_variant_field(*field) {
                    match field {
                        ImportField::Variant => colour = Some(value),
                        ImportField::Code => code = Some(value),
                        ImportField::ColourRule => colour_rule_text = Some(value),
                        _ => {}
                    }
                } else {
                    match field {
                        ImportField::CategoryBrand => product.category_brand = Some(value),
                        ImportField::CategoryCode => product.category_code = Some(value),
                        ImportField::CategoryName => product.category_name = Some(value),
                        ImportField::Name => product.name = Some(value),
                        ImportField::Size => product.size = Some(Some(value)),
                        ImportField::Alias => product.alias = Some(Some(value)),
                        _ => {}
                    }
                }
            }
            ImportKind::Boolean => match lookup_boolean_word(&raw.to_lowercase()) {
                Some(flag) => {
                    if *field == ImportField::MultiColour {
                        product.multi_colour = Some(flag);
                    }
                }
                None => push_issue(
                    &mut issues,
                    row,
                    header_row,
                    Some(index),
                    *field,
                    "validation.import.invalidValue",
                    Some(IssueParams {
                        column: header_text,
                        allowed: Some("yes, no"),
                    }),
                ),
            },
            ImportKind::Number => match parse_number(raw) {
                Some(value) if value.is_finite() => {
                    let below_min = match spec.min {
                        Some(min) => {
                            if spec.exclusive_min {
                                value <= min
                            } else {
                                value < min
                            }
                        }
                        None => false,
                    };
                    if below_min {
                        push_issue(
                            &mut issues,
                            row,
                            header_row,
                            Some(index),
                            *field,
                            "validation.product.weightPositive",
                            None,
                        );
                    } else if *field == ImportField::WeightKg {
                        weight_kg = Some(value);
                    }
                }
                _ => push_issue(
                    &mut issues,
                    row,
                    header_row,
                    Some(index),
                    *field,
                    "validation.import.notANumber",
                    Some(IssueParams {
                        column: header_text,
                        allowed: None,
                    }),
                ),
            },
        }
    }

    let position = |field: ImportField| {
        matched
            .by_index
            .iter()
            .position(|slot| *slot == Some(field))
    };
    let named = |value: &Option<String>| matches!(value, Some(text) if !text.is_empty());
    if !options.update_only && !named(&product.category_name) && !named(&product.category_code) {
        push_issue(
            &mut issues,
            row,
            header_row,
            position(ImportField::CategoryName),
            ImportField::CategoryName,
            "validation.product.categoryRequired",
            None,
        );
    }
    if !options.update_only && !named(&product.name) {
        push_issue(
            &mut issues,
            row,
            header_row,
            position(ImportField::Name),
            ImportField::Name,
            "validation.product.nameRequired",
            None,
        );
    }
    if code.as_deref().unwrap_or("").is_empty() {
        push_issue(
            &mut issues,
            row,
            header_row,
            position(ImportField::Code),
            ImportField::Code,
            "validation.product.variantCodeRequired",
            None,
        );
    }

    let rule_text = colour_rule_text.as_deref().unwrap_or("").to_lowercase();
    let rule = if rule_text.is_empty() {
        None
    } else {
        lookup_colour_rule(&normalize_header(&rule_text))
    };
    if !rule_text.is_empty() && rule.is_none() {
        let at = position(ImportField::ColourRule);
        let header = js_trim(at.and_then(|i| header_row.get(i)).copied().unwrap_or(""));
        let header = if header.is_empty() {
            "colourRule"
        } else {
            header
        };
        push_issue(
            &mut issues,
            row,
            header_row,
            at,
            ImportField::ColourRule,
            "validation.import.invalidValue",
            Some(IssueParams {
                column: header.to_string(),
                allowed: Some("fixed, dedicated, multicolour"),
            }),
        );
    } else if rule == Some(ColourRule::Fixed) && colour.is_none() {
        push_issue(
            &mut issues,
            row,
            header_row,
            position(ImportField::Variant),
            ImportField::Variant,
            "validation.import.fixedNeedsColour",
            None,
        );
    }
    if let Some(applied) = rule {
        product.multi_colour = Some(applied == ColourRule::MultiColour);
    }

    let built = ImportRow {
        product,
        variant: ImportVariant {
            code: code.unwrap_or_default(),
            label: if rule == Some(ColourRule::Dedicated) {
                None
            } else {
                colour
            },
            weight_kg,
        },
    };

    if issues.is_empty() {
        ParsedImportRow {
            input: Some(built),
            issues,
        }
    } else {
        ParsedImportRow {
            input: None,
            issues,
        }
    }
}

// ---------------------------------------------------------------------------
// A prefix `tsquery` (`search-terms.ts`: `prefixTsQuery`)
// ---------------------------------------------------------------------------

/// A token character the way `/[^\p{L}\p{N}]/u` means it.
///
/// Edge: `char::is_alphabetic` is the Alphabetic derived property, a superset
/// of `\p{L}` (it adds the Other_Alphabetic marks, which are not Letters), and
/// `char::is_numeric` covers `\p{N}`; lone surrogates cannot occur in a `&str`
/// (the twin treats them as separators). Real picker tokens — words and codes
/// like `RST-300` — split identically either way.
fn is_query_token_char(ch: char) -> bool {
    ch.is_alphabetic() || ch.is_numeric()
}

/// A prefix `tsquery`: `gla ser` becomes `gla:* & ser:*`. Mirrors
/// `prefixTsQuery`, including the split on **any** run of non-alphanumerics
/// (so `RST-300` is the two prefixes `RST:* & 300:*`, matching what
/// `to_tsvector` indexes) and `None` for a term with nothing searchable in
/// it — the caller must treat that as "no text filter", not "no results".
pub fn prefix_ts_query(term: &str) -> Option<String> {
    let tokens: Vec<&str> = term
        .split(|ch| !is_query_token_char(ch))
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(
        tokens
            .iter()
            .map(|token| format!("{token}:*"))
            .collect::<Vec<_>>()
            .join(" & "),
    )
}

// ---------------------------------------------------------------------------
// A stored line (`line-items.ts`: `buildLineSnapshot`)
// ---------------------------------------------------------------------------

/// The catalogue values a line freezes from the product model.
#[derive(Debug, Clone, PartialEq)]
pub struct ProductSnapshotSource {
    pub id: String,
    pub name: String,
    pub category_name: Option<String>,
    pub category_code: Option<String>,
    pub brand: Option<String>,
    pub alias: Option<String>,
    pub size: Option<String>,
    pub multi_colour: bool,
}

/// The variant the line is for: where the code, the colour text and the
/// weight come from.
#[derive(Debug, Clone, PartialEq)]
pub struct ProductVariantSnapshotSource {
    pub id: String,
    pub code: String,
    pub label: Option<String>,
    pub weight_kg: Option<f64>,
}

/// A party's own version of the product, used when a lead is in party-wise mode.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PartyVariantSnapshotSource {
    pub alias: Option<String>,
    pub size: Option<String>,
    pub product_name: Option<String>,
}

/// What the client asserted about a line, before the server fills the gaps.
/// Only the fields `buildLineSnapshot` reads (the stored id is matched up by
/// `matchExistingLines`, which this port does not cover).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LineDraft {
    pub product_name: Option<String>,
    pub category_name: Option<String>,
    pub category_code: Option<String>,
    pub brand_name: Option<String>,
    pub alias: Option<String>,
    pub code: Option<String>,
    pub variant_label: Option<String>,
    pub colour: Option<String>,
    pub size: Option<String>,
    pub weight_kg: Option<f64>,
    pub packaging: Option<String>,
    pub grade: Option<String>,
    pub sequence: Option<f64>,
    pub from_party_variant: Option<bool>,
    pub image_path: Option<String>,
    pub notes: Option<String>,
    pub quantity: f64,
}

/// The part of a stored line an edit must carry over unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptLine {
    pub id: String,
    pub variant_id: String,
    pub colour: Option<String>,
    pub variant_label: Option<String>,
}

/// A line as it exists on a lead or an order, independent of storage.
#[derive(Debug, Clone, PartialEq)]
pub struct LineSnapshot {
    pub product_id: String,
    pub variant_id: String,
    pub product_name: String,
    pub category_name: Option<String>,
    pub category_code: Option<String>,
    pub brand_name: Option<String>,
    pub alias: Option<String>,
    pub code: Option<String>,
    pub variant_label: Option<String>,
    pub colour: Option<String>,
    pub size: Option<String>,
    pub weight_kg: Option<f64>,
    pub packaging: Option<String>,
    pub grade: Option<String>,
    pub sequence: f64,
    pub from_party_variant: bool,
    pub image_path: Option<String>,
    pub notes: Option<String>,
    pub quantity: f64,
}

/// A finite, non-negative number; anything else counts as nothing entered.
/// Mirrors `normaliseQuantity`.
///
/// Edge: the twin coerces via `Number()`, so `'12'` reads `12` there; at this
/// typed boundary the quantity already arrives as a number and that coercion
/// lives with the caller.
pub fn normalise_quantity(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

/// Build the stored line from what the panel sent plus the catalogue. Mirrors
/// `buildLineSnapshot`: values the client supplied win (an offline panel's
/// snapshot is the spec the customer was quoted), the catalogue only fills
/// blanks; the code, the colour text and the weight come from the variant;
/// `packaging`, `grade` and `colour` are never filled from any source; a
/// colour is kept only on a `multiColour` product and dropped anywhere else;
/// a `kept` line keeps its stored colour and colour text whatever the product
/// is today.
pub fn build_line_snapshot(
    draft: &LineDraft,
    product: &ProductSnapshotSource,
    variant: &ProductVariantSnapshotSource,
    party_variant: Option<&PartyVariantSnapshotSource>,
    sequence: f64,
    kept: Option<&KeptLine>,
) -> LineSnapshot {
    let from_party_variant = draft.from_party_variant.unwrap_or(party_variant.is_some());
    let carried = kept.is_some() && !product.multi_colour;
    let colour = if carried {
        kept.and_then(|line| line.colour.clone())
    } else if product.multi_colour {
        draft
            .colour
            .as_deref()
            .map(js_trim)
            .filter(|colour| !colour.is_empty())
            .map(str::to_string)
    } else {
        None
    };

    LineSnapshot {
        product_id: product.id.clone(),
        variant_id: variant.id.clone(),
        product_name: draft
            .product_name
            .clone()
            .or_else(|| party_variant.and_then(|party| party.product_name.clone()))
            .unwrap_or_else(|| product.name.clone()),
        category_name: draft
            .category_name
            .clone()
            .or_else(|| product.category_name.clone()),
        category_code: draft
            .category_code
            .clone()
            .or_else(|| product.category_code.clone()),
        brand_name: draft.brand_name.clone().or_else(|| product.brand.clone()),
        alias: draft
            .alias
            .clone()
            .or_else(|| party_variant.and_then(|party| party.alias.clone()))
            .or_else(|| product.alias.clone()),
        code: draft.code.clone().or_else(|| Some(variant.code.clone())),
        variant_label: if carried {
            kept.and_then(|line| line.variant_label.clone())
        } else {
            draft
                .variant_label
                .clone()
                .or_else(|| variant.label.clone())
        },
        colour,
        size: draft
            .size
            .clone()
            .or_else(|| party_variant.and_then(|party| party.size.clone()))
            .or_else(|| product.size.clone()),
        weight_kg: draft.weight_kg.or(variant.weight_kg),
        packaging: draft.packaging.clone(),
        grade: draft
            .grade
            .as_deref()
            .map(js_trim)
            .filter(|grade| !grade.is_empty())
            .map(str::to_string),
        sequence: draft.sequence.unwrap_or(sequence),
        from_party_variant,
        image_path: draft.image_path.clone(),
        notes: draft.notes.clone(),
        quantity: normalise_quantity(draft.quantity),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- headers (`product-import-domain.test.ts`: "header matching") ---

    #[test]
    fn headers_normalise_case_spaces_and_punctuation() {
        assert_eq!(normalize_header("Product Code"), "productcode");
        assert_eq!(normalize_header("product_code"), "productcode");
        assert_eq!(normalize_header("Weight (kg)"), "weightkg");
        assert_eq!(normalize_header("Colour / variant"), "colourvariant");
    }

    #[test]
    fn headers_map_field_keys_labels_and_shorthand_to_the_same_fields() {
        let matched = match_headers(&[
            "Category",
            "Model",
            "Colour",
            "SKU",
            "Weight (kg)",
            "Dimensions",
            "All colours",
        ]);
        let fields: Vec<Option<ImportField>> = matched.by_index;
        assert_eq!(
            fields,
            vec![
                Some(ImportField::CategoryName),
                Some(ImportField::Name),
                Some(ImportField::Variant),
                Some(ImportField::Code),
                Some(ImportField::WeightKg),
                Some(ImportField::Size),
                Some(ImportField::MultiColour),
            ]
        );
    }

    #[test]
    fn headers_report_unknown_and_second_claims_as_ignored() {
        let matched = match_headers(&[
            "categoryName",
            "name",
            "code",
            "Supplier ref",
            "Product name",
        ]);
        assert_eq!(
            matched.by_index,
            vec![
                Some(ImportField::CategoryName),
                Some(ImportField::Name),
                Some(ImportField::Code),
                None,
                None,
            ]
        );
        assert_eq!(
            matched.ignored,
            vec!["Supplier ref".to_string(), "Product name".to_string()]
        );
    }

    #[test]
    fn headers_name_the_required_columns_a_file_lacks() {
        assert_eq!(
            match_headers(&["code", "size"]).missing,
            vec![ImportField::CategoryName, ImportField::Name]
        );
        assert_eq!(
            match_headers(&["categoryName", "name"]).missing,
            vec![ImportField::Code]
        );
        // A product named by its code needs no name column.
        assert_eq!(
            match_headers(&["categoryCode", "name", "code"]).missing,
            Vec::<ImportField>::new()
        );
        assert_eq!(
            match_headers(&["categoryBrand", "name", "code"]).missing,
            vec![ImportField::CategoryName]
        );
    }

    // --- one row (`product-import-domain.test.ts`: "parsing one row") ---

    fn parse(headers: &[&str], cells: &[&str]) -> ParsedImportRow {
        let matched = match_headers(headers);
        parse_import_row(cells, &matched, headers, 2, ParseOptions::default())
    }

    #[test]
    fn row_splits_into_model_and_variant_keeping_codes_as_text() {
        let headers = [
            "categoryName",
            "name",
            "code",
            "variant",
            "weightKg",
            "size",
            "multiColour",
            "alias",
        ];
        let parsed = parse(
            &headers,
            &[
                "ONE PIECE BASIN",
                "DAMRU",
                "00041",
                "Vitrosa 41",
                "18.5 kg",
                "L-16 H-31",
                "yes",
                "",
            ],
        );
        assert_eq!(parsed.issues, vec![]);
        assert_eq!(
            parsed.input,
            Some(ImportRow {
                product: ImportProduct {
                    category_name: Some("ONE PIECE BASIN".to_string()),
                    name: Some("DAMRU".to_string()),
                    size: Some(Some("L-16 H-31".to_string())),
                    multi_colour: Some(true),
                    ..ImportProduct::default()
                },
                variant: ImportVariant {
                    code: "00041".to_string(),
                    label: Some("Vitrosa 41".to_string()),
                    weight_kg: Some(18.5),
                },
            })
        );
    }

    #[test]
    fn row_leaves_a_blank_variant_and_weight_as_null() {
        let parsed = parse(
            &["categoryName", "name", "code", "variant", "weightKg"],
            &["Urinals", "Hexa", "HEXA", "", ""],
        );
        assert_eq!(
            parsed.input.map(|row| row.variant),
            Some(ImportVariant {
                code: "HEXA".to_string(),
                label: None,
                weight_kg: None
            })
        );
    }

    #[test]
    fn row_reads_the_colour_switch_in_the_words_a_sheet_uses() {
        for word in ["yes", "Y", "TRUE", "1"] {
            let parsed = parse(
                &["categoryName", "name", "code", "multiColour"],
                &["Pans", "Orissa", "OP-20", word],
            );
            assert_eq!(
                parsed.input.unwrap().product.multi_colour,
                Some(true),
                "{word}"
            );
        }
        for word in ["no", "n", "false", "0"] {
            let parsed = parse(
                &["categoryName", "name", "code", "multiColour"],
                &["Pans", "Orissa", "OP-20", word],
            );
            assert_eq!(
                parsed.input.unwrap().product.multi_colour,
                Some(false),
                "{word}"
            );
        }
    }

    #[test]
    fn row_names_the_column_and_allowed_values_for_an_unknown_switch_word() {
        let parsed = parse(
            &["categoryName", "name", "code", "All colours"],
            &["Pans", "Orissa", "OP-20", "maybe"],
        );
        assert_eq!(parsed.input, None);
        assert_eq!(
            parsed.issues,
            vec![ImportIssue {
                row: 2,
                kind: ImportIssueKind::Error,
                column: Some("All colours".to_string()),
                message_key: "validation.import.invalidValue",
                params: Some(IssueParams {
                    column: "All colours".to_string(),
                    allowed: Some("yes, no")
                }),
            }]
        );
    }

    #[test]
    fn row_reports_every_bad_cell_not_just_the_first() {
        let headers = ["categoryName", "name", "code", "weightKg", "multiColour"];
        let matched = match_headers(&headers);
        let parsed = parse_import_row(
            &["Pans", "Orissa", "OP-20", "0", "sometimes"],
            &matched,
            &headers,
            9,
            ParseOptions::default(),
        );
        assert_eq!(
            parsed
                .issues
                .iter()
                .map(|issue| (issue.row, issue.column.clone(), issue.message_key))
                .collect::<Vec<_>>(),
            vec![
                (
                    9,
                    Some("weightKg".to_string()),
                    "validation.product.weightPositive"
                ),
                (
                    9,
                    Some("multiColour".to_string()),
                    "validation.import.invalidValue"
                ),
            ]
        );
    }

    #[test]
    fn row_refuses_a_weight_that_is_not_a_number() {
        let parsed = parse(
            &["categoryName", "name", "code", "weightKg"],
            &["Pans", "Orissa", "OP-20", "twelve"],
        );
        assert_eq!(
            parsed
                .issues
                .iter()
                .map(|issue| (issue.column.clone(), issue.message_key))
                .collect::<Vec<_>>(),
            vec![(Some("weightKg".to_string()), "validation.import.notANumber")]
        );
    }

    #[test]
    fn row_reads_decimal_comma_weights_like_the_twin() {
        for (cell, want) in [
            ("12,5", 12.5),
            ("0,125", 0.125),
            ("1.234,5", 1234.5),
            ("1,200.50", 1200.5),
        ] {
            let parsed = parse(
                &["categoryName", "name", "code", "weightKg"],
                &["Pans", "Orissa", "OP-20", cell],
            );
            assert_eq!(
                parsed.input.unwrap().variant.weight_kg,
                Some(want),
                "{cell}"
            );
        }
    }

    #[test]
    fn row_requires_a_category_a_model_name_and_a_code() {
        assert_eq!(
            parse(
                &["categoryName", "name", "code"],
                &["   ", "Orissa", "OP-20"]
            )
            .issues
            .iter()
            .map(|issue| issue.message_key)
            .collect::<Vec<_>>(),
            vec!["validation.product.categoryRequired"]
        );
        assert_eq!(
            parse(&["categoryName", "name", "code"], &["Pans", "   ", "OP-20"])
                .issues
                .iter()
                .map(|issue| issue.message_key)
                .collect::<Vec<_>>(),
            vec!["validation.product.nameRequired"]
        );
        let parsed = parse(&["categoryName", "name", "code"], &["Pans", "Orissa", ""]);
        assert_eq!(
            parsed.issues,
            vec![ImportIssue {
                row: 2,
                kind: ImportIssueKind::Error,
                column: Some("code".to_string()),
                message_key: "validation.product.variantCodeRequired",
                params: None,
            }]
        );
    }

    #[test]
    fn row_applies_the_colour_rule_fixed_dedicated_or_multicolour() {
        let headers = [
            "Main product",
            "Sub product",
            "Code",
            "Colour rule",
            "Colour",
        ];
        let fixed = parse(&headers, &["Basins", "Damru", "D-1", "fixed", "White"])
            .input
            .unwrap();
        assert_eq!(fixed.variant.label, Some("White".to_string()));
        assert_eq!(fixed.product.multi_colour, Some(false));

        let dedicated = parse(&headers, &["Basins", "1111", "D-2", "dedicated", "White"])
            .input
            .unwrap();
        assert_eq!(dedicated.variant.label, None);

        let multi = parse(&headers, &["Pans", "Orissa", "P-1", "Multicolour", ""])
            .input
            .unwrap();
        assert_eq!(multi.product.multi_colour, Some(true));
        assert_eq!(multi.variant.label, None);

        assert_eq!(
            parse(&headers, &["Basins", "Damru", "D-3", "fixed", ""])
                .issues
                .iter()
                .map(|issue| issue.message_key)
                .collect::<Vec<_>>(),
            vec!["validation.import.fixedNeedsColour"]
        );
        assert_eq!(
            parse(&headers, &["Basins", "Damru", "D-4", "odd", ""])
                .issues
                .iter()
                .map(|issue| issue.message_key)
                .collect::<Vec<_>>(),
            vec!["validation.import.invalidValue"]
        );
    }

    #[test]
    fn restore_keeps_inner_spacing_and_clears_blank_alias_and_size() {
        let headers = [
            "Brand",
            "Main product",
            "Sub product",
            "Size",
            "Colour rule",
            "Colour",
            "Code",
            "Weight (kg)",
            "Alias",
        ];
        let matched = match_headers(&headers);
        let options = ParseOptions {
            restore: true,
            update_only: false,
        };
        let parsed = parse_import_row(
            &[
                " Swis  ware ",
                "WALL  HUNG",
                "ROYAL SET",
                "L-27  B-15",
                "fixed",
                "Off  White",
                "R-1",
                "",
                "",
            ],
            &matched,
            &headers,
            2,
            options,
        );
        let input = parsed.input.unwrap();
        assert_eq!(input.product.category_brand, Some("Swis  ware".to_string()));
        assert_eq!(input.product.category_name, Some("WALL  HUNG".to_string()));
        assert_eq!(input.product.size, Some(None));
        assert_eq!(input.product.alias, Some(None));
        assert_eq!(input.variant.label, Some("Off  White".to_string()));
    }

    // --- prefix tsquery (no TS test file; vectors from the doc contract) ---

    #[test]
    fn prefix_query_joins_prefix_tokens_with_and() {
        assert_eq!(
            prefix_ts_query("gla ser"),
            Some("gla:* & ser:*".to_string())
        );
        assert_eq!(
            prefix_ts_query("  gla   ser  "),
            Some("gla:* & ser:*".to_string())
        );
    }

    #[test]
    fn prefix_query_splits_codes_on_punctuation_like_the_tsvector() {
        assert_eq!(
            prefix_ts_query("RST-300"),
            Some("RST:* & 300:*".to_string())
        );
        assert_eq!(
            prefix_ts_query("600x600_MATT"),
            Some("600x600:* & MATT:*".to_string())
        );
    }

    #[test]
    fn prefix_query_returns_none_when_nothing_is_searchable() {
        assert_eq!(prefix_ts_query(""), None);
        assert_eq!(prefix_ts_query("   "), None);
        assert_eq!(prefix_ts_query("!!!"), None);
    }

    #[test]
    fn prefix_query_keeps_case_and_unicode_letters() {
        assert_eq!(prefix_ts_query("Glazed"), Some("Glazed:*".to_string()));
        assert_eq!(
            prefix_ts_query("café 300"),
            Some("café:* & 300:*".to_string())
        );
    }

    // --- lines (`line-items-domain.test.ts`) ---

    fn product() -> ProductSnapshotSource {
        ProductSnapshotSource {
            id: "PR0000000001".to_string(),
            name: "Pedestal standard".to_string(),
            category_name: Some("One Piece Toilet".to_string()),
            category_code: Some("OPT".to_string()),
            brand: Some("Swisware+".to_string()),
            alias: None,
            size: None,
            multi_colour: false,
        }
    }

    fn white() -> ProductVariantSnapshotSource {
        ProductVariantSnapshotSource {
            id: "VR0000000001".to_string(),
            code: "201".to_string(),
            label: Some("White".to_string()),
            weight_kg: Some(12.5),
        }
    }

    fn party() -> PartyVariantSnapshotSource {
        PartyVariantSnapshotSource {
            alias: Some("Ped std".to_string()),
            size: Some("22x17".to_string()),
            product_name: Some("Pedestal (Ganesh)".to_string()),
        }
    }

    fn draft(quantity: f64) -> LineDraft {
        LineDraft {
            quantity,
            ..LineDraft::default()
        }
    }

    #[test]
    fn line_freezes_the_variants_code_label_and_weight() {
        let line = build_line_snapshot(&draft(4.0), &product(), &white(), None, 1.0, None);
        assert_eq!(line.variant_id, "VR0000000001");
        assert_eq!(line.code, Some("201".to_string()));
        assert_eq!(line.variant_label, Some("White".to_string()));
        assert_eq!(line.weight_kg, Some(12.5));
        assert_eq!(line.quantity, 4.0);
    }

    #[test]
    fn line_takes_the_partys_own_name_alias_and_size_when_party_wise() {
        let line =
            build_line_snapshot(&draft(4.0), &product(), &white(), Some(&party()), 1.0, None);
        assert_eq!(line.product_name, "Pedestal (Ganesh)");
        assert_eq!(line.alias, Some("Ped std".to_string()));
        assert_eq!(line.size, Some("22x17".to_string()));
        assert!(line.from_party_variant);
    }

    #[test]
    fn line_keeps_the_code_and_weight_an_offline_panel_already_froze() {
        let offline = LineDraft {
            code: Some("201-OLD".to_string()),
            weight_kg: Some(11.0),
            quantity: 4.0,
            ..LineDraft::default()
        };
        let line = build_line_snapshot(&offline, &product(), &white(), None, 1.0, None);
        assert_eq!(line.code, Some("201-OLD".to_string()));
        assert_eq!(line.weight_kg, Some(11.0));
    }

    #[test]
    fn line_colour_is_null_unless_the_panel_chose_one_on_a_multicolour_product() {
        let multi = ProductSnapshotSource {
            multi_colour: true,
            ..product()
        };
        assert_eq!(
            build_line_snapshot(&draft(4.0), &multi, &white(), None, 1.0, None).colour,
            None
        );
        let blank = LineDraft {
            colour: Some("   ".to_string()),
            quantity: 4.0,
            ..LineDraft::default()
        };
        assert_eq!(
            build_line_snapshot(&blank, &multi, &white(), None, 1.0, None).colour,
            None
        );

        let ivory = LineDraft {
            colour: Some(" Ivory ".to_string()),
            quantity: 4.0,
            ..LineDraft::default()
        };
        let line = build_line_snapshot(&ivory, &multi, &white(), None, 1.0, None);
        assert_eq!(line.colour, Some("Ivory".to_string()));
        assert_eq!(line.variant_label, Some("White".to_string()));
    }

    #[test]
    fn line_drops_a_colour_on_a_product_not_made_in_colours_but_keeps_the_rest() {
        let chosen = LineDraft {
            colour: Some("Ivory".to_string()),
            quantity: 4.0,
            ..LineDraft::default()
        };
        let line = build_line_snapshot(&chosen, &product(), &white(), None, 1.0, None);
        assert_eq!(line.colour, None);
        assert_eq!(line.variant_label, Some("White".to_string()));
        assert_eq!(line.quantity, 4.0);
    }

    #[test]
    fn line_edit_keeps_the_stored_colour_and_label_when_the_product_is_no_longer_multicolour() {
        let stored = KeptLine {
            id: "LI0000000001".to_string(),
            variant_id: "VR0000000001".to_string(),
            colour: Some("Ivory".to_string()),
            variant_label: None,
        };
        let resent = LineDraft {
            colour: Some("Ivory".to_string()),
            variant_label: None,
            quantity: 4.0,
            ..LineDraft::default()
        };
        let line = build_line_snapshot(&resent, &product(), &white(), None, 1.0, Some(&stored));
        assert_eq!(line.colour, Some("Ivory".to_string()));
        assert_eq!(line.variant_label, None);

        // The same resent line without a stored past is new: the colour drops.
        let fresh = build_line_snapshot(&resent, &product(), &white(), None, 1.0, None);
        assert_eq!(fresh.colour, None);
        assert_eq!(fresh.variant_label, Some("White".to_string()));
    }

    #[test]
    fn line_freezes_brand_and_code_from_the_category_and_keeps_offline_values() {
        let line = build_line_snapshot(&draft(4.0), &product(), &white(), None, 1.0, None);
        assert_eq!(line.category_name, Some("One Piece Toilet".to_string()));
        assert_eq!(line.category_code, Some("OPT".to_string()));
        assert_eq!(line.brand_name, Some("Swisware+".to_string()));

        let offline = LineDraft {
            category_code: Some("OPT-OLD".to_string()),
            brand_name: Some("Swisware".to_string()),
            quantity: 4.0,
            ..LineDraft::default()
        };
        let frozen = build_line_snapshot(&offline, &product(), &white(), None, 1.0, None);
        assert_eq!(frozen.category_code, Some("OPT-OLD".to_string()));
        assert_eq!(frozen.brand_name, Some("Swisware".to_string()));
    }

    #[test]
    fn line_grade_is_only_ever_what_the_panel_sent() {
        assert_eq!(
            build_line_snapshot(&draft(4.0), &product(), &white(), Some(&party()), 1.0, None).grade,
            None
        );
        let blank = LineDraft {
            grade: Some("   ".to_string()),
            quantity: 4.0,
            ..LineDraft::default()
        };
        assert_eq!(
            build_line_snapshot(&blank, &product(), &white(), None, 1.0, None).grade,
            None
        );

        let graded = LineDraft {
            grade: Some(" A ".to_string()),
            quantity: 4.0,
            ..LineDraft::default()
        };
        assert_eq!(
            build_line_snapshot(&graded, &product(), &white(), None, 1.0, None).grade,
            Some("A".to_string())
        );
    }

    #[test]
    fn quantities_treat_blank_negative_or_unparsable_as_nothing_entered() {
        assert_eq!(normalise_quantity(0.0), 0.0);
        assert_eq!(normalise_quantity(-2.0), 0.0);
        assert_eq!(normalise_quantity(f64::NAN), 0.0);
        assert_eq!(normalise_quantity(f64::INFINITY), 0.0);
        assert_eq!(normalise_quantity(12.0), 12.0);
    }
}
