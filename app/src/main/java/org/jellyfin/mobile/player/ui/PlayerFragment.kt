package org.jellyfin.mobile.player.ui

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.OrientationEventListener
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
import android.view.accessibility.CaptioningManager
import android.widget.ImageButton
import androidx.annotation.RequiresApi
import androidx.appcompat.widget.Toolbar
import androidx.constraintlayout.widget.ConstraintLayout
import androidx.core.content.ContextCompat
import androidx.core.content.getSystemService
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isInvisible
import androidx.core.view.isVisible
import androidx.core.view.setPadding
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePadding
import androidx.fragment.app.Fragment
import androidx.fragment.app.viewModels
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.Player
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.PlayerView
import androidx.media3.ui.SubtitleView
import io.github.peerless2012.ass.media.AssHandler
import io.github.peerless2012.ass.media.widget.AssSubtitleView
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.jellyfin.mobile.R
import org.jellyfin.mobile.app.AppPreferences
import org.jellyfin.mobile.databinding.ExoPlayerControlViewBinding
import org.jellyfin.mobile.databinding.FragmentPlayerBinding
import org.jellyfin.mobile.player.PlayerException
import org.jellyfin.mobile.player.PlayerViewModel
import org.jellyfin.mobile.player.interaction.PlayOptions
import org.jellyfin.mobile.player.interaction.PlayerWebPreferences
import org.jellyfin.mobile.player.ui.playermenuhelper.PlayerMenuHelper
import org.jellyfin.mobile.utils.AndroidVersion
import org.jellyfin.mobile.utils.BackPressInterceptor
import org.jellyfin.mobile.utils.Constants
import org.jellyfin.mobile.utils.Constants.DEFAULT_CONTROLS_TIMEOUT_MS
import org.jellyfin.mobile.utils.Constants.PIP_MAX_RATIONAL
import org.jellyfin.mobile.utils.Constants.PIP_MIN_RATIONAL
import org.jellyfin.mobile.utils.SmartOrientationListener
import org.jellyfin.mobile.utils.brightness
import org.jellyfin.mobile.utils.extensions.aspectRational
import org.jellyfin.mobile.utils.extensions.getParcelableCompat
import org.jellyfin.mobile.utils.extensions.isLandscape
import org.jellyfin.mobile.utils.extensions.keepScreenOn
import org.jellyfin.mobile.utils.isRemoteNavigationKey
import org.jellyfin.mobile.utils.isTvDevice
import org.jellyfin.mobile.utils.preferFastestRefreshRate
import org.jellyfin.mobile.utils.toast
import org.jellyfin.sdk.model.api.MediaSegmentDto
import org.jellyfin.sdk.model.api.MediaStream
import org.koin.android.ext.android.inject
import kotlin.math.max
import androidx.media3.ui.R as Media3R

@Suppress("TooManyFunctions")
class PlayerFragment : Fragment(), BackPressInterceptor {
    private val appPreferences: AppPreferences by inject()
    private val assHandler: AssHandler by inject()
    private val viewModel: PlayerViewModel by viewModels()
    private var _playerBinding: FragmentPlayerBinding? = null
    private val playerBinding: FragmentPlayerBinding get() = _playerBinding!!
    private val playerView: PlayerView get() = playerBinding.playerView
    private val playerOverlay: View get() = playerBinding.playerOverlay
    private val loadingIndicator: View get() = playerBinding.loadingIndicator
    private var _playerControlsBinding: ExoPlayerControlViewBinding? = null
    private val playerControlsBinding: ExoPlayerControlViewBinding get() = _playerControlsBinding!!
    private val playerControlsView: View get() = playerControlsBinding.root
    private val toolbar: Toolbar get() = playerControlsBinding.toolbar
    private val fullscreenSwitcher: ImageButton get() = playerControlsBinding.fullscreenSwitcher
    private var playerMenus: PlayerMenus? = null
    private var liveTv: LiveTvController? = null

    private lateinit var playerFullscreenHelper: PlayerFullscreenHelper
    private lateinit var displayModeHelper: DisplayModeHelper
    private var isTv = false
    lateinit var playerLockScreenHelper: PlayerLockScreenHelper
    lateinit var playerGestureHelper: PlayerGestureHelper

    private val currentVideoStream: MediaStream?
        get() = viewModel.mediaSourceOrNull?.selectedVideoStream

