/** Reviewed startup authority; no request/config/environment supplies these paths. */
export function ownedChatgptStartupOptions() {
  return {
    computerOwnedChatgpt: {
      stateRoot: '/var/lib/deckide-chatgpt',
      producerStateDir: '/var/lib/deckide-chatgpt',
      // Verified owner launch contract: Xvfb -screen 0 1440x960x24.
      // The sealed v4 gate requires the upstream ServerInit to match exactly.
      framebuffer: { width: 1440, height: 960 },
    },
    computerVncSandbox: {
      expectedLauncherSha256: '927ff0b4d21183e008f665d68978f944c2550ea65202ec1462087f7ef31cfeec',
      expectedFilterSha256: 'dc159080d3fb3013273eb8badcee46347501de0054da5bab7e72b130fab91c7e',
    },
  };
}
