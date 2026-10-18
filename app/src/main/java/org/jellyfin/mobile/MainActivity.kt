package org.jellyfin.mobile

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.Service
import android.content.ComponentName
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.drawable.Animatable
import android.graphics.Color
import android.os.Bundle
import android.os.IBinder
import android.os.SystemClock
import android.provider.Settings
import android.view.KeyEvent
import android.view.OrientationEventListener
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.PathInterpolator
import android.widget.ImageView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.splashscreen.SplashScreen
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.doOnLayout
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.withStarted
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import org.jellyfin.mobile.events.ActivityEventHandler
import org.jellyfin.mobile.player.cast.Chromecast
import org.jellyfin.mobile.player.cast.IChromecast
import org.jellyfin.mobile.player.ui.PlayerFragment
import org.jellyfin.mobile.setup.ConnectFragment
import org.jellyfin.mobile.utils.AndroidVersion
import org.jellyfin.mobile.utils.BackPressInterceptor
import org.jellyfin.mobile.utils.BluetoothPermissionHelper
import org.jellyfin.mobile.utils.Constants
import org.jellyfin.mobile.utils.PermissionRequestHelper
import org.jellyfin.mobile.utils.SmartOrientationListener
import org.jellyfin.mobile.utils.extensions.replaceFragment
import org.jellyfin.mobile.utils.isRemoteNavigationKey
import org.jellyfin.mobile.utils.isWebViewSupported
import org.jellyfin.mobile.webapp.RemotePlayerService
import org.jellyfin.mobile.webapp.WebViewFragment
import org.koin.android.ext.android.get
import org.koin.android.ext.android.inject
import org.koin.androidx.fragment.android.setupKoinFragmentFactory
import org.koin.androidx.viewmodel.ext.android.viewModel

class MainActivity : AppCompatActivity() {
    private val activityEventHandler: ActivityEventHandler = get()
    val mainViewModel: MainViewModel by viewModel()
    val bluetoothPermissionHelper: BluetoothPermissionHelper = BluetoothPermissionHelper(this, get())
    val chromecast: IChromecast = Chromecast()
    private val permissionRequestHelper: PermissionRequestHelper by inject()

    var serviceBinder: RemotePlayerService.ServiceBinder? = null
        private set
    private val serviceConnection: ServiceConnection = object : ServiceConnection {
        override fun onServiceConnected(componentName: ComponentName, binder: IBinder) {
            serviceBinder = binder as? RemotePlayerService.ServiceBinder
        }

        override fun onServiceDisconnected(componentName: ComponentName) {
            serviceBinder = null
        }
    }

    private val orientationListener: OrientationEventListener by lazy { SmartOrientationListener(this) }

    // Branded splash state, see setupSplash()
    private var splashOverlay: View? = null
    private var splashAnimationStartTime = 0L
    private var splashRevealTime = 0L
    private var splashProgressAnimator: ValueAnimator? = null
    private var isContentReady = false
    private var isSplashDismissing = false
    private val isSplashVisible: Boolean
        get() = splashOverlay != null && !isSplashDismissing
    private val splashFallbackStart = Runnable { startSplashAnimation() }

