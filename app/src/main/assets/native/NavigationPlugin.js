export class NavigationPlugin {
    constructor({ playbackManager }) {
        window['NavigationHelper'] = this;

        this.playbackManager = playbackManager;
    }

    goBack() {
        // Streamix: on a TV the navigation rail gets Back first (see nativeshell.js)
        var shell = window['StreamixShell'];
        if (shell && shell.onBack && shell.onBack()) {
            return;
        }
        var appRouter = window['Emby']['Page'];
        if (appRouter.canGoBack()) {
            appRouter.back();
        } else {
            window['NativeInterface'].exitApp();
        }
    }
}
