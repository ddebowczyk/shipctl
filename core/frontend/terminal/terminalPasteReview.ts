/** External decisions used by the unsafe-paste review policy. */
export interface TerminalPasteReviewPorts {
  confirmationEnabled(): boolean;
  classify(text: string): Promise<boolean>;
  requestConfirmation(accept: () => void, cancel: () => void): void;
  reportFailure(error: unknown): void;
}

/**
 * Submit paste text now, or hold it for the host-backed confirmation flow.
 *
 * The disabled path does not call the host. This keeps the guard optional and
 * preserves the direct-paste behavior unless the user enables it in config.
 */
export function reviewTerminalPaste(
  ports: TerminalPasteReviewPorts,
  text: string,
  submit: () => void,
): void {
  if (!ports.confirmationEnabled()) {
    submit();
    return;
  }

  void ports.classify(text).then(
    (safe) => {
      if (safe) submit();
      else ports.requestConfirmation(submit, () => undefined);
    },
    (error: unknown) => ports.reportFailure(error),
  );
}
