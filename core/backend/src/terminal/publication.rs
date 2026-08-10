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
    TerminalAttachmentId, TerminalDescriptor, TerminalError, TerminalErrorCode, TerminalEvent,
    TerminalReplay, TerminalRevision,
};

/// One ordered effect of a runtime operation. The actor applies these in order;
/// the order is part of the decision, not of the application.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RuntimeEffect {
    /// Bytes the parser generated in answer to the child. They go to the PTY
    /// writer. They are never delivered to a subscriber.
    ReplyToChild(Vec<u8>),
    /// A descriptor change for the registry sink.
    Descriptor(TerminalDescriptor),
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

/// Effects of an answer the parser produced outside the child's output stream.
///
/// Setting the theme is the one operation that does this: the engine reports the
/// new colours back to the child. The answer is its own plan because it must be
/// written before the change is recorded — if the child cannot be answered, the
/// revision and the sequence must stay where they were.
pub(crate) fn plan_child_reply(reply: Vec<u8>) -> Vec<RuntimeEffect> {
    if reply.is_empty() {
        return Vec::new();
    }
    vec![RuntimeEffect::ReplyToChild(reply)]
}

/// Effects of an operation that reconstructs the screen: a resize or a theme
/// change. Both publish one descriptor and exactly one replay, and neither asks
/// the child anything.
pub(crate) fn plan_replay_transition(
    descriptor: TerminalDescriptor,
    replay: TerminalReplay,
    sequence: u64,
) -> Vec<RuntimeEffect> {
    vec![
        RuntimeEffect::Descriptor(descriptor),
        RuntimeEffect::Publish(TerminalEvent::Replay { sequence, replay }),
    ]
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use crate::terminal::types::{TerminalId, TerminalLifecycle, TerminalMetadata, TerminalOwner};

    fn descriptor() -> TerminalDescriptor {
        TerminalDescriptor {
            id: TerminalId::new(),
            revision: TerminalRevision(7),
            lifecycle: TerminalLifecycle::Running,
            exit: None,
            metadata: TerminalMetadata {
                label: "test".to_string(),
                cwd: PathBuf::from("/"),
                project_path: None,
                display_command: "zsh".to_string(),
                created_at_ms: 0,
                owner: TerminalOwner::Core,
                owner_metadata: None,
                presentation: None,
            },
            columns: 80,
            rows: 24,
            last_output_at_ms: None,
            agent_activity: None,
        }
    }

    fn replay() -> TerminalReplay {
        TerminalReplay {
            revision: TerminalRevision(7),
            columns: 80,
            rows: 24,
            bytes: Arc::from(b"replayed".as_slice()),
        }
    }

    /// Every event a plan would deliver to a subscriber.
    fn published(effects: &[RuntimeEffect]) -> Vec<TerminalEvent> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                RuntimeEffect::Publish(event) => Some(event.clone()),
                _ => None,
            })
            .collect()
    }

    /// Every byte a plan would send to the child.
    fn replied(effects: &[RuntimeEffect]) -> Vec<u8> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                RuntimeEffect::ReplyToChild(bytes) => Some(bytes.clone()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    #[test]
    fn published_output_is_the_chunk_the_child_sent() {
        let data = b"\x1b[31mred\x1b[0m";
        let effects = plan_child_output(data, Vec::new(), 1, TerminalRevision(2));
        match published(&effects).as_slice() {
            [TerminalEvent::Output {
                sequence,
                revision,
                data: payload,
            }] => {
                assert_eq!(
                    &payload[..],
                    data,
                    "the payload is the chunk, byte for byte"
                );
                assert_eq!(*sequence, 1);
                assert_eq!(*revision, TerminalRevision(2));
            }
            other => panic!("expected one Output event, got {other:?}"),
        }
    }

    #[test]
    fn a_query_reply_reaches_the_child_and_no_subscriber() {
        // A cursor position report: the child asked, so the child is answered.
        let reply = b"\x1b[2;4R".to_vec();
        let effects = plan_child_output(b"\x1b[6n", reply.clone(), 1, TerminalRevision(1));

        assert_eq!(replied(&effects), reply, "the answer goes to the child");

        let events = published(&effects);
        assert_eq!(events.len(), 1, "the reply did not become a second event");
        match &events[0] {
            TerminalEvent::Output { data, .. } => assert_eq!(
                &data[..],
                b"\x1b[6n",
                "the published payload is the query, not the answer to it"
            ),
            other => panic!("expected Output, got {other:?}"),
        }
    }

    #[test]
    fn the_reply_is_ordered_before_the_event_that_shares_its_mutation() {
        let effects = plan_child_output(b"\x1b[6n", b"\x1b[2;4R".to_vec(), 1, TerminalRevision(1));
        assert!(
            matches!(effects[0], RuntimeEffect::ReplyToChild(_)),
            "the child is answered before clients are told anything"
        );
    }

    #[test]
    fn output_that_asks_nothing_produces_no_reply() {
        let effects = plan_child_output(b"plain", Vec::new(), 1, TerminalRevision(1));
        assert!(
            replied(&effects).is_empty(),
            "an empty answer is not written to the child"
        );
        assert_eq!(effects.len(), 1, "and produces no effect of its own");
    }

    #[test]
    fn a_theme_change_answers_the_child_without_publishing_the_answer() {
        // This is the second reply producer, and the one a test written against
        // child output alone would miss.
        let reply = b"\x1b]11;rgb:20/40/60\x1b\\".to_vec();
        let effects = plan_child_reply(reply.clone());

        assert_eq!(replied(&effects), reply);
        assert!(
            published(&effects).is_empty(),
            "answering the child tells no client anything"
        );
    }

    #[test]
    fn a_theme_change_that_answers_nothing_produces_no_effect() {
        assert!(plan_child_reply(Vec::new()).is_empty());
    }

    #[test]
    fn a_replay_transition_publishes_one_descriptor_and_one_replay_in_that_order() {
        let effects = plan_replay_transition(descriptor(), replay(), 9);
        assert!(matches!(effects[0], RuntimeEffect::Descriptor(_)));
        assert!(matches!(effects[1], RuntimeEffect::Publish(_)));
        assert_eq!(
            effects.len(),
            2,
            "a reconstruction is not two reconstructions"
        );
    }

    #[test]
    fn a_replay_transition_asks_the_child_nothing() {
        let effects = plan_replay_transition(descriptor(), replay(), 9);
        assert!(replied(&effects).is_empty());
    }

    #[test]
    fn no_planner_can_put_reply_bytes_into_a_client_event() {
        // The guarantee stated as a property over both producers: whatever the
        // reply is, it is absent from every published payload.
        let reply = b"\x1b[2;4R".to_vec();
        let plans = [
            plan_child_output(b"\x1b[6n", reply.clone(), 1, TerminalRevision(1)),
            plan_child_reply(reply.clone()),
        ];
        for effects in plans {
            for event in published(&effects) {
                let payload = match event {
                    TerminalEvent::Output { data, .. } => data.to_vec(),
                    TerminalEvent::Replay { replay, .. } => replay.bytes.to_vec(),
                    other => panic!("unexpected published event {other:?}"),
                };
                assert!(
                    !payload
                        .windows(reply.len())
                        .any(|window| window == reply.as_slice()),
                    "a parser reply reached a client event stream"
                );
            }
        }
    }

    #[test]
    fn a_resize_needs_the_renderer_authority() {
        let holder = TerminalAttachmentId::new();
        let other = TerminalAttachmentId::new();

        assert!(
            resize_admission(RuntimeLiveness::Running, Some(holder), holder, "t").is_ok(),
            "the authority may resize"
        );

        let refused = resize_admission(RuntimeLiveness::Running, Some(holder), other, "t")
            .expect_err("a second attachment must not resize");
        assert_eq!(refused.code, TerminalErrorCode::InvalidRequest);

        let unclaimed = resize_admission(RuntimeLiveness::Running, None, holder, "t")
            .expect_err("an unclaimed terminal has no authority to be");
        assert_eq!(unclaimed.code, TerminalErrorCode::InvalidRequest);
    }

    #[test]
    fn lifecycle_refusals_outrank_authority() {
        let holder = TerminalAttachmentId::new();
        // Holding the authority does not make a dead terminal resizable, and
        // the caller is told which of the two reasons applies.
        assert_eq!(
            resize_admission(RuntimeLiveness::Exited, Some(holder), holder, "t")
                .expect_err("exited")
                .code,
            TerminalErrorCode::Exited
        );
        assert_eq!(
            resize_admission(RuntimeLiveness::Closing, Some(holder), holder, "t")
                .expect_err("closing")
                .code,
            TerminalErrorCode::Closing
        );
    }

    #[test]
    fn liveness_reports_the_furthest_state_reached() {
        assert_eq!(RuntimeLiveness::of(false, false), RuntimeLiveness::Running);
        assert_eq!(RuntimeLiveness::of(false, true), RuntimeLiveness::Closing);
        assert_eq!(RuntimeLiveness::of(true, false), RuntimeLiveness::Exited);
        // A terminal that exited while closing has exited.
        assert_eq!(RuntimeLiveness::of(true, true), RuntimeLiveness::Exited);
    }

    #[test]
    fn a_full_mailbox_is_told_to_resync_and_a_dropped_one_is_not() {
        assert_eq!(
            subscriber_disposition(DeliveryOutcome::Delivered),
            SubscriberDisposition::Keep
        );
        assert_eq!(
            subscriber_disposition(DeliveryOutcome::Full),
            SubscriberDisposition::ResyncThenRemove
        );
        assert_eq!(
            subscriber_disposition(DeliveryOutcome::Disconnected),
            SubscriberDisposition::Remove
        );
    }
}
