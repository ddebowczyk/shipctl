//! Native credential authority. Public callers use redacted credential IDs;
//! secret bytes remain inside this provider and the operating-system store.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

pub const CREDENTIAL_STORE_TRANSPORT_FAILED: &str = "credential-store.transport-failed";
pub const CREDENTIAL_STORE_DENIED: &str = "credential-store.denied";
pub const CREDENTIAL_STORE_INVALID_REQUEST: &str = "credential-store.invalid-request";
pub const CREDENTIAL_STORE_UNAVAILABLE: &str = "credential-store.unavailable";
pub const CREDENTIAL_STORE_ACTIVATION_DISPOSED: &str = "credential-store.activation-disposed";

const PI_API_KEY_PREFIX: &str = "pi.api-key:";
const KEYCHAIN_ACCOUNT: &str = "shipctl-pi";
const LEGACY_KEYCHAIN_ACCOUNT: &str = "shep-pi";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialStoreActor {
    pub module_id: String,
    pub activation_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStoreError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub credential_id: String,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PiAuthEntry {
    #[serde(rename = "type")]
    entry_type: String,
    key: String,
}

trait CredentialBackend: Send + Sync {
    fn has(&self, provider: &str) -> Result<bool, ()>;
    fn save(&self, provider: &str, secret: &str) -> Result<(), ()>;
    fn delete(&self, provider: &str) -> Result<(), ()>;
}

#[derive(Default)]
struct PiKeychainBackend;

impl CredentialBackend for PiKeychainBackend {
    fn has(&self, provider: &str) -> Result<bool, ()> {
        let path = pi_auth_path().map_err(|_| ())?;
        if !path.exists() {
            return Ok(false);
        }
        let content = fs::read_to_string(path).map_err(|_| ())?;
        let auth: HashMap<String, PiAuthEntry> = serde_json::from_str(&content).unwrap_or_default();
        if !auth.contains_key(provider) {
            return Ok(false);
        }
        Ok(
            keychain_entry_exists(KEYCHAIN_ACCOUNT, &service_name(provider))
                || keychain_entry_exists(LEGACY_KEYCHAIN_ACCOUNT, &legacy_service_name(provider)),
        )
    }

    fn save(&self, provider: &str, secret: &str) -> Result<(), ()> {
        let service = service_name(provider);
        let output = Command::new("security")
            .args([
                "add-generic-password",
                "-U",
                "-a",
                KEYCHAIN_ACCOUNT,
                "-s",
                &service,
                "-w",
                secret,
            ])
            .output()
            .map_err(|_| ())?;
        if !output.status.success() {
            return Err(());
        }
        update_auth_entry(provider, &auth_command(&service)).map_err(|_| ())
    }

    fn delete(&self, provider: &str) -> Result<(), ()> {
        let service = service_name(provider);
        let _ = Command::new("security")
            .args([
                "delete-generic-password",
                "-a",
                KEYCHAIN_ACCOUNT,
                "-s",
                &service,
            ])
            .output();
        remove_auth_entry(provider).map_err(|_| ())
    }
}

#[derive(Default)]
struct CredentialStoreState {
    released_activations: HashSet<(String, String)>,
}

struct CredentialStoreServiceInner {
    backend: Arc<dyn CredentialBackend>,
    state: Mutex<CredentialStoreState>,
}

#[derive(Clone)]
pub struct CredentialStoreService {
    inner: Arc<CredentialStoreServiceInner>,
}

impl Default for CredentialStoreService {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialStoreService {
    pub fn new() -> Self {
        Self::with_backend(Arc::new(PiKeychainBackend))
    }

    fn with_backend(backend: Arc<dyn CredentialBackend>) -> Self {
        Self {
            inner: Arc::new(CredentialStoreServiceInner {
                backend,
                state: Mutex::new(CredentialStoreState::default()),
            }),
        }
    }

    pub fn has_credential(
        &self,
        actor: &CredentialStoreActor,
        credential_id: String,
    ) -> Result<CredentialStatus, CredentialStoreError> {
        let provider = self.authorize(actor, &credential_id)?;
        let configured = self
            .inner
            .backend
            .has(provider)
            .map_err(|_| unavailable_error())?;
        Ok(CredentialStatus {
            credential_id,
            configured,
        })
    }

    pub fn save_credential(
        &self,
        actor: &CredentialStoreActor,
        credential_id: String,
        secret: String,
    ) -> Result<CredentialStatus, CredentialStoreError> {
        let provider = self.authorize(actor, &credential_id)?;
        if secret.is_empty() {
            return Err(invalid_error("Credential secret cannot be empty"));
        }
        self.inner
            .backend
            .save(provider, &secret)
            .map_err(|_| unavailable_error())?;
        Ok(CredentialStatus {
            credential_id,
            configured: true,
        })
    }

    pub fn delete_credential(
        &self,
        actor: &CredentialStoreActor,
        credential_id: String,
    ) -> Result<CredentialStatus, CredentialStoreError> {
        let provider = self.authorize(actor, &credential_id)?;
        self.inner
            .backend
            .delete(provider)
            .map_err(|_| unavailable_error())?;
        Ok(CredentialStatus {
            credential_id,
            configured: false,
        })
    }

    pub fn release_activation(
        &self,
        actor: &CredentialStoreActor,
    ) -> Result<bool, CredentialStoreError> {
        validate_actor(actor)?;
        if actor.module_id != "shipctl.assistants" {
            return Err(denied_error());
        }
        let mut state = self.inner.state.lock().map_err(|_| state_error())?;
        Ok(state
            .released_activations
            .insert((actor.module_id.clone(), actor.activation_id.clone())))
    }

    fn authorize<'a>(
        &self,
        actor: &CredentialStoreActor,
        credential_id: &'a str,
    ) -> Result<&'a str, CredentialStoreError> {
        validate_actor(actor)?;
        if actor.module_id != "shipctl.assistants" {
            return Err(denied_error());
        }
        let state = self.inner.state.lock().map_err(|_| state_error())?;
        if state
            .released_activations
            .contains(&(actor.module_id.clone(), actor.activation_id.clone()))
        {
            return Err(CredentialStoreError {
                code: CREDENTIAL_STORE_ACTIVATION_DISPOSED.to_string(),
                message: "The credential-store activation is no longer active".to_string(),
                retryable: false,
            });
        }
        pi_provider(credential_id).ok_or_else(|| invalid_error("Credential identity is invalid"))
    }
}

