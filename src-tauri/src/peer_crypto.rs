//! The cryptography of LAN pairing (docs/peers.md), kept apart from the
//! networking so every step is a pure function with a test.
//!
//! Everything but the exchange is `ring`, already linked for rustls (the
//! updater's TLS). Three primitives:
//!
//! - SPAKE2 for the pairing exchange (the `spake2` crate, the only primitive
//!   not from ring): a four-digit code shown on one screen and typed into
//!   the other is the password. A short code is safe only with a PAKE, which
//!   gives an attacker one online guess per attempt and no offline search.
//! - HKDF-SHA256 to turn the exchange into the pair key, and the pair key
//!   into one key per direction.
//! - ChaCha20-Poly1305 for every call after pairing: the credential never
//!   travels, and a LAN sniffer sees neither it nor the prompts and diffs.

use base64::Engine as _;
use ring::rand::{SecureRandom, SystemRandom};
use ring::{aead, hkdf};

/// Length of every nonce the pairing exchange carries, and of a request id.
pub(crate) const NONCE_LEN: usize = 16;

pub(crate) fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub(crate) fn unb64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s.trim()).ok()
}

pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    // SystemRandom only fails when the OS has no entropy source at all, in
    // which case nothing secure is possible; a zeroed buffer would be a
    // silent disaster, so this is the one place a panic is the right answer.
    SystemRandom::new().fill(&mut out).expect("the OS random source failed");
    out
}

pub(crate) fn random_hex<const N: usize>() -> String {
    random_bytes::<N>().iter().map(|b| format!("{b:02x}")).collect()
}

struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn hkdf32(salt: &[u8], ikm: &[u8], info: &[&[u8]]) -> [u8; 32] {
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(ikm);
    let okm = prk.expand(info, Len(32)).expect("32 bytes is within HKDF-SHA256's limit");
    let mut out = [0u8; 32];
    okm.fill(&mut out).expect("the buffer is exactly the requested length");
    out
}

// ───────────────────────────── pairing ───────────────────────────────

/// Digits in a pairing code. Four, because a person reads it off one screen
/// and types it into another. Enough with a PAKE: an attacker gets one guess
/// per attempt (no offline search), and a machine in pairing mode closes it
/// after three wrong codes, so the odds are 3 in 10,000 per time a person
/// opens it, and every failed guess shows on that person's screen.
pub(crate) const CODE_DIGITS: usize = 4;

/// A fresh code for pairing mode. Rejection-sampled so every value is
/// equally likely.
pub(crate) fn new_code() -> String {
    let max = 10u32.pow(CODE_DIGITS as u32);
    let limit = u32::MAX - u32::MAX % max;
    loop {
        let n = u32::from_be_bytes(random_bytes::<4>());
        if n < limit {
            return format!("{:0width$}", n % max, width = CODE_DIGITS);
        }
    }
}

/// The code as typed: digits only, so "48 21" and "4821" are the same code.
/// None unless exactly `CODE_DIGITS` remain.
pub(crate) fn normalize_code(s: &str) -> Option<String> {
    let d: String = s.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    (d.len() == CODE_DIGITS && d.bytes().all(|b| b.is_ascii_digit())).then_some(d)
}

/// One side of SPAKE2 (Ed25519 group, the RustCrypto `spake2` crate, the
/// exchange magic-wormhole uses for short codes). A is the machine whose
/// person TYPES the code, B the one in pairing mode that SHOWS it. Ids are
/// the two instance ids, so a run between other machines does not verify.
/// The code never travels; a machine that does not know it derives a
/// different key, and learns nothing that lets it try another code offline.
pub(crate) struct Pake(spake2::Spake2<spake2::Ed25519Group>);

impl Pake {
    pub(crate) fn start_a(code: &str, id_a: &str, id_b: &str) -> (Pake, Vec<u8>) {
        let (s, msg) = spake2::Spake2::<spake2::Ed25519Group>::start_a(
            &spake2::Password::new(code.as_bytes()),
            &spake2::Identity::new(id_a.as_bytes()),
            &spake2::Identity::new(id_b.as_bytes()),
        );
        (Pake(s), msg)
    }

    pub(crate) fn start_b(code: &str, id_a: &str, id_b: &str) -> (Pake, Vec<u8>) {
        let (s, msg) = spake2::Spake2::<spake2::Ed25519Group>::start_b(
            &spake2::Password::new(code.as_bytes()),
            &spake2::Identity::new(id_a.as_bytes()),
            &spake2::Identity::new(id_b.as_bytes()),
        );
        (Pake(s), msg)
    }

    /// The shared secret, given the other side's message. Equal on both
    /// sides only when both used the same code. None for a malformed or
    /// wrong-side message.
    pub(crate) fn finish(self, theirs: &[u8]) -> Option<[u8; 32]> {
        self.0.finish(theirs).ok()?.try_into().ok()
    }
}

