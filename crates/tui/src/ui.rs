use crate::app::{display_title, App, Mode, Row};
use coool_core::model::*;
use crate::theme::Theme;
use coool_core::util::*;
use ratatui::layout::{Alignment, Constraint, Layout, Margin, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;
use std::time::Duration;
use tui_term::widget::PseudoTerminal;

const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub fn draw(f: &mut Frame, app: &mut App) {
    let t = app.theme;
    let area = f.area();
    f.render_widget(Block::default().style(Style::default().bg(t.bg).fg(t.fg)), area);

    if let Mode::Attach(i) = app.mode {
        draw_attach(f, app, i, area);
        return;
    }

    let [header, body, footer] = Layout::vertical([Constraint::Length(1), Constraint::Min(0), Constraint::Length(1)]).areas(area);
    // Keep PTYs sized to the real terminal so attaching is seamless.
    app.attach_size = (area.height.saturating_sub(1).max(5), area.width.max(20));

    draw_header(f, app, header);
    let [left, right] = Layout::horizontal([Constraint::Percentage(42), Constraint::Percentage(58)]).areas(body);
    draw_list(f, app, left);
    draw_detail(f, app, right);
    draw_footer(f, app, footer);

    match &app.mode {
        Mode::NewSession { provider, cwd } => draw_new(f, t, *provider, cwd),
        Mode::Prompt { input, .. } => draw_prompt(f, t, input),
        Mode::ConfirmKill { label, .. } => draw_confirm(f, t, "stop session", &format!("Stop “{}”?", truncate(label, 40))),
        Mode::ConfirmQuit => draw_confirm(f, t, "quit coool", "Sessions launched in coool will be stopped. Quit?"),
        Mode::Help => draw_help(f, t),
        _ => {}
    }
}

fn panel(t: Theme, title: &str) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(t.border))
        .title(Span::styled(format!(" {title} "), Style::default().fg(t.dim)))
        .style(Style::default().bg(t.bg))
}

fn provider_color(t: Theme, p: Provider) -> ratatui::style::Color {
    match p {
        Provider::Claude => t.claude,
        Provider::Codex => t.codex,
    }
}

fn status_span(app: &App, s: Status) -> Span<'static> {
    let t = app.theme;
    match s {
        Status::Busy => Span::styled(SPINNER[app.tick as usize % SPINNER.len()], Style::default().fg(t.running)),
        Status::Idle => Span::styled("●", Style::default().fg(t.waiting)),
        Status::Ended => Span::styled("○", Style::default().fg(t.dim)),
    }
}

fn draw_header(f: &mut Frame, app: &App, area: Rect) {
    let t = app.theme;
    let busy = app.sessions.iter().filter(|s| s.status == Status::Busy).count();
    let live = app.sessions.iter().filter(|s| s.status != Status::Ended).count();
    let agents: usize = app.sessions.iter().map(|s| s.agents.iter().filter(|a| !a.finished).count()).sum();
    let out: u64 = app.sessions.iter().map(|s| s.tokens.output + s.agents.iter().map(|a| a.tokens.output).sum::<u64>()).sum();

    let logo = vec![
        Span::styled(" c", Style::default().fg(t.accent).bold()),
        Span::styled("o", Style::default().fg(t.accent).bold()),
        Span::styled("o", Style::default().fg(t.accent2).bold()),
        Span::styled("o", Style::default().fg(t.claude).bold()),
        Span::styled("l ", Style::default().fg(t.codex).bold()),
    ];
    let mut spans = logo;
    let sep = || Span::styled("  ", Style::default());
    spans.push(Span::styled(format!("{live} live"), Style::default().fg(t.fg)));
    spans.push(sep());
    spans.push(Span::styled(format!("{busy} working"), Style::default().fg(if busy > 0 { t.running } else { t.dim })));
    spans.push(sep());
    spans.push(Span::styled(format!("{agents} subagents"), Style::default().fg(if agents > 0 { t.accent2 } else { t.dim })));
    spans.push(sep());
    spans.push(Span::styled(format!("{} out-tokens", fmt_tokens(out)), Style::default().fg(t.dim)));
    if app.hub.loading() {
        spans.push(sep());
        spans.push(Span::styled("loading…", Style::default().fg(t.busy)));
    }
    let left = Line::from(spans);
    let left_w = left.width();
    f.render_widget(Paragraph::new(left).style(Style::default().bg(t.panel)), area);
    let scope = if app.live_only { "live only" } else { "live + recent" };
    let right = if app.hidden_automation > 0 { format!("{} by other tools hidden (a) · {scope} ", app.hidden_automation) } else { format!("{scope} ") };
    // Drawn on top of the same row: skip it rather than overwrite the counters.
    if left_w + display_width(&right) < area.width as usize {
        f.render_widget(Paragraph::new(Span::styled(right, Style::default().fg(t.dim))).alignment(Alignment::Right), area);
    }
}

