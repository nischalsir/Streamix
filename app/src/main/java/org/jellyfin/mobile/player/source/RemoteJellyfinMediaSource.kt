package org.jellyfin.mobile.player.source

import org.jellyfin.sdk.model.api.BaseItemDto
import org.jellyfin.sdk.model.api.MediaProtocol
import org.jellyfin.sdk.model.api.MediaSourceInfo
import org.jellyfin.sdk.model.api.PlayMethod
import java.util.UUID

class RemoteJellyfinMediaSource(
    itemId: UUID,
    item: BaseItemDto?,
    sourceInfo: MediaSourceInfo,
    playSessionId: String,
    val liveStreamId: String?,
    val maxStreamingBitrate: Int?,
    playbackDetails: PlaybackDetails?,
) : JellyfinMediaSource(itemId, item, sourceInfo, playSessionId, playbackDetails) {
    /** Changes to [PlayMethod.DIRECT_PLAY] when a Live TV channel is played from [directLiveStreamUrl] */
    override var playMethod: PlayMethod = when {
        sourceInfo.supportsDirectPlay -> PlayMethod.DIRECT_PLAY
        sourceInfo.supportsDirectStream -> PlayMethod.DIRECT_STREAM
        sourceInfo.supportsTranscoding -> PlayMethod.TRANSCODE
        else -> throw IllegalArgumentException("No play method found for ${sourceInfo.name} ($itemId)")
    }

    /**
     * For a Live TV channel from an IPTV (M3U) tuner: the provider's own HLS address. Jellyfin only offers such
     * channels as a transcode, which makes every channel change wait for FFmpeg to start (8 seconds or more);
     * the player can open the provider's stream itself and start in a second or two.
     */
    val directLiveStreamUrl: String? = sourceInfo.path?.takeIf { path ->
        sourceInfo.isInfiniteStream &&
            sourceInfo.isRemote &&
            sourceInfo.protocol == MediaProtocol.HTTP &&
            (path.startsWith("https://") || path.startsWith("http://")) &&
            (sourceInfo.container.equals("hls", ignoreCase = true) ||
                path.substringBefore('?').endsWith(".m3u8", ignoreCase = true))
    }
}
