//! Phase-2 parity vectors: the vectors the TypeScript suites pin, mirrored here
//! so a machine with a linker proves the Rust twins byte-identical.

use orderbook_core::{
    canonical_manifest_payload, detect_delimiter, matches_batch, matches_record, parse_csv,
    pick_batch,
};

fn rows(texts: &[&str]) -> Vec<Vec<String>> {
    vec![texts.iter().map(|cell| cell.to_string()).collect()]
}

#[test]
fn parse_csv_reads_plain_comma_sheets() {
    assert_eq!(parse_csv(""), Vec::<Vec<String>>::new());
    assert_eq!(
        parse_csv("a,b,c"),
        vec![vec!["a".to_string(), "b".to_string(), "c".to_string()]]
    );
    assert_eq!(
        parse_csv("  padded  ,x\r\n"),
        vec![vec!["padded".to_string(), "x".to_string()]]
    );
}

#[test]
fn parse_csv_detects_semicolon_sheets() {
    assert_eq!(detect_delimiter("a;b\r\nc;d"), ';');
    assert_eq!(detect_delimiter("a,b"), ',');
    assert_eq!(
        parse_csv("a;b\r\nc;d"),
        vec![
            vec!["a".to_string(), "b".to_string()],
            vec!["c".to_string(), "d".to_string()]
        ]
    );
}

#[test]
fn parse_csv_reads_quotes_and_guard_strips() {
    assert_eq!(
        parse_csv("\"a,b\",c"),
        vec![vec!["a,b".to_string(), "c".to_string()]]
    );
    assert_eq!(parse_csv("\"a\"\"b\""), vec![vec!["a\"b".to_string()]]);
    assert_eq!(
        parse_csv("\"line1\nline2\",x"),
        vec![vec!["line1\nline2".to_string(), "x".to_string()]]
    );
    assert_eq!(
        parse_csv("'=SUM(A1),x"),
        vec![vec!["=SUM(A1)".to_string(), "x".to_string()]]
    );
    assert_eq!(parse_csv("'hello"), rows(&["'hello"]));
}

#[test]
fn parse_csv_keeps_blank_lines_as_rows() {
    assert_eq!(
        parse_csv("a\n\nb\n"),
        vec![
            vec!["a".to_string()],
            vec!["".to_string()],
            vec!["b".to_string()]
        ]
    );
}

#[test]
fn parse_csv_round_trips_through_the_fuzz_corpus_shape() {
    // Quoted fields holding the delimiter, quotes and breaks at once.
    assert_eq!(
        parse_csv("\"a,\"\"b\"\"\nc\",d"),
        vec![vec!["a,\"b\"\nc".to_string(), "d".to_string()]]
    );
}

#[test]
fn matches_batch_scores_every_row() {
    let haystacks = vec!["a b".to_string(), "c".to_string()];
    assert_eq!(matches_batch(&haystacks, "a"), vec![true, false]);
    assert_eq!(matches_batch(&haystacks, "  "), vec![true, true]);
    assert_eq!(matches_batch(&[], "a"), Vec::<bool>::new());
    assert!(matches_record("LD1 Home", "home ld1"));
}

#[test]
fn manifest_payload_orders_fields_and_lowercases_sha() {
    assert_eq!(
        canonical_manifest_payload(
            "master",
            "win",
            "1.5.4",
            "setup.exe",
            "123",
            "ABCDEF",
            "2026-10-26"
        ),
        "panel=master\nplatform=win\nversion=1.5.4\nfile=setup.exe\nsizeBytes=123\nsha256=abcdef\nreleasedAt=2026-10-26"
    );
}

#[test]
fn pick_batch_mirrors_single_scores() {
    assert_eq!(
        pick_batch(
            &[vec!["matt".to_string()], vec!["formatted".to_string()]],
            "matt"
        ),
        vec![4, 1]
    );
}
