package org.jellyfin.mobile.player

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Mixes surround sound (3 to 8 channels) down to stereo on the device, for "Audio output: Downmix to stereo".
 *
 * Centre goes to both sides at -3 dB (keeps dialogue clear), surrounds to their side at -3 dB, the LFE channel
 * is left out. The result is scaled so a full-scale front + centre stays below clipping; rarer peaks are clamped.
 * Mono and stereo pass through untouched (the processor is inactive for them).
 */
class StereoDownmixAudioProcessor : BaseAudioProcessor() {
    private var leftGains = FloatArray(0)
    private var rightGains = FloatArray(0)

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        val channels = inputAudioFormat.channelCount
        if (channels <= 2) return AudioProcessor.AudioFormat.NOT_SET
        val encoding = inputAudioFormat.encoding
        val layout = LAYOUTS[channels]
        if (layout == null || (encoding != C.ENCODING_PCM_16BIT && encoding != C.ENCODING_PCM_FLOAT)) {
            throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
        }
        leftGains = FloatArray(channels) { layout[it].left * GAIN }
        rightGains = FloatArray(channels) { layout[it].right * GAIN }
        return AudioProcessor.AudioFormat(inputAudioFormat.sampleRate, 2, encoding)
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val input = inputBuffer.order(ByteOrder.nativeOrder())
        val channels = inputAudioFormat.channelCount
        val isFloat = inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT
        val bytesPerSample = if (isFloat) FLOAT_BYTES else SHORT_BYTES
        val frames = input.remaining() / (channels * bytesPerSample)
        val output = replaceOutputBuffer(frames * 2 * bytesPerSample)
        repeat(frames) {
            var left = 0f
            var right = 0f
            for (channel in 0 until channels) {
                val sample = if (isFloat) input.float else input.short / SHORT_SCALE
                left += sample * leftGains[channel]
                right += sample * rightGains[channel]
            }
            left = left.coerceIn(-1f, 1f)
            right = right.coerceIn(-1f, 1f)
            if (isFloat) {
                output.putFloat(left)
                output.putFloat(right)
            } else {
                output.putShort((left * Short.MAX_VALUE).toInt().toShort())
                output.putShort((right * Short.MAX_VALUE).toInt().toShort())
            }
        }
        // Skip any partial frame left over
        input.position(input.limit())
        output.flip()
    }

    private class Gain(val left: Float, val right: Float)

    companion object {
        private const val MINUS_3_DB = 0.7071f
        private const val GAIN = 1f / (1f + MINUS_3_DB)
        private const val SHORT_SCALE = 32768f
        private const val SHORT_BYTES = 2
        private const val FLOAT_BYTES = 4

        private val FRONT_LEFT = Gain(1f, 0f)
        private val FRONT_RIGHT = Gain(0f, 1f)
        private val CENTER = Gain(MINUS_3_DB, MINUS_3_DB)
        private val LFE = Gain(0f, 0f)
        private val SURROUND_LEFT = Gain(MINUS_3_DB, 0f)
        private val SURROUND_RIGHT = Gain(0f, MINUS_3_DB)
        private val BACK_CENTER = Gain(0.5f, 0.5f)

        /** Channel order of decoded PCM on Android (WAVE order), by channel count */
        private val LAYOUTS = mapOf(
            3 to listOf(FRONT_LEFT, FRONT_RIGHT, CENTER),
            4 to listOf(FRONT_LEFT, FRONT_RIGHT, SURROUND_LEFT, SURROUND_RIGHT),
            5 to listOf(FRONT_LEFT, FRONT_RIGHT, CENTER, SURROUND_LEFT, SURROUND_RIGHT),
            6 to listOf(FRONT_LEFT, FRONT_RIGHT, CENTER, LFE, SURROUND_LEFT, SURROUND_RIGHT),
            7 to listOf(FRONT_LEFT, FRONT_RIGHT, CENTER, LFE, SURROUND_LEFT, SURROUND_RIGHT, BACK_CENTER),
            8 to listOf(
                FRONT_LEFT, FRONT_RIGHT, CENTER, LFE,
                Gain(0.5f, 0f), Gain(0f, 0.5f), // back left/right
                Gain(0.5f, 0f), Gain(0f, 0.5f), // side left/right
            ),
        )
    }
}
