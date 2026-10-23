package org.jellyfin.mobile.ui.screens.connect

import androidx.compose.foundation.Image
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.ButtonDefaults
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Surface
import androidx.compose.material.Text
import androidx.compose.material.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import org.jellyfin.mobile.MainViewModel
import org.jellyfin.mobile.R
import org.jellyfin.mobile.events.ActivityEvent
import org.jellyfin.mobile.events.ActivityEventHandler
import org.jellyfin.mobile.ui.utils.CenterRow
import org.jellyfin.mobile.ui.utils.isFocused
import org.jellyfin.mobile.ui.utils.tvFocusScale
import org.jellyfin.mobile.utils.isTvDevice
import org.koin.compose.koinInject

@Composable
fun ConnectScreen(
    mainViewModel: MainViewModel,
    showExternalConnectionError: Boolean,
    activityEventHandler: ActivityEventHandler = koinInject(),
) {
    Surface(color = MaterialTheme.colors.background) {
        // A centred column reads well on a TV; full width only makes sense on a phone
        Box(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                modifier = Modifier
                    .widthIn(max = 600.dp)
                    .fillMaxSize()
                    .padding(horizontal = 24.dp),
            ) {
                LogoHeader()
                ServerSelection(
                    showExternalConnectionError = showExternalConnectionError,
                    onConnected = { hostname ->
                        mainViewModel.switchServer(hostname)
                    },
                )
                // Nothing is downloaded to a TV, so there's nothing to view there
                if (!LocalContext.current.isTvDevice()) {
                    StyledTextButton(
                        onClick = { activityEventHandler.emit(ActivityEvent.OpenDownloads) },
                        text = stringResource(R.string.view_downloads),
                    )
                }
            }
        }
    }
}

@Stable
@Composable
fun LogoHeader() {
    CenterRow(
        modifier = Modifier.padding(top = 40.dp, bottom = 32.dp),
    ) {
        Image(
            painter = painterResource(R.drawable.app_logo),
            modifier = Modifier
                .height(48.dp),
            contentDescription = null,
        )
    }
}

@Stable
@Composable
fun StyledTextButton(
    text: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    // Focused button turns amber with dark text and lifts, so it's obvious from the sofa
    val interactionSource = remember { MutableInteractionSource() }
    val focused by interactionSource.isFocused()
    TextButton(
        onClick = onClick,
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .tvFocusScale(interactionSource),
        enabled = enabled,
        interactionSource = interactionSource,
        shape = MaterialTheme.shapes.medium,
        colors = ButtonDefaults.buttonColors(
            backgroundColor = if (focused) MaterialTheme.colors.primary else Color.White.copy(alpha = 0.12f),
            contentColor = if (focused) MaterialTheme.colors.onPrimary else Color.White,
            disabledBackgroundColor = Color.White.copy(alpha = 0.06f),
            disabledContentColor = Color.White.copy(alpha = 0.38f),
        ),
    ) {
        Text(text = text, modifier = Modifier.padding(vertical = 4.dp))
    }
}
