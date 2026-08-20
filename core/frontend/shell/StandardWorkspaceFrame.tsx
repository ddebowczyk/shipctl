import type { ReactNode } from "react";

import "./standardWorkspaceFrame.css";

export interface StandardWorkspaceFrameProps {
  readonly navigation?: ReactNode;
  readonly tabs?: ReactNode;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}

/**
 * Trusted workspace chrome. It owns only neutral regions and deliberately
 * knows nothing about projects, terminals, or any contributed feature.
 */
export default function StandardWorkspaceFrame({
  navigation,
  tabs,
  trailing,
  children,
}: StandardWorkspaceFrameProps) {
  return (
    <div className="app-shell__frame">
      {navigation}
      <main className="workspace-panel">
        {tabs}
        <div className="workspace-stage">
          {children}
        </div>
      </main>
      {trailing}
    </div>
  );
}