fn draw_list(f: &mut Frame, app: &App, area: Rect) {
    let t = app.theme;
    let width = area.width.saturating_sub(4) as usize;
    let items: Vec<ListItem> = app
        .rows
        .iter()
        .map(|r| match *r {
            Row::Session(i) => {
                let s = &app.sessions[i];
                let title_style = if s.status == Status::Ended { Style::default().fg(t.dim) } else { Style::default().fg(t.fg).bold() };
                let mut l1 = vec![
                    status_span(app, s.status),
                    Span::raw(" "),
                    Span::styled(format!("{:<7}", s.provider.label()), Style::default().fg(provider_color(t, s.provider))),
                    Span::styled(truncate(&display_title(s), width.saturating_sub(18)), title_style),
                ];
                if s.managed.is_some() {
                    l1.push(Span::styled(" ◆", Style::default().fg(t.accent2)));
                }
                let dir = std::path::Path::new(&s.cwd).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
                let now = s.current.clone().unwrap_or_default();
                let l2_text = if now.is_empty() {
                    format!("{dir} · {} ago", ago(s.updated))
                } else {
                    format!("{dir} · {now}")
                };
                let l2 = Line::from(vec![
                    Span::raw("         "),
                    Span::styled(truncate(&l2_text, width.saturating_sub(9)), Style::default().fg(if now.is_empty() { t.dim } else { t.running })),
                ]);
                ListItem::new(Text::from(vec![Line::from(l1), l2]))
            }
            Row::Agent(i, a) => {
                let ag = &app.sessions[i].agents[a];
                let icon = if ag.finished { Span::styled("✓", Style::default().fg(t.dim)) } else { Span::styled(SPINNER[app.tick as usize % 10], Style::default().fg(t.accent2)) };
                let what = ag.current.clone().filter(|_| !ag.finished).unwrap_or_else(|| ag.description.clone());
                ListItem::new(Line::from(vec![
                    Span::styled("   └ ", Style::default().fg(t.border)),
                    icon,
                    Span::raw(" "),
                    Span::styled(format!("{} ", ag.kind), Style::default().fg(t.accent2)),
                    Span::styled(truncate(&what, width.saturating_sub(display_width(&ag.kind) + 9)), Style::default().fg(t.dim)),
                ]))
            }
            Row::Pending(m) => {
                let label = app.hub.managed.get(m).and_then(|x| x.as_ref()).map(|x| format!("{} · starting in {}", x.provider.label(), home_short(&x.cwd))).unwrap_or_default();
                ListItem::new(Line::from(vec![
                    Span::styled(SPINNER[app.tick as usize % 10], Style::default().fg(t.running)),
                    Span::raw(" "),
                    Span::styled(label, Style::default().fg(t.fg)),
                    Span::styled(" ◆", Style::default().fg(t.accent2)),
                ]))
            }
        })
        .collect();

    let empty = items.is_empty();
    let list = List::new(items)
        .block(panel(t, "sessions"))
        .highlight_style(Style::default().bg(t.sel_bg))
        .highlight_symbol("▎");
    let mut state = ListState::default().with_selected(if empty { None } else { Some(app.selected) });
    f.render_stateful_widget(list, area, &mut state);
    if empty {
        let msg = Paragraph::new(vec![
            Line::from(""),
            Line::from(Span::styled(if app.hub.loading() { "looking for sessions…" } else { "no sessions yet" }, Style::default().fg(t.dim))),
            Line::from(Span::styled("press n to start one", Style::default().fg(t.accent))),
        ])
        .alignment(Alignment::Center);
        f.render_widget(msg, area.inner(Margin::new(1, 2)));
    }
}