/// The pair key both machines store, from the SPAKE2 secret. `id_a` typed
/// the code, `id_b` showed it. Whether the two sides agree is proven by the
/// first message sealed under it (`/pair/confirm`): the envelope opens only
/// under the same key.
pub(crate) fn pair_key(secret: &[u8; 32], id_a: &str, id_b: &str) -> [u8; 32] {
    hkdf32(b"termic-pair-v2", secret, &[b"termic-peer-v2|", id_a.as_bytes(), b"|", id_b.as_bytes()])
}

// ───────────────────────────── envelope ──────────────────────────────

/// The key for messages from `sender` to `receiver`. One per direction, so a
/// message can never be reflected back at the machine that sent it and
/// accepted as the other side's.
fn direction_key(pair_key: &[u8; 32], sender: &str, receiver: &str) -> aead::LessSafeKey {
    let k = hkdf32(b"termic-dir-v1", pair_key, &[sender.as_bytes(), b"->", receiver.as_bytes()]);
    aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::CHACHA20_POLY1305, &k).expect("32 bytes is a ChaCha20 key"),
    )
}

/// Everything the seal authenticates beside the plaintext: which endpoint
/// and which two machines. A sealed body moved to another path or presented
/// by another sender fails to open.
fn aad(path: &str, sender: &str, receiver: &str) -> Vec<u8> {
    format!("termic-peer-v1|{path}|{sender}|{receiver}").into_bytes()
}

/// One sealed message on the wire.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Envelope {
    /// The sender's instance id, in the clear: the receiver needs it to pick
    /// the key. It is authenticated (part of the AAD), not trusted.
    pub from: String,
    /// 96-bit nonce, base64.
    pub n: String,
    /// Ciphertext + tag, base64.
    pub c: String,
}

pub(crate) fn seal(
    pair_key: &[u8; 32],
    path: &str,
    sender: &str,
    receiver: &str,
    plaintext: &[u8],
) -> Envelope {
    let key = direction_key(pair_key, sender, receiver);
    // Random 96-bit nonces: the volume here (a person's agents talking) is
    // nowhere near the ~2^32 messages per key where a collision matters.
    let nonce = random_bytes::<12>();
    let mut buf = plaintext.to_vec();
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(aad(path, sender, receiver)),
        &mut buf,
    )
    .expect("sealing only fails for a message beyond ChaCha20's 256 GiB limit");
    Envelope { from: sender.to_string(), n: b64(&nonce), c: b64(&buf) }
}

/// Open a sealed message addressed to `receiver`. None for anything that is
/// not exactly what `seal` produced with this key, path and pair of ids.
pub(crate) fn open(
    pair_key: &[u8; 32],
    path: &str,
    receiver: &str,
    env: &Envelope,
) -> Option<Vec<u8>> {
    let nonce: [u8; 12] = unb64(&env.n)?.try_into().ok()?;
    let mut buf = unb64(&env.c)?;
    let key = direction_key(pair_key, &env.from, receiver);
    let plain = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad(path, &env.from, receiver)),
            &mut buf,
        )
        .ok()?;
    Some(plain.to_vec())
}

