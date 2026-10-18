package org.jellyfin.mobile.utils

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.view.KeyEvent
import androidx.core.content.getSystemService

/**
 * True on Google TV / Android TV (leanback) devices.
 */
fun Context.isTvDevice(): Boolean {
    val uiModeManager = getSystemService<UiModeManager>()
    return uiModeManager?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
        packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
}

/**
 * Remote-control navigation keys: the D-pad, its centre button and enter.
 */
fun isRemoteNavigationKey(keyCode: Int): Boolean = when (keyCode) {
    KeyEvent.KEYCODE_DPAD_UP,
    KeyEvent.KEYCODE_DPAD_DOWN,
    KeyEvent.KEYCODE_DPAD_LEFT,
    KeyEvent.KEYCODE_DPAD_RIGHT,
    KeyEvent.KEYCODE_DPAD_UP_LEFT,
    KeyEvent.KEYCODE_DPAD_UP_RIGHT,
    KeyEvent.KEYCODE_DPAD_DOWN_LEFT,
    KeyEvent.KEYCODE_DPAD_DOWN_RIGHT,
    KeyEvent.KEYCODE_DPAD_CENTER,
    KeyEvent.KEYCODE_ENTER,
    KeyEvent.KEYCODE_NUMPAD_ENTER,
    -> true
    else -> false
}
