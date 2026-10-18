package org.jellyfin.mobile.player

import android.content.Context
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import org.jellyfin.mobile.utils.Constants

/**
 * Renderers factory for the "Audio output" setting.
 *
 * - Direct (the default): Media3 sends Dolby Digital, Dolby Digital Plus (including Atmos), DTS and TrueHD
 *   untouched to whatever the TV reports it can decode: the TV itself, or a soundbar or AV receiver over
 *   HDMI ARC/eARC. Anything it can't take is decoded on the device (FFmpeg extension).
 * - Decode on the TV: the sink only advertises PCM, so every format is decoded on the device. That's the
 *   fix for setups that claim a format they then play as silence.
 * - Downmix to stereo: decoded on the device as above, then mixed down to two channels
 *   ([StereoDownmixAudioProcessor]) - clearer dialogue on TV speakers.
 */
class StreamixRenderersFactory(
    context: Context,
    private val audioOutput: String,
) : DefaultRenderersFactory(context) {
    override fun buildAudioSink(
        context: Context,
        enableFloatOutput: Boolean,
        enableAudioTrackPlaybackParams: Boolean,
    ): AudioSink? {
        if (audioOutput == Constants.AUDIO_OUTPUT_DIRECT) {
            return super.buildAudioSink(context, enableFloatOutput, enableAudioTrackPlaybackParams)
        }

        @Suppress("DEPRECATION")
        val builder = DefaultAudioSink.Builder(context)
            .setAudioCapabilities(AudioCapabilities.DEFAULT_AUDIO_CAPABILITIES)
            .setEnableFloatOutput(enableFloatOutput)
            .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
        if (audioOutput == Constants.AUDIO_OUTPUT_STEREO) {
            builder.setAudioProcessors(arrayOf(StereoDownmixAudioProcessor()))
        }
        return builder.build()
    }
}
