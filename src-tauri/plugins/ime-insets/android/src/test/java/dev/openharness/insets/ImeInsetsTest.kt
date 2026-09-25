package dev.openharness.insets

import android.view.View
import android.os.Build
import android.widget.FrameLayout
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29, 35])
class ImeInsetsTest {
    @Test
    @Suppress("DEPRECATION")
    fun keyboardInsetsResizeContentOnceAndRestoreOnHide() {
        val content = FrameLayout(RuntimeEnvironment.getApplication())
        // Robolectric does not run Chromium's WebView measure implementation.
        // Assert the native child bounds supplied to that renderer instead.
        val viewport = View(RuntimeEnvironment.getApplication())
        content.addView(viewport, FrameLayout.LayoutParams(-1, -1))
        installInsets(content)
        val bars = WindowInsetsCompat.Type.systemBars()
        val ime = WindowInsetsCompat.Type.ime()
        // Before API 30, Android reports keyboard overlap as system-window bottom
        // and AndroidX derives IME from it; separate native inset types do not exist.
        val visible = if (Build.VERSION.SDK_INT < 30) WindowInsetsCompat.Builder()
            .setSystemWindowInsets(Insets.of(0, 24, 0, 300))
            .setStableInsets(Insets.of(0, 24, 0, 20)).build()
        else WindowInsetsCompat.Builder()
            .setInsets(bars, Insets.of(0, 24, 0, 20))
            .setInsets(ime, Insets.of(0, 0, 0, 300)).build()
        fun layout() {
            content.measure(View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY))
            content.layout(0, 0, 400, 800)
        }
        val forwarded = ViewCompat.dispatchApplyWindowInsets(content, visible)
        layout()
        assertEquals(24, content.paddingTop)
        assertEquals(300, content.paddingBottom)
        assertEquals(476, viewport.height)
        assertEquals(Insets.NONE, forwarded.getInsets(bars or ime))
        ViewCompat.dispatchApplyWindowInsets(content, visible)
        layout()
        assertEquals(476, viewport.height)
        val hidden = if (Build.VERSION.SDK_INT < 30) WindowInsetsCompat.Builder(visible)
            .setSystemWindowInsets(Insets.of(0, 24, 0, 20)).build()
        else WindowInsetsCompat.Builder(visible).setInsets(ime, Insets.NONE).build()
        ViewCompat.dispatchApplyWindowInsets(content, hidden)
        layout()
        assertEquals(756, viewport.height)
    }
}