    /**
     * Passes back press events onto the currently visible [Fragment] if it implements the [BackPressInterceptor] interface.
     *
     * If the current fragment does not implement [BackPressInterceptor] or has decided not to intercept the event
     * (see result of [BackPressInterceptor.onInterceptBackPressed]), the topmost backstack entry will be popped.
     *
     * If there is no topmost backstack entry, the event will be passed onto the dispatcher's fallback handler.
     */
    private val onBackPressedCallback: OnBackPressedCallback.() -> Unit = callback@{
        val currentFragment = supportFragmentManager.findFragmentById(R.id.fragment_container)
        if (currentFragment is BackPressInterceptor && currentFragment.onInterceptBackPressed()) {
            // Top fragment handled back press
            return@callback
        }

        // This is the same default action as in Activity.onBackPressed
        if (!supportFragmentManager.isStateSaved && supportFragmentManager.popBackStackImmediate()) {
            // Removed fragment from back stack
            return@callback
        }

        // Let the system handle the back press
        isEnabled = false
        // Make sure that we *really* call the fallback handler
        assert(!onBackPressedDispatcher.hasEnabledCallbacks()) {
            "MainActivity should be the lowest onBackPressCallback"
        }
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true // re-enable callback in case activity isn't finished
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splashScreen = installSplashScreen()
        setupKoinFragmentFactory()
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        setupSplash(splashScreen, savedInstanceState)

        // Check WebView support
        if (!isWebViewSupported()) {
            onContentReady()
            AlertDialog.Builder(this).apply {
                setTitle(R.string.dialog_web_view_not_supported)
                setMessage(R.string.dialog_web_view_not_supported_message)
                setCancelable(false)
                if (AndroidVersion.isAtLeastN) {
                    setNeutralButton(R.string.dialog_button_open_settings) { _, _ ->
                        startActivity(Intent(Settings.ACTION_WEBVIEW_SETTINGS))
                        Toast.makeText(context, R.string.toast_reopen_after_change, Toast.LENGTH_LONG).show()
                        finishAfterTransition()
                    }
                }
                setNegativeButton(R.string.dialog_button_close_app) { _, _ ->
                    finishAfterTransition()
                }
            }.show()
            return
        }

        // Bind player service
        bindService(Intent(this, RemotePlayerService::class.java), serviceConnection, Service.BIND_AUTO_CREATE)

        // Subscribe to activity events
        with(activityEventHandler) { subscribe() }

        // Load UI
        lifecycleScope.launch {
            mainViewModel.serverState.collectLatest { state ->
                lifecycle.withStarted {
                    handleServerState(state)
                }
            }
        }

        // Handle back presses
        onBackPressedDispatcher.addCallback(this, onBackPressed = onBackPressedCallback)

        // Keep remote focus on whichever screen is on top
        supportFragmentManager.addOnBackStackChangedListener { updateWebViewFocus() }

        // Setup Chromecast
        chromecast.initializePlugin(this)
    }

    /**
     * Takes over from the black system splash with the Streamix splash: the animated intro (ring draws
     * itself, play button zooms in), then the logo glides up and the wordmark and developer credits
     * fade in. The overlay stays until [onContentReady] (or a time limit).
     */
    private fun setupSplash(splashScreen: SplashScreen, savedInstanceState: Bundle?) {
        val overlay = findViewById<View>(R.id.splash_overlay)
        if (savedInstanceState != null) {
            // Recreated activity: the user has already seen the splash
            (overlay.parent as ViewGroup).removeView(overlay)
            return
        }
        splashOverlay = overlay

        splashScreen.setOnExitAnimationListener { provider ->
            // Black on black, so removing the system splash is invisible
            overlay.removeCallbacks(splashFallbackStart)
            provider.remove()
            startSplashAnimation()
        }
        // The exit listener isn't called when the system skips its splash. Count from our own first
        // layout, so a slow start can't run the intro while the system splash still covers it.
        overlay.doOnLayout { overlay.postDelayed(splashFallbackStart, SPLASH_FALLBACK_START_MS) }
        overlay.postDelayed({ dismissSplash() }, SPLASH_MAX_MS)
    }

