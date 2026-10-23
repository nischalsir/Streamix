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
            primary = Color(0xFF7C5CFF),
            primaryVariant = Color(0xFF16132A),
            secondary = Color(0xFFA68BFF),
            background = Color(0xFF0E0C19),
            surface = Color(0xFF16132A),
            error = Color(0xFFCF6679),
            onPrimary = Color.White,
            onSecondary = Color(0xFF0E0C19),
            onBackground = Color.White,
            onSurface = Color.White,
            onError = Color.White,
        )
    }
    MaterialTheme(
        colors = colors,
        typography = Typography(defaultFontFamily = InterFamily),
        shapes = Shapes(
            small = RoundedCornerShape(10.dp),
            medium = RoundedCornerShape(14.dp),
            large = RoundedCornerShape(0.dp),
        ),
        content = content,
    )
}
