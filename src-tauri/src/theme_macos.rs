/// macOS Tahoe (26+) title bar theme fix.
///
/// Tauri's `window.setTheme()` sets `NSApp.appearance` via tao, but on
/// macOS Tahoe the Liquid Glass rendering pipeline does not always propagate
/// that change to the native title bar.  This command sets the appearance
/// directly on the `NSWindow` **and** `NSApplication` objects, updates
/// the window background color, and forces a full redraw cycle to ensure
/// the Liquid Glass title bar picks up the change.

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn set_native_theme(window: tauri::WebviewWindow, theme: Option<String>) -> Result<(), String> {
    if objc2::MainThreadMarker::new().is_some() {
        return apply_native_theme_on_main_thread(window, theme);
    }

    let window_for_main = window.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let result = apply_native_theme_on_main_thread(window_for_main, theme);
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
pub fn read_persisted_theme(app: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;

    let app_dir = app.path().app_data_dir().ok()?;
    let settings_path = app_dir.join("settings.json");
    let contents = std::fs::read_to_string(settings_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let theme = json
        .get("bytro-settings")?
        .get("state")?
        .get("theme")?
        .as_str()?
        .to_string();

    if theme == "system" {
        return None;
    }
    Some(theme)
}

#[cfg(target_os = "macos")]
fn apply_native_theme_on_main_thread(
    window: tauri::WebviewWindow,
    theme: Option<String>,
) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSApplication, NSColor, NSView, NSWindow,
    };
    use objc2_foundation::NSString;
    use raw_window_handle::HasWindowHandle;

    let handle = window.window_handle().map_err(|e| e.to_string())?;
    let raw = handle.as_raw();

    if let raw_window_handle::RawWindowHandle::AppKit(appkit) = raw {
        let ns_view = appkit.ns_view.as_ptr() as *const NSView;
        let ns_window: Retained<NSWindow> = unsafe { &*ns_view }
            .window()
            .ok_or_else(|| "Failed to obtain NSWindow from NSView".to_string())?;

        let appearance: Option<Retained<NSAppearance>> = match theme.as_deref() {
            Some("dark") => {
                let name = NSString::from_str("NSAppearanceNameDarkAqua");
                NSAppearance::appearanceNamed(&name)
            }
            Some("light") => {
                let name = NSString::from_str("NSAppearanceNameAqua");
                NSAppearance::appearanceNamed(&name)
            }
            _ => None,
        };

        // 1. Set appearance on NSApplication so menus / popovers also follow.
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| "set_native_theme must run on main thread".to_string())?;
        let app = NSApplication::sharedApplication(mtm);
        app.setAppearance(appearance.as_deref());

        // 2. Set appearance on the NSWindow itself.
        ns_window.setAppearance(appearance.as_deref());
        if let Some(content_view) = ns_window.contentView() {
            content_view.setAppearance(appearance.as_deref());
        }

        // 3. Set window background color to influence Liquid Glass tint.
        //    On Tahoe the title bar material samples from the window background;
        //    a dark bg produces a dark Liquid Glass tint and vice versa.
        let bg = match theme.as_deref() {
            Some("dark") => NSColor::colorWithSRGBRed_green_blue_alpha(
                0.094, 0.094, 0.106, 1.0, // #18181b
            ),
            Some("light") => NSColor::colorWithSRGBRed_green_blue_alpha(
                0.973, 0.976, 0.98, 1.0, // #F8F9FA
            ),
            _ => NSColor::windowBackgroundColor(),
        };
        ns_window.setBackgroundColor(Some(&bg));

        // 4. Toggle titlebar transparency to bust the Liquid Glass cache.
        let was_transparent = ns_window.titlebarAppearsTransparent();
        ns_window.setTitlebarAppearsTransparent(!was_transparent);
        ns_window.setTitlebarAppearsTransparent(was_transparent);

        // 5. Re-commit the title and force a full redraw cycle. Re-setting the
        //    same title makes AppKit rebuild the native title text with the
        //    current window appearance after workspace/title changes.
        let title = ns_window.title();
        ns_window.setTitle(&title);
        ns_window.invalidateShadow();
        if let Some(content_view) = ns_window.contentView() {
            content_view.setNeedsLayout(true);
            content_view.layoutSubtreeIfNeeded();
            content_view.setNeedsDisplay(true);
            content_view.displayIfNeeded();
        }
        ns_window.display();

        Ok(())
    } else {
        Err("Not running on macOS".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn set_native_theme(
    _window: tauri::WebviewWindow,
    _theme: Option<String>,
) -> Result<(), String> {
    Ok(())
}