    /**
     * Listener that watches the current device orientation.
     * It makes sure that the orientation sensor can still be used (if enabled)
     * after toggling the orientation through the fullscreen button.
     *
     * If the requestedOrientation was reset directly after setting it in the fullscreenSwitcher click handler,
     * the orientation would get reverted before the user had any chance to rotate the device to the desired position.
     */
    private val orientationListener: OrientationEventListener by lazy { SmartOrientationListener(requireActivity()) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val window = requireActivity().window
        playerFullscreenHelper = PlayerFullscreenHelper(window)
        displayModeHelper = DisplayModeHelper(window)
        isTv = requireContext().isTvDevice()
        // Phones: let the system match the screen to the video rather than holding it at 120 Hz
        if (!isTv) window.preferFastestRefreshRate(false)

        // Observe ViewModel
        viewModel.player.observe(this) { player ->
            playerView.player = player
            // The remote only reaches the player while it holds focus
            if (player != null && isTv) playerView.requestFocus()
            // Automatically close fragment, unless we're in PiP mode
            if (player == null && !(AndroidVersion.isAtLeastN && requireActivity().isInPictureInPictureMode)) {
                parentFragmentManager.popBackStack()
            }
        }
        viewModel.playerState.observe(this) { playerState ->
            val isPlaying = viewModel.playerOrNull?.isPlaying == true
            requireActivity().window.keepScreenOn = isPlaying
            // While a Live TV channel tunes, its own card shows progress
            loadingIndicator.isVisible = playerState == Player.STATE_BUFFERING && liveTv?.isTuning != true
            liveTv?.onPlayerState(playerState)
        }
        viewModel.decoderType.observe(this) { type ->
            playerMenus?.updatedSelectedDecoder(type)
        }
        viewModel.error.observe(this) { message ->
            val safeMessage = message.ifEmpty { requireContext().getString(R.string.player_error_unspecific_exception) }
            requireContext().toast(safeMessage)
            liveTv?.onError()
        }
        viewModel.queueManager.currentMediaSource.observe(this) { mediaSource ->
            if (mediaSource.selectedVideoStream?.isLandscape == false) {
                // For portrait videos, immediately enable fullscreen
                playerFullscreenHelper.enableFullscreen()
            } else if (appPreferences.exoPlayerStartLandscapeVideoInLandscape) {
                // Auto-switch to landscape for landscape videos if enabled
                requireActivity().requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            }

            // Show 24p/25p/50p video at a matching refresh rate instead of the panel's fixed 60 Hz
            if (isTv && appPreferences.exoPlayerMatchFrameRate) {
                val videoStream = mediaSource.selectedVideoStream
                val frameRate = videoStream?.realFrameRate ?: videoStream?.averageFrameRate
                if (frameRate != null) displayModeHelper.matchFrameRate(frameRate)
            }

            // Update title and player menus
            toolbar.title = mediaSource.getName(requireContext())
            playerMenus?.onQueueItemChanged(mediaSource, viewModel.queueManager.hasNext())
            // On Live TV, next flips to the next channel
            if (liveTv?.isActive == true) playerControlsBinding.nextButton.isEnabled = true
        }

        // Handle fragment arguments, extract playback options and start playback
        lifecycleScope.launch {
            val context = requireContext()
            val playOptions = requireArguments().getParcelableCompat<PlayOptions>(Constants.EXTRA_MEDIA_PLAY_OPTIONS)
            val preferences = requireArguments().getParcelableCompat<PlayerWebPreferences>(Constants.EXTRA_WEB_PREFERENCES)
            if (playOptions == null) {
                context.toast(R.string.player_error_invalid_play_options)
                return@launch
            }
            val error = viewModel.queueManager.initializePlaybackQueue(playOptions, preferences)
            when (error) {
                is PlayerException.InvalidPlayOptions -> context.toast(R.string.player_error_invalid_play_options)
                is PlayerException.NetworkFailure -> context.toast(R.string.player_error_network_failure)
                is PlayerException.UnsupportedContent -> context.toast(R.string.player_error_unsupported_content)
                null -> Unit // success
            }
            if (error != null) liveTv?.onError()
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _playerBinding = FragmentPlayerBinding.inflate(layoutInflater)
        _playerControlsBinding = ExoPlayerControlViewBinding.bind(playerBinding.root.findViewById(R.id.player_controls))
        return playerBinding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        // Insets handling
        ViewCompat.setOnApplyWindowInsetsListener(playerBinding.root) { _, insets ->
            playerFullscreenHelper.onWindowInsetsChanged(insets)

            val systemInsets = when {
                AndroidVersion.isAtLeastR -> insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars())
                else -> insets.getInsets(WindowInsetsCompat.Type.systemBars())
            }
            if (playerFullscreenHelper.isFullscreen) {
                playerView.setPadding(0)
                playerControlsView.updatePadding(
                    left = max(insets.displayCutout?.safeInsetLeft ?: 0, systemInsets.left),
                    top = max(insets.displayCutout?.safeInsetTop ?: 0, systemInsets.top),
                    right = max(insets.displayCutout?.safeInsetRight ?: 0, systemInsets.right),
                    bottom = max(insets.displayCutout?.safeInsetBottom ?: 0, systemInsets.bottom),
                )
            } else {
                playerView.updatePadding(
                    left = systemInsets.left,
                    top = systemInsets.top,
                    right = systemInsets.right,
                    bottom = systemInsets.bottom,
                )
                playerControlsView.setPadding(0) // Padding is handled by PlayerView
            }
            playerOverlay.updatePadding(
                left = systemInsets.left,
                top = systemInsets.top,
                right = systemInsets.right,
                bottom = systemInsets.bottom,
            )

            // Update fullscreen switcher icon
            val fullscreenDrawable = when {
                playerFullscreenHelper.isFullscreen -> R.drawable.ic_fullscreen_exit_white_32dp
                else -> R.drawable.ic_fullscreen_enter_white_32dp
            }
            fullscreenSwitcher.setImageResource(fullscreenDrawable)

            insets
        }

        // Handle toolbar back button
        toolbar.setNavigationOnClickListener { parentFragmentManager.popBackStack() }

        // Create playback menus
        playerMenus = PlayerMenus(this, playerBinding, playerControlsBinding)

        // Set controller timeout
        suppressControllerAutoHide(false)

        // Disable controller animations
        playerView.setControllerAnimationEnabled(false)

        if (appPreferences.exoPlayerDirectPlayAss) {
            playerView.subtitleView?.apply {
                addView(AssSubtitleView(this.context, assHandler))
            }
        }

        playerView.subtitleView?.let(::applyTheaterSubtitleStyle)

        if (isTv) setupForTv()
        setupLiveTv()

        playerLockScreenHelper = PlayerLockScreenHelper(this, playerBinding, orientationListener)
        playerGestureHelper = PlayerGestureHelper(this, playerBinding, playerLockScreenHelper)

        // Handle fullscreen switcher
        fullscreenSwitcher.setOnClickListener {
            toggleFullscreen()
        }
    }

