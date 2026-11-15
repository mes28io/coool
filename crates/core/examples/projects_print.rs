//! Prints `cwd -> project` for every current session.
use coool_core::hub::Hub;

fn main() {
    let mut hub = Hub::new(std::time::Duration::from_secs(3600 * 24 * 3650));
    for s in hub.refresh(false) {
        println!("{} -> {}", s.cwd, s.project);
    }
}
