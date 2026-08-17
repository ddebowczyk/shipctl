//! Semantic terminal scrollback retention policy.
//!
//! Ghostty is the physical retention authority. `TerminalOptions::max_scrollback`
//! is a **byte budget**, not a row count: small budgets all behave alike because
//! the page list keeps a geometry-derived floor, and eviction drops whole pages,
//! so the number of retained rows is never the number a user configured. The
//! tests in this module measure those facts against the pinned parser; they are
//! the authority for the constants below, not dependency prose.
//!
//! Retention is a product setting, so `TerminalService` owns it and seeds every
//! runtime it constructs. It is deliberately absent from `TerminalLaunchRequest`
//! so that no caller -- Tauri, control socket, or module -- can choose its own.

/// Host retention budget in bytes.
///
/// The unit is in the name because the value reaches Ghostty unchanged. The type
/// is opaque so that a row count cannot be assigned to it by accident.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct TerminalRetentionPolicy {
    bytes: usize,
}

/// No history. Measured: a zero budget retains zero scrollback rows, so this is
/// an honest "active screen only" and not a floor.
pub const RETENTION_MIN_BYTES: usize = 0;

/// Default budget.
///
/// Derived, not chosen: the promise the product already shipped was 10,000 rows
/// of history, and 16 MiB is the smallest probed budget that retains more than
/// 10,000 rows at the 80-column reference geometry (4 MiB retains 5,476).
pub const RETENTION_DEFAULT_BYTES: usize = 16 * 1024 * 1024;

/// Largest budget offered.
///
/// Derived from the fixture: 256 MiB is the largest budget these measurements
/// exercise, so it is the largest value whose construction and retention
/// behavior is evidenced. A user cannot request an unbounded parser allocation.
pub const RETENTION_MAX_BYTES: usize = 256 * 1024 * 1024;

impl TerminalRetentionPolicy {
    /// Clamp any stored or IPC-supplied value into the supported domain. This is
    /// the only place the domain is enforced.
    pub fn from_bytes(bytes: usize) -> Self {
        Self {
            bytes: bytes.clamp(RETENTION_MIN_BYTES, RETENTION_MAX_BYTES),
        }
    }

    pub fn bytes(self) -> usize {
        self.bytes
    }
}

impl Default for TerminalRetentionPolicy {
    fn default() -> Self {
        Self::from_bytes(RETENTION_DEFAULT_BYTES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic_terminal::libghostty_vt::{Terminal, TerminalOptions};

    /// Write `lines` rows of `width` printable columns into a fresh parser and
    /// report how many rows survived in history.
    fn retained_rows(
        max_scrollback: usize,
        cols: u16,
        screen_rows: u16,
        lines: usize,
        width: usize,
    ) -> usize {
        let mut terminal = Terminal::new(TerminalOptions {
            cols,
            rows: screen_rows,
            max_scrollback,
        })
        .expect("terminal");
        let payload = "x".repeat(width);
        for _ in 0..lines {
            terminal.vt_write(payload.as_bytes());
            terminal.vt_write(b"\r\n");
        }
        terminal.scrollback_rows().expect("scrollback rows")
    }

    /// The budget bounds history. Identical content and geometry, two budgets,
    /// strictly different retention.
    #[test]
    fn the_budget_bounds_retained_history() {
        let small = retained_rows(1024 * 1024, 80, 24, 12_000, 1);
        let large = retained_rows(RETENTION_MAX_BYTES, 80, 24, 12_000, 1);
        assert!(
            large > small,
            "a larger budget must retain more history: small={small} large={large}"
        );
    }

    /// The default is derived from the 10,000-row promise the product shipped.
    /// If a parser upgrade changes page accounting this fails, and the constant
    /// must be re-derived rather than guessed.
    #[test]
    fn the_default_budget_retains_the_promised_ten_thousand_rows() {
        let retained = retained_rows(RETENTION_DEFAULT_BYTES, 80, 24, 12_000, 1);
        assert!(
            retained >= 10_000,
            "default budget must honor the shipped promise, retained={retained}"
        );
    }

    /// Small budgets are indistinguishable because the page list keeps a floor.
    /// This is why the product cannot offer a small row count.
    #[test]
    fn budgets_below_the_page_floor_are_indistinguishable() {
        let one_byte = retained_rows(1, 80, 24, 5_000, 1);
        let one_mebibyte = retained_rows(1024 * 1024, 80, 24, 5_000, 1);
        assert_eq!(
            one_byte, one_mebibyte,
            "a floor makes sub-page budgets equivalent"
        );
        assert!(one_byte > 0, "the floor itself retains history");
    }

    /// The floor follows geometry, not the configured value.
    #[test]
    fn the_page_floor_follows_geometry() {
        let narrow = retained_rows(1, 80, 24, 5_000, 1);
        let wide = retained_rows(1, 400, 24, 5_000, 1);
        assert!(
            wide < narrow,
            "wider rows must fit fewer of them in one floor: 80c={narrow} 400c={wide}"
        );
    }

    /// A zero budget is honest: no history at all.
    #[test]
    fn a_zero_budget_retains_no_history() {
        assert_eq!(retained_rows(0, 80, 24, 5_000, 1), 0);
    }

    /// Eviction is page-granular, so retained rows are not a function of the
    /// configured value. This is the evidence that forbids an exact-row promise.
    #[test]
    fn retained_rows_are_page_granular_and_not_a_configured_count() {
        let after_three_thousand = retained_rows(1024 * 1024, 80, 24, 3_000, 1);
        let after_five_thousand = retained_rows(1024 * 1024, 80, 24, 5_000, 1);
        assert_ne!(
            after_three_thousand, after_five_thousand,
            "whole-page eviction must make the retained count depend on history, \
             not on the budget alone"
        );
    }

    #[test]
    fn the_domain_is_clamped_at_both_ends() {
        assert_eq!(
            TerminalRetentionPolicy::from_bytes(usize::MAX).bytes(),
            RETENTION_MAX_BYTES
        );
        assert_eq!(
            TerminalRetentionPolicy::from_bytes(0).bytes(),
            RETENTION_MIN_BYTES
        );
        assert_eq!(
            TerminalRetentionPolicy::default().bytes(),
            RETENTION_DEFAULT_BYTES
        );
    }
}
