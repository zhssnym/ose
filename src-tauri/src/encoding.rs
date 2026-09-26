//! Text in any encoding (docs/HOST.md "Encodings", M52).
//!
//! A file that is not UTF-8 is detected, decoded, and saved back **in its own encoding**; nothing
//! is ever converted without being asked. Detection is conservative, in this order:
//!
//! 1. valid UTF-8 (with or without a byte-order mark) is UTF-8;
//! 2. a UTF-16 byte-order mark is UTF-16, little or big endian;
//! 3. a UTF-8 byte-order mark is UTF-8, whatever follows it;
//! 4. bytes that are mostly UTF-8 (at least one well-formed multibyte character, and no more
//!    malformed sequences than those, a character cut short at the very end not counted) are
//!    UTF-8: a UTF-8 note with one stray byte or a truncated tail is damaged UTF-8, not a
//!    windows-1252 file;
//! 5. anything else is what chardetng guesses.
//!
//! 3 and 4 decode with errors, so such a file is `lossy`: it opens read-only with the banner,
//! instead of as editable mojibake whose next keystroke would mix two encodings.
//!
//! The byte-order mark stays inside the text as U+FEFF, for every encoding, exactly as UTF-8 has
//! always kept it: the editor strips it and puts it back, and encoding U+FEFF gives the same mark
//! again. So a round trip of an untouched file is byte for byte, by construction.
//!
//! A decode is `lossy` when the bytes do not come back from encoding the text: a malformed
//! sequence, or a byte an encoding maps to a character it cannot map back. Such a file opens
//! read-only, and a save in its encoding is refused (`[lossy]`); converting it to UTF-8 is always
//! an explicit command. A character the target encoding cannot hold is `[unencodable]`, and
//! nothing is written.
//!
//! encoding_rs has no UTF-16 encoder (the Encoding Standard has none), so UTF-16 is encoded here.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

/// A decoded file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    /// Every character of the file; a byte-order mark is a leading U+FEFF.
    pub text: String,
    /// The encoding's name as the Encoding Standard spells it (`UTF-8`, `UTF-16LE`,
    /// `windows-1252`, `Shift_JIS`); every such name is also a label `encoding_for` takes.
    pub encoding: &'static str,
    /// The file starts with a byte-order mark.
    pub bom: bool,
    /// The text does not encode back to the same bytes: read-only.
    pub lossy: bool,
}

/// The encoding a label names (`utf-8`, `latin1`, `shift_jis`, `UTF-16LE`, …), or `[bad_arg]`.
pub fn encoding_for(label: &str) -> Result<&'static Encoding, String> {
    Encoding::for_label(label.trim().as_bytes())
        .ok_or_else(|| crate::coded("bad_arg", format!("not an encoding: {label}")))
}

/// Is `label` absent or UTF-8?
pub fn is_utf8(label: Option<&str>) -> bool {
    match label {
        None => true,
        Some(l) => encoding_for(l).map(|e| e == UTF_8).unwrap_or(false),
    }
}

/// The encoding of `bytes`, by the order of the module comment.
pub fn detect(bytes: &[u8]) -> &'static Encoding {
    if std::str::from_utf8(bytes).is_ok() {
        return UTF_8;
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return UTF_16LE;
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return UTF_16BE;
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) || mostly_utf8(bytes) {
        return UTF_8;
    }
    guess(bytes)
}

/// Rule 4: UTF-8 with a few malformed sequences. A malformed sequence is counted once however
/// many bytes it has; a character cut short by the end of the bytes is not counted. Bytes with
/// no well-formed multibyte character at all are left to chardetng, even when their only fault
/// is one last byte such as 0xE9: "caf" and that byte is far more likely windows-1252 "café"
/// than a UTF-8 character cut short.
fn mostly_utf8(bytes: &[u8]) -> bool {
    let (mut multibyte, mut bad) = (0usize, 0usize);
    let mut chunks = bytes.utf8_chunks().peekable();
    while let Some(chunk) = chunks.next() {
        multibyte += chunk.valid().chars().filter(|c| c.len_utf8() > 1).count();
        let invalid = chunk.invalid();
        if invalid.is_empty() {
            continue;
        }
        let last = chunks.peek().is_none();
        if !(last && cut_short(invalid)) {
            bad += 1;
        }
    }
    multibyte > 0 && bad <= multibyte
}

