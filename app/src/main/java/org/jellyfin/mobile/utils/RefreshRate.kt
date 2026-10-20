package org.jellyfin.mobile.utils

import android.view.Window

/**
 * Phones with a 90 or 120 Hz screen: asks for the fastest refresh rate at the current resolution, so
 * scrolling and animations in the app are as smooth as the screen allows. Some phones (Xiaomi's among
 * them) otherwise keep an app at 60 Hz. Passing false hands the choice back to the system, which lets
 * the player match the screen to the video instead.
 */
fun Window.preferFastestRefreshRate(enabled: Boolean) {
    val modeId = if (enabled) {
        val display = decorView.display ?: return
        val current = display.mode
        display.supportedModes
            .filter { mode -> mode.physicalWidth == current.physicalWidth && mode.physicalHeight == current.physicalHeight }
            .maxByOrNull { mode -> mode.refreshRate }
            ?.modeId
            ?: return
    } else {
        0
    }
    if (attributes.preferredDisplayModeId == modeId) return
    attributes = attributes.apply { preferredDisplayModeId = modeId }
}
