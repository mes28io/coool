//! coool's release signing tool (minisign format, so a signature can also be checked by hand with
//! `minisign -Vm coool-macos-arm64.tar.gz -p scripts/coool-release.pub`). Used by scripts/release-key.sh and
//! scripts/package.sh; not part of the app.
//!
//!   cargo run -p coool-app --example sign_release -- keygen
//!       prints `public <base64>` and `secret <base64>` (the secret is meant for the Keychain, nowhere else)
//!   cargo run -p coool-app --example sign_release -- sign <file> <keys.rs>   (the secret key on stdin)
//!       writes <file>.minisig, then checks it with the app's own verifier against the keys pinned in <keys.rs>
//!
//! The secret key is minisign's raw secret key bytes, unencrypted (the Keychain item is its protection), as one base64
//! line.

use std::io::Read;

fn die(msg: &str) -> ! {
    eprintln!("sign_release: {msg}");
    std::process::exit(1)
}

fn b64(s: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(s)
}

fn unb64(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s.trim()).unwrap_or_else(|_| die("the secret key isn't base64"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("keygen") => {
            let kp = minisign::KeyPair::generate_unencrypted_keypair().unwrap_or_else(|e| die(&e.to_string()));
            println!("public {}", kp.pk.to_base64());
            println!("secret {}", b64(&kp.sk.to_bytes()));
        }
        Some("sign") if args.len() == 3 => {
            let (file, keys_rs) = (&args[1], &args[2]);
            let mut secret = String::new();
            std::io::stdin().read_to_string(&mut secret).unwrap_or_else(|e| die(&e.to_string()));
            let sk = minisign::SecretKey::from_bytes(&unb64(&secret)).unwrap_or_else(|e| die(&format!("the secret key isn't usable: {e}")));
            let data = std::fs::File::open(file).unwrap_or_else(|e| die(&format!("{file}: {e}")));
            let name = std::path::Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let sig = minisign::sign(None, &sk, data, Some(&format!("file:{name}")), Some("coool release signature")).unwrap_or_else(|e| die(&e.to_string()));
            let sig_path = format!("{file}.minisig");
            std::fs::write(&sig_path, sig.into_string()).unwrap_or_else(|e| die(&format!("{sig_path}: {e}")));
            // The app accepts it only if a pinned key verifies it: check now, with the same verifier.
            let pinned = std::fs::read_to_string(keys_rs).unwrap_or_else(|e| die(&format!("{keys_rs}: {e}")));
            let keys: Vec<&str> = pinned.lines().filter(|l| !l.trim_start().starts_with("//")).flat_map(|l| l.split('"').skip(1).step_by(2)).collect();
            let sig = minisign_verify::Signature::decode(&std::fs::read_to_string(&sig_path).unwrap()).unwrap_or_else(|_| die("the new signature doesn't parse"));
            let bytes = std::fs::read(file).unwrap_or_else(|e| die(&e.to_string()));
            let ok = keys.iter().filter_map(|k| minisign_verify::PublicKey::from_base64(k).ok()).any(|pk| pk.verify(&bytes, &sig, false).is_ok());
            if !ok {
                let _ = std::fs::remove_file(&sig_path);
                die(&format!("the signing key isn't one of the keys pinned in {keys_rs}: the app would refuse this release"));
            }
            println!("signed {sig_path} (verifies against a pinned key)");
        }
        _ => die("usage: sign_release keygen | sign <file> <keys.rs> (secret key on stdin)"),
    }
}