fn draw_detail(f: &mut Frame, app: &App, area: Rect) {
    let t = app.theme;
    let row = app.rows.get(app.selected).cloned();
    let (title, activity, info): (String, Vec<Activity>, Vec<Line>) = match row {
        Some(Row::Session(i)) => {
            let s = &app.sessions[i];
            (display_title(s), s.activity.to_vec(), session_info(app, s))
        }
        Some(Row::Agent(i, a)) => {
            let s = &app.sessions[i];
            let ag = &s.agents[a];
            let info = vec![
                kv(t, "agent", format!("{} · {}", ag.kind, if ag.finished { "finished" } else { "running" })),
                kv(t, "task", ag.description.clone()),
                kv(t, "parent", display_title(s)),
                kv(t, "tokens", tokens_line(&ag.tokens)),
            ];
            (format!("subagent · {}", ag.kind), ag.activity.to_vec(), info)
        }
        Some(Row::Pending(_)) => ("starting…".into(), vec![], vec![Line::from(Span::styled("waiting for the session transcript to appear · enter to attach", Style::default().fg(t.dim)))]),
        None => ("".into(), vec![], vec![]),
    };

    let info_h = (info.len() as u16 + 2).min(area.height / 2);
    let [top, bottom] = Layout::vertical([Constraint::Length(info_h), Constraint::Min(0)]).areas(area);
    f.render_widget(Paragraph::new(info).block(panel(t, &truncate(&title, 60))).wrap(Wrap { trim: true }), top);

    // Activity feed, newest at the bottom.
    let inner_w = bottom.width.saturating_sub(4) as usize;
    let mut lines: Vec<Line> = Vec::new();
    for a in &activity {
        let (icon, color) = match a.kind {
            ActivityKind::Prompt => ("❯", t.accent),
            ActivityKind::Text => ("◆", t.fg),
            ActivityKind::Tool => ("▸", t.running),
            ActivityKind::Agent => ("⑂", t.accent2),
            ActivityKind::Error => ("✗", t.err),
        };
        let text_style = match a.kind {
            ActivityKind::Prompt => Style::default().fg(t.accent).add_modifier(Modifier::BOLD),
            ActivityKind::Text => Style::default().fg(t.fg),
            ActivityKind::Error => Style::default().fg(t.err),
            _ => Style::default().fg(t.dim),
        };
        lines.push(Line::from(vec![
            Span::styled(format!("{} ", a.ts), Style::default().fg(t.border)),
            Span::styled(format!("{icon} "), Style::default().fg(color)),
            // Tool calls stay on one line; prose may wrap to a few lines.
            Span::styled(
                match a.kind {
                    ActivityKind::Tool | ActivityKind::Agent | ActivityKind::Error => truncate(&a.text, inner_w.saturating_sub(12).max(10)),
                    _ => truncate(&a.text, inner_w.saturating_sub(12).max(10) * 3),
                },
                text_style,
            ),
        ]));
    }
    let feed_h = bottom.height.saturating_sub(2);
    let para = Paragraph::new(lines).wrap(Wrap { trim: false });
    // Ask ratatui how many rows the word-wrapped feed really takes: a
    // width/columns estimate undercounts word wrapping and hides the newest lines.
    let total = para.line_count(bottom.width.saturating_sub(2)).min(u16::MAX as usize) as u16;
    let max_scroll = total.saturating_sub(feed_h);
    let scroll = max_scroll.saturating_sub(app.feed_scroll);
    let title = if app.feed_scroll > 0 { format!("activity ↑{}", app.feed_scroll) } else { "activity".into() };
    f.render_widget(para.block(panel(t, &title)).scroll((scroll, 0)), bottom);
}

fn kv(t: Theme, k: &str, v: String) -> Line<'static> {
    Line::from(vec![Span::styled(format!("{k:<8}"), Style::default().fg(t.dim)), Span::styled(v, Style::default().fg(t.fg))])
}

fn tokens_line(tk: &Tokens) -> String {
    format!("ctx {} · in {} · cached {} · out {}", fmt_tokens(tk.context), fmt_tokens(tk.input), fmt_tokens(tk.cached), fmt_tokens(tk.output))
}

