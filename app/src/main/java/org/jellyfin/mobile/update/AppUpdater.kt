package org.jellyfin.mobile.update

import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.provider.Settings
import android.text.format.Formatter
import android.view.LayoutInflater
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.edit
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.jellyfin.mobile.BuildConfig
import org.jellyfin.mobile.R
import org.jellyfin.mobile.utils.AndroidVersion
import timber.log.Timber
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.coroutines.coroutineContext

/**
 * Updates Streamix from its GitHub releases, without a USB drive or file manager:
 * checks the latest release, downloads the APK inside the app and hands it to Android's installer.
 *
 * Android asks the user once to allow Streamix to install apps; the APK must be signed with the
 * same key as the installed app, which the release build script takes care of.
 */
class AppUpdater(private val activity: AppCompatActivity) {
    private val context: Context get() = activity
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private var downloadJob: Job? = null

    /** APK that is downloaded and waiting for the install permission. */
    private var pendingInstall: File? = null

    data class Release(val version: String, val notes: String, val apkUrl: String, val apkSize: Long)

    /**
     * Quiet check on launch: at most every few hours, and the same version is offered at most once a day.
     */
    fun checkInBackground() {
        val now = System.currentTimeMillis()
        if (now - preferences.getLong(KEY_LAST_CHECK, 0) < CHECK_INTERVAL_MS) return
        activity.lifecycleScope.launch {
            val release = fetchLatestRelease() ?: return@launch
            preferences.edit { putLong(KEY_LAST_CHECK, now) }
            if (!isNewer(release.version, BuildConfig.VERSION_NAME)) return@launch

            val offeredRecently = preferences.getString(KEY_OFFERED_VERSION, null) == release.version &&
                now - preferences.getLong(KEY_OFFERED_AT, 0) < REMIND_INTERVAL_MS
            if (offeredRecently) return@launch
            preferences.edit {
                putString(KEY_OFFERED_VERSION, release.version)
                putLong(KEY_OFFERED_AT, now)
            }
            showUpdateAvailable(release)
        }
    }

    /**
     * "Check for updates" in Streamix Settings: always checks and always says what it found.
     */
    fun checkNow() {
        Toast.makeText(context, R.string.update_checking, Toast.LENGTH_SHORT).show()
        activity.lifecycleScope.launch {
            val release = fetchLatestRelease()
            when {
                release == null -> toast(R.string.update_check_failed)
                isNewer(release.version, BuildConfig.VERSION_NAME) -> showUpdateAvailable(release)
                else -> toast(context.getString(R.string.update_up_to_date, BuildConfig.VERSION_NAME))
            }
        }
    }

    /**
     * Called from the activity's onResume: picks the install up again after the user allowed it.
     */
    fun onResume() {
        val file = pendingInstall ?: return
        if (canInstallPackages()) {
            pendingInstall = null
            install(file)
        }
    }

