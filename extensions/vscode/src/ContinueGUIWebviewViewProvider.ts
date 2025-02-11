import type { FileEdit } from "core";
import { ConfigHandler } from "core/config/ConfigHandler";
import { getTheme } from "./util/getTheme";
import { getExtensionVersion } from "./util/util";
import { getExtensionUri, getNonce, getUniqueId } from "./util/vscode";
import { VsCodeWebviewProtocol } from "./webviewProtocol";
import {
  CancellationToken,
  ExtensionContext,
  ExtensionMode,
  OutputChannel,
  StatusBarAlignment,
  StatusBarItem,
  Uri,
  Webview,
  WebviewPanel,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
  window,
  workspace,
} from "vscode";

export class ContinueGUIWebviewViewProvider implements WebviewViewProvider {
  public static readonly viewType = "pearai.continueGUIView";
  public webviewProtocol: VsCodeWebviewProtocol;

  private updateDebugLogsStatus() {
    const settings = workspace.getConfiguration("pearai");
    this.enableDebugLogs = settings.get<boolean>("enableDebugLogs", false);
    if (this.enableDebugLogs) {
      this.outputChannel.show(true);
    } else {
      this.outputChannel.hide();
    }
  }

  // Show or hide the output channel on enableDebugLogs
  private setupDebugLogsListener() {
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("pearai.enableDebugLogs")) {
        const settings = workspace.getConfiguration("pearai");
        const enableDebugLogs = settings.get<boolean>("enableDebugLogs", false);
        if (enableDebugLogs) {
          this.outputChannel.show(true);
        } else {
          this.outputChannel.hide();
        }
      }
    });
  }
  public setLoginStatus(isLoggedIn: boolean) {
    this.updateLoginStatusBar(isLoggedIn);
  }

  private loginStatusBarItem: StatusBarItem | undefined;

  private updateLoginStatusBar(isLoggedIn: boolean) {
    if (!this.loginStatusBarItem) {
      this.loginStatusBarItem = window.createStatusBarItem(
        StatusBarAlignment.Left,
      );
      this.loginStatusBarItem.command = "pearai.login";
    }

    this.loginStatusBarItem.text = `$(${isLoggedIn ? "check" : "x"}) PearAI: ${
      isLoggedIn ? "Logged In" : "Not Logged In"
    }`;
    this.loginStatusBarItem.tooltip = isLoggedIn
      ? "Click to view account"
      : "Click to log in";
    this.loginStatusBarItem.show();
  }

  private async handleWebviewMessage(message: any) {
    if (message.messageType === "log") {
      const settings = workspace.getConfiguration("pearai");
      const enableDebugLogs = settings.get<boolean>("enableDebugLogs", false);

      if (message.level === "debug" && !enableDebugLogs) {
        return; // Skip debug logs if enableDebugLogs is false
      }

      const timestamp = new Date().toISOString().split(".")[0];
      const logMessage = `[${timestamp}] [${message.level.toUpperCase()}] ${
        message.text
      }`;
      this.outputChannel.appendLine(logMessage);
    }
  }

  resolveWebviewView(
    webviewView: WebviewView,
    _context: WebviewViewResolveContext,
    _token: CancellationToken,
  ): void | Thenable<void> {
    this._webview = webviewView.webview;
    this._webview.onDidReceiveMessage((message) =>
      this.handleWebviewMessage(message),
    );
    webviewView.webview.html = this.getSidebarContent(
      this.extensionContext,
      webviewView,
    );
  }

  private _webview?: Webview;
  private _webviewView?: WebviewView;
  private outputChannel: OutputChannel;
  private enableDebugLogs: boolean;

  get isVisible() {
    return this._webviewView?.visible;
  }

  get webview() {
    return this._webview;
  }

  public resetWebviewProtocolWebview(): void {
    if (this._webview) {
      this.webviewProtocol.webview = this._webview;
    } else {
      console.warn("no webview found during reset");
    }
  }

  sendMainUserInput(input: string) {
    this.webview?.postMessage({
      type: "userInput",
      input,
    });
  }

  constructor(
    private readonly configHandlerPromise: Promise<ConfigHandler>,
    private readonly windowId: string,
    private readonly extensionContext: ExtensionContext,
  ) {
    this.outputChannel = window.createOutputChannel("Continue");
    this.enableDebugLogs = false;
    this.updateDebugLogsStatus();
    this.setupDebugLogsListener();
    this.setLoginStatus(false); // Initially set to not loggedin
    this.webviewProtocol = new VsCodeWebviewProtocol(
      (async () => {
        const configHandler = await this.configHandlerPromise;
        return configHandler.reloadConfig();
      }).bind(this),
    );
  }

  getSidebarContent(
    context: ExtensionContext | undefined,
    panel: WebviewPanel | WebviewView,
    page: string | undefined = undefined,
    edits: FileEdit[] | undefined = undefined,
    isFullScreen = false,
  ): string {
    const extensionUri = getExtensionUri();
    let scriptUri: string;
    let styleMainUri: string;
    const vscMediaUrl: string = panel.webview
      .asWebviewUri(Uri.joinPath(extensionUri, "gui"))
      .toString();

    const inDevelopmentMode =
      context?.extensionMode === ExtensionMode.Development;
    if (!inDevelopmentMode) {
      scriptUri = panel.webview
        .asWebviewUri(Uri.joinPath(extensionUri, "gui/assets/index.js"))
        .toString();
      styleMainUri = panel.webview
        .asWebviewUri(Uri.joinPath(extensionUri, "gui/assets/index.css"))
        .toString();
    } else {
      scriptUri = "http://localhost:5173/src/main.tsx";
      styleMainUri = "http://localhost:5173/src/index.css";
    }

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.joinPath(extensionUri, "gui"),
        Uri.joinPath(extensionUri, "assets"),
      ],
      enableCommandUris: true,
      portMapping: [
        {
          webviewPort: 65433,
          extensionHostPort: 65433,
        },
      ],
    };

    const nonce = getNonce();

    const currentTheme = getTheme();
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("workbench.colorTheme")) {
        // Send new theme to GUI to update embedded Monaco themes
        this.webviewProtocol?.request("setTheme", { theme: getTheme() });
      }
    });

    this.webviewProtocol.webview = panel.webview;

    return `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script>const vscode = acquireVsCodeApi();</script>
        <link href="${styleMainUri}" rel="stylesheet">

        <title>Continue</title>
      </head>
      <body>
        <div id="root"></div>

        ${`<script>
        function log(level, ...args) {
          const text = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
          ).join(' ');
          vscode.postMessage({ messageType: 'log', level, text, messageId: "log" });
        }

        window.console.log = (...args) => log('log', ...args);
        window.console.info = (...args) => log('info', ...args);
        window.console.warn = (...args) => log('warn', ...args);
        window.console.error = (...args) => log('error', ...args);
        window.console.debug = (...args) => log('debug', ...args);

        console.debug('Logging initialized');
        </script>`}
        ${
          inDevelopmentMode
            ? `<script type="module">
          import RefreshRuntime from "http://localhost:5173/@react-refresh"
          RefreshRuntime.injectIntoGlobalHook(window)
          window.$RefreshReg$ = () => {}
          window.$RefreshSig$ = () => (type) => type
          window.__vite_plugin_react_preamble_installed__ = true
          </script>`
            : ""
        }

        <script type="module" nonce="${nonce}" src="${scriptUri}"></script>

        <script>localStorage.setItem("ide", '"vscode"')</script>
        <script>localStorage.setItem("extensionVersion", '"${getExtensionVersion()}"')</script>
        <script>window.windowId = "${this.windowId}"</script>
        <script>window.vscMachineId = "${getUniqueId()}"</script>
        <script>window.vscMediaUrl = "${vscMediaUrl}"</script>
        <script>window.ide = "vscode"</script>
        <script>window.fullColorTheme = ${JSON.stringify(currentTheme)}</script>
        <script>window.colorThemeName = "dark-plus"</script>
        <script>window.workspacePaths = ${JSON.stringify(
          workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) || [],
        )}</script>
        <script>window.isFullScreen = ${isFullScreen}</script>

        ${
          edits
            ? `<script>window.edits = ${JSON.stringify(edits)}</script>`
            : ""
        }
        ${page ? `<script>window.location.pathname = "${page}"</script>` : ""}
      </body>
    </html>`;
  }
}
