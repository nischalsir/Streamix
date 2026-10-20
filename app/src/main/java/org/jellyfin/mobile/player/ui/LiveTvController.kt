package org.jellyfin.mobile.player.ui

import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import androidx.lifecycle.LifecycleCoroutineScope
import androidx.media3.common.Player
import androidx.media3.ui.PlayerView
import coil3.ImageLoader
import coil3.request.ImageRequest
import coil3.request.crossfade
import coil3.request.target
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.jellyfin.mobile.R
import org.jellyfin.mobile.databinding.FragmentPlayerBinding
import org.jellyfin.mobile.player.PlayerViewModel
import org.jellyfin.mobile.player.interaction.LiveTvChannelInfo
import org.jellyfin.mobile.utils.isTvDevice
import org.jellyfin.sdk.api.client.ApiClient
import org.jellyfin.sdk.api.client.exception.ApiClientException
import org.jellyfin.sdk.api.client.extensions.imageApi
import org.jellyfin.sdk.api.client.extensions.liveTvApi
import org.jellyfin.sdk.model.api.ImageType
import org.koin.core.component.KoinComponent
import org.koin.core.component.get
import timber.log.Timber
import java.util.UUID

/**
 * Live TV in the player, TV-box style:
 * - while a channel tunes, its logo and name sit in the middle of the screen instead of a black void
 * - once it plays, a banner shows the channel for a few seconds
 * - up/down (or CH+/CH-) flip through the channel list; quick presses only move the banner, and the
 *   channel tunes once the remote goes quiet
 * - number keys jump straight to a channel number (101, 205, ...)
 * - on a phone, a sideways swipe flips to the next or previous channel
 */