/// Is `tail` the start of a well-formed UTF-8 sequence that ran out of bytes: a lead byte and
/// only continuation bytes, fewer than the lead byte announces?
fn cut_short(tail: &[u8]) -> bool {
    let Some((&lead, rest)) = tail.split_first() else { return false };
    let want = match lead {
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => return false,
    };
    tail.len() < want && rest.iter().all(|b| (0x80..=0xBF).contains(b))
}

/// chardetng's guess, never UTF-8 (that was checked first, exactly).
fn guess(bytes: &[u8]) -> &'static Encoding {
    let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    det.feed(bytes, true);
    det.guess(None, chardetng::Utf8Detection::Deny)
}

/// `bytes` decoded, detected or in the encoding `forced` names. A forced decode that meets a
/// malformed sequence is `[not_utf8]` (the one error a read has for "not in that encoding"); a
/// detected one is `lossy` instead, and opens read-only.
pub fn decode(bytes: &[u8], forced: Option<&str>) -> Result<Decoded, String> {
    let enc = match forced {
        Some(label) => encoding_for(label)?,
        None => detect(bytes),
    };
    let (text, had_errors) = enc.decode_without_bom_handling(bytes);
    if had_errors && forced.is_some() {
        return Err(crate::coded("not_utf8", format!("not valid {}", enc.name())));
    }
    let text = text.into_owned();
    let lossy = had_errors || encode(&text, enc).map(|b| b != bytes).unwrap_or(true);
    Ok(Decoded { bom: text.starts_with('\u{feff}'), text, encoding: enc.name(), lossy })
}

/// `text` in `enc`. A character `enc` cannot hold is `[unencodable]`.
pub fn encode(text: &str, enc: &'static Encoding) -> Result<Vec<u8>, String> {
    if enc == UTF_8 {
        return Ok(text.as_bytes().to_vec());
    }
    if enc == UTF_16LE || enc == UTF_16BE {
        let le = enc == UTF_16LE;
        let mut out = Vec::with_capacity(text.len() * 2);
        for unit in text.encode_utf16() {
            let b = if le { unit.to_le_bytes() } else { unit.to_be_bytes() };
            out.extend_from_slice(&b);
        }
        return Ok(out);
    }
    // `encode` would answer UTF-8 for an encoding that has no encoder of its own (`replacement`),
    // which would be a silent conversion: refused instead.
    if enc.output_encoding() != enc {
        return Err(crate::coded("unencodable", format!("{} cannot be written", enc.name())));
    }
    let (bytes, _, had_errors) = enc.encode(text);
    if had_errors {
        let bad = text.chars().find(|c| {
            let mut buf = [0u8; 4];
            enc.encode(c.encode_utf8(&mut buf)).2
        });
        let what = bad.map(|c| format!("'{c}' (U+{:04X})", c as u32)).unwrap_or_else(|| "a character".into());
        return Err(crate::coded("unencodable", format!("{what} cannot be written in {}", enc.name())));
    }
    Ok(bytes.into_owned())
}

/// `text` in the encoding `label` names (UTF-8 when absent).
pub fn encode_as(text: &str, label: Option<&str>) -> Result<Vec<u8>, String> {
    match label {
        None => Ok(text.as_bytes().to_vec()),
        Some(l) => encode(text, encoding_for(l)?),
    }
}

