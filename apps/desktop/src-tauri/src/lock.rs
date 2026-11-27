//! Locks that outlive a panic. A `Mutex` is "poisoned" when a thread panics while holding it, and `.lock().unwrap()` then
//! panics on every later call, so one bad moment in, say, the phone door would turn every later phone call into a panic until
//! the app restarts. The values these locks guard (lists, maps, a state and its time) are whole after any single write, so
//! taking the value as it stands is safer than failing forever; `outpost/mod.rs` already recovers this way.
use std::sync::{Mutex, MutexGuard};

pub trait LockOrRecover<T> {
    /// The lock, recovered from a panic in another holder rather than panicking again.
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockOrRecover<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::LockOrRecover;
    use std::sync::{Arc, Mutex};

    #[test]
    fn a_lock_poisoned_by_a_panic_is_still_taken_with_its_value() {
        let m = Arc::new(Mutex::new(vec![1, 2]));
        let held = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let mut v = held.lock().unwrap();
            v.push(3);
            panic!("a holder panics");
        })
        .join();
        assert!(m.is_poisoned());
        assert_eq!(*m.lock_or_recover(), vec![1, 2, 3]);
        m.lock_or_recover().push(4);
        assert_eq!(m.lock_or_recover().len(), 4);
    }
}
