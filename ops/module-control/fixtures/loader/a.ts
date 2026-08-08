export const runtimeMarker = "A";

export function activate(host: { readonly react: unknown }) {
  return { marker: runtimeMarker, react: host.react };
}
