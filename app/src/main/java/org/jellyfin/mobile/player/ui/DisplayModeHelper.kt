package org.jellyfin.mobile.player.ui

import android.view.Display
import android.view.Window
import timber.log.Timber
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Switches the TV's refresh rate to a whole multiple of the video's frame rate
 * (for example 50 Hz for 25 fps, 23.976 Hz for film), so every frame is shown for the
 * same amount of time. Without this a 60 Hz panel shows 24p and 25p video with judder.
 *
 * Only modes with the current resolution are considered, and nothing changes when the
 * panel has no matching mode or already runs at a matching rate.
 */
class DisplayModeHelper(private val window: Window) {
    private var originalModeId: Int? = null

    fun matchFrameRate(frameRate: Float) {
        if (frameRate <= 0f) return
        val display = window.decorView.display ?: return
        val currentMode = display.mode

        val bestMode = display.supportedModes
            .asSequence()
            .filter { mode ->
                mode.physicalWidth == currentMode.physicalWidth && mode.physicalHeight == currentMode.physicalHeight
            }
            .mapNotNull { mode -> frameRateError(mode, frameRate)?.let { error -> mode to error } }
            .minWithOrNull(
                compareBy<Pair<Display.Mode, Float>> { (_, error) -> error }
                    // On a tie keep the current mode, so we don't blank the screen for nothing
                    .thenBy { (mode, _) -> if (mode.modeId == currentMode.modeId) 0 else 1 }
                    .thenByDescending { (mode, _) -> mode.refreshRate },
            )
            ?.first
            ?: return

        if (bestMode.modeId == currentMode.modeId) return

        Timber.i("Switching display to %.3f Hz for %.3f fps video", bestMode.refreshRate, frameRate)
        if (originalModeId == null) originalModeId = window.attributes.preferredDisplayModeId
        window.attributes = window.attributes.apply { preferredDisplayModeId = bestMode.modeId }
    }

    fun restore() {
        val modeId = originalModeId ?: return
        originalModeId = null
        window.attributes = window.attributes.apply { preferredDisplayModeId = modeId }
    }

    /**
     * Relative distance between the mode's refresh rate and the nearest whole multiple of the
     * frame rate, or null when the mode isn't close to any multiple.
     */
    private fun frameRateError(mode: Display.Mode, frameRate: Float): Float? {
        val ratio = mode.refreshRate / frameRate
        val multiple = ratio.roundToInt()
        if (multiple < 1) return null
        val error = abs(ratio - multiple) / multiple
        return error.takeIf { it < MAX_RELATIVE_ERROR }
    }

    private companion object {
        /** Accepts 24 fps on a 23.976 Hz mode (0.1 %), rejects 24 fps on 60 Hz. */
        const val MAX_RELATIVE_ERROR = 0.003f
    }
}