class LiveTvController(
    private val binding: FragmentPlayerBinding,
    private val playerView: PlayerView,
    private val viewModel: PlayerViewModel,
    private val scope: LifecycleCoroutineScope,
) : KoinComponent {
    private data class Channel(
        val id: UUID,
        val name: String,
        val number: String?,
        val imageTag: String?,
        val programName: String?,
    )

    private val apiClient: ApiClient = get()
    private val imageLoader: ImageLoader = get()
    private val handler = Handler(Looper.getMainLooper())
    private val context get() = binding.root.context

    /** On a phone there's no remote: channels change with a sideways swipe (see PlayerGestureHelper) */
    private val isTv = context.isTvDevice()

    private var channels: List<Channel> = emptyList()
    private var current: Channel? = null
    private var pendingIndex = -1
    private var controlsVisible = false
    private val typedNumber = StringBuilder()

    /** True from the moment a channel is picked until its first frame plays */
    var isTuning = false
        private set

    val isActive: Boolean get() = current != null

    private val hideBanner = Runnable { fadeOut(binding.liveTvBanner) }
    private val tunePending = Runnable { tune(pendingIndex) }
    private val tuneTypedNumber = Runnable { finishNumberEntry() }
    private val stillTuning = Runnable {
        if (isTuning && binding.liveTvTuningProgress.isVisible) binding.liveTvTuningStatus.setText(R.string.live_tv_still_tuning)
    }

    fun start(channelId: UUID, info: LiveTvChannelInfo) {
        // The tuning card and channel banner say what's on; the controls only come up when asked for
        playerView.controllerAutoShow = false
        val channel = Channel(channelId, cleanName(info.name), info.number, info.imageTag, programName = null)
        current = channel
        if (!isTv) {
            binding.liveTvBannerHint.setText(R.string.live_tv_hint_touch)
            // A phone held upright has little room across: keep the banner just clear of both edges
            val margin = context.resources.getDimensionPixelSize(R.dimen.live_tv_banner_margin_phone)
            binding.liveTvBanner.updateLayoutParams<ViewGroup.MarginLayoutParams> {
                marginStart = margin
                marginEnd = margin
            }
        }
        showTuning(channel)
        loadChannels()
    }

    private fun loadChannels() {
        scope.launch {
            val items = try {
                withContext(Dispatchers.IO) {
                    apiClient.liveTvApi.getLiveTvChannels(
                        enableImageTypes = listOf(ImageType.PRIMARY),
                        imageTypeLimit = 1,
                        enableUserData = false,
                        addCurrentProgram = true,
                    ).content.items
                }
            } catch (e: ApiClientException) {
                Timber.e(e, "Failed to load Live TV channels")
                return@launch
            }
            channels = items.map { item ->
                Channel(
                    id = item.id,
                    name = cleanName(item.name.orEmpty()),
                    number = item.number ?: item.channelNumber,
                    imageTag = item.imageTags?.get(ImageType.PRIMARY),
                    programName = item.currentProgram?.name,
                )
            }
            // Pick up the programme name and number for the channel that's already on
            current?.let { playing -> channels.find { it.id == playing.id }?.let { current = it } }
        }
    }

    /**
     * @param step +1 for the next channel in the list, -1 for the previous one
     * @return true if the key was used
     */
    fun zap(step: Int): Boolean {
        if (channels.size < 2) return current != null
        val base = when {
            pendingIndex >= 0 -> pendingIndex
            else -> channels.indexOfFirst { it.id == current?.id }.coerceAtLeast(0)
        }
        pendingIndex = (base + step).mod(channels.size)
        showBanner(channels[pendingIndex], autoHide = false)
        handler.removeCallbacks(tunePending)
        handler.postDelayed(tunePending, ZAP_SETTLE_MS)
        return true
    }

    /**
     * A number key: shows the channel being typed, and tunes it once the remote goes quiet.
     *
     * @return true if the key was used
     */
    fun enterDigit(digit: Int): Boolean {
        if (current == null) return false
        if (typedNumber.length >= MAX_NUMBER_DIGITS) typedNumber.setLength(0)
        typedNumber.append(digit)
        handler.removeCallbacks(tunePending)
        pendingIndex = -1

        val typed = typedNumber.toString()
        val match = channels.indexOfFirst { it.number == typed }.takeIf { it >= 0 }
            ?: channels.indexOfFirst { it.number?.startsWith(typed) == true }.takeIf { it >= 0 }
        when (match) {
            null -> showMissingNumber(typed)
            else -> showBanner(channels[match], autoHide = false, numberText = typed)
        }
        handler.removeCallbacks(tuneTypedNumber)
        handler.postDelayed(tuneTypedNumber, NUMBER_SETTLE_MS)
        return true
    }

    private fun finishNumberEntry() {
        val typed = typedNumber.toString()
        typedNumber.setLength(0)
        val index = channels.indexOfFirst { it.number == typed }
        if (index >= 0) tune(index) else fadeOut(binding.liveTvBanner)
    }

    private fun showMissingNumber(typed: String) {
        if (controlsVisible) return
        with(binding) {
            liveTvBannerNumber.text = context.getString(R.string.live_tv_channel_number, typed)
            liveTvBannerName.text = context.getString(R.string.live_tv_no_channel)
            liveTvBannerProgram.isVisible = false
            liveTvBannerLogo.setImageResource(R.drawable.ic_live_tv_channel)
            liveTvBanner.animate().cancel()
            liveTvBanner.alpha = 1f
            liveTvBanner.isVisible = true
        }
        handler.removeCallbacks(hideBanner)
    }

    private fun tune(index: Int) {
        val channel = channels.getOrNull(index) ?: return
        pendingIndex = -1
        if (channel.id == current?.id && !isTuning) {
            showBanner(channel, autoHide = true)
            return
        }
        current = channel
        fadeOut(binding.liveTvBanner)
        showTuning(channel)
        scope.launch {
            if (viewModel.switchChannel(channel.id) != null) onError()
        }
    }

    fun onPlayerState(state: Int) {
        if (!isActive || state != Player.STATE_READY || !isTuning) return
        isTuning = false
        fadeOut(binding.liveTvTuning)
        current?.let { showBanner(it, autoHide = true) }
    }

    fun onError() {
        if (!isActive) return
        isTuning = true
        binding.liveTvTuning.isVisible = true
        binding.liveTvTuning.alpha = 1f
        binding.liveTvTuningProgress.isVisible = false
        binding.liveTvTuningStatus.setText(if (isTv) R.string.live_tv_unavailable else R.string.live_tv_unavailable_touch)
    }

    fun onControlsVisibilityChanged(visible: Boolean) {
        controlsVisible = visible
        if (visible) {
            handler.removeCallbacks(hideBanner)
            binding.liveTvBanner.animate().cancel()
            binding.liveTvBanner.isVisible = false
        }
    }

    fun release() {
        handler.removeCallbacksAndMessages(null)
    }

    private fun showTuning(channel: Channel) {
        isTuning = true
        playerView.hideController()
        // Some providers take half a minute; say so, so it doesn't look stuck
        handler.removeCallbacks(stillTuning)
        handler.postDelayed(stillTuning, STILL_TUNING_MS)
        with(binding) {
            liveTvTuningName.text = channel.name
            liveTvTuningStatus.setText(R.string.live_tv_tuning)
            liveTvTuningProgress.isVisible = true
            loadLogo(liveTvTuningLogo, channel, TUNING_LOGO_HEIGHT)
            liveTvTuning.animate().cancel()
            liveTvTuning.alpha = 1f
            liveTvTuning.isVisible = true
        }
    }

    private fun showBanner(channel: Channel, autoHide: Boolean, numberText: String? = null) {
        if (controlsVisible) return
        val index = channels.indexOfFirst { it.id == channel.id }
        with(binding) {
            liveTvBannerName.text = channel.name
            liveTvBannerNumber.text = when {
                numberText != null -> context.getString(R.string.live_tv_channel_number, numberText)
                !channel.number.isNullOrBlank() -> context.getString(R.string.live_tv_channel_number, channel.number)
                index >= 0 -> context.getString(R.string.live_tv_channel_position, index + 1, channels.size)
                else -> ""
            }
            liveTvBannerProgram.text = channel.programName.orEmpty()
            liveTvBannerProgram.isVisible = !channel.programName.isNullOrBlank()
            loadLogo(liveTvBannerLogo, channel, BANNER_LOGO_HEIGHT)
            liveTvBanner.animate().cancel()
            if (!liveTvBanner.isVisible) {
                liveTvBanner.alpha = 0f
                liveTvBanner.isVisible = true
            }
            liveTvBanner.animate().alpha(1f).setDuration(FADE_MS).start()
        }
        handler.removeCallbacks(hideBanner)
        if (autoHide) handler.postDelayed(hideBanner, BANNER_TIMEOUT_MS)
    }

    private fun loadLogo(view: ImageView, channel: Channel, height: Int) {
        if (channel.imageTag == null) {
            view.setImageResource(R.drawable.ic_live_tv_channel)
            return
        }
        val url = apiClient.imageApi.getItemImageUrl(
            itemId = channel.id,
            imageType = ImageType.PRIMARY,
            maxHeight = height,
            tag = channel.imageTag,
        )
        imageLoader.enqueue(
            ImageRequest.Builder(context)
                .data(url)
                .crossfade(true)
                .target(view)
                .build(),
        )
    }

    private fun fadeOut(view: View) {
        if (!view.isVisible) return
        view.animate().cancel()
        view.animate()
            .alpha(0f)
            .setDuration(FADE_MS)
            .withEndAction { view.isVisible = false }
            .start()
    }

    companion object {
        /** IPTV lists tag names with the stream's resolution, e.g. "Kantipur TV (1080p)" */
        private val QUALITY_TAG = Regex("""\s*\((?:\d{3,4}[pi]|4K|UHD)\)""", RegexOption.IGNORE_CASE)

        fun cleanName(name: String): String = name.replace(QUALITY_TAG, "").trim().ifEmpty { name }

        private const val ZAP_SETTLE_MS = 800L
        private const val NUMBER_SETTLE_MS = 1500L
        private const val STILL_TUNING_MS = 12_000L
        private const val MAX_NUMBER_DIGITS = 4
        private const val BANNER_TIMEOUT_MS = 4500L
        private const val FADE_MS = 220L
        private const val TUNING_LOGO_HEIGHT = 320
        private const val BANNER_LOGO_HEIGHT = 200
    }
}
