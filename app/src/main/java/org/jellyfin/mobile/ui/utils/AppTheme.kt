package org.jellyfin.mobile.ui.utils

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.MaterialTheme
import androidx.compose.material.Shapes
import androidx.compose.material.Typography
import androidx.compose.material.darkColors
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.jellyfin.mobile.R

/** Inter, the typeface of the whole interface */
private val InterFamily = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_semibold, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_bold, FontWeight.Bold),
)

@Composable
fun AppTheme(content: @Composable () -> Unit) {
    val colors = remember {
        @Suppress("MagicNumber")
        darkColors(
            primary = Color(0xFFE5A00D),
            primaryVariant = Color(0xFF282828),
            secondary = Color(0xFFE5A00D),
            background = Color(0xFF1F1F1F),
            surface = Color(0xFF282828),
            error = Color(0xFFCF6679),
            onPrimary = Color(0xFF141414),
            onSecondary = Color(0xFF141414),
            onBackground = Color.White,
            onSurface = Color.White,
            onError = Color.White,
        )
    }
    MaterialTheme(
        colors = colors,
        typography = Typography(defaultFontFamily = InterFamily),
        shapes = Shapes(
            small = RoundedCornerShape(6.dp),
            medium = RoundedCornerShape(10.dp),
            large = RoundedCornerShape(0.dp),
        ),
        content = content,
    )
}