fn session_info(app: &App, s: &Session) -> Vec<Line<'static>> {
    let t = app.theme;
    let status = match s.status {
        Status::Busy => "working",
        Status::Idle => "waiting for you",
        Status::Ended => "ended",
    };
    let mut v = vec![
        Line::from(vec![
            Span::styled(format!("{:<8}", "status"), Style::default().fg(t.dim)),
            status_span(app, s.status),
            Span::styled(format!(" {status}"), Style::default().fg(t.fg)),
            Span::styled(
                format!("{}{}", s.pid.map(|p| format!("  pid {p}")).unwrap_or_default(), if s.managed.is_some() { "  ◆ in coool" } else { "" }),
                Style::default().fg(t.dim),
            ),
        ]),
        kv(t, "where", home_short(&s.cwd)),
        Line::from(vec![
            Span::styled(format!("{:<8}", "model"), Style::default().fg(t.dim)),
            Span::styled(format!("{} ", s.provider.label()), Style::default().fg(provider_color(t, s.provider))),
            Span::styled(if s.model.is_empty() { "—".to_string() } else { s.model.clone() }, Style::default().fg(t.fg)),
        ]),
        kv(t, "tokens", tokens_line(&s.tokens)),
    ];
    if let Some(c) = &s.current {
        v.push(Line::from(vec![Span::styled(format!("{:<8}", "now"), Style::default().fg(t.dim)), Span::styled(one_line(c, 90), Style::default().fg(t.running))]));
    }
    if !s.agents.is_empty() {
        let running = s.agents.iter().filter(|a| !a.finished).count();
        v.push(kv(t, "agents", format!("{running} running · {} total", s.agents.len())));
    }
    v
}

fn draw_footer(f: &mut Frame, app: &mut App, area: Rect) {
    let t = app.theme;
    if let Some((msg, at)) = &app.flash
        && at.elapsed() < Duration::from_secs(4) {
            f.render_widget(Paragraph::new(Span::styled(format!(" {msg}"), Style::default().fg(t.busy))).style(Style::default().bg(t.panel)), area);
            return;
        }
    app.flash = None;
    let keys = [("n", "new"), ("⏎", "attach"), ("p", "prompt"), ("r", "resume"), ("x", "stop"), ("f", "filter"), ("t", "theme"), ("?", "help"), ("q", "quit")];
    let mut spans = vec![Span::raw(" ")];
    for (k, d) in keys {
        spans.push(Span::styled(k, Style::default().fg(t.accent).bold()));
        spans.push(Span::styled(format!(" {d}   "), Style::default().fg(t.dim)));
    }
    f.render_widget(Paragraph::new(Line::from(spans)).style(Style::default().bg(t.panel)), area);
}

fn draw_attach(f: &mut Frame, app: &mut App, i: usize, area: Rect) {
    let t = app.theme;
    let [bar, body] = Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(area);
    app.attach_size = (body.height.max(5), body.width.max(20));
    let title = app
        .sessions
        .iter()
        .find(|s| s.managed == Some(i))
        .map(display_title)
        .or_else(|| app.hub.managed.get(i).and_then(|m| m.as_ref()).map(|m| format!("{} · {}", m.provider.label(), home_short(&m.cwd))))
        .unwrap_or_default();
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" coool ", Style::default().fg(t.bg).bg(t.accent).bold()),
            Span::styled(format!(" {} ", truncate(&title, 60)), Style::default().fg(t.fg)),
        ]))
        .style(Style::default().bg(t.panel)),
        bar,
    );
    f.render_widget(Paragraph::new(Span::styled("ctrl+\\ detach ", Style::default().fg(t.dim))).alignment(Alignment::Right), bar);
    if let Some(Some(m)) = app.hub.managed.get(i) {
        let parser = m.parser.lock().unwrap();
        f.render_widget(PseudoTerminal::new(parser.screen()), body);
    }
}

fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width.saturating_sub(4));
    let h = h.min(area.height.saturating_sub(2));
    Rect { x: area.x + (area.width - w) / 2, y: area.y + (area.height - h) / 2, width: w, height: h }
}

fn modal(f: &mut Frame, t: Theme, title: &str, w: u16, h: u16) -> Rect {
    let r = centered(f.area(), w, h);
    f.render_widget(Clear, r);
    let b = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(t.accent))
        .title(Span::styled(format!(" {title} "), Style::default().fg(t.accent).bold()))
        .style(Style::default().bg(t.panel).fg(t.fg));
    let inner = b.inner(r);
    f.render_widget(b, r);
    inner.inner(Margin::new(1, 0))
}