fn pi_provider(credential_id: &str) -> Option<&str> {
    let provider = credential_id.strip_prefix(PI_API_KEY_PREFIX)?;
    (!provider.is_empty()
        && provider.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        }))
    .then_some(provider)
}

fn validate_actor(actor: &CredentialStoreActor) -> Result<(), CredentialStoreError> {
    if actor.module_id.trim().is_empty()
        || actor.activation_id.trim().is_empty()
        || actor.module_id.chars().any(char::is_control)
        || actor.activation_id.chars().any(char::is_control)
    {
        Err(invalid_error(
            "The credential-store activation identity is invalid",
        ))
    } else {
        Ok(())
    }
}

fn denied_error() -> CredentialStoreError {
    CredentialStoreError {
        code: CREDENTIAL_STORE_DENIED.to_string(),
        message: "Credential access was denied".to_string(),
        retryable: false,
    }
}

fn invalid_error(message: &str) -> CredentialStoreError {
    CredentialStoreError {
        code: CREDENTIAL_STORE_INVALID_REQUEST.to_string(),
        message: message.to_string(),
        retryable: false,
    }
}

fn unavailable_error() -> CredentialStoreError {
    CredentialStoreError {
        code: CREDENTIAL_STORE_UNAVAILABLE.to_string(),
        message: "Credential storage is unavailable".to_string(),
        retryable: false,
    }
}

fn state_error() -> CredentialStoreError {
    CredentialStoreError {
        code: CREDENTIAL_STORE_TRANSPORT_FAILED.to_string(),
        message: "Credential storage state is unavailable".to_string(),
        retryable: false,
    }
}

fn pi_agent_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".pi")
        .join("agent"))
}

fn pi_auth_path() -> Result<PathBuf, String> {
    Ok(pi_agent_dir()?.join("auth.json"))
}

fn service_name(provider: &str) -> String {
    format!("{KEYCHAIN_ACCOUNT}-{provider}")
}

