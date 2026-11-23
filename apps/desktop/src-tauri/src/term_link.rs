//! `manut://terminal/<link id>` links opened from outside (a browser, Slack, a bot's message in another app). The OS
//! hands the link to manut through the deep-link plugin (on Windows and Linux a second launch carries it, and the
//! single-instance plugin passes it to the running manut). manut only ever takes a link of exactly that shape: the id
//! is 10 characters of lowercase base32 and nothing else may follow it. A link that passes brings the main window to
//! the front and goes to the page as the bare id (event `term-link`); the page opens the TERMINALS session with that
//! id, or says it is not on this computer. Links that arrive before the page listens wait in a small queue the page
//! takes once (`term_link_take`). Nothing is started, typed or read here.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};

/// How many links wait for the page at most (the oldest go first).
const QUEUE_MAX: usize = 8;

/// The link id in `url` when it is `manut://terminal/<id>` (one trailing slash allowed), else None.
pub fn link_id(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("manut://terminal/")?;
    let id = rest.strip_suffix('/').unwrap_or(rest);
    let ok = id.len() == 10 && id.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b));
    ok.then(|| id.to_string())
}

/// A TERMINALS session's link id alone, as [`link_id`] checks it: exactly 10 characters of lowercase base32.
pub fn is_link_id(id: &str) -> bool {
    link_id(&format!("manut://terminal/{id}")).as_deref() == Some(id)
}

/// Links that arrived before the page asked for them.
#[derive(Default)]
pub struct TermLinks {
    queue: Mutex<Vec<String>>,
}

impl TermLinks {
    /// Keep the ids of the links among `urls` that pass; returns those ids in order.
    pub fn push<'a>(&self, urls: impl IntoIterator<Item = &'a str>) -> Vec<String> {
        let ids: Vec<String> = urls.into_iter().filter_map(link_id).collect();
        if !ids.is_empty() {
            let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            q.extend(ids.iter().cloned());
            let over = q.len().saturating_sub(QUEUE_MAX);
            q.drain(..over);
        }
        ids
    }

    /// Everything waiting, once.
    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.queue.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// Links the OS handed over: the ones that pass are queued, sent to the page and bring the window forward.
pub fn arrived<R: Runtime>(app: &AppHandle<R>, urls: &[String]) {
    let Some(links) = app.try_state::<TermLinks>() else { return };
    let ids = links.push(urls.iter().map(String::as_str));
    if ids.is_empty() {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    for id in ids {
        let _ = app.emit("term-link", id);
    }
}

/// The link ids that arrived before the page listened (each handed out once).
#[tauri::command]
pub fn term_link_take(links: tauri::State<'_, TermLinks>) -> Vec<String> {
    links.take()
}

#[cfg(test)]
mod tests {
    use super::{link_id, TermLinks, QUEUE_MAX};

    #[test]
    fn takes_only_a_terminal_link_with_a_well_formed_id() {
        assert_eq!(link_id("manut://terminal/abcdefgh23").as_deref(), Some("abcdefgh23"));
        assert_eq!(link_id(" manut://terminal/abcdefgh23/ ").as_deref(), Some("abcdefgh23"));
        for bad in [
            "manut://terminal/abcdefgh2",
            "manut://terminal/abcdefgh234",
            "manut://terminal/ABCDEFGH23",
            "manut://terminal/abcdefgh01",
            "manut://terminal/abcdefgh23?x=1",
            "manut://terminal/abcdefgh23#x",
            "manut://terminal/abcdefgh23/x",
            "manut://terminal/abcdefgh23//",
            "manut://terminal/../abcdefgh",
            "manut://terminal/abcdéfgh23",
            "manut://bot/abcdefgh23",
            "manut:terminal/abcdefgh23",
            "https://terminal/abcdefgh23",
            "file:///etc/passwd",
            "",
        ] {
            assert_eq!(link_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn queues_passing_links_once_and_keeps_the_newest_few() {
        let q = TermLinks::default();
        assert_eq!(q.push(["manut://terminal/aaaaaaaaaa", "manut://evil/x", "manut://terminal/bbbbbbbbbb/"]), vec!["aaaaaaaaaa", "bbbbbbbbbb"]);
        assert_eq!(q.take(), vec!["aaaaaaaaaa", "bbbbbbbbbb"]);
        assert!(q.take().is_empty());
        let many: Vec<String> = (0..QUEUE_MAX + 3).map(|i| format!("manut://terminal/{}", "abcdefghijklmnop".chars().nth(i).unwrap().to_string().repeat(10))).collect();
        q.push(many.iter().map(String::as_str));
        let kept = q.take();
        assert_eq!(kept.len(), QUEUE_MAX);
        assert_eq!(kept[0], "d".repeat(10));
    }
}
