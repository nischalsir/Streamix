package org.jellyfin.mobile.player.ui

import androidx.core.view.isInvisible
import androidx.core.view.isVisible
import androidx.lifecycle.LifecycleCoroutineScope
import coil3.ImageLoader
import coil3.request.ImageRequest
import coil3.request.crossfade
import coil3.request.target
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.jellyfin.mobile.R
import org.jellyfin.mobile.databinding.ExoPlayerControlViewBinding
import org.jellyfin.mobile.player.source.JellyfinMediaSource
import org.jellyfin.sdk.api.client.ApiClient
import org.jellyfin.sdk.api.client.exception.ApiClientException
import org.jellyfin.sdk.api.client.extensions.imageApi
import org.jellyfin.sdk.api.client.extensions.userLibraryApi
import org.jellyfin.sdk.model.api.BaseItemDto
import org.jellyfin.sdk.model.api.BaseItemKind
import org.jellyfin.sdk.model.api.ImageType
import org.koin.core.component.KoinComponent
import org.koin.core.component.get
import timber.log.Timber
import java.util.UUID

/**
 * What's playing, in the TV player's controls (see layout-television/exo_player_control_view.xml):
 * - bottom left, the title and a line of details: a film's year, rating and genres, an episode's show with
 *   its season and episode, or on Live TV the programme (when the guide has one) and the channel
 * - top left, the title's logo (an episode's show's), or the channel's logo on Live TV
 * - the favourite star, which marks the item on the server
 *
 * Phones use the shared layout, which has none of these views, so this only runs on a TV.
 */
class TvPlayerInfo(
    private val binding: ExoPlayerControlViewBinding,
    private val scope: LifecycleCoroutineScope,
) : KoinComponent {
    private val apiClient: ApiClient = get()
    private val imageLoader: ImageLoader = get()
    private val context get() = binding.root.context

    private var itemId: UUID? = null
    private var favourite = false

    init {
        binding.favoriteButton?.setOnClickListener { toggleFavourite() }
    }

    fun bind(mediaSource: JellyfinMediaSource, live: Boolean) {
        val item = mediaSource.item
        itemId = mediaSource.itemId

        binding.playerTitle?.text = item?.let(::titleOf) ?: mediaSource.getName(context)
        val details = item?.let { detailsOf(it, live) }
        binding.playerSubtitle?.text = details
        binding.playerSubtitle?.isVisible = !details.isNullOrEmpty()

        // A live channel has a Live tag instead of a timeline
        binding.liveBadge.isVisible = live
        binding.timelineHint?.isVisible = !live
        binding.timeSeparator?.isInvisible = live

        loadLogo(item)

        favourite = item?.userData?.isFavorite == true
        renderFavourite()
    }

    private fun titleOf(item: BaseItemDto): String? = when (item.type) {
        BaseItemKind.EPISODE -> item.seriesName ?: item.name
        BaseItemKind.TV_CHANNEL -> item.currentProgram?.name ?: item.name?.let(LiveTvController::cleanName)
        else -> item.name
    }

    private fun detailsOf(item: BaseItemDto, live: Boolean): String? {
        val parts = when {
            live || item.type == BaseItemKind.TV_CHANNEL -> {
                val channel = item.name?.let(LiveTvController::cleanName)
                when {
                    // With a programme as the title, the channel goes underneath
                    item.currentProgram?.name != null -> listOf(channel)
                    !item.channelNumber.isNullOrBlank() -> listOf(context.getString(R.string.live_tv_channel_number, item.channelNumber))
                    else -> emptyList()
                }
            }
            item.type == BaseItemKind.EPISODE -> {
                val season = item.parentIndexNumber
                val episode = item.indexNumber
                val number = when {
                    season == 0 -> context.getString(R.string.special_episode)
                    season != null && episode != null -> context.getString(R.string.tv_player_episode, season, episode)
                    else -> null
                }
                listOf(number, item.name)
            }
            else -> listOf(
                item.productionYear?.toString(),
                item.officialRating,
                item.genres?.take(MAX_GENRES)?.joinToString(", ")?.takeIf { it.isNotEmpty() },
            )
        }
        return parts.filterNot { it.isNullOrBlank() }.joinToString(" · ").ifEmpty { null }
    }

    private fun loadLogo(item: BaseItemDto?) {
        val logo = binding.playerLogo ?: return
        val primaryTag = item?.imageTags?.get(ImageType.PRIMARY)
        val logoTag = item?.imageTags?.get(ImageType.LOGO)
        val parentLogoId = item?.parentLogoItemId
        val parentLogoTag = item?.parentLogoImageTag
        val source = when {
            item == null -> null
            item.type == BaseItemKind.TV_CHANNEL -> primaryTag?.let { Triple(item.id, ImageType.PRIMARY, it) }
            logoTag != null -> Triple(item.id, ImageType.LOGO, logoTag)
            parentLogoId != null && parentLogoTag != null -> Triple(parentLogoId, ImageType.LOGO, parentLogoTag)
            else -> null
        }
        if (source == null) {
            logo.setImageDrawable(null)
            logo.isVisible = false
            return
        }
        val (id, type, tag) = source
        val url = apiClient.imageApi.getItemImageUrl(itemId = id, imageType = type, maxHeight = LOGO_HEIGHT, tag = tag)
        logo.isVisible = true
        imageLoader.enqueue(
            ImageRequest.Builder(context)
                .data(url)
                .crossfade(true)
                .target(logo)
                .build(),
        )
    }

    private fun toggleFavourite() {
        val id = itemId ?: return
        val next = !favourite
        // The star answers at once; the server is told in the background, and the star goes back if it says no
        favourite = next
        renderFavourite()
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    if (next) apiClient.userLibraryApi.markFavoriteItem(id) else apiClient.userLibraryApi.unmarkFavoriteItem(id)
                }
            } catch (e: ApiClientException) {
                Timber.e(e, "Failed to update the favourite state of $id")
                if (itemId == id) {
                    favourite = !next
                    renderFavourite()
                }
            }
        }
    }

    private fun renderFavourite() {
        val button = binding.favoriteButton ?: return
        button.isSelected = favourite
        button.contentDescription = context.getString(
            if (favourite) R.string.tv_player_remove_favourite else R.string.tv_player_add_favourite,
        )
    }

    private companion object {
        const val LOGO_HEIGHT = 160
        const val MAX_GENRES = 2
    }
}