pub(crate) fn key_to_hex(k: &[u8; 32]) -> String {
    k.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn key_from_hex(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        let hex = std::str::from_utf8(chunk).ok()?;
        out[i] = u8::from_str_radix(hex, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A complete exchange, as both sides run it, with the code each typed.
    fn exchange(code_a: &str, code_b: &str) -> (Option<[u8; 32]>, Option<[u8; 32]>) {
        let (a, msg_a) = Pake::start_a(code_a, "ida", "idb");
        let (b, msg_b) = Pake::start_b(code_b, "ida", "idb");
        (a.finish(&msg_b), b.finish(&msg_a))
    }

    #[test]
    fn the_same_code_gives_both_sides_the_same_key() {
        let (a, b) = exchange("4821", "4821");
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(pair_key(&a.unwrap(), "ida", "idb"), pair_key(&b.unwrap(), "ida", "idb"));
    }

    #[test]
    fn a_wrong_code_gives_different_keys() {
        // Nobody refuses at this step: the keys simply differ, and the first
        // sealed message does not open. That is the whole check.
        let (a, b) = exchange("4821", "4822");
        assert_ne!(a.unwrap(), b.unwrap());
    }

    #[test]
    fn a_man_in_the_middle_without_the_code_holds_neither_key() {
        // M sits between A and B, guessing. Each half is an exchange with
        // a different code, so neither half's key is the real one.
        let (a, msg_a) = Pake::start_a("4821", "ida", "idb");
        let (m_b, msg_m_b) = Pake::start_b("0000", "ida", "idb");
        let (m_a, msg_m_a) = Pake::start_a("0000", "ida", "idb");
        let (b, msg_b) = Pake::start_b("4821", "ida", "idb");
        let on_a = a.finish(&msg_m_b).unwrap();
        let m_with_a = m_b.finish(&msg_a).unwrap();
        let on_b = b.finish(&msg_m_a).unwrap();
        let m_with_b = m_a.finish(&msg_b).unwrap();
        assert_ne!(on_a, m_with_a);
        assert_ne!(on_b, m_with_b);
    }

    #[test]
    fn the_exchange_is_bound_to_both_ids() {
        let (a, msg_a) = Pake::start_a("4821", "ida", "idb");
        let (b, msg_b) = Pake::start_b("4821", "ida", "other");
        assert_ne!(a.finish(&msg_b).unwrap(), b.finish(&msg_a).unwrap());
    }

    #[test]
    fn a_malformed_or_same_side_message_does_not_finish() {
        let (a, _) = Pake::start_a("4821", "ida", "idb");
        assert!(a.finish(&[0u8; 5]).is_none());
        let (a, _) = Pake::start_a("4821", "ida", "idb");
        let (_, other_a) = Pake::start_a("4821", "ida", "idb");
        assert!(a.finish(&other_a).is_none(), "two A sides do not pair");
    }

    #[test]
    fn codes_are_four_digits_and_typing_is_forgiving() {
        for _ in 0..200 {
            let c = new_code();
            assert_eq!(c.len(), CODE_DIGITS);
            assert!(c.bytes().all(|b| b.is_ascii_digit()));
        }
        assert_eq!(normalize_code(" 48 21 ").as_deref(), Some("4821"));
        assert_eq!(normalize_code("48-21").as_deref(), Some("4821"));
        assert_eq!(normalize_code("482"), None);
        assert_eq!(normalize_code("48211"), None);
        assert_eq!(normalize_code("48a1"), None);
    }

    #[test]
    fn the_pair_key_depends_on_who_typed() {
        let s = [9u8; 32];
        assert_ne!(pair_key(&s, "x", "y"), pair_key(&s, "y", "x"));
    }

    #[test]
    fn a_sealed_message_opens_only_where_it_was_sent() {
        let k = [7u8; 32];
        let env = seal(&k, "/call", "mac", "win", b"{\"hello\":1}");
        assert_eq!(open(&k, "/call", "win", &env).unwrap(), b"{\"hello\":1}");
        // Another path, another receiver, another key, a flipped bit, a
        // forged sender: each fails closed.
        assert!(open(&k, "/unpair", "win", &env).is_none(), "path is authenticated");
        assert!(open(&k, "/call", "mac", &env).is_none(), "receiver is authenticated");
        assert!(open(&[8u8; 32], "/call", "win", &env).is_none(), "wrong key");
        let mut forged = env.clone();
        forged.from = "evil".into();
        assert!(open(&k, "/call", "win", &forged).is_none(), "sender is authenticated");
        let mut flipped = env.clone();
        let mut c = unb64(&flipped.c).unwrap();
        c[0] ^= 1;
        flipped.c = b64(&c);
        assert!(open(&k, "/call", "win", &flipped).is_none(), "ciphertext is authenticated");
    }

    #[test]
    fn a_reply_cannot_be_reflected_back_as_a_request() {
        // The same key, the other direction: what win sends mac must not
        // open as something mac sent win.
        let k = [7u8; 32];
        let to_mac = seal(&k, "/call", "win", "mac", b"x");
        let reflected = Envelope { from: "mac".into(), ..to_mac };
        assert!(open(&k, "/call", "win", &reflected).is_none());
    }

    #[test]
    fn garbage_envelopes_fail_without_panicking() {
        let k = [7u8; 32];
        for env in [
            Envelope { from: "a".into(), n: "not base64!".into(), c: "".into() },
            Envelope { from: "a".into(), n: b64(&[0; 11]), c: b64(&[0; 40]) },
            Envelope { from: "a".into(), n: b64(&[0; 12]), c: b64(&[0; 3]) },
        ] {
            assert!(open(&k, "/call", "b", &env).is_none());
        }
    }

    #[test]
    fn keys_round_trip_through_hex_and_bad_hex_is_refused() {
        let k = random_bytes::<32>();
        assert_eq!(key_from_hex(&key_to_hex(&k)), Some(k));
        assert_eq!(key_from_hex("abc"), None);
        assert_eq!(key_from_hex(&"zz".repeat(32)), None);
    }

    /// Pinned vector for the key derivation, so another implementation (the
    /// fake peer in e2e/specs/peers.e2e.ts) is checked against a number
    /// rather than against this file. Computed independently (Python hmac)
    /// from the salt, info and byte layout above. The SPAKE2 half is the
    /// crate's, and the e2e spec pairs against it for real.
    #[test]
    fn the_pair_key_matches_the_pinned_vector() {
        assert_eq!(
            key_to_hex(&pair_key(&[1u8; 32], "ida", "idb")),
            PINNED_PAIR_KEY,
        );
    }

    const PINNED_PAIR_KEY: &str = "c6d9626e5110e9e4cd3c446b9d419ed786f1d6f86d387849f8a6bd3cdbe3068f";
}
