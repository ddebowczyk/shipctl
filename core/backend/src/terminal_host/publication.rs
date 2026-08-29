//! What the runtime actor decides to emit, separated from the machinery that
//! carries it out.
//!
//! `RuntimeActor` owns a PTY and a child process, and its only constructor
//! spawns both. That makes every decision it takes unreachable from a test:
//! there is no way to ask "what does a theme change publish?" without starting
//! a program. The decisions here are ordinary functions over ordinary values,
//! so they can be proved directly, and the actor is left holding only the I/O.
//!
//! The rule this module exists to keep is that parser-generated replies are
//! answers to the child and never client events. Two operations produce one:
//! feeding child output, and changing the theme. Both route the reply through
//! `ReplyToChild` and neither can reach a subscriber, because `Publish` is a
//! different variant and the planners never build one from a reply.

use std::sync::Arc;

use super::types::{
    TerminalAttachmentId, TerminalError, TerminalErrorCode, TerminalEvent, TerminalRevision,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EventAudience {
    All,
}

impl EventAudience {
    pub(crate) fn includes(self) -> bool {
        true
    }
}

pub(crate) fn event_audience(event: &TerminalEvent) -> EventAudience {
    match event {
        TerminalEvent::Output { .. }
        | TerminalEvent::MetadataChanged { .. }
        | TerminalEvent::AgentActivityChanged { .. }
        | TerminalEvent::Exited { .. }
        | TerminalEvent::ResyncRequired { .. }
        | TerminalEvent::Detached { .. } => EventAudience::All,
    }
}

/// One ordered effect of a runtime operation. The actor applies these in order;
/// the order is part of the decision, not of the application.
#[derive(Debug, Clone, PartialEq)]
#[allow(
    clippy::large_enum_variant,
    reason = "runtime effects preserve the exact public terminal event payload"
)]
pub(crate) enum RuntimeEffect {
    /// Bytes the parser generated in answer to the child. They go to the PTY
    /// writer. They are never delivered to a subscriber.
    ReplyToChild(Vec<u8>),
    /// An event for every attached subscriber.
    Publish(TerminalEvent),
}

/// Effects of a chunk of child output.
///
/// The published payload is the chunk exactly as it arrived. The engine's
/// answer, when it produced one, is written back to the child first so it keeps
/// its place in the ordering with the mutation that caused it.
pub(crate) fn plan_child_output(
    data: &[u8],
    reply: Vec<u8>,
    sequence: u64,
    revision: TerminalRevision,
) -> Vec<RuntimeEffect> {
    let mut effects = Vec::new();
    if !reply.is_empty() {
        effects.push(RuntimeEffect::ReplyToChild(reply));
    }
    effects.push(RuntimeEffect::Publish(TerminalEvent::Output {
        sequence,
        revision,
        data: Arc::from(data),
    }));
    effects
}

/// Whether a resize may proceed, and why not when it may not.
///
/// Resizing is the one operation a client can drive that mutates host geometry,
/// so it is refused unless the caller is the current renderer authority. The
/// checks are ordered by how final they are: an exited terminal cannot become
/// resizable again, a closing one will not, and authority can change.
pub(crate) fn resize_admission(
    state: RuntimeLiveness,
    resize_authority: Option<TerminalAttachmentId>,
    attachment_id: TerminalAttachmentId,
    terminal_id: &str,
) -> Result<(), TerminalError> {
    match state {
        RuntimeLiveness::Exited => Err(TerminalError::new(
            TerminalErrorCode::Exited,
            format!("Terminal {terminal_id} has exited"),
        )),
        RuntimeLiveness::Closing => Err(TerminalError::new(
            TerminalErrorCode::Closing,
            format!("Terminal {terminal_id} is closing"),
        )),
        RuntimeLiveness::Running if resize_authority != Some(attachment_id) => {
            Err(TerminalError::new(
                TerminalErrorCode::InvalidRequest,
                "Resize rejected because this attachment is not the current renderer authority",
            ))
        }
        RuntimeLiveness::Running => Ok(()),
    }
}

/// How far through its lifecycle the runtime is. Ordered: a terminal never
/// moves back up this list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeLiveness {
    Running,
    Closing,
    Exited,
}

impl RuntimeLiveness {
    pub(crate) fn of(exited: bool, closing: bool) -> Self {
        if exited {
            Self::Exited
        } else if closing {
            Self::Closing
        } else {
            Self::Running
        }
    }
}

/// What happened when an event was offered to one subscriber's mailbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeliveryOutcome {
    Delivered,
    /// The mailbox is at its flow-control budget.
    Full,
    /// The receiving end is gone.
    Disconnected,
}

/// What to do with a subscriber after offering it an event.
///
/// A full mailbox is recoverable and a dropped one is not, so overflow asks the
/// client to resync before the subscription goes away. Dropping it silently
/// would leave a client believing it had a continuous stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubscriberDisposition {
    Keep,
    ResyncThenRemove,
    Remove,
}

pub(crate) fn subscriber_disposition(outcome: DeliveryOutcome) -> SubscriberDisposition {
    match outcome {
        DeliveryOutcome::Delivered => SubscriberDisposition::Keep,
        DeliveryOutcome::Full => SubscriberDisposition::ResyncThenRemove,
        DeliveryOutcome::Disconnected => SubscriberDisposition::Remove,
    }
}
