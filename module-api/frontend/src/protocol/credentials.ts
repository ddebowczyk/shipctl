import { defineSemanticService } from "./semanticServices.ts";
import type { SemanticRequestOperation } from "./semanticServices";

declare const credentialIdBrand: unique symbol;

/** Stable, namespaced identity. It never describes the native secret store. */
export type CredentialId = string & { readonly [credentialIdBrand]: true };

export function credentialId(namespace: string, localIdentity: string): CredentialId {
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(namespace)) {
    throw new Error("Invalid credential namespace");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(localIdentity)) {
    throw new Error("Invalid credential local identity");
  }
  return `${namespace}:${localIdentity}` as CredentialId;
}

export type CredentialGrant = "credential.inspect" | "credential.write";

export interface InspectCredentialInput {
  readonly credentialId: CredentialId;
}

export interface SaveCredentialInput extends InspectCredentialInput {
  /** Write-only request data. Providers must not copy it into results or traces. */
  readonly secret: string;
}

export type DeleteCredentialInput = InspectCredentialInput;

/** Redacted status and mutation receipt. Secret bytes are never returned. */
export interface CredentialStatus {
  readonly credentialId: CredentialId;
  readonly configured: boolean;
}

export type CredentialStoreErrorCode =
  | "credential-store.transport-failed"
  | "credential-store.denied"
  | "credential-store.invalid-request"
  | "credential-store.unavailable"
  | "credential-store.cancelled"
  | "credential-store.activation-disposed";

export interface CredentialStoreService {
  readonly hasCredential: SemanticRequestOperation<
    InspectCredentialInput,
    CredentialStatus,
    CredentialStoreErrorCode
  >;
  readonly saveCredential: SemanticRequestOperation<
    SaveCredentialInput,
    CredentialStatus,
    CredentialStoreErrorCode
  >;
  readonly deleteCredential: SemanticRequestOperation<
    DeleteCredentialInput,
    CredentialStatus,
    CredentialStoreErrorCode
  >;
}

export const credentialStoreService = defineSemanticService<CredentialStoreService>(
  "shipctl.credential-store",
  1,
);
