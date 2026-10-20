package org.jellyfin.mobile.webapp

import android.content.Intent
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.doOnNextLayout
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader.AssetsPathHandler
import androidx.webkit.WebViewCompat
import kotlinx.coroutines.launch
import org.jellyfin.mobile.MainViewModel
import org.jellyfin.mobile.R
import org.jellyfin.mobile.app.AppPreferences
import org.jellyfin.mobile.bridge.ExternalPlayer
import org.jellyfin.mobile.bridge.MediaSegments
import org.jellyfin.mobile.bridge.NativeInterface
import org.jellyfin.mobile.bridge.NativePlayer
import org.jellyfin.mobile.data.entity.ServerEntity
import org.jellyfin.mobile.databinding.FragmentWebviewBinding
import org.jellyfin.mobile.setup.ConnectFragment
import org.jellyfin.mobile.utils.AndroidVersion
import org.jellyfin.mobile.utils.BackPressInterceptor
import org.jellyfin.mobile.utils.Constants
import org.jellyfin.mobile.utils.Constants.FRAGMENT_WEB_VIEW_EXTRA_SERVER
import org.jellyfin.mobile.utils.applyDefault
import org.jellyfin.mobile.utils.applyWindowInsetsAsMargins
import org.jellyfin.mobile.utils.dip
import org.jellyfin.mobile.utils.extensions.getParcelableCompat
import org.jellyfin.mobile.utils.extensions.replaceFragment
import org.jellyfin.mobile.utils.fadeIn
import org.jellyfin.mobile.utils.extensions.requireMainActivity
import org.jellyfin.mobile.utils.isOutdated
import org.jellyfin.mobile.utils.isTvDevice
import org.jellyfin.mobile.utils.requestNoBatteryOptimizations
import org.jellyfin.mobile.utils.runOnUiThread
import org.koin.android.ext.android.inject
import org.koin.androidx.viewmodel.ext.android.activityViewModel

class WebViewFragment : Fragment(), BackPressInterceptor, JellyfinWebChromeClient.FileChooserListener {
    val appPreferences: AppPreferences by inject()
    private val mainViewModel: MainViewModel by activityViewModel()
    private val webappFunctionChannel: WebappFunctionChannel by inject()
    private lateinit var assetsPathHandler: AssetsPathHandler
    private lateinit var jellyfinWebViewClient: JellyfinWebViewClient
    private val nativePlayer: NativePlayer by inject()
    private lateinit var externalPlayer: ExternalPlayer
    private val mediaSegments: MediaSegments by inject()

    lateinit var server: ServerEntity
        private set
    private var connected = false
    private val timeoutRunnable = Runnable {
        handleError()
    }
    private val showLoadingContainerRunnable = Runnable {
        webViewBinding?.loadingContainer?.isVisible = true
    }

    /**
     * Normally nativeshell.js reports the first drawn page. This is the fallback if it never does.
     */
    private val contentReadyFallbackRunnable = Runnable {
        if (isAdded) requireMainActivity().onContentReady()
    }

    // UI
    private var webViewBinding: FragmentWebviewBinding? = null

    /** Phone layout: sets the system bar heights on the page, see [drawBehindSystemBars] */
    private var systemBarsScript: String? = null
    private val pushSystemBarsRunnable = Runnable { pushSystemBars() }

