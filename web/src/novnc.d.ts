declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string }; shared?: boolean });
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    focus(): void;
    blur(): void;
    disconnect(): void;
    sendCredentials(credentials: { password?: string }): void;
  }
}
