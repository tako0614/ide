/** Reviewed startup authority; no request/config/environment supplies these paths. */
export function ownedChatgptStartupOptions() {
  return {
    computerOwnedChatgpt: {
      stateRoot: '/var/lib/deckide-chatgpt',
      producerStateDir: '/var/lib/deckide-chatgpt',
    },
    computerVncSandbox: {
      expectedLauncherSha256: '927ff0b4d21183e008f665d68978f944c2550ea65202ec1462087f7ef31cfeec',
      expectedFilterSha256: 'dc159080d3fb3013273eb8badcee46347501de0054da5bab7e72b130fab91c7e',
    },
  };
}