    private fun startSplashAnimation() {
        val overlay = splashOverlay ?: return
        if (splashAnimationStartTime != 0L) return
        splashAnimationStartTime = SystemClock.uptimeMillis()
        splashRevealTime = splashAnimationStartTime + SPLASH_INTRO_MS

        val logo = overlay.findViewById<ImageView>(R.id.splash_logo)
        (logo.drawable as? Animatable)?.start()

        val easeOut = PathInterpolator(0.2f, 0.8f, 0.2f, 1f)
        val logoScale = resources.getDimension(R.dimen.splash_logo_final_size) / resources.getDimension(R.dimen.splash_logo_size)

        overlay.findViewById<View>(R.id.splash_glow).animate()
            .alpha(1f)
            .setDuration(SPLASH_GLOW_MS)
            .setInterpolator(easeOut)
            .withLayer()
            .start()
        logo.animate()
            .translationY(-resources.getDimension(R.dimen.splash_logo_shift))
            .scaleX(logoScale)
            .scaleY(logoScale)
            .setStartDelay(SPLASH_INTRO_MS + SPLASH_LOGO_DELAY_MS)
            .setDuration(SPLASH_LOGO_MS)
            .setInterpolator(easeOut)
            .withLayer()
            .start()
        overlay.findViewById<View>(R.id.splash_wordmark).animate()
            .alpha(1f)
            .translationY(resources.getDimension(R.dimen.splash_wordmark_final_offset))
            .setStartDelay(SPLASH_INTRO_MS + SPLASH_WORDMARK_DELAY_MS)
            .setDuration(SPLASH_TEXT_MS)
            .setInterpolator(easeOut)
            .withLayer()
            .start()
        overlay.findViewById<View>(R.id.splash_credits).apply {
            translationY = resources.getDimension(R.dimen.splash_credits_offset)
            animate()
                .alpha(1f)
                .translationY(0f)
                .setStartDelay(SPLASH_INTRO_MS + SPLASH_CREDITS_DELAY_MS)
                .setDuration(SPLASH_TEXT_MS)
                .setInterpolator(easeOut)
                .withLayer()
                .start()
        }

        overlay.postDelayed({ showSplashProgress() }, SPLASH_INTRO_MS + SPLASH_PROGRESS_DELAY_MS)
        overlay.postDelayed({ maybeDismissSplash() }, SPLASH_INTRO_MS + SPLASH_MIN_MS)
    }

    /**
     * Only shown when loading takes a while, so a fast start never flashes a spinner.
     */
    private fun showSplashProgress() {
        val overlay = splashOverlay ?: return
        if (isContentReady || isSplashDismissing) return

        val track = overlay.findViewById<View>(R.id.splash_progress_track)
        val bar = overlay.findViewById<View>(R.id.splash_progress_bar)
        track.animate().alpha(1f).setDuration(SPLASH_PROGRESS_FADE_MS).start()
        splashProgressAnimator = ObjectAnimator.ofFloat(
            bar,
            View.TRANSLATION_X,
            -bar.width.toFloat(),
            track.width.toFloat(),
        ).apply {
            duration = SPLASH_PROGRESS_CYCLE_MS
            interpolator = AccelerateDecelerateInterpolator()
            repeatCount = ValueAnimator.INFINITE
            start()
        }
    }

    /**
     * The first screen (web UI page or connect screen) is drawn underneath, so the splash may go.
     */
    fun onContentReady() {
        if (isContentReady) return
        isContentReady = true
        maybeDismissSplash()
    }

    private fun maybeDismissSplash() {
        if (!isContentReady || splashAnimationStartTime == 0L) return
        if (SystemClock.uptimeMillis() - splashRevealTime < SPLASH_MIN_MS) return
        dismissSplash()
    }

