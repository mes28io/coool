//! Translate crossterm key events into the bytes a terminal would send.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

pub fn is_detach(k: &KeyEvent) -> bool {
    k.modifiers.contains(KeyModifiers::CONTROL) && matches!(k.code, KeyCode::Char('\\') | KeyCode::Char('4'))
}

pub fn to_bytes(k: &KeyEvent) -> Vec<u8> {
    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let alt = k.modifiers.contains(KeyModifiers::ALT);
    let shift = k.modifiers.contains(KeyModifiers::SHIFT);
    // xterm modifier parameter for cursor / editing keys: 1 + shift + 2·alt + 4·ctrl.
    let m = 1 + shift as u8 + 2 * alt as u8 + 4 * ctrl as u8;
    let csi = |final_: char| -> Vec<u8> {
        if m == 1 { format!("\x1b[{final_}") } else { format!("\x1b[1;{m}{final_}") }.into_bytes()
    };
    let tilde = |n: u8| -> Vec<u8> {
        if m == 1 { format!("\x1b[{n}~") } else { format!("\x1b[{n};{m}~") }.into_bytes()
    };
    match k.code {
        KeyCode::Up => return csi('A'),
        KeyCode::Down => return csi('B'),
        KeyCode::Right => return csi('C'),
        KeyCode::Left => return csi('D'),
        KeyCode::Home => return csi('H'),
        KeyCode::End => return csi('F'),
        KeyCode::PageUp => return tilde(5),
        KeyCode::PageDown => return tilde(6),
        KeyCode::Delete => return tilde(3),
        KeyCode::Insert => return tilde(2),
        _ => {}
    }
    let mut out = Vec::new();
    // Alt is sent as an ESC prefix ("meta sends escape").
    if alt {
        out.push(0x1b);
    }
    match k.code {
        KeyCode::Char(c) if ctrl => {
            let b = match c {
                'a'..='z' => (c as u8) - b'a' + 1,
                'A'..='Z' => (c as u8) - b'A' + 1,
                '@' | ' ' | '2' => 0,
                '[' | '3' => 0x1b,
                // In legacy mode crossterm reports bytes 0x1c..=0x1f as ctrl+'4'..'7'.
                '\\' | '4' => 0x1c,
                ']' | '5' => 0x1d,
                '^' | '6' => 0x1e,
                '_' | '7' | '/' => 0x1f,
                '8' | '?' => 0x7f,
                _ => return out,
            };
            out.push(b);
        }
        KeyCode::Char(c) => {
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
        // Alt already contributed the ESC prefix above.
        KeyCode::Enter if shift && !alt => out.extend_from_slice(b"\x1b\r"),
        KeyCode::Enter => out.push(b'\r'),
        KeyCode::Backspace => out.push(0x7f),
        KeyCode::Tab => out.push(b'\t'),
        KeyCode::BackTab => out.extend_from_slice(b"\x1b[Z"),
        KeyCode::Esc => out.push(0x1b),
        KeyCode::F(n) => {
            let seq: &[u8] = match n {
                1 => b"\x1bOP",
                2 => b"\x1bOQ",
                3 => b"\x1bOR",
                4 => b"\x1bOS",
                5 => b"\x1b[15~",
                6 => b"\x1b[17~",
                7 => b"\x1b[18~",
                8 => b"\x1b[19~",
                9 => b"\x1b[20~",
                10 => b"\x1b[21~",
                11 => b"\x1b[23~",
                12 => b"\x1b[24~",
                _ => b"",
            };
            out.extend_from_slice(seq);
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode, m: KeyModifiers) -> Vec<u8> {
        to_bytes(&KeyEvent::new(code, m))
    }

    #[test]
    fn ctrl_digits_as_reported_by_crossterm_are_forwarded() {
        // crossterm turns 0x1d (ctrl+]) into ctrl+'5', etc.
        assert_eq!(key(KeyCode::Char('5'), KeyModifiers::CONTROL), vec![0x1d]);
        assert_eq!(key(KeyCode::Char('7'), KeyModifiers::CONTROL), vec![0x1f]);
        assert_eq!(key(KeyCode::Char(' '), KeyModifiers::CONTROL), vec![0]);
        assert_eq!(key(KeyCode::Char('c'), KeyModifiers::CONTROL), vec![3]);
    }

    #[test]
    fn alt_enter_has_a_single_escape() {
        assert_eq!(key(KeyCode::Enter, KeyModifiers::ALT), b"\x1b\r");
        assert_eq!(key(KeyCode::Enter, KeyModifiers::SHIFT), b"\x1b\r");
        assert_eq!(key(KeyCode::Enter, KeyModifiers::NONE), b"\r");
        assert_eq!(key(KeyCode::Char('x'), KeyModifiers::ALT), b"\x1bx");
    }

    #[test]
    fn modified_cursor_keys_use_xterm_parameters() {
        assert_eq!(key(KeyCode::Left, KeyModifiers::NONE), b"\x1b[D");
        assert_eq!(key(KeyCode::Left, KeyModifiers::ALT), b"\x1b[1;3D");
        assert_eq!(key(KeyCode::Right, KeyModifiers::CONTROL), b"\x1b[1;5C");
        assert_eq!(key(KeyCode::Delete, KeyModifiers::NONE), b"\x1b[3~");
        assert_eq!(key(KeyCode::PageUp, KeyModifiers::SHIFT), b"\x1b[5;2~");
    }

    #[test]
    fn detach_chord() {
        assert!(is_detach(&KeyEvent::new(KeyCode::Char('4'), KeyModifiers::CONTROL)));
        assert!(is_detach(&KeyEvent::new(KeyCode::Char('\\'), KeyModifiers::CONTROL)));
        assert!(!is_detach(&KeyEvent::new(KeyCode::Char('\\'), KeyModifiers::NONE)));
    }
}