    /**
     * Remote-control layout: no touch-only buttons, and the time bar seeks in 10 second steps.
     */
    private fun setupForTv() {
        fullscreenSwitcher.isVisible = false
        playerControlsBinding.lockScreenButton.isVisible = false
        playerControlsBinding.audioStreamsButton.updateLayoutParams<ConstraintLayout.LayoutParams> {
            goneStartMargin = resources.getDimensionPixelSize(R.dimen.exo_bottom_controls_margin)
        }
        playerControlsBinding.exoProgress.setKeyTimeIncrement(Constants.DEFAULT_SEEK_TIME_MS)
        playerView.isFocusable = true

        // The phone ripple is too faint to follow from across the room
        with(playerControlsBinding) {
            listOf(
                previousButton, previousChapterButton, exoPlayPause, nextChapterButton, nextButton,
                audioStreamsButton, subtitlesButton, speedButton, qualityButton, decoderButton, infoButton,
            ).forEach { button ->
                button.background = ContextCompat.getDrawable(requireContext(), R.drawable.tv_player_button)
            }
        }
    }

    /**
     * A Live TV channel gets its tuning card, channel banner and channel flipping.
     */
    private fun setupLiveTv() {
        val playOptions = requireArguments().getParcelableCompat<PlayOptions>(Constants.EXTRA_MEDIA_PLAY_OPTIONS)
        val channel = playOptions?.liveTvChannel ?: return
        val channelId = playOptions.ids.getOrNull(playOptions.startIndex) ?: return
        liveTv = LiveTvController(playerBinding, playerView, viewModel, viewLifecycleOwner.lifecycleScope).apply {
            start(channelId, channel)
        }
        playerView.setControllerVisibilityListener(
            PlayerView.ControllerVisibilityListener { visibility ->
                liveTv?.onControlsVisibilityChanged(visibility == View.VISIBLE)
            },
        )
        with(playerControlsBinding) {
            // A live stream has no timeline worth showing: a LIVE tag takes its place
            liveBadge.isVisible = true
            exoPosition.isInvisible = true
            exoDuration.isInvisible = true
            seekBarContainer.isInvisible = true
            exoProgress.isFocusable = false
            // Previous / next change channel, like CH- / CH+
            previousButton.setOnClickListener {
                playerView.hideController()
                liveTv?.zap(-1)
            }
            nextButton.setOnClickListener {
                playerView.hideController()
                liveTv?.zap(1)
            }
        }
    }