/// Does the head of a file read as text, and in which encoding (`stat {sniff}`)? UTF-8 as before
/// (no NUL, valid, a character cut at the edge allowed); a UTF-16 mark; or a guess whose decode
/// round-trips and holds no control character but tab, line breaks, form feed and escape.
pub fn sniff(head: &[u8], full_head: bool) -> Option<&'static str> {
    if head.starts_with(&[0xFF, 0xFE]) {
        return Some(UTF_16LE.name());
    }
    if head.starts_with(&[0xFE, 0xFF]) {
        return Some(UTF_16BE.name());
    }
    if head.contains(&0) {
        return None;
    }
    match std::str::from_utf8(head) {
        Ok(_) => return Some(UTF_8.name()),
        // A character cut in two by the edge of the head does not count against the file.
        Err(e) if e.error_len().is_none() && full_head => return Some(UTF_8.name()),
        Err(_) => {}
    }
    // Damaged UTF-8 is UTF-8, as `detect` says: it opens read-only, not as mojibake.
    if head.starts_with(&[0xEF, 0xBB, 0xBF]) || mostly_utf8(head) {
        return Some(UTF_8.name());
    }
    let enc = guess(head);
    let (text, had_errors) = enc.decode_without_bom_handling(head);
    if had_errors || text.chars().any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r' | '\u{c}' | '\u{1b}')) {
        return None;
    }
    let back = encode(&text, enc).ok()?;
    (back == head).then_some(enc.name())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_comes_first_and_keeps_its_mark_inside_the_text() {
        let d = decode("\u{feff}# café\r\n".as_bytes(), None).unwrap();
        assert_eq!(d.encoding, "UTF-8");
        assert!(d.bom && !d.lossy);
        assert_eq!(d.text, "\u{feff}# café\r\n");
        let plain = decode(b"ascii only\n", None).unwrap();
        assert_eq!((plain.encoding, plain.bom, plain.lossy), ("UTF-8", false, false));
    }

    #[test]
    fn windows_1252_round_trips_byte_for_byte() {
        let bytes: Vec<u8> = b"Caf\xe9 cr\xe8me br\xfbl\xe9e \x80 5, na\xefve r\xe9sum\xe9 d\xe9j\xe0 vu\r\n".to_vec();
        let d = decode(&bytes, None).unwrap();
        assert_eq!(d.encoding, "windows-1252");
        assert!(!d.lossy && !d.bom);
        assert!(d.text.starts_with("Café crème"));
        assert!(d.text.contains('€'));
        assert_eq!(encode_as(&d.text, Some(d.encoding)).unwrap(), bytes);
        // One edit keeps every other byte.
        let edited = d.text.replacen("Café", "Thé", 1);
        let out = encode_as(&edited, Some("windows-1252")).unwrap();
        assert_eq!(&out[..4], b"Th\xe9 ");
        assert_eq!(&out[4..], &bytes[5..]);
    }

    #[test]
    fn utf16_with_a_mark_round_trips_both_ways() {
        let text = "\u{feff}# Notes\r\nœuvre — 日本\r\n";
        for (label, le) in [("UTF-16LE", true), ("UTF-16BE", false)] {
            let bytes: Vec<u8> = text
                .encode_utf16()
                .flat_map(|u| if le { u.to_le_bytes() } else { u.to_be_bytes() })
                .collect();
            let d = decode(&bytes, None).unwrap();
            assert_eq!(d.encoding, label);
            assert!(d.bom && !d.lossy);
            assert_eq!(d.text, text);
            assert_eq!(encode_as(&d.text, Some(label)).unwrap(), bytes);
            assert_eq!(sniff(&bytes, false), Some(label));
        }
    }

    #[test]
    fn shift_jis_round_trips() {
        let text = "日本語のテキストです。これはテストの文章で、エンコーディングの検出を確かめます。\r\n東京、大阪、京都。\r\n";
        let (bytes, _, errors) = encoding_rs::SHIFT_JIS.encode(text);
        assert!(!errors);
        let d = decode(&bytes, None).unwrap();
        assert_eq!(d.encoding, "Shift_JIS", "detected");
        assert!(!d.lossy);
        assert_eq!(d.text, text);
        assert_eq!(encode_as(&d.text, Some(d.encoding)).unwrap(), bytes.into_owned());
        // A forced decoding is taken as asked.
        let forced = decode(&encoding_rs::SHIFT_JIS.encode("テスト").0, Some("shift_jis")).unwrap();
        assert_eq!(forced.text, "テスト");
    }

    #[test]
    fn a_character_the_encoding_cannot_hold_is_unencodable() {
        let e = encode_as("price: 5 € and 日本", Some("windows-1252")).unwrap_err();
        assert!(e.starts_with("[unencodable]"), "{e}");
        assert!(e.contains("U+65E5"), "{e}");
        assert!(encode_as("€", Some("windows-1252")).is_ok());
        assert!(encode_as("x", Some("no-such-thing")).unwrap_err().starts_with("[bad_arg]"));
        // An encoding with no encoder of its own is never written as something else.
        assert!(encode_as("x", Some("replacement")).is_err() || encode_as("x", Some("iso-2022-kr")).is_err());
    }

    #[test]
    fn a_decode_that_does_not_round_trip_is_lossy() {
        // UTF-16LE with a mark and an unpaired surrogate: decodes with a replacement character.
        let bytes = [0xFF, 0xFE, b'a', 0, 0x00, 0xD8, b'b', 0];
        let d = decode(&bytes, None).unwrap();
        assert!(d.lossy, "{d:?}");
        // A forced decoding that meets a malformed sequence is an error, not a guess.
        assert!(decode(&[0xff, 0xfe, 0xfd], Some("utf-8")).unwrap_err().starts_with("[not_utf8]"));
    }

    /// A UTF-8 note with a stray byte, a truncated tail, or a mark and a bad byte is damaged
    /// UTF-8: read-only, never editable windows-1252 mojibake.
    #[test]
    fn damaged_utf8_is_lossy_utf8_not_a_guess() {
        let note = "Aujourd\u{2019}hui j\u{2019}ai r\u{e9}vis\u{e9} la le\u{e7}on, \u{e0} demain.\n";
        // One stray windows-1252 byte in the middle.
        let mut stray = note.as_bytes().to_vec();
        stray.splice(4..4, [0xE9u8]);
        let d = decode(&stray, None).unwrap();
        assert_eq!((d.encoding, d.lossy), ("UTF-8", true), "{d:?}");
        assert!(d.text.contains("r\u{e9}vis\u{e9}"), "the rest reads as UTF-8: {}", d.text);
        assert_eq!(sniff(&stray, false), Some("UTF-8"));
        // Cut in the middle of the last character.
        let mut cut = note.trim_end_matches(".\n").as_bytes().to_vec();
        cut.extend_from_slice(&"\u{e9}".as_bytes()[..1]);
        let d = decode(&cut, None).unwrap();
        assert_eq!((d.encoding, d.lossy), ("UTF-8", true), "{d:?}");
        // A UTF-8 mark and one bad byte, with nothing else multibyte.
        let marked = [&[0xEFu8, 0xBB, 0xBF][..], b"plain text \xff here\n"].concat();
        let d = decode(&marked, None).unwrap();
        assert_eq!((d.encoding, d.bom, d.lossy), ("UTF-8", true, true), "{d:?}");
        // A windows-1252 file with no multibyte UTF-8 in it is still windows-1252.
        let latin = b"Aujourd'hui j'ai r\xe9vis\xe9 la le\xe7on, \xe0 demain. Caf\xe9 cr\xe8me.\r\n";
        let d = decode(latin, None).unwrap();
        assert_eq!((d.encoding, d.lossy), ("windows-1252", false), "{d:?}");
        assert!(!cut_short(&[0xE9, b'x']) && cut_short(&[0xE2, 0x80]) && !cut_short(&[0xE2, 0x80, 0x99]));
    }

    #[test]
    fn sniffing_keeps_binary_out() {
        assert_eq!(sniff(b"plain text\n", false), Some("UTF-8"));
        assert_eq!(sniff(&[0x89, b'P', b'N', b'G', 0, 0, 1], false), None);
        assert_eq!(sniff(b"caf\xe9 au lait, cr\xe8me", false), Some("windows-1252"));
        assert_eq!(sniff(&[0x01, 0x02, 0x03, 0xe9, 0x04], false), None, "control characters are not text");
        assert!(is_utf8(None) && is_utf8(Some("utf8")) && !is_utf8(Some("latin1")));
    }
}