fn legacy_service_name(provider: &str) -> String {
    format!("{LEGACY_KEYCHAIN_ACCOUNT}-{provider}")
}

fn keychain_entry_exists(account: &str, service: &str) -> bool {
    Command::new("security")
        .args(["find-generic-password", "-a", account, "-s", service])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn auth_command(service: &str) -> String {
    format!("!security find-generic-password -a {KEYCHAIN_ACCOUNT} -ws {service}")
}

fn update_auth_entry(provider: &str, key_ref: &str) -> Result<(), String> {
    let directory = pi_agent_dir()?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create ~/.pi/agent dir: {error}"))?;
    let path = pi_auth_path()?;
    let mut auth: HashMap<String, PiAuthEntry> = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read pi auth: {error}"))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        HashMap::new()
    };
    auth.insert(
        provider.to_string(),
        PiAuthEntry {
            entry_type: "api_key".to_string(),
            key: key_ref.to_string(),
        },
    );
    let json = serde_json::to_string_pretty(&auth)
        .map_err(|error| format!("Failed to serialize pi auth: {error}"))?;
    fs::write(path, json).map_err(|error| format!("Failed to write pi auth: {error}"))
}

fn remove_auth_entry(provider: &str) -> Result<(), String> {
    let path = pi_auth_path()?;
    if !path.exists() {
        return Ok(());
    }
    let content =
        fs::read_to_string(&path).map_err(|error| format!("Failed to read pi auth: {error}"))?;
    let mut auth: HashMap<String, PiAuthEntry> = serde_json::from_str(&content).unwrap_or_default();
    auth.remove(provider);
    let json = serde_json::to_string_pretty(&auth)
        .map_err(|error| format!("Failed to serialize pi auth: {error}"))?;
    fs::write(path, json).map_err(|error| format!("Failed to write pi auth: {error}"))
}

#[cfg(test)]
mod provider_properties {
    use super::*;
    use proptest::prelude::*;

    #[derive(Default)]
    struct MemoryBackend {
        values: Mutex<HashMap<String, String>>,
        unavailable: bool,
    }

    impl CredentialBackend for MemoryBackend {
        fn has(&self, provider: &str) -> Result<bool, ()> {
            if self.unavailable {
                return Err(());
            }
            Ok(self.values.lock().unwrap().contains_key(provider))
        }

        fn save(&self, provider: &str, secret: &str) -> Result<(), ()> {
            if self.unavailable {
                return Err(());
            }
            self.values
                .lock()
                .unwrap()
                .insert(provider.to_string(), secret.to_string());
            Ok(())
        }

        fn delete(&self, provider: &str) -> Result<(), ()> {
            if self.unavailable {
                return Err(());
            }
            self.values.lock().unwrap().remove(provider);
            Ok(())
        }
    }

    fn actor(module_id: &str, activation_id: &str) -> CredentialStoreActor {
        CredentialStoreActor {
            module_id: module_id.to_string(),
            activation_id: activation_id.to_string(),
        }
    }

    fn service(backend: Arc<MemoryBackend>) -> CredentialStoreService {
        CredentialStoreService::with_backend(backend)
    }