    private suspend fun fetchLatestRelease(): Release? = withContext(Dispatchers.IO) {
        try {
            val connection = (URL(RELEASES_URL).openConnection() as HttpURLConnection).apply {
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", "Streamix/${BuildConfig.VERSION_NAME}")
            }
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            connection.disconnect()

            val json = Json.parseToJsonElement(body).jsonObject
            val tag = json["tag_name"]?.jsonPrimitive?.contentOrNull ?: return@withContext null
            val apk = json["assets"]?.jsonArray
                ?.map { it.jsonObject }
                ?.firstOrNull { asset -> asset["name"]?.jsonPrimitive?.contentOrNull?.endsWith(".apk") == true }
                ?: return@withContext null
            Release(
                version = tag.removePrefix("v"),
                notes = json["body"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                apkUrl = apk["browser_download_url"]?.jsonPrimitive?.contentOrNull ?: return@withContext null,
                apkSize = apk["size"]?.jsonPrimitive?.longOrNull ?: 0,
            )
        } catch (e: Exception) {
            Timber.w(e, "Update check failed")
            null
        }
    }

    private fun showUpdateAvailable(release: Release) {
        if (activity.isFinishing) return
        AlertDialog.Builder(activity)
            .setTitle(context.getString(R.string.update_available_title, release.version))
            .setMessage(context.getString(R.string.update_available_message, summarize(release.notes)))
            .setPositiveButton(R.string.update_now) { _, _ -> download(release) }
            .setNegativeButton(R.string.update_later, null)
            .show()
            .getButton(AlertDialog.BUTTON_POSITIVE)
            ?.requestFocus()
    }

    private fun download(release: Release) {
        val view = LayoutInflater.from(activity).inflate(R.layout.dialog_update_progress, null)
        val progressBar = view.findViewById<ProgressBar>(R.id.update_progress)
        val progressText = view.findViewById<TextView>(R.id.update_progress_text)
        val dialog = AlertDialog.Builder(activity)
            .setTitle(R.string.update_downloading)
            .setView(view)
            .setCancelable(false)
            .setNegativeButton(android.R.string.cancel) { _, _ -> downloadJob?.cancel() }
            .show()

        downloadJob = activity.lifecycleScope.launch {
            val file = try {
                downloadApk(release) { done, total ->
                    val percent = if (total > 0) (done * 100 / total).toInt() else 0
                    progressBar.progress = percent
                    progressText.text = context.getString(
                        R.string.update_downloading_progress,
                        percent,
                        Formatter.formatShortFileSize(context, total),
                    )
                }
            } catch (e: Exception) {
                Timber.w(e, "Update download failed")
                null
            }
            dialog.dismiss()
            when {
                file != null -> install(file)
                coroutineContext[Job]?.isCancelled != true -> toast(R.string.update_download_failed)
            }
        }
    }

    private suspend fun downloadApk(release: Release, onProgress: (Long, Long) -> Unit): File =
        withContext(Dispatchers.IO) {
            val folder = File(context.cacheDir, "updates").apply {
                deleteRecursively()
                mkdirs()
            }
            val file = File(folder, "Streamix-${release.version}.apk")
            val connection = (URL(release.apkUrl).openConnection() as HttpURLConnection).apply {
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "Streamix/${BuildConfig.VERSION_NAME}")
            }
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: release.apkSize
            var done = 0L
            var lastReport = 0L
            connection.inputStream.use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(BUFFER_SIZE)
                    while (true) {
                        coroutineContext.ensureActive()
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        done += read
                        val now = System.currentTimeMillis()
                        if (now - lastReport > PROGRESS_INTERVAL_MS) {
                            lastReport = now
                            withContext(Dispatchers.Main) { onProgress(done, total) }
                        }
                    }
                }
            }
            connection.disconnect()
            withContext(Dispatchers.Main) { onProgress(total, total) }
            file
        }

    private fun canInstallPackages(): Boolean =
        !AndroidVersion.isAtLeastO || context.packageManager.canRequestPackageInstalls()

    private fun install(file: File) {
        if (!canInstallPackages()) {
            pendingInstall = file
            askForInstallPermission()
            return
        }
        try {
            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(context.packageName)
            }
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite("streamix.apk", 0, file.length()).use { output ->
                    file.inputStream().use { input -> input.copyTo(output) }
                    session.fsync(output)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    if (AndroidVersion.isAtLeastS) PendingIntent.FLAG_MUTABLE else 0
                val callback = PendingIntent.getBroadcast(
                    context,
                    sessionId,
                    Intent(context, UpdateInstallReceiver::class.java),
                    flags,
                )
                session.commit(callback.intentSender)
            }
        } catch (e: Exception) {
            Timber.e(e, "Update install failed")
            toast(context.getString(R.string.update_install_failed, e.message.orEmpty()))
        }
    }

    private fun askForInstallPermission() {
        AlertDialog.Builder(activity)
            .setTitle(R.string.update_permission_title)
            .setMessage(R.string.update_permission_message)
            .setPositiveButton(R.string.update_permission_open) { _, _ ->
                val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                try {
                    activity.startActivity(intent)
                } catch (e: ActivityNotFoundException) {
                    // Some TV firmwares hide that screen; the security settings list it instead
                    try {
                        activity.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS))
                    } catch (e: ActivityNotFoundException) {
                        toast(R.string.update_permission_manual)
                    }
                }
            }
            .setNegativeButton(android.R.string.cancel) { _, _ -> pendingInstall = null }
            .show()
    }

    /** Release notes are Markdown; the dialog gets the first few plain lines. */
    private fun summarize(notes: String): String = notes.lineSequence()
        .map { line -> line.replace(Regex("[*_`#>]"), "").replace(Regex("\\[(.*?)]\\(.*?\\)"), "$1").trim() }
        .filter { it.isNotEmpty() }
        .take(NOTES_MAX_LINES)
        .joinToString("\n")

    private fun toast(message: Int) = Toast.makeText(context, message, Toast.LENGTH_LONG).show()

    private fun toast(message: String) = Toast.makeText(context, message, Toast.LENGTH_LONG).show()

    companion object {
        private const val RELEASES_URL = "https://api.github.com/repos/nischalsir/Streamix/releases/latest"
        private const val PREFERENCES_NAME = "streamix_updates"
        private const val KEY_LAST_CHECK = "last_check"
        private const val KEY_OFFERED_VERSION = "offered_version"
        private const val KEY_OFFERED_AT = "offered_at"
        private const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L
        private const val REMIND_INTERVAL_MS = 24 * 60 * 60 * 1000L
        private const val TIMEOUT_MS = 15_000
        private const val BUFFER_SIZE = 64 * 1024
        private const val PROGRESS_INTERVAL_MS = 200L
        private const val NOTES_MAX_LINES = 6

        /** True if [remote] (like "1.2.0") is a later version than [local]. */
        fun isNewer(remote: String, local: String): Boolean {
            val a = remote.split('.', '-').mapNotNull(String::toIntOrNull)
            val b = local.split('.', '-').mapNotNull(String::toIntOrNull)
            for (i in 0 until maxOf(a.size, b.size)) {
                val diff = a.getOrElse(i) { 0 } - b.getOrElse(i) { 0 }
                if (diff != 0) return diff > 0
            }
            return false
        }
    }
}
