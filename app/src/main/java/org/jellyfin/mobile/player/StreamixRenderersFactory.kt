package org.jellyfin.mobile.player

import android.content.Context
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink

/**
 * Renderers factory with a switch for audio passthrough.
 *
 * With passthrough on (the default), Media3 sends Dolby Digital, Dolby Digital Plus (including Atmos),
 * DTS and TrueHD untouched to whatever the TV reports it can decode: the TV itself, or a soundbar or
 * AV receiver over HDMI ARC/eARC. Anything it can't take is decoded on the device (FFmpeg extension).
 *
 * With passthrough off, the sink only advertises PCM, so every format is decoded on the device.
 * That's the fix for setups that claim a format they then play as silence.
 */
class StreamixRenderersFactory(
    context: Context,
    private val audioPassthrough: Boolean,
) : DefaultRenderersFactory(context) {
    override fun buildAudioSink(
        context: Context,
        enableFloatOutput: Boolean,
        enableAudioTrackPlaybackParams: Boolean,
    ): AudioSink? {
        if (audioPassthrough) {
            return super.buildAudioSink(context, enableFloatOutput, enableAudioTrackPlaybackParams)
        }

        @Suppress("DEPRECATION")
        return DefaultAudioSink.Builder(context)
            .setAudioCapabilities(AudioCapabilities.DEFAULT_AUDIO_CAPABILITIES)
            .setEnableFloatOutput(enableFloatOutput)
            .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
            .build()
    }
}