    private fun dismissSplash() {
        val overlay = splashOverlay ?: return
        if (isSplashDismissing) return
        isSplashDismissing = true
        splashProgressAnimator?.cancel()
        splashProgressAnimator = null

        overlay.animate()
            .alpha(0f)
            .scaleX(SPLASH_EXIT_SCALE)
            .scaleY(SPLASH_EXIT_SCALE)
            .setStartDelay(0)
            .setDuration(SPLASH_EXIT_MS)
            .setInterpolator(PathInterpolator(0.4f, 0f, 0.2f, 1f))
            .withLayer()
            .withEndAction {
                (overlay.parent as? ViewGroup)?.removeView(overlay)
                splashOverlay = null
                updateWebViewFocus()
            }
            .start()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (isSplashVisible && isRemoteNavigationKey(event.keyCode)) {
            // OK skips the rest of the splash once the app is ready; other keys would only
            // move focus around the page hidden underneath
            if (event.action == KeyEvent.ACTION_UP && isContentReady) dismissSplash()
            return true
        }

        val currentFragment = supportFragmentManager.findFragmentById(R.id.fragment_container)
        if (currentFragment is PlayerFragment && currentFragment.onRemoteKeyEvent(event)) return true

        return super.dispatchKeyEvent(event)
    }

    /**
     * The web UI stays alive under the player, settings and downloads screens. Stop the remote
     * from moving focus into it while it's covered, and give focus back when it's on top again.
     */
    private fun updateWebViewFocus() {
        val webViewFragment = supportFragmentManager.fragments.firstOrNull { it is WebViewFragment } as? WebViewFragment
            ?: return
        val currentFragment = supportFragmentManager.findFragmentById(R.id.fragment_container)
        webViewFragment.setRemoteFocusEnabled(currentFragment === webViewFragment)
    }

    override fun onStart() {
        super.onStart()
        orientationListener.enable()
    }

    private fun handleServerState(state: ServerState) {
        with(supportFragmentManager) {
            val currentFragment = findFragmentById(R.id.fragment_container)
            when (state) {
                ServerState.Pending -> {
                    // TODO add loading indicator
                }
                is ServerState.Unset -> {
                    if (currentFragment !is ConnectFragment) {
                        replaceFragment<ConnectFragment>()
                    }
                }
                is ServerState.Available -> {
                    if (currentFragment !is WebViewFragment || currentFragment.server != state.server) {
                        replaceFragment<WebViewFragment>(
                            Bundle().apply {
                                putParcelable(Constants.FRAGMENT_WEB_VIEW_EXTRA_SERVER, state.server)
                            },
                        )
                    }
                }
            }
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)

        permissionRequestHelper.handleRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    override fun onSupportNavigateUp(): Boolean {
        onBackPressedDispatcher.onBackPressed()
        return true
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        for (fragment in supportFragmentManager.fragments) {
            if (fragment is PlayerFragment && fragment.isVisible) {
                fragment.onUserLeaveHint()
            }
        }
    }

    override fun onStop() {
        super.onStop()
        orientationListener.disable()
    }

    override fun onDestroy() {
        splashProgressAnimator?.cancel()
        unbindService(serviceConnection)
        chromecast.destroy()
        super.onDestroy()
    }

    private companion object {
        const val SYSTEM_SPLASH_FADE_MS = 220L

        /** Length of @drawable/ic_splash_animated */
        const val SPLASH_INTRO_MS = 1000L
        const val SPLASH_FALLBACK_START_MS = 400L
        const val SPLASH_GLOW_MS = 700L
        const val SPLASH_LOGO_DELAY_MS = 80L
        const val SPLASH_LOGO_MS = 650L
        const val SPLASH_WORDMARK_DELAY_MS = 260L
        const val SPLASH_CREDITS_DELAY_MS = 460L
        const val SPLASH_TEXT_MS = 560L
        const val SPLASH_PROGRESS_DELAY_MS = 1400L
        const val SPLASH_PROGRESS_FADE_MS = 300L
        const val SPLASH_PROGRESS_CYCLE_MS = 1100L

        /** Credits on screen after the intro: long enough to read, short enough not to feel slow. */
        const val SPLASH_MIN_MS = 2000L

        /** Safety net: never hold the user on the splash longer than this. */
        const val SPLASH_MAX_MS = 12_000L
        const val SPLASH_EXIT_MS = 420L
        const val SPLASH_EXIT_SCALE = 1.04f
    }
}
