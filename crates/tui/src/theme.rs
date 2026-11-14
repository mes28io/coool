use ratatui::style::Color;
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Copy)]
pub struct Theme {
    pub dark: bool,
    pub bg: Color,
    pub panel: Color,
    pub fg: Color,
    pub dim: Color,
    pub border: Color,
    pub accent: Color,
    pub accent2: Color,
    pub busy: Color,
    pub err: Color,
    pub sel_bg: Color,
    pub claude: Color,
    pub codex: Color,
}

const fn rgb(hex: u32) -> Color {
    Color::Rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

impl Theme {
    pub const DARK: Theme = Theme {
        dark: true,
        bg: rgb(0x0e1014),
        panel: rgb(0x14171e),
        fg: rgb(0xe4e6eb),
        dim: rgb(0x767c8c),
        border: rgb(0x262b36),
        accent: rgb(0x7cf0c5),
        accent2: rgb(0xb48cff),
        busy: rgb(0xffcc66),
        err: rgb(0xff6b7a),
        sel_bg: rgb(0x1f2533),
        claude: rgb(0xe8956b),
        codex: rgb(0x8ab4ff),
    };

    pub const LIGHT: Theme = Theme {
        dark: false,
        bg: rgb(0xfafaf7),
        panel: rgb(0xf0f0ea),
        fg: rgb(0x1b1d22),
        dim: rgb(0x6b7080),
        border: rgb(0xd8d8d0),
        accent: rgb(0x0b8f6a),
        accent2: rgb(0x7a4fd6),
        busy: rgb(0xb7791f),
        err: rgb(0xc53030),
        sel_bg: rgb(0xe3e6ef),
        claude: rgb(0xc2602c),
        codex: rgb(0x2f6fd6),
    };

    pub fn toggled(self) -> Theme {
        if self.dark { Theme::LIGHT } else { Theme::DARK }
    }

    fn pref_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("coool").join("theme"))
    }

    /// CLI flag > COOOL_THEME env > saved preference > dark.
    pub fn load(flag: Option<bool>) -> Theme {
        let want_dark = flag
            .or_else(|| std::env::var("COOOL_THEME").ok().map(|v| v != "light"))
            .or_else(|| Self::pref_path().and_then(|p| fs::read_to_string(p).ok()).map(|v| v.trim() != "light"))
            .unwrap_or(true);
        if want_dark { Theme::DARK } else { Theme::LIGHT }
    }

    pub fn save(&self) {
        if let Some(p) = Self::pref_path() {
            let _ = fs::create_dir_all(p.parent().unwrap());
            let _ = fs::write(p, if self.dark { "dark" } else { "light" });
        }
    }
}
