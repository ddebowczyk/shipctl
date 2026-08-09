use std::sync::Arc;

use shipctl_core::message_bus::{
    MessageBusBridgeService, MessageEnvelope, MessageTypeId, MESSAGE_CONTRACT_SCHEMA_VERSION,
};
use shipctl_module_usage::{GlobalCapabilityDataAuthority, HostServices, UsageIngestNotifier};

use shipctl_core::workspace::manager::WorkspaceManager;

struct WorkspaceGlobalCapabilityData {
    workspace: WorkspaceManager,
}

const USAGE_MODULE_ID: &str = "shipctl.usage";
const USAGE_INGEST_COMPLETED: &str = "usage.ingest-completed";

#[derive(Clone)]
struct RuntimeMessageUsageIngestNotifier {
    messages: MessageBusBridgeService,
}

impl UsageIngestNotifier for RuntimeMessageUsageIngestNotifier {
    fn ingest_completed(&self) {
        let messages = self.messages.clone();
        tauri::async_runtime::spawn(async move {
            // The route is intentionally best-effort: a completion before a
            // webview activates is reconciled by the next usage refresh.
            let _ = messages
                .publish_for_module(
                    USAGE_MODULE_ID,
                    MessageEnvelope {
                        schema_version: MESSAGE_CONTRACT_SCHEMA_VERSION,
                        endpoint: USAGE_INGEST_COMPLETED.to_owned(),
                        message: MessageTypeId {
                            id: USAGE_INGEST_COMPLETED.to_owned(),
                            version: 1,
                        },
                        payload: serde_json::json!({}),
                        correlation_id: None,
                    },
                )
                .await;
        });
    }
}

impl GlobalCapabilityDataAuthority for WorkspaceGlobalCapabilityData {
    fn read(&self, capability_id: &str) -> Result<Option<serde_json::Value>, String> {
        self.workspace.load_global_capability_data(capability_id)
    }
}

pub fn host_services(
    workspace: WorkspaceManager,
    messages: MessageBusBridgeService,
) -> HostServices {
    HostServices::with_ingest_notifier(
        Arc::new(WorkspaceGlobalCapabilityData { workspace }),
        Arc::new(RuntimeMessageUsageIngestNotifier { messages }),
    )
}
