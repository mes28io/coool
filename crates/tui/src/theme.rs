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
    pub working: Color,
    pub waiting: Color,
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
        bg: rgb(0x212121),
        panel: rgb(0x171717),
        fg: rgb(0xececec),
        dim: rgb(0x8e8e8e),
        border: rgb(0x383838),
        accent: rgb(0x28c840),
        accent2: rgb(0xb4b4b4),
        busy: rgb(0xfebc2e),
        working: rgb(0x28c840),
        waiting: rgb(0xfebc2e),
        err: rgb(0xff5f57),
        sel_bg: rgb(0x2f2f2f),
        claude: rgb(0xd97757),
        codex: rgb(0xececec),
    };

    pub const LIGHT: Theme = Theme {
        dark: false,
        bg: rgb(0xffffff),
        panel: rgb(0xf9f9f9),
        fg: rgb(0x0d0d0d),
        dim: rgb(0x8f8f8f),
        border: rgb(0xe5e5e5),
        accent: rgb(0x1a7f37),
        accent2: rgb(0x5d5d5d),
        busy: rgb(0x9a6700),
        working: rgb(0x1a7f37),
        waiting: rgb(0x9a6700),
        err: rgb(0xd92d20),
        sel_bg: rgb(0xececec),
        claude: rgb(0xd97757),
        codex: rgb(0x0d0d0d),
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