fn draw_new(f: &mut Frame, t: Theme, p: Provider, cwd: &str) {
    let r = modal(f, t, "new session", 64, 8);
    let chip = |pp: Provider| {
        if pp == p {
            Span::styled(format!(" {} ", pp.label()), Style::default().fg(t.bg).bg(provider_color(t, pp)).bold())
        } else {
            Span::styled(format!(" {} ", pp.label()), Style::default().fg(t.dim))
        }
    };
    let lines = vec![
        Line::from(""),
        Line::from(vec![Span::styled("agent   ", Style::default().fg(t.dim)), chip(Provider::Claude), Span::raw(" "), chip(Provider::Codex), Span::styled("   tab", Style::default().fg(t.dim))]),
        Line::from(""),
        Line::from(vec![Span::styled("folder  ", Style::default().fg(t.dim)), Span::styled(cwd.to_string(), Style::default().fg(t.fg)), Span::styled("▏", Style::default().fg(t.accent))]),
        Line::from(""),
        Line::from(Span::styled("enter launch · esc cancel", Style::default().fg(t.dim))),
    ];
    f.render_widget(Paragraph::new(lines), r);
}

fn draw_prompt(f: &mut Frame, t: Theme, input: &str) {
    let r = modal(f, t, "send prompt", 70, 9);
    let mut text = Text::from(Span::styled(format!("{input}▏"), Style::default().fg(t.fg)));
    text.lines.push(Line::from(""));
    text.lines.push(Line::from(Span::styled("enter send · alt+enter / ctrl+j newline · esc cancel", Style::default().fg(t.dim))));
    f.render_widget(Paragraph::new(text).wrap(Wrap { trim: false }), r);
}

fn draw_confirm(f: &mut Frame, t: Theme, title: &str, msg: &str) {
    let r = modal(f, t, title, 56, 6);
    f.render_widget(
        Paragraph::new(vec![
            Line::from(""),
            Line::from(Span::styled(msg.to_string(), Style::default().fg(t.fg))),
            Line::from(""),
            Line::from(vec![Span::styled("y", Style::default().fg(t.err).bold()), Span::styled(" yes   any other key cancels", Style::default().fg(t.dim))]),
        ])
        .wrap(Wrap { trim: true }),
        r,
    );
}

fn draw_help(f: &mut Frame, t: Theme) {
    let r = modal(f, t, "coool · keys", 60, 20);
    let rows = [
        ("↑↓ / j k", "move"),
        ("enter", "attach to a session launched in coool"),
        ("ctrl+\\", "detach back to the dashboard"),
        ("n", "new claude / codex session"),
        ("r", "resume an ended session inside coool"),
        ("p", "send a prompt without attaching"),
        ("x", "stop a session (any live one)"),
        ("pgup/pgdn", "scroll activity"),
        ("f", "toggle live-only / live + recent"),
        ("a", "show / hide runs started by other tools"),
        ("t", "dark / light theme"),
        ("q", "quit"),
    ];
    let mut lines = vec![Line::from("")];
    for (k, d) in rows {
        lines.push(Line::from(vec![Span::styled(format!("{k:<12}"), Style::default().fg(t.accent).bold()), Span::styled(d, Style::default().fg(t.fg))]));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled("◆ = running inside coool. Others are discovered", Style::default().fg(t.dim))));
    lines.push(Line::from(Span::styled("  from ~/.claude and ~/.codex and are read-only.", Style::default().fg(t.dim))));
    f.render_widget(Paragraph::new(lines), r);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn modals_survive_tiny_terminals() {
        let t = Theme::DARK;
        for w in 0..12u16 {
            for h in 0..10u16 {
                let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
                term.draw(|f| {
                    draw_new(f, t, Provider::Codex, "~/漢字/🙂");
                    draw_prompt(f, t, "multi\nline 漢字");
                    draw_confirm(f, t, "stop session", "Stop “x”?");
                    draw_help(f, t);
                })
                .unwrap();
            }
        }
    }

    #[test]
    fn centered_stays_inside_area() {
        for (w, h) in [(0, 0), (1, 1), (3, 2), (5, 3), (80, 24)] {
            let a = Rect::new(2, 1, w, h);
            let r = centered(a, 64, 8);
            assert!(r.x >= a.x && r.y >= a.y && r.right() <= a.right() && r.bottom() <= a.bottom(), "{r:?} in {a:?}");
        }
    }
}
