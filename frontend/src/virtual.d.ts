/** package.json version, set by the inline view's build. */
declare const __APP_VERSION__: string;

declare module 'virtual:inline-fonts' {
  /** Excalidraw font files by path under its fonts/ folder, base64. */
  const fonts: Record<string, string>;
  export default fonts;
}
