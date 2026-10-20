package org.jellyfin.mobile.utils

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.provider.Settings.System.ACCELEROMETER_ROTATION
import androidx.coordinatorlayout.widget.CoordinatorLayout
import androidx.core.content.getSystemService
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.suspendCancellableCoroutine
import org.jellyfin.mobile.BuildConfig
import org.jellyfin.mobile.MainActivity
import org.jellyfin.mobile.R
import org.jellyfin.mobile.app.AppPreferences
import org.jellyfin.mobile.downloads.DownloadManager
import org.jellyfin.mobile.settings.ExternalPlayerPackage
import org.jellyfin.mobile.ui.utils.shouldShowDownloadSettingsDialog
import org.jellyfin.mobile.ui.utils.showDownloadSettingsDialog
import org.jellyfin.mobile.webapp.WebViewFragment
import org.jellyfin.sdk.model.serializer.toUUID
import org.koin.android.ext.android.get
import timber.log.Timber
import java.util.UUID
import kotlin.coroutines.resume

fun WebViewFragment.requestNoBatteryOptimizations(rootView: CoordinatorLayout) {
    // TVs run on mains power, and the prompt would cover the bottom of the screen
    if (requireContext().isTvDevice()) return

    val powerManager = requireContext().getSystemService(Activity.POWER_SERVICE) as PowerManager
    if (
        !appPreferences.ignoreBatteryOptimizations &&
        !powerManager.isIgnoringBatteryOptimizations(BuildConfig.APPLICATION_ID)
    ) {
        Snackbar.make(rootView, R.string.battery_optimizations_prompt, Snackbar.LENGTH_INDEFINITE).apply {
            setAction(R.string.battery_optimizations_allow) {
                // Android's own Allow / Deny dialog for this app; the full list of apps only as a fallback
                val request = Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:${BuildConfig.APPLICATION_ID}"),
                )
                try {
                    startActivity(request)
                } catch (notFound: ActivityNotFoundException) {
                    Timber.w(notFound, "No battery optimization dialog, opening the settings list")
                    try {
                        startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    } catch (e: ActivityNotFoundException) {
                        Timber.e(e)
                    }
                }

                // Ignore after the user interacted with the snackbar at least once
                appPreferences.ignoreBatteryOptimizations = true
            }
            show()
        }
    }
}

suspend fun MainActivity.requestDownload(itemIds: Collection<UUID>) {
    if (itemIds.isEmpty()) return

    val appPreferences: AppPreferences = get()
    val downloadManager: DownloadManager = get()

    // Show dialog to choose download location for first download
    if (shouldShowDownloadSettingsDialog()) {
        showDownloadSettingsDialog()
    }

    // If no storage location is set the request for choosing a download folder
    // so we'll cancel the download too
    if (appPreferences.storageLocation == null) return

    // Request permissions to send notifications about download progress
    suspendCancellableCoroutine { continuation ->
        requestPermission("android.permission.POST_NOTIFICATIONS") { permissionsMap ->
            if (permissionsMap[Manifest.permission.POST_NOTIFICATIONS] == PackageManager.PERMISSION_GRANTED) {
                continuation.resume(true)
            } else {
                continuation.cancel(null)
            }
        }
    }

    // Add actual download
    val server = mainViewModel.serverState.value.server ?: return
    val user = mainViewModel.userState.value.user ?: return

    downloadManager.enqueueItems(server, user, itemIds)
}

fun Activity.isAutoRotateOn() = Settings.System.getInt(contentResolver, ACCELEROMETER_ROTATION, 0) == 1

fun PackageManager.isPackageInstalled(@ExternalPlayerPackage packageName: String) = try {
    packageName.isNotEmpty() && getApplicationInfo(packageName, 0).enabled
} catch (e: PackageManager.NameNotFoundException) {
    false
}

fun Context.createMediaNotificationChannel(notificationManager: NotificationManager) {
    if (AndroidVersion.isAtLeastO) {
        val notificationChannel = NotificationChannel(
            Constants.MEDIA_NOTIFICATION_CHANNEL_ID,
            getString(R.string.app_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Media notifications"
        }
        notificationManager.createNotificationChannel(notificationChannel)
    }
}

val Context.isLowRamDevice: Boolean
    get() = getSystemService<ActivityManager>()!!.isLowRamDevice

/**
 * Cache key for a Jellyfin media URL: the item id (plus the subtitle index for subtitles), so downloads
 * are found whatever the rest of the URL says. Addresses without an item id (a Live TV channel's own
 * stream, for example) keep the URL itself as the key.
 */
fun Uri.extractId(): String {
    val uri = toString()
    val idRegex = Regex("""/([a-f0-9]{32}|[a-f0-9-]{36})/""")
    val itemId = idRegex.find(uri)?.groups?.get(1)?.value ?: return uri
    var item = itemId.toUUID().toString()

    val subtitleRegex = Regex("""Subtitles/(\d+)/\d+/Stream.subrip|/(\d+).subrip""")
    val subtitleResult = subtitleRegex.find(uri)
    if (subtitleResult != null) {
        item += ":${subtitleResult.groups[1]?.value ?: subtitleResult.groups[2]?.value}"
    }

    return item
}
