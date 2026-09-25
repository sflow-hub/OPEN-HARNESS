package dev.openharness.insets

import android.app.Activity
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin

@TauriPlugin
class ImeInsetsPlugin(private val activity: Activity) : Plugin(activity) {
    override fun load(webView: WebView) {
        activity.runOnUiThread {
            // Edge-to-edge windows do not reliably resize for the IME, including
            // Android 15's enforced mode. Own layout insets on every Android version.
            WindowCompat.setDecorFitsSystemWindows(activity.window, false)
            activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            val content = activity.findViewById<View>(android.R.id.content)
            installInsets(content)
            ViewCompat.requestApplyInsets(content)
        }
    }
}

internal fun installInsets(content: View) {
    val left = content.paddingLeft
    val top = content.paddingTop
    val right = content.paddingRight
    val bottom = content.paddingBottom
    val handled = WindowInsetsCompat.Type.systemBars() or
        WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
        val insets = windowInsets.getInsets(handled)
        view.setPadding(left + insets.left, top + insets.top,
            right + insets.right, bottom + insets.bottom)
        // Inform both old and modern WebViews that layout already handled these
        // areas. CONSUMED would suppress the hide update and leave ghost padding.
        WindowInsetsCompat.Builder(windowInsets)
            .setInsets(handled, Insets.NONE)
            .build()
    }
}
