export const runtimeMarker = "B";

export function activate(host: { readonly react: unknown }) {
  return { marker: runtimeMarker, react: host.react };
}