    /**
     * White text with a soft shadow and no box, like the web theme's subtitles.
     * Skipped when the user has turned on their own caption style in the system settings.
     */
    private fun applyTheaterSubtitleStyle(subtitleView: SubtitleView) {
        val captioningManager = requireContext().getSystemService<CaptioningManager>()
        if (captioningManager?.isEnabled == true) return

        subtitleView.setStyle(
            CaptionStyleCompat(
                Color.WHITE,
                Color.TRANSPARENT,
                Color.TRANSPARENT,
                CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW,
                Color.BLACK,
                Typeface.create("sans-serif-medium", Typeface.NORMAL),
            ),
        )
        subtitleView.setBottomPaddingFraction(SUBTITLE_BOTTOM_PADDING_FRACTION)
    }

    /**
     * Remote handling while the controls are hidden, called by [org.jellyfin.mobile.MainActivity]
     * before the key reaches the view hierarchy:
     * - left/right seek straight away, then leave focus on the time bar so further presses keep seeking
     * - any other D-pad key brings up the controls with focus on play/pause
     *
     * @return true if the event was consumed
     */
    fun onRemoteKeyEvent(event: KeyEvent): Boolean {
        if (!isTv || _playerBinding == null || viewModel.playerOrNull == null) return false
        if (handleChannelKey(event)) return true
        if (!isRemoteNavigationKey(event.keyCode)) return false
        // While a channel tunes, its card is the whole screen: the controls would only cover it
        if (liveTv?.isTuning == true) return true
        if (!playerView.useController || playerView.isControllerFullyVisible) return false

        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                // Nothing to seek through on Live TV
                KeyEvent.KEYCODE_DPAD_LEFT,
                KeyEvent.KEYCODE_DPAD_RIGHT,
                -> if (liveTv?.isActive == true) {
                    showControllerWithFocus(playerControlsBinding.exoPlayPause)
                    return true
                }
            }
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> {
                    viewModel.rewind()
                    showControllerWithFocus(playerControlsBinding.exoProgress)
                }
                KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    viewModel.fastForward()
                    showControllerWithFocus(playerControlsBinding.exoProgress)
                }
                else -> showControllerWithFocus(playerControlsBinding.exoPlayPause)
            }
        }
        return true
    }

    /**
     * Live TV: CH+/CH- always change channel, and so do up/down while the controls are hidden.
     * Number keys type a channel number.
     */
    private fun handleChannelKey(event: KeyEvent): Boolean {
        val liveTv = liveTv?.takeIf { it.isActive } ?: return false
        val digit = when (event.keyCode) {
            in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> event.keyCode - KeyEvent.KEYCODE_0
            in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> event.keyCode - KeyEvent.KEYCODE_NUMPAD_0
            else -> -1
        }
        if (digit >= 0) {
            if (event.action == KeyEvent.ACTION_DOWN) liveTv.enterDigit(digit)
            return true
        }
        val controlsHidden = !playerView.isControllerFullyVisible
        val step = when (event.keyCode) {
            KeyEvent.KEYCODE_CHANNEL_UP -> 1
            KeyEvent.KEYCODE_CHANNEL_DOWN -> -1
            KeyEvent.KEYCODE_DPAD_UP -> if (controlsHidden) 1 else 0
            KeyEvent.KEYCODE_DPAD_DOWN -> if (controlsHidden) -1 else 0
            else -> 0
        }
        if (step == 0) return false
        if (event.action == KeyEvent.ACTION_DOWN) liveTv.zap(step)
        return true
    }

    private fun showControllerWithFocus(target: View) {
        playerView.showController()
        target.requestFocus()
    }

    /**
     * On TV the first Back hides the controls, the second one leaves the player.
     */
    override fun onInterceptBackPressed(): Boolean {
        if (isTv && _playerBinding != null && playerView.isControllerFullyVisible) {
            playerView.hideController()
            playerView.requestFocus()
            return true
        }
        return false
    }

    override fun onStart() {
        super.onStart()
        orientationListener.enable()
    }

    override fun onResume() {
        super.onResume()

        // When returning from another app, fullscreen mode for landscape orientation has to be set again
        if (isLandscape()) {
            playerFullscreenHelper.enableFullscreen()
        }

        // If playback ended during picture in picture we'll return to the main app when PiP is closed
        if (viewModel.playerOrNull == null) {
            parentFragmentManager.popBackStack()
        }
    }

    /**
     * Handle current orientation and update fullscreen state and switcher icon
     */
    private fun updateFullscreenState(configuration: Configuration) {
        // Do not handle any orientation changes while being in Picture-in-Picture mode
        if (AndroidVersion.isAtLeastN && activity?.isInPictureInPictureMode == true) {
            return
        }

        when {
            isLandscape(configuration) -> {
                // Landscape orientation is always fullscreen
                playerFullscreenHelper.enableFullscreen()
            }
            currentVideoStream?.isLandscape != false -> {
                // Disable fullscreen for landscape video in portrait orientation
                playerFullscreenHelper.disableFullscreen()
            }
        }
    }

    /**
     * Toggle fullscreen.
     *
     * If playing a portrait video, this just hides the status and navigation bars.
     * For landscape videos, additionally the screen gets rotated.
     */
    private fun toggleFullscreen() {
        val videoTrack = currentVideoStream
        if (videoTrack == null || videoTrack.isLandscape) {
            val current = resources.configuration.orientation
            requireActivity().requestedOrientation = when (current) {
                Configuration.ORIENTATION_PORTRAIT -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                else -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            }
            // No need to call playerFullscreenHelper in this case,
            // since the configuration change triggers updateFullscreenState,
            // which does it for us.
        } else {
            playerFullscreenHelper.toggleFullscreen()
        }
    }

    /**
     * If true, the player controls will show indefinitely
     */
    fun suppressControllerAutoHide(suppress: Boolean) {
        playerView.controllerShowTimeoutMs = if (suppress) -1 else DEFAULT_CONTROLS_TIMEOUT_MS
    }

    fun isLandscape(configuration: Configuration = resources.configuration) =
        configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

    fun onRewind() = viewModel.rewind()

    fun onFastForward() = viewModel.fastForward()

    fun onSeekByOffset(offsetMs: Long) = viewModel.seekByOffset(offsetMs)

    /**
     * Live TV on a phone: a sideways swipe changes channel, as there's nothing to seek through.
     *
     * @param step +1 for the next channel, -1 for the previous one
     * @return false when this isn't a Live TV channel, so the swipe seeks as usual
     */
    fun onLiveTvSwipe(step: Int): Boolean {
        val liveTv = liveTv?.takeIf { it.isActive } ?: return false
        playerView.hideController()
        liveTv.zap(step)
        return true
    }

    val isLiveTv: Boolean get() = liveTv?.isActive == true

    fun onPreviousChapter() = viewModel.previousChapter()

    fun onNextChapter() = viewModel.nextChapter()

    /**
     * @param callback called if track selection was successful and UI needs to be updated
     */
    fun onAudioTrackSelected(index: Int, callback: TrackSelectionCallback): Job = lifecycleScope.launch {
        if (viewModel.trackSelectionHelper.selectAudioTrack(index)) {
            callback.onTrackSelected(true)
        }
    }

    /**
     * @param callback called if track selection was successful and UI needs to be updated
     */
    fun onSubtitleSelected(index: Int, callback: TrackSelectionCallback): Job = lifecycleScope.launch {
        if (viewModel.trackSelectionHelper.selectSubtitleTrack(index)) {
            callback.onTrackSelected(true)
        }
    }

    /**
     * Toggle subtitles, selecting the first by [MediaStream.index] if there are multiple.
     *
     * @return true if subtitles are enabled now, false if not
     */
    fun toggleSubtitles(callback: TrackSelectionCallback) = lifecycleScope.launch {
        callback.onTrackSelected(viewModel.trackSelectionHelper.toggleSubtitles())
    }

    fun onBitrateChanged(bitrate: Int?, callback: TrackSelectionCallback) = lifecycleScope.launch {
        callback.onTrackSelected(viewModel.changeBitrate(bitrate))
    }

    /**
     * @return true if the playback speed was changed
     */
    fun onSpeedSelected(speed: Float): Boolean {
        return viewModel.setPlaybackSpeed(speed)
    }

    fun onPressSpeedUp(isPressing: Boolean): Boolean {
        return viewModel.setPressSpeedUp(isPressing, Constants.HOLD_SPEEDUP_MULTIPLIER)
    }

    fun onDecoderSelected(type: DecoderType) {
        viewModel.updateDecoderType(type)
    }

    fun onSkipToPrevious() {
        viewModel.skipToPrevious()
    }

    fun onSkipToNext() {
        viewModel.skipToNext()
    }

    fun onSkipMediaSegment(mediaSegmentDto: MediaSegmentDto?) {
        viewModel.skipMediaSegment(mediaSegmentDto)
    }

    fun onPopupDismissed() {
        if (!AndroidVersion.isAtLeastR) {
            updateFullscreenState(resources.configuration)
        }
    }

    fun onUserLeaveHint() {
        // Many TVs have no picture-in-picture, and asking for it there throws
        val supportsPip = requireContext().packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
        if (AndroidVersion.isAtLeastN && supportsPip && viewModel.playerOrNull != null) {
            requireActivity().enterPictureInPicture()
        }
    }

    @Suppress("NestedBlockDepth")
    @RequiresApi(Build.VERSION_CODES.N)
    private fun Activity.enterPictureInPicture() {
        if (AndroidVersion.isAtLeastO) {
            val params = PictureInPictureParams.Builder().apply {
                val aspectRational = currentVideoStream?.aspectRational?.let { aspectRational ->
                    when {
                        aspectRational < PIP_MIN_RATIONAL -> PIP_MIN_RATIONAL
                        aspectRational > PIP_MAX_RATIONAL -> PIP_MAX_RATIONAL
                        else -> aspectRational
                    }
                }
                setAspectRatio(aspectRational)
                val contentFrame: View = playerView.findViewById(Media3R.id.exo_content_frame)
                val contentRect = with(contentFrame) {
                    val (x, y) = intArrayOf(0, 0).also(::getLocationInWindow)
                    Rect(x, y, x + width, y + height)
                }
                setSourceRectHint(contentRect)
            }.build()
            enterPictureInPictureMode(params)
        } else {
            @Suppress("DEPRECATION")
            enterPictureInPictureMode()
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean) {
        playerView.useController = !isInPictureInPictureMode
        if (isInPictureInPictureMode) {
            playerMenus?.dismissPlaybackInfo()
            playerLockScreenHelper.hideUnlockButton()
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        Handler(Looper.getMainLooper()).post {
            if (!isAdded) return@post

            updateFullscreenState(newConfig)
            playerGestureHelper.handleConfiguration(newConfig)
        }
    }

    override fun onStop() {
        super.onStop()
        orientationListener.disable()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        liveTv?.release()
        liveTv = null
        // Detach player from PlayerView
        playerView.player = null

        // Set binding references to null
        _playerBinding = null
        _playerControlsBinding = null
        playerMenus = null
    }

    override fun onDestroy() {
        super.onDestroy()
        displayModeHelper.restore()
        if (!isTv) requireActivity().window.preferFastestRefreshRate(true)
        with(requireActivity()) {
            // Reset screen orientation
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            playerFullscreenHelper.disableFullscreen()
            // Reset screen brightness
            window.brightness = BRIGHTNESS_OVERRIDE_NONE
        }
    }

    fun setPlayerMenuHelper(menuHelper: PlayerMenuHelper) {
        viewModel.setPlayerMenuHelper(menuHelper)
    }

    private companion object {
        const val SUBTITLE_BOTTOM_PADDING_FRACTION = 0.08f
    }
}