    // External file access
    private var fileChooserActivityLauncher: ActivityResultLauncher<Intent> = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        fileChooserCallback?.onReceiveValue(FileChooserParams.parseResult(result.resultCode, result.data))
    }
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        server = requireNotNull(requireArguments().getParcelableCompat(FRAGMENT_WEB_VIEW_EXTRA_SERVER)) {
            "Server entity has not been supplied!"
        }

        assetsPathHandler = AssetsPathHandler(requireContext())
        jellyfinWebViewClient = object : JellyfinWebViewClient(
            lifecycleScope,
            server,
            assetsPathHandler,
            mainViewModel,
        ) {
            override fun onConnectedToWebapp() {
                val webViewBinding = webViewBinding ?: return
                val webView = webViewBinding.webView
                webView.removeCallbacks(timeoutRunnable)
                webView.removeCallbacks(showLoadingContainerRunnable)
                connected = true
                runOnUiThread {
                    webViewBinding.loadingContainer.isVisible = false
                    webView.fadeIn()
                    // The TV remote drives the web UI through the focused WebView
                    webView.requestFocus()
                    webView.postDelayed(contentReadyFallbackRunnable, Constants.WEB_READY_FALLBACK_DELAY)
                    // The page is new: give it the system bar heights again, and once more when it has settled
                    pushSystemBars()
                    webView.postDelayed(pushSystemBarsRunnable, SYSTEM_BARS_REPEAT_DELAY_MS)
                }
                requestNoBatteryOptimizations(webViewBinding.root)
            }

            override fun onErrorReceived() {
                handleError()
            }
        }
        externalPlayer = ExternalPlayer(requireContext(), this, requireActivity().activityResultRegistry)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        return FragmentWebviewBinding.inflate(inflater, container, false).also { binding ->
            webViewBinding = binding
        }.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val webView = webViewBinding!!.webView

        // Apply window insets: on a TV the page sits inside the safe area; on a phone it runs under the
        // status and navigation bars like a native app
        if (requireContext().isTvDevice()) webView.applyWindowInsetsAsMargins() else webView.drawBehindSystemBars()

        // Setup exclusion rects for gestures
        if (AndroidVersion.isAtLeastQ) {
            @Suppress("MagicNumber")
            webView.doOnNextLayout {
                // Maximum allowed exclusion rect height is 200dp,
                // offsetting 100dp from the center in both directions
                // uses the maximum available space
                val verticalCenter = webView.measuredHeight / 2
                val offset = webView.resources.dip(100)

                // Arbitrary, currently 2x minimum touch target size
                val exclusionWidth = webView.resources.dip(96)

                webView.systemGestureExclusionRects = listOf(
                    Rect(
                        0,
                        verticalCenter - offset,
                        exclusionWidth,
                        verticalCenter + offset,
                    ),
                )
            }
        }

        // Setup WebView
        webView.initialize()

        webViewBinding!!.useDifferentServerButton.setOnClickListener {
            webView.removeCallbacks(timeoutRunnable)
            webView.stopLoading()
            webViewBinding!!.loadingContainer.isVisible = false
            onSelectServer(error = false)
        }

        // Process JS functions called from other components (e.g. the PlayerActivity)
        lifecycleScope.launch {
            for (function in webappFunctionChannel) {
                webView.evaluateJavascript(function, null)
            }
        }
    }

    override fun onInterceptBackPressed(): Boolean {
        return connected && webappFunctionChannel.goBack()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        webViewBinding?.webView?.removeCallbacks(contentReadyFallbackRunnable)
        webViewBinding?.webView?.removeCallbacks(pushSystemBarsRunnable)
        webViewBinding = null
    }

    /**
     * Phone layout: the page fills the screen under the status and navigation bars, so artwork and the glass
     * bars reach the edges. Their heights go to the page as --streamix-inset-top / --streamix-inset-bottom
     * (CSS pixels), which streamix.css keeps the header, tab bar and content clear of. The keyboard still
     * pushes the page up.
     */
    private fun WebView.drawBehindSystemBars() {
        ViewCompat.setOnApplyWindowInsetsListener(this) { view, windowInsets ->
            val bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            view.updateLayoutParams<ViewGroup.MarginLayoutParams> {
                setMargins(bars.left, 0, bars.right, keyboard.bottom)
            }
            val density = resources.displayMetrics.density
            val top = bars.top / density
            val bottom = if (keyboard.bottom > 0) 0f else bars.bottom / density
            systemBarsScript = "(function(s){s.setProperty('--streamix-inset-top','${top}px');" +
                "s.setProperty('--streamix-inset-bottom','${bottom}px')})(document.documentElement.style)"
            pushSystemBars()
            windowInsets
        }
    }

    private fun pushSystemBars() {
        val script = systemBarsScript ?: return
        webViewBinding?.webView?.evaluateJavascript(script, null)
    }

    /**
     * Blocks remote focus while another screen (player, settings, downloads) covers the web UI,
     * and hands focus back to it when it's on top again.
     */
    fun setRemoteFocusEnabled(enabled: Boolean) {
        val binding = webViewBinding ?: return
        if (enabled) {
            binding.root.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
            if (connected) binding.webView.requestFocus()
        } else {
            binding.webView.clearFocus()
            binding.root.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        }
    }

    private fun WebView.initialize() {
        if (!appPreferences.ignoreWebViewChecks && isOutdated()) { // Check WebView version
            showOutdatedWebViewDialog(this)
            return
        }
        webViewClient = jellyfinWebViewClient
        webChromeClient = JellyfinWebChromeClient(this@WebViewFragment)
        settings.applyDefault()

        // Black before the first paint (no white flash), no edge glow, no native scrollbars on TV
        setBackgroundColor(Color.BLACK)
        overScrollMode = View.OVER_SCROLL_NEVER
        if (requireContext().isTvDevice()) {
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            // Keep the page's own focus when the WebView gets focus back (after the splash, player or
            // settings); by default Android jumps to the first element on the page, the top bar
            settings.setNeedInitialFocus(false)
        }
        // Keep the web renderer from being killed under memory pressure while it's on screen
        if (AndroidVersion.isAtLeastO) {
            setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true)
        }
        addJavascriptInterface(NativeInterface(requireContext()), "NativeInterface")
        addJavascriptInterface(nativePlayer, "NativePlayer")
        addJavascriptInterface(externalPlayer, "ExternalPlayer")
        addJavascriptInterface(mediaSegments, "MediaSegments")

        loadUrl("${server.hostname.trimEnd('/')}/")
        postDelayed(timeoutRunnable, Constants.INITIAL_CONNECTION_TIMEOUT)
        postDelayed(showLoadingContainerRunnable, Constants.SHOW_PROGRESS_BAR_DELAY)
    }

    private fun showOutdatedWebViewDialog(webView: WebView) {
        AlertDialog.Builder(requireContext()).apply {
            setTitle(R.string.dialog_web_view_outdated)
            setMessage(R.string.dialog_web_view_outdated_message)
            setCancelable(false)

            val webViewPackage = WebViewCompat.getCurrentWebViewPackage(context)
            if (webViewPackage != null) {
                val marketUri = Uri.Builder().apply {
                    scheme("market")
                    authority("details")
                    appendQueryParameter("id", webViewPackage.packageName)
                }.build()
                val referrerUri = Uri.Builder().apply {
                    scheme("android-app")
                    authority(context.packageName)
                }.build()

                val marketIntent = Intent(Intent.ACTION_VIEW).apply {
                    data = marketUri
                    putExtra(Intent.EXTRA_REFERRER, referrerUri)
                }

                // Only show button if the intent can be resolved
                if (marketIntent.resolveActivity(context.packageManager) != null) {
                    setNegativeButton(R.string.dialog_button_check_for_updates) { _, _ ->
                        startActivity(marketIntent)
                        requireActivity().finishAfterTransition()
                    }
                }
            }
            if (AndroidVersion.isAtLeastN) {
                setPositiveButton(R.string.dialog_button_open_settings) { _, _ ->
                    startActivity(Intent(Settings.ACTION_WEBVIEW_SETTINGS))
                    Toast.makeText(context, R.string.toast_reopen_after_change, Toast.LENGTH_LONG).show()
                    requireActivity().finishAfterTransition()
                }
            }
            setNeutralButton(R.string.dialog_button_ignore) { _, _ ->
                appPreferences.ignoreWebViewChecks = true
                // Re-initialize
                webView.initialize()
            }
        }.show()
    }

    private fun onSelectServer(error: Boolean = false) = runOnUiThread {
        val activity = activity
        if (activity != null && activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
            val extras = when {
                error -> Bundle().apply {
                    putBoolean(Constants.FRAGMENT_CONNECT_EXTRA_ERROR, true)
                }
                else -> null
            }
            parentFragmentManager.replaceFragment<ConnectFragment>(extras)
        }
    }

    private fun handleError() {
        connected = false
        onSelectServer(error = true)
        runOnUiThread { if (isAdded) requireMainActivity().onContentReady() }
    }

    override fun onShowFileChooser(intent: Intent, filePathCallback: ValueCallback<Array<Uri>>) {
        fileChooserCallback = filePathCallback
        fileChooserActivityLauncher.launch(intent)
    }

    private companion object {
        const val SYSTEM_BARS_REPEAT_DELAY_MS = 1500L
    }
}