    proptest! {
        #[test]
        fn architecture_provider_credential_store_parity_property(
            provider in "[A-Za-z0-9][A-Za-z0-9_-]{0,20}",
            secret in ".{1,128}",
            delete_after_save in any::<bool>(),
        ) {
            let backend = Arc::new(MemoryBackend::default());
            let service = service(backend.clone());
            let actor = actor("shipctl.assistants", "parity");
            let credential_id = format!("{PI_API_KEY_PREFIX}{provider}");

            prop_assert!(!service.has_credential(&actor, credential_id.clone()).unwrap().configured);
            let saved = service
                .save_credential(&actor, credential_id.clone(), secret.clone())
                .unwrap();
            prop_assert!(saved.configured);
            let stored = backend.values.lock().unwrap().get(&provider).cloned();
            prop_assert_eq!(stored, Some(secret.clone()));
            if delete_after_save {
                prop_assert!(!service
                    .delete_credential(&actor, credential_id.clone())
                    .unwrap()
                    .configured);
            }
            prop_assert_eq!(
                service.has_credential(&actor, credential_id).unwrap().configured,
                !delete_after_save,
            );
        }

        #[test]
        fn architecture_provider_credential_store_authority_property(
            known_module in any::<bool>(),
            disposed in any::<bool>(),
            valid_scope in any::<bool>(),
            provider in "[A-Za-z0-9][A-Za-z0-9_-]{0,20}",
        ) {
            let service = service(Arc::new(MemoryBackend::default()));
            let candidate = actor(
                if known_module { "shipctl.assistants" } else { "shipctl.unknown" },
                "authority",
            );
            if known_module && disposed {
                service.release_activation(&candidate).unwrap();
            }
            let credential_id = if valid_scope {
                format!("{PI_API_KEY_PREFIX}{provider}")
            } else {
                format!("foreign.secret:{provider}")
            };
            let result = service.has_credential(&candidate, credential_id);
            let expected = if !known_module {
                Some(CREDENTIAL_STORE_DENIED)
            } else if disposed {
                Some(CREDENTIAL_STORE_ACTIVATION_DISPOSED)
            } else if !valid_scope {
                Some(CREDENTIAL_STORE_INVALID_REQUEST)
            } else {
                None
            };
            match expected {
                Some(code) => prop_assert_eq!(result.unwrap_err().code, code),
                None => prop_assert!(result.is_ok()),
            }
        }

        #[test]
        fn architecture_provider_credential_store_ownership_property(
            release_owner in any::<bool>(),
            provider in "[A-Za-z0-9][A-Za-z0-9_-]{0,20}",
            secret in ".{1,128}",
        ) {
            let backend = Arc::new(MemoryBackend::default());
            let service = service(backend.clone());
            let owner = actor("shipctl.assistants", "owner");
            let peer = actor("shipctl.assistants", "peer");
            let credential_id = format!("{PI_API_KEY_PREFIX}{provider}");
            service
                .save_credential(&owner, credential_id.clone(), secret.clone())
                .unwrap();
            let (released, live) = if release_owner { (&owner, &peer) } else { (&peer, &owner) };

            service.release_activation(released).unwrap();
            prop_assert_eq!(
                service.has_credential(released, credential_id.clone()).unwrap_err().code,
                CREDENTIAL_STORE_ACTIVATION_DISPOSED,
            );
            let status = service.has_credential(live, credential_id.clone()).unwrap();
            prop_assert!(status.configured);
            let encoded_status = serde_json::to_string(&status).unwrap();
            let stored = backend.values.lock().unwrap().get(&provider).cloned();
            prop_assert_eq!(stored, Some(secret.clone()));

            let comparison_secret = format!("{secret}::shipctl-comparison");
            service
                .save_credential(live, credential_id.clone(), comparison_secret.clone())
                .unwrap();
            let comparison_status = service.has_credential(live, credential_id).unwrap();
            prop_assert_eq!(
                encoded_status,
                serde_json::to_string(&comparison_status).unwrap(),
            );
            let stored = backend.values.lock().unwrap().get(&provider).cloned();
            prop_assert_eq!(stored, Some(comparison_secret));
        }

        #[test]
        fn architecture_provider_credential_store_non_disclosure_property(
            provider in "[A-Za-z0-9][A-Za-z0-9_-]{0,20}",
            secret in ".{1,128}",
        ) {
            let service = service(Arc::new(MemoryBackend {
                values: Mutex::new(HashMap::new()),
                unavailable: true,
            }));
            let actor = actor("shipctl.assistants", "redaction");
            let credential_id = format!("{PI_API_KEY_PREFIX}{provider}");
            let result = service.save_credential(
                &actor,
                credential_id.clone(),
                secret.clone(),
            );
            let comparison = service.save_credential(
                &actor,
                credential_id,
                format!("{secret}::shipctl-comparison"),
            );
            let encoded = serde_json::to_string(&result.unwrap_err()).unwrap();
            let comparison_encoded = serde_json::to_string(&comparison.unwrap_err()).unwrap();
            prop_assert!(encoded.contains(CREDENTIAL_STORE_UNAVAILABLE));
            prop_assert_eq!(encoded, comparison_encoded);
        }
    }
}
