//! Native host integration for the usage module.

use std::path::PathBuf;
use std::sync::Arc;

use shipctl_core::message_bus::{MessageEnvelope, MessageTypeId, MESSAGE_CONTRACT_SCHEMA_VERSION};
use shipctl_core::plugin_data::{PluginDataScope, PluginDataService};
use shipctl_module_api::{DurableWriteBarrier, SnapshotProvider};
use shipctl_module_usage::{GlobalCapabilityDataAuthority, HostServices, UsageIngestNotifier};
use shipctl_tauri_adapter::MessageBusBridgeService;
use tauri::{AppHandle, Builder, Runtime};

const USAGE_MODULE_ID: &str = "shipctl.usage";
const USAGE_INGEST_COMPLETED: &str = "usage.ingest-completed";

struct PluginUsageData {
    plugin_data: PluginDataService,
}

#[derive(Clone)]
struct RuntimeMessageUsageIngestNotifier {
    messages: MessageBusBridgeService,
}

impl UsageIngestNotifier for RuntimeMessageUsageIngestNotifier {
    fn ingest_completed(&self) {
        let messages = self.messages.clone();
        tauri::async_runtime::spawn(async move {
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

impl GlobalCapabilityDataAuthority for PluginUsageData {
    fn read(&self, capability_id: &str) -> Result<Option<serde_json::Value>, String> {
        if capability_id != "usage" {
            return Err("Usage requested an unknown plugin-data record".to_string());
        }
        self.plugin_data
            .read_owned_value(USAGE_MODULE_ID, &PluginDataScope::Global, "settings")
    }
}

fn host_services(
    plugin_data: PluginDataService,
    messages: MessageBusBridgeService,
) -> HostServices {
    HostServices::with_ingest_notifier(
        Arc::new(PluginUsageData { plugin_data }),
        Arc::new(RuntimeMessageUsageIngestNotifier { messages }),
    )
}

pub fn install<R: Runtime>(
    builder: Builder<R>,
    plugin_data: PluginDataService,
    messages: MessageBusBridgeService,
    database_path: PathBuf,
    durable_writes: DurableWriteBarrier,
) -> Builder<R> {
    builder.plugin(shipctl_module_usage::init(
        host_services(plugin_data, messages),
        database_path,
        durable_writes,
    ))
}

pub fn snapshot_provider(path: PathBuf) -> Arc<dyn SnapshotProvider> {
    Arc::new(shipctl_module_usage::UsageSnapshotProvider::new(path))
}

pub fn start_background_ingest<R: Runtime>(app: &AppHandle<R>) {
    shipctl_module_usage::start_background_ingest(app);
}
