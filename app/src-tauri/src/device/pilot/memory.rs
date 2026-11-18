//! Muscle memory: (goal, screen signature, previous action) → the action that worked there, per project.
//!
//! Learned only from runs that ended `done` (verified by the success checks, or judged done when none were given),
//! and only steps that changed the screen. A lookup is an exact match on all three parts: the same goal on the same
//! screen reached the same way. The previous action tells "the same screen, a later step" apart (a form before
//! and after a field was filled can look alike). Kept as one small JSON file per project in coool's data folder;
//! nothing goes into the project itself.
//!
//! Next to the entries, one [`Route`] per goal: the screens its last verified run went through. A warm start (the
//! app already in front) continues from the screen it is on only when that screen is on the route, so a replay
//! starts from the same place a learned run did.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Default, Serialize, Deserialize)]
struct File {
    /// The project folder it is for (for people reading the file).
    #[serde(default)]
    project: String,
    #[serde(default)]
    entries: HashMap<String, Entry>,
    /// Per goal (hash of its memory key): the path its last verified run took, for warm starts.
    #[serde(default)]
    routes: HashMap<String, Route>,
}

/// The path a verified run took through an app, from its first screen to the end: what a warm start recognises.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Route {
    /// The app's name as its screens show it ("Settings").
    pub app: String,
    /// Screen signatures, from the app's first screen after a fresh launch to the verified end.
    pub screens: Vec<String>,
    /// The action key taken on each screen but the last (`screens.len() - 1` of them).
    pub actions: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    action: String,
    #[serde(default)]
    learned: u32,
}

/// At most this many entries per project; the least learned go first.
const MAX_ENTRIES: usize = 5000;

pub struct Memory {
    path: Option<PathBuf>,
    file: File,
}

fn route_key(goal: &str) -> String {
    format!("{:016x}", super::fnv(goal))
}

/// The lookup key: goal, screen signature and the action before.
pub fn key(goal: &str, signature: &str, prev: &str) -> String {
    format!("{:016x}", super::fnv(&format!("{goal}\n{signature}\n{prev}")))
}

impl Memory {
    /// Nothing on disk (tests, or no data folder).
    pub fn in_memory() -> Self {
        Memory { path: None, file: File::default() }
    }

    /// The project's memory under `dir` (`<dir>/<hash of the project path>.json`).
    pub fn open(dir: &Path, project: &str) -> Self {
        let path = dir.join(format!("{:016x}.json", super::fnv(project)));
        let file = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<File>(&b).ok()).unwrap_or_default();
        Memory { path: Some(path), file: File { project: project.to_string(), ..file } }
    }

    pub fn lookup(&self, key: &str) -> Option<String> {
        self.file.entries.get(key).map(|e| e.action.clone())
    }

    /// The goal's learned route (see [`Route`]).
    pub fn route(&self, goal: &str) -> Option<Route> {
        self.file.routes.get(&route_key(goal)).cloned().filter(|r| r.screens.len() == r.actions.len() + 1)
    }

    /// Records the goal's route (saved with the next [`Self::learn`]).
    pub fn set_route(&mut self, goal: &str, r: Route) {
        if r.screens.len() == r.actions.len() + 1 {
            self.file.routes.insert(route_key(goal), r);
        }
        // Routes are few (one per goal), but bounded all the same.
        while self.file.routes.len() > MAX_ENTRIES / 10 {
            let Some(k) = self.file.routes.keys().next().cloned() else { break };
            self.file.routes.remove(&k);
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.file.entries.len()
    }

    /// Stores the steps of a successful run (and saves): how many entries are new or changed.
    pub fn learn(&mut self, steps: &[(String, String)]) -> usize {
        let mut changed = 0;
        for (k, a) in steps {
            let e = self.file.entries.entry(k.clone()).or_insert_with(|| Entry { action: String::new(), learned: 0 });
            if e.action != *a {
                e.action = a.clone();
                changed += 1;
            }
            e.learned = e.learned.saturating_add(1);
        }
        if self.file.entries.len() > MAX_ENTRIES {
            let mut v: Vec<_> = self.file.entries.iter().map(|(k, e)| (e.learned, k.clone())).collect();
            v.sort();
            for (_, k) in v.into_iter().take(self.file.entries.len() - MAX_ENTRIES) {
                self.file.entries.remove(&k);
            }
        }
        if !steps.is_empty() {
            self.save();
        }
        changed
    }

    fn save(&self) {
        let Some(p) = &self.path else { return };
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let tmp = p.with_extension(format!("tmp{}", std::process::id()));
        if let Ok(b) = serde_json::to_vec(&self.file)
            && std::fs::write(&tmp, b).is_ok()
        {
            let _ = std::fs::rename(&tmp, p);
        }
    }
}
